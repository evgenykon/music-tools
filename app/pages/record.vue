<script setup lang="ts">
import { createTabSynth } from '~/composables/useTabSynth'
import { createRecorder } from '~/composables/useRecorder'
import { encodeWav } from '~/composables/useWaveform'
import {
  analyzeTempo,
  barAt,
  detectOnsets,
  type TempoRegion,
  type TempoSummary,
} from '~/composables/useTempoAnalysis'

useHead({ title: 'Проверка — music-tools' })

const base = useRuntimeConfig().app.baseURL

const synth = createTabSynth({ base })
const recorder = createRecorder({ getContext: () => synth.context, base })

type TrackRow = {
  index: number
  name: string
  muted: boolean
  hidden: boolean
  isPercussion: boolean
}

const fileInput = ref<HTMLInputElement | null>(null)
const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const fileName = ref('')
const scoreTitle = ref('')
const tracks = ref<TrackRow[]>([])

const pxPerMs = ref(0.06)
const zoomSteps = [
  { id: 0.025, label: '¼' },
  { id: 0.06, label: '1×' },
  { id: 0.12, label: '2×' },
  { id: 0.28, label: '4×' },
]

const shiftMs = ref(0)
const toleranceMs = ref(120)
const referenceTrack = ref<number | 'all'>('all')

const playheadMs = ref(0)
const follow = ref(true)
const withScore = ref(true)
const playing = ref(false)

const regions = ref<TempoRegion[]>([])
const summary = ref<TempoSummary | null>(null)
const analysisDone = ref(false)

const scoreDuration = computed(() => synth.duration.value)
const barMarks = computed(() => synth.timeline.bars)
const timelineEvents = computed(() => synth.timeline.events)

const recording = computed(
  () => recorder.status.value === 'recording' || recorder.status.value === 'countIn',
)
const hasTake = computed(() => recorder.status.value === 'ready')
const peaks = computed(() => recorder.peaks.value ?? recorder.livePeaks.value)

const statusLabel = computed(() => {
  switch (recorder.status.value) {
    case 'requesting':
      return 'Спрашиваю доступ к микрофону…'
    case 'countIn':
      return 'Отсчёт: 4 клика'
    case 'recording':
      return 'Идёт запись'
    case 'ready':
      return 'Запись готова'
    case 'error':
      return recorder.error.value || 'Ошибка записи'
    default:
      return loaded.value ? 'Готов к тестированию' : 'Откройте файл с партитурой'
  }
})

const levelPercent = computed(() => Math.round(Math.min(1, recorder.level.value) * 100))
const levelTone = computed(() => {
  if (recorder.clipping.value > 0) return 'clip'
  if (recorder.level.value > 0.85) return 'hot'
  return 'ok'
})

const positionLabel = computed(() => formatTime(playheadMs.value))
const durationLabel = computed(() => formatTime(Math.max(scoreDuration.value, playheadMs.value)))

/** 1 нота / 2 ноты / 5 нот — readable counts instead of "3 нот". */
function plural(count: number, forms: [string, string, string]) {
  const abs = Math.abs(count) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---- loading a score --------------------------------------------------------

const allowed = /\.(gp3|gp4|gp5|gpx|gp|musicxml|xml)$/i

async function loadBuffer(buffer: ArrayBuffer, name: string) {
  error.value = null
  loading.value = true
  try {
    const at: any = await import('@coderline/alphatab')
    // ScoreLoader lives in the importer barrel; parsing without an AlphaTabApi
    // means no engraving pass, which keeps big scores fast to open here.
    const loader = at.importer?.ScoreLoader ?? at.ScoreLoader
    if (!loader) throw new Error('alphaTab: загрузчик партитур недоступен')
    const settings = new at.Settings()
    const score = loader.loadScoreFromBytes(new Uint8Array(buffer), settings)
    synth.stop()
    synth.loadScore(score)
    fileName.value = name
    scoreTitle.value = score.title || name
    tracks.value = synth.tracks.value.map((track) => ({
      index: track.index,
      name: track.name,
      muted: false,
      hidden: false,
      isPercussion: track.isPercussion,
    }))
    playheadMs.value = 0
    regions.value = []
    summary.value = null
    analysisDone.value = false
    loaded.value = true
    recorder.clearTake()
    applyAutoShift()
  } catch (e: any) {
    error.value = e?.message || 'Не удалось прочитать файл'
  } finally {
    loading.value = false
  }
}

async function openFile(file: File) {
  if (!allowed.test(file.name)) {
    error.value = 'Поддерживаются .gp3, .gp4, .gp5, .gpx, .gp и MusicXML'
    return
  }
  if (file.size > 25 * 1024 * 1024) {
    error.value = 'Файл больше 25 МБ'
    return
  }
  await loadBuffer(await file.arrayBuffer(), file.name)
}

const dragOver = ref(false)

function onDrop(event: DragEvent) {
  dragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) openFile(file)
}

function onPick(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) openFile(file)
  target.value = ''
}

async function openDemo() {
  loading.value = true
  error.value = null
  try {
    const response = await fetch(`${base}samples/demo.musicxml`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await loadBuffer(await response.arrayBuffer(), 'demo.musicxml')
  } catch (e: any) {
    loading.value = false
    error.value = `Не удалось загрузить пример: ${e?.message || e}`
  }
}

// ---- tracks -----------------------------------------------------------------

function applyTrackSettings() {
  for (const row of tracks.value) {
    const state = synth.tracks.value[row.index]
    if (!state) continue
    state.muted = row.muted
    synth.applyTrackSettings(state)
  }
}

function toggleHidden(index: number) {
  const row = tracks.value.find((item) => item.index === index)
  if (!row) return
  row.hidden = !row.hidden
}

function toggleMute(index: number) {
  const row = tracks.value.find((item) => item.index === index)
  if (!row) return
  row.muted = !row.muted
  applyTrackSettings()
}

// ---- latency ---------------------------------------------------------------

function applyAutoShift() {
  const ctx = synth.context
  if (!ctx) return
  const latency = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000
  shiftMs.value = Math.round(Math.min(300, Math.max(0, latency)))
}

// ---- recording -------------------------------------------------------------

let autoStop: number | null = null

function clearTake() {
  recorder.clearTake()
  regions.value = []
  summary.value = null
  analysisDone.value = false
  playheadMs.value = 0
}

async function startTest() {
  if (!loaded.value) {
    error.value = 'Сначала откройте файл с партитурой'
    return
  }
  error.value = null
  clearTake()
  try {
    await synth.ensureAudio()
    applyAutoShift()
    const tempo = synth.timeline.firstTempo || 120
    const zero = await recorder.begin(4, 60000 / tempo)
    await synth.play(0, zero)
    follow.value = true
    autoStop = window.setInterval(() => {
      if (recorder.status.value !== 'recording') return
      if (!synth.playing.value) finishTest()
    }, 250)
  } catch (e: any) {
    error.value = e?.message || 'Не удалось начать запись'
    stopTimers()
  }
}

function stopTimers() {
  if (autoStop) {
    clearInterval(autoStop)
    autoStop = null
  }
}

function finishTest() {
  stopTimers()
  const position = synth.position.value
  synth.pause()
  recorder.stop()
  playheadMs.value = Math.max(0, position)
  if (!recorder.peaks.value) error.value = 'Запись пустая — проверьте микрофон'
}

function toggleTest() {
  if (recording.value) finishTest()
  else startTest()
}

// While recording, the playhead follows the score clock directly.
watch(
  () => synth.position.value,
  (value) => {
    if (recording.value) playheadMs.value = value
  },
)

// ---- listening back --------------------------------------------------------

let clock: number | null = null
let clockCtxStart = 0
let clockFrom = 0

function stopClock() {
  if (clock) {
    clearInterval(clock)
    clock = null
  }
}

async function togglePlayback() {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!hasTake.value) return
  const ctx = await synth.ensureAudio()
  const from = playheadMs.value >= Math.max(scoreDuration.value, 1000) - 80 ? 0 : playheadMs.value
  const at = ctx.currentTime + 0.12
  playheadMs.value = from
  if (withScore.value) await synth.play(from, at)
  recorder.play(from, at, shiftMs.value)
  playing.value = true
  clockCtxStart = at
  clockFrom = from
  stopClock()
  clock = window.setInterval(() => {
    const current = synth.context
    if (!current) return
    if (withScore.value) {
      playheadMs.value = synth.position.value
      if (!synth.playing.value) stopPlayback()
      return
    }
    const elapsed = (current.currentTime - clockCtxStart) * 1000
    playheadMs.value = clockFrom + elapsed
    const takeEnd = recorder.durationMs.value - recorder.recordStartMs.value - shiftMs.value
    if (clockFrom + elapsed >= takeEnd) stopPlayback()
  }, 50)
}

function stopPlayback() {
  stopClock()
  synth.pause()
  recorder.stopPlayback()
  playing.value = false
}

function seek(ms: number) {
  const limit = Math.max(scoreDuration.value, recorder.durationMs.value)
  const target = Math.min(Math.max(0, ms), limit)
  playheadMs.value = target
  if (playing.value) {
    stopPlayback()
    togglePlayback()
  }
}

// ---- analysis --------------------------------------------------------------

function analyze() {
  const samples = recorder.samples.value
  if (!samples) return
  const onsets = detectOnsets(samples, recorder.sampleRate.value)
  const takeStart = recorder.recordStartMs.value + shiftMs.value
  const detected = onsets
    .map((time) => time - takeStart)
    .filter((time) => time >= -500 && time <= scoreDuration.value + 800)

  const reference =
    referenceTrack.value === 'all'
      ? tracks.value.filter((row) => !row.hidden).map((row) => row.index)
      : [referenceTrack.value]

  const result = analyzeTempo({
    events: timelineEvents.value,
    tracks: reference.length ? reference : tracks.value.map((row) => row.index),
    detected,
    options: { thresholdMs: toleranceMs.value, padMs: 80 },
  })
  summary.value = result
  regions.value = result.regions
  analysisDone.value = true
}

type RegionRow = TempoRegion & { place: string; direction: string }

/** «такт 6, доля 2 — позже на 223 мс, 6 нот» — human readable region. */
const regionRows = computed<RegionRow[]>(() => {
  const bars = barMarks.value
  return (summary.value?.regions ?? []).map((region) => {
    const place = barAt(region.startMs, bars)
    const worst = region.worstDt
    return {
      ...region,
      place: place ? `такт ${place.bar}, доля ${place.beat}` : formatTime(region.startMs),
      direction: worst > 0 ? `позже на ${Math.abs(Math.round(worst))} мс` : `раньше на ${Math.abs(Math.round(worst))} мс`,
    }
  })
})

function focusRegion(region: TempoRegion) {
  seek(region.startMs)
  if (!playing.value) togglePlayback()
}

// ---- export ----------------------------------------------------------------

function exportWav() {
  const samples = recorder.samples.value
  if (!samples) return
  const wav = encodeWav([samples], recorder.sampleRate.value)
  const blob = new Blob([wav], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${(scoreTitle.value || 'take').replace(/\.[^.]+$/, '')}-take.wav`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return
  if (event.code === 'Space' && loaded.value) {
    event.preventDefault()
    if (hasTake.value) togglePlayback()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // Dev-only handle for browser checks: inject a take or inspect refs without a
  // microphone. Never included in the production build.
  if (import.meta.dev) {
    ;(window as any).__recordDebug = { synth, recorder, analyze, seek, playheadMs, shiftMs, toleranceMs }
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  stopTimers()
  stopClock()
  recorder.destroy()
  synth.destroy()
})
</script>

<template>
  <div class="page">
    <header class="header">
      <h1 class="title">Проверка</h1>
      <p class="subtitle">
        Играйте под минус из GTP-файла — запись ляжет дорожкой под нотами, а «Анализ темпа» подсветит
        места, где вы вышли из темпа. Наушники обязательны: мониторинг выключен.
      </p>
    </header>

    <ClientOnly>
      <div
        v-if="!loaded"
        class="drop"
        :class="{ 'drop--over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop.prevent="onDrop"
      >
        <p class="drop-title">{{ loading ? 'Читаю файл…' : 'Перетащите сюда файл партитуры' }}</p>
        <p class="drop-hint">.gp3 · .gp4 · .gp5 · .gpx · .gp · .musicxml — до 25 МБ</p>
        <div class="drop-actions">
          <button type="button" class="button button--primary" @click="fileInput?.click()">
            Выбрать файл
          </button>
          <button type="button" class="button" :disabled="loading" @click="openDemo">
            Открыть пример
          </button>
        </div>
        <input
          ref="fileInput"
          class="hidden-input"
          type="file"
          accept=".gp3,.gp4,.gp5,.gpx,.gp,.musicxml,.xml"
          @change="onPick"
        >
      </div>

      <template v-if="loaded">
        <section class="transport">
          <div class="transport-row">
            <button
              type="button"
              class="button button--record"
              :class="{ 'button--stop': recording }"
              @click="toggleTest"
            >
              {{ recording ? '■ Стоп' : '● Тестирование' }}
            </button>

            <button
              type="button"
              class="button"
              :disabled="!hasTake"
              :aria-label="playing ? 'Пауза' : 'Слушать'"
              @click="togglePlayback"
            >
              {{ playing ? '❚❚' : '▶' }}
            </button>

            <div class="time">
              <span class="time-now">{{ positionLabel }}</span>
              <span class="time-sep">/</span>
              <span class="time-total">{{ durationLabel }}</span>
            </div>

            <div class="status" :class="`status--${levelTone}`">
              <span class="status-dot" />
              <span class="status-text">{{ statusLabel }}</span>
            </div>

            <div class="meter" :title="`Уровень ${levelPercent}%`">
              <div class="meter-fill" :style="{ width: `${levelPercent}%` }" />
            </div>

            <span class="device">{{ recorder.deviceLabel.value || 'микрофон не выбран' }}</span>

            <div class="file-meta">
              <span class="file-name">{{ scoreTitle }}</span>
              <button type="button" class="button button--ghost" @click="fileInput?.click()">
                Другой файл
              </button>
              <input
                ref="fileInput"
                class="hidden-input"
                type="file"
                accept=".gp3,.gp4,.gp5,.gpx,.gp,.musicxml,.xml"
                @change="onPick"
              >
            </div>
          </div>

          <div class="transport-row transport-row--second">
            <div class="segmented" role="group" aria-label="Масштаб">
              <button
                v-for="step in zoomSteps"
                :key="step.id"
                type="button"
                class="segmented-item"
                :class="{ 'segmented-item--active': Math.abs(pxPerMs - step.id) < 0.001 }"
                @click="pxPerMs = step.id"
              >
                {{ step.label }}
              </button>
            </div>

            <label class="control">
              <span class="control-label">Сдвиг записи</span>
              <input v-model.number="shiftMs" class="range" type="range" min="-300" max="300" step="5">
              <span class="control-value">{{ shiftMs }} мс</span>
            </label>

            <label class="control">
              <span class="control-label">Допуск темпа</span>
              <input v-model.number="toleranceMs" class="range" type="range" min="60" max="250" step="10">
              <span class="control-value">{{ toleranceMs }} мс</span>
            </label>

            <label class="control">
              <span class="control-label">Сравнивать с</span>
              <select v-model="referenceTrack" class="select">
                <option value="all">всеми видимыми</option>
                <option v-for="track in tracks" :key="track.index" :value="track.index">
                  {{ track.name }}
                </option>
              </select>
            </label>

            <button type="button" class="button button--primary" :disabled="!hasTake" @click="analyze">
              Анализ темпа
            </button>

            <label class="control control--check">
              <input v-model="withScore" type="checkbox">
              <span class="control-label">вместе с GTP</span>
            </label>

            <button type="button" class="button" :disabled="!hasTake" @click="exportWav">
              Экспорт WAV
            </button>
          </div>
        </section>

        <RecordTimeline
          :events="timelineEvents"
          :tracks="tracks"
          :bars="barMarks"
          :score-duration="scoreDuration"
          :px-per-ms="pxPerMs"
          :peaks="peaks"
          :record-start-ms="recorder.recordStartMs.value"
          :shift-ms="shiftMs"
          :regions="regions"
          :stray="summary?.stray ?? []"
          :playhead-ms="playheadMs"
          :follow="follow"
          @seek="seek"
          @toggle-hidden="toggleHidden"
          @toggle-mute="toggleMute"
        />

        <section v-if="analysisDone && summary" class="analysis">
          <div class="analysis-head">
            <h2 class="analysis-title">Анализ темпа</h2>
            <span class="analysis-verdict" :class="`analysis-verdict--${summary.verdict}`">
              {{
                summary.verdict === 'rushing'
                  ? 'Торопитесь'
                  : summary.verdict === 'dragging'
                    ? 'Отстаёте'
                    : 'Темп ровный'
              }}
            </span>
          </div>

          <div class="metrics">
            <div class="metric">
              <span class="metric-value">{{ Math.round(summary.hitRate * 100) }}%</span>
              <span class="metric-label">нот в допуске</span>
            </div>
            <div class="metric">
              <span class="metric-value">{{ Math.round(summary.meanAbsDt) }} мс</span>
              <span class="metric-label">средняя ошибка</span>
            </div>
            <div class="metric">
              <span class="metric-value">{{ Math.round(summary.maxAbsDt) }} мс</span>
              <span class="metric-label">худшая нота</span>
            </div>
            <div class="metric">
              <span class="metric-value">{{ summary.driftPerOnset.toFixed(1) }} мс</span>
              <span class="metric-label">дрейф на ноту</span>
            </div>
            <div class="metric">
              <span class="metric-value">{{ summary.regions.length }}</span>
              <span class="metric-label">
                {{ plural(summary.regions.length, ['участок', 'участка', 'участков']) }} вне темпа
              </span>
            </div>
            <div class="metric">
              <span class="metric-value">{{ summary.stray.length }}</span>
              <span class="metric-label">
                {{ plural(summary.stray.length, ['одиночный промах', 'одиночных промаха', 'одиночных промахов']) }}
              </span>
            </div>
            <div class="metric">
              <span class="metric-value">{{ summary.missed.length }}</span>
              <span class="metric-label">не сыграно</span>
            </div>
          </div>

          <p class="analysis-legend">
            Пунктир — место ноты по партитуре, сплошная линия — где она сыграна, красная полоса —
            участок, где игра вышла из допуска {{ toleranceMs }} мс на две ноты и больше.
            Бледный пунктир — одиночные промахи.
          </p>

          <p v-if="!summary.regions.length && !summary.stray.length" class="analysis-empty">
            Отклонений больше {{ toleranceMs }} мс не найдено — темп держится.
          </p>

          <ul v-else class="regions">
            <li v-for="(region, index) in regionRows" :key="index">
              <button type="button" class="region" @click="focusRegion(region)">
                <span class="region-time">{{ formatTime(region.startMs) }}</span>
                <span class="region-place">{{ region.place }}</span>
                <span class="region-label">{{ region.direction }}</span>
                <span class="region-count">
                  {{ region.count }} {{ plural(region.count, ['нота', 'ноты', 'нот']) }}
                </span>
              </button>
            </li>
          </ul>
        </section>

      </template>

      <p v-if="error" class="error">{{ error }}</p>
    </ClientOnly>
  </div>
</template>

<style scoped>
.page {
  width: 100%;
  padding: 32px 24px;
}

.header {
  margin-bottom: 20px;
  max-width: 860px;
}

.title {
  margin: 0 0 6px;
  font-size: 26px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

.subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--muted-foreground);
}

.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 320px;
  padding: 40px 24px;
  border: 1.5px dashed var(--border);
  border-radius: 16px;
  background: var(--muted);
  text-align: center;
}

.drop--over {
  border-color: var(--accent);
}

.drop-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.drop-hint {
  margin: 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.drop-actions {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}

.hidden-input {
  display: none;
}

.button {
  font: inherit;
  font-size: 13px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 13px;
  cursor: pointer;
  touch-action: manipulation;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.button:hover:not(:disabled) {
  background: var(--muted);
}

.button:disabled {
  opacity: 0.5;
  cursor: default;
}

.button--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-foreground);
}

.button--ghost {
  border-color: transparent;
  color: var(--muted-foreground);
}

.button--record {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  border-color: #d9534f;
  color: #d9534f;
}

.button--stop {
  background: #d9534f;
  border-color: #d9534f;
  color: #fff;
}

.transport {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.transport-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.transport-row--second {
  gap: 8px 16px;
}

.time {
  display: flex;
  gap: 4px;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--muted-foreground);
}

.time-now {
  color: var(--foreground);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted-foreground);
}

.status--ok .status-dot {
  background: #38a169;
}

.status--hot .status-dot {
  background: #d69e2e;
}

.status--clip .status-dot {
  background: #d9534f;
}

.meter {
  width: 90px;
  height: 6px;
  border-radius: 3px;
  background: var(--muted);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.1s linear;
}

.device {
  font-size: 11px;
  color: var(--muted-foreground);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-meta {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  min-width: 0;
}

.file-name {
  font-size: 12px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.segmented {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  gap: 2px;
}

.segmented-item {
  font: inherit;
  font-size: 12px;
  color: var(--muted-foreground);
  background: transparent;
  border: 0;
  border-radius: 7px;
  padding: 6px 10px;
  cursor: pointer;
}

.segmented-item--active {
  background: var(--muted);
  color: var(--foreground);
}

.control {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.control--check {
  gap: 5px;
}

.control-label {
  white-space: nowrap;
}

.control-value {
  font-variant-numeric: tabular-nums;
  min-width: 54px;
  color: var(--foreground);
}

.range {
  width: 110px;
  accent-color: var(--accent);
}

.select {
  font: inherit;
  font-size: 12px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  max-width: 200px;
}

.analysis {
  margin-top: 16px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
}

.analysis-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.analysis-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.analysis-verdict {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 20px;
  background: var(--muted);
  color: var(--muted-foreground);
}

.analysis-verdict--rushing,
.analysis-verdict--dragging {
  background: rgba(220, 38, 38, 0.14);
  color: #d9534f;
}

.metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.metric-value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.metric-label {
  font-size: 11px;
  color: var(--muted-foreground);
}

.analysis-legend {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--muted-foreground);
}

.analysis-empty {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--muted-foreground);
}

.regions {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.region {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  font: inherit;
  font-size: 12px;
  text-align: left;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid #d9534f;
  border-radius: 8px;
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
}

.region:hover {
  background: var(--muted);
}

.region-time {
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
}

.region-place {
  color: var(--foreground);
}

.region-label {
  font-weight: 600;
  color: #d9534f;
}

.region-count {
  margin-left: auto;
  color: var(--muted-foreground);
}

.error {
  margin: 12px 0 0;
  font-size: 13px;
  color: #d9534f;
}

@media (max-width: 760px) {
  .page {
    padding: 20px 12px;
  }

  .button {
    min-height: 40px;
  }

  .file-meta {
    margin-left: 0;
  }

  .device {
    max-width: 120px;
  }
}
</style>
