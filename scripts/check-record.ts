/**
 * Regression checks for the record page: peaks, WAV header, onset detection,
 * matching and tempo regions. Runs in the container, no browser needed:
 *
 *   make run cmd="node scripts/check-record.ts"
 */
import { concatBlocks, computePeaks, encodeWav, peakAmplitude } from '../app/composables/useWaveform.ts'
import {
  analyzeTempo,
  clusterOnsets,
  detectOnsets,
  expectedOnsets,
  matchOnsets,
  tempoRegions,
  tempoTrend,
} from '../app/composables/useTempoAnalysis.ts'

let failures = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---- waveform ---------------------------------------------------------------

{
  const samples = new Float32Array([0.5, -0.25, 0.75, -1, 0, 0, 0.1, -0.1])
  const peaks = computePeaks(samples, 8000, 1) // 8 samples per bucket at 8 kHz/1 ms
  check('computePeaks: число бакетов', peaks.min.length === 1 && peaks.max.length === 1)
  check('computePeaks: min/max', peaks.min[0] === -1 && peaks.max[0] === 0.75, `${peaks.min[0]} / ${peaks.max[0]}`)
  check('computePeaks: длительность', Math.abs(peaks.durationMs - 1) < 1e-9, `${peaks.durationMs}`)
}

{
  const samples = new Float32Array(48000)
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin((i / 48000) * 2 * Math.PI * 440) * 0.5
  const peaks = computePeaks(samples, 48000, 5)
  check('computePeaks: 1 с при hop 5 мс → 200 бакетов', peaks.min.length === 200, `${peaks.min.length}`)
  check('computePeaks: амплитуда в бакете', peaks.max[40]! > 0.45 && peaks.max[40]! < 0.6, `${peaks.max[40]}`)
}

{
  const a = new Float32Array([1, 2])
  const b = new Float32Array([3, 4, 5])
  const joined = concatBlocks([a, b])
  check('concatBlocks: склейка', joined.length === 5 && joined[2] === 3 && joined[4] === 5)
}

{
  const samples = new Float32Array([0.2, -0.7, 0.995])
  check('peakAmplitude', Math.abs(peakAmplitude(samples) - 0.995) < 1e-6)
}

{
  const mono = new Float32Array(100).fill(0.5)
  const wav = encodeWav([mono], 48000)
  const view = new DataView(wav)
  const ascii = (offset: number) => String.fromCharCode(...new Uint8Array(wav, offset, 4))
  check('WAV: RIFF/WAVE', ascii(0) === 'RIFF' && ascii(8) === 'WAVE')
  check('WAV: моно 16 бит', view.getUint16(22, true) === 1 && view.getUint16(34, true) === 16)
  check('WAV: sample rate', view.getUint32(24, true) === 48000)
  check('WAV: размер файла', wav.byteLength === 44 + 100 * 2, `${wav.byteLength}`)
  check('WAV: данные начинаются с 0.5', Math.abs(view.getInt16(44, true) - 16383) <= 1, `${view.getInt16(44, true)}`)
}

// ---- onsets -----------------------------------------------------------------

/** 4 clicks (10 ms bursts) at known times, silence in between. */
function clicks(timesMs: number[], sampleRate = 48000) {
  const length = Math.round((sampleRate * (Math.max(...timesMs) + 500)) / 1000)
  const samples = new Float32Array(length)
  for (const timeMs of timesMs) {
    const from = Math.round((sampleRate * timeMs) / 1000)
    for (let i = 0; i < Math.round(sampleRate * 0.012); i += 1) {
      samples[from + i] = Math.sin(i / 3) * 0.6 * Math.exp(-i / 300)
    }
  }
  return samples
}

{
  const detected = detectOnsets(clicks([500, 1000, 1500, 2000]), 48000)
  check('detectOnsets: найдено 4 удара', detected.length === 4, detected.map((t) => Math.round(t)).join(', '))
  const errors = detected.map((time, index) => Math.abs(time - [500, 1000, 1500, 2000][index]!))
  check('detectOnsets: точность ±30 мс', errors.every((error) => error <= 30), errors.map((e) => e.toFixed(0)).join(', '))
}

{
  const detected = detectOnsets(new Float32Array(48000), 48000)
  check('detectOnsets: тишина ничего не даёт', detected.length === 0)
}

{
  const events = [
    { track: 0, note: 60, start: 0, dur: 200 },
    { track: 0, note: 64, start: 10, dur: 200 },
    { track: 0, note: 67, start: 500, dur: 200 },
    { track: 1, note: 48, start: 500, dur: 200 },
    { track: 1, note: 50, start: 1000, dur: 200 },
  ]
  const expected = expectedOnsets(events, [0])
  check('expectedOnsets: аккорд = один онсет', expected.length === 2 && expected[0]!.ms === 0, expected.map((e) => e.ms).join(','))
  check('clusterOnsets: склейка близких', clusterOnsets([0, 10, 20, 40, 200]).length === 3)
  const both = expectedOnsets(events, [0, 1])
  check('expectedOnsets: две дорожки', both.length === 3, both.map((e) => e.ms).join(','))
}

// ---- matching ---------------------------------------------------------------

{
  const events = Array.from({ length: 8 }, (_unused, index) => ({
    track: 0,
    note: 60,
    start: index * 500,
    dur: 200,
  }))
  const expected = expectedOnsets(events, [0])
  const detected = [5, 510, 1012, 1510, 2020, 2510, 3010, 3520]
  const { matched, missed, extra } = matchOnsets(expected, detected, 250)
  check('matchOnsets: совпадения', matched.length === 8, `${matched.length}`)
  check(
    'matchOnsets: отклонения',
    matched.map((m) => m.dt).join(',') === '5,10,12,10,20,10,10,20',
    matched.map((m) => m.dt).join(','),
  )
  check('matchOnsets: лишних и пропусков нет', extra.length === 0 && missed.length === 0, `extra ${extra.length}, missed ${missed.length}`)
}

{
  const expected = expectedOnsets([{ track: 0, note: 60, start: 0, dur: 100 }], [0])
  const { matched, missed } = matchOnsets(expected, [900], 250)
  check('matchOnsets: вне окна = пропуск', matched.length === 0 && missed.length === 1)
}

// ---- regions ----------------------------------------------------------------

{
  const matched = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500].map((ms, index) => ({
    ms,
    index,
    detectedMs: ms + (index >= 3 && index <= 4 ? 200 : 10),
    dt: index >= 3 && index <= 4 ? 200 : 10,
  }))
  const regions = tempoRegions(matched, { thresholdMs: 120, minRun: 2, padMs: 50 })
  check('tempoRegions: один регион', regions.length === 1, `${regions.length}`)
  check('tempoRegions: границы', regions[0]?.startMs === 1450 && regions[0]?.endMs === 2050, `${regions[0]?.startMs}…${regions[0]?.endMs}`)
  check('tempoRegions: отклонение', regions[0]?.avgDt === 200 && regions[0]?.count === 2)
  check(
    'tempoRegions: онсеты региона (где должно быть и где сыграно)',
    regions[0]?.onsets.length === 2 &&
      regions[0]!.onsets[0]!.ms === 1500 &&
      regions[0]!.onsets[0]!.detectedMs === 1700,
    JSON.stringify(regions[0]?.onsets),
  )
}

{
  const matched = [0, 500, 1000].map((ms, index) => ({ ms, index, detectedMs: ms, dt: index === 1 ? 400 : 0 }))
  const regions = tempoRegions(matched, { thresholdMs: 120, minRun: 2, padMs: 0 })
  check('tempoRegions: одиночная грубая ошибка ловится', regions.length === 1)
}

{
  const matched = [0, 500, 1000].map((ms, index) => ({ ms, index, detectedMs: ms, dt: index === 1 ? 150 : 0 }))
  const regions = tempoRegions(matched, { thresholdMs: 120, minRun: 2 })
  check('tempoRegions: одиночная мелкая ошибка не ловится', regions.length === 0)
}

{
  const matched = Array.from({ length: 10 }, (_unused, index) => ({
    ms: index * 500,
    index,
    detectedMs: index * 500,
    dt: 30 * index,
  }))
  const { slope, verdict } = tempoTrend(matched)
  check('tempoTrend: отставание', Math.abs(slope - 30) < 1e-6 && verdict === 'dragging', `${slope.toFixed(1)} ${verdict}`)
  const rushing = tempoTrend(matched.map((item) => ({ ...item, dt: -30 * item.index })))
  check('tempoTrend: спешка', rushing.verdict === 'rushing', `${rushing.slope.toFixed(1)}`)
}

// ---- end to end -------------------------------------------------------------

{
  const events = Array.from({ length: 6 }, (_unused, index) => ({
    track: 0,
    note: 60,
    start: index * 500,
    dur: 200,
  }))
  const summary = analyzeTempo({
    events,
    tracks: [0],
    detected: [0, 500, 1000, 1700, 2200, 2520],
    options: { thresholdMs: 120 },
  })
  check('analyzeTempo: попадания', Math.round(summary.hitRate * 100) === 100, `${summary.hitRate}`)
  check('analyzeTempo: средняя ошибка', Math.round(summary.meanAbsDt) === 70, `${summary.meanAbsDt.toFixed(1)}`)
  check('analyzeTempo: регион', summary.regions.length === 1 && summary.regions[0]!.count === 2, `${summary.regions.length}`)
}

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  ;(globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1)
}
console.log('\nall passed')
