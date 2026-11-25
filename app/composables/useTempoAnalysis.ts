/**
 * Tempo analysis for a recording played against a GTP score.
 *
 * Pure module on purpose: no Vue, no DOM, no browser types — the same code runs
 * in the container from `scripts/check-record.ts` and in the page.
 *
 * Pipeline: expected onsets (score) → detected onsets (take) → global offset →
 * order-preserving match → residual deviation per onset → error regions.
 *
 * The global offset matters: a take recorded through a microphone is a few tens
 * of milliseconds late as a whole. Without removing it every single note looks
 * like a mistake, so the offset is estimated first, reported separately
 * (`offsetMs`) and the page offers to shift the take by it.
 */

export interface TempEvent {
  track: number
  note: number
  start: number
  dur: number
}

export interface ExpectedOnset {
  /** Score time, ms. */
  ms: number
  /** Order inside the reference track, 0-based. */
  index: number
}

export interface MatchedOnset extends ExpectedOnset {
  /** Recorded onset converted to score time, ms. */
  detectedMs: number
  /** detectedMs − ms: absolute lateness, including the global offset. */
  dt: number
  /** dt − offsetMs: the mistake of this particular note. */
  residual: number
}

export interface MissedOnset extends ExpectedOnset {
  missed: true
}

export interface TempoRegion {
  /** Score time where the slip starts, ms. */
  startMs: number
  /** Score time where it ends. */
  endMs: number
  /** Mean residual inside the region, ms (positive = late). */
  avgDt: number
  /** Worst residual inside the region, ms. */
  worstDt: number
  /** Number of onsets in the region. */
  count: number
  fromIndex: number
  toIndex: number
  label: string
  /** Every slipping onset: where it should be and where it was actually played. */
  onsets: { ms: number; detectedMs: number; dt: number }[]
}

export interface TempoSummary {
  matched: MatchedOnset[]
  missed: MissedOnset[]
  /** Recorded onsets that matched nothing in the score. */
  extra: number[]
  regions: TempoRegion[]
  /** Notes outside the tolerance that did not become a whole region. */
  stray: MatchedOnset[]
  /** Every note outside the tolerance — early and late — for the graph marks. */
  errors: MatchedOnset[]
  /** Share of notes whose residual stays inside the tolerance. */
  hitRate: number
  meanAbsDt: number
  maxAbsDt: number
  /** Regression slope of the residual, ms of deviation per onset. */
  driftPerOnset: number
  /** Human answer for the drift. */
  verdict: 'even' | 'rushing' | 'dragging'
  /** Systematic lateness of the whole take, ms — «выровнять» uses it. */
  offsetMs: number
  /** How many onsets the reference track(s) contain. */
  expectedCount: number
  /** How many onsets the detector found in the take. */
  detectedCount: number
}

export interface DetectOptions {
  /** Amplitude below which nothing counts as an onset. */
  floor?: number
  /** How much the level must exceed the local median to fire. */
  factor?: number
  /** Minimum distance between two onsets, ms. */
  minGapMs?: number
  /** Bucket size of the level envelope, ms. */
  hopMs?: number
  /** Window used for both the level and the local median, ms. */
  windowMs?: number
}

/** Collapse near-simultaneous note starts (chords) into single onsets. */
export function clusterOnsets(times: number[], toleranceMs = 30): number[] {
  const sorted = [...times].sort((a, b) => a - b)
  const out: number[] = []
  for (const time of sorted) {
    const last = out[out.length - 1]
    if (last == null || time - last > toleranceMs) out.push(time)
  }
  return out
}

/** Score-side onsets of the selected tracks, in playback order. */
export function expectedOnsets(
  events: TempEvent[],
  tracks: number[],
  toleranceMs = 30,
): ExpectedOnset[] {
  const wanted = new Set(tracks)
  const times = events.filter((event) => wanted.has(event.track)).map((event) => event.start)
  return clusterOnsets(times, toleranceMs).map((ms, index) => ({ ms, index }))
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Onset detection on raw PCM: RMS envelope with an adaptive median threshold.
 * Returns onsets in milliseconds of the buffer.
 */
export function detectOnsets(
  samples: Float32Array,
  sampleRate: number,
  options: DetectOptions = {},
): number[] {
  const hopMs = options.hopMs ?? 5
  const windowMs = options.windowMs ?? 20
  const minGapMs = options.minGapMs ?? 60
  const floor = options.floor ?? 0.01
  const factor = options.factor ?? 2.5

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  const window = Math.max(1, Math.round((sampleRate * windowMs) / 1000))
  const frames = Math.floor(samples.length / hop)
  if (!frames) return []

  const envelope = new Float32Array(frames)
  let globalMax = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const center = frame * hop
    const from = Math.max(0, center - (window >> 1))
    const to = Math.min(samples.length, from + window)
    let sum = 0
    for (let i = from; i < to; i += 1) sum += samples[i]! * samples[i]!
    const rms = Math.sqrt(sum / Math.max(1, to - from))
    envelope[frame] = rms
    if (rms > globalMax) globalMax = rms
  }
  if (globalMax < floor) return []

  // Local baseline: median level of the previous 400 ms, so a steady note does
  // not keep retriggering and a quiet passage still fires.
  const baselineFrames = Math.max(4, Math.round(400 / hopMs))
  const lookback = Math.max(2, Math.round(40 / hopMs))
  const minGapFrames = Math.max(1, Math.round(minGapMs / hopMs))
  const onsets: number[] = []
  let lastOnsetFrame = -Infinity

  for (let frame = lookback; frame < frames; frame += 1) {
    const previous = frame - lookback
    const level = envelope[frame]!
    if (level <= envelope[previous]!) continue
    const history: number[] = []
    const from = Math.max(0, frame - baselineFrames)
    for (let i = from; i < previous; i += 1) history.push(envelope[i]!)
    const base = median(history)
    const threshold = Math.max(floor, base * factor, globalMax * 0.05)
    if (level < threshold) continue

    // Walk to the local maximum of this attack — that is the real hit.
    let peakFrame = frame
    const horizon = Math.min(frames - 1, frame + Math.round(40 / hopMs))
    while (peakFrame < horizon && envelope[peakFrame + 1]! >= envelope[peakFrame]!) peakFrame += 1
    if (peakFrame - lastOnsetFrame < minGapFrames) continue
    lastOnsetFrame = peakFrame
    onsets.push(peakFrame * hopMs)
  }

  return onsets
}

/**
 * Most likely constant lateness of the take: the offset the largest number of
 * (detected − expected) pairs agree on, within `toleranceMs`.
 */
export function estimateOffset(
  expected: number[],
  detected: number[],
  maxMs = 600,
  toleranceMs = 60,
): number {
  if (!expected.length || !detected.length) return 0
  const hist = new Map<number, number>()
  for (const e of expected) {
    for (const d of detected) {
      const diff = d - e
      if (Math.abs(diff) > maxMs) continue
      const key = Math.round(diff / 10) * 10
      hist.set(key, (hist.get(key) ?? 0) + 1)
    }
  }
  let best = 0
  let bestScore = -1
  for (const key of hist.keys()) {
    let score = 0
    for (const [other, count] of hist) {
      if (Math.abs(other - key) <= toleranceMs) score += count
    }
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }
  return best
}

/**
 * Order-preserving matching around the estimated offset, with a second pass for
 * notes that fall far outside the window, so a whole-beat slip shows up as a
 * mistake instead of vanishing into «не сыграно».
 */
export function matchOnsets(
  expected: ExpectedOnset[],
  detected: number[],
  // Narrow on purpose: on a dense grid a note played 200 ms late sits closer to
  // the *next* expected note than to its own, and a wide window pairs them
  // wrongly. Anything outside this window is handled by the ordered second pass.
  windowMs = 80,
): { matched: MatchedOnset[]; missed: MissedOnset[]; extra: number[]; offsetMs: number } {
  const offsetMs = estimateOffset(
    expected.map((item) => item.ms),
    detected,
  )
  const used = new Uint8Array(detected.length)
  const matched: MatchedOnset[] = []
  let cursor = 0
  let lastMatched = -Infinity

  const pair = (onset: ExpectedOnset, index: number) => {
    used[index] = 1
    lastMatched = detected[index]!
    matched.push({
      ...onset,
      detectedMs: detected[index]!,
      dt: detected[index]! - onset.ms,
      residual: detected[index]! - onset.ms - offsetMs,
    })
  }

  for (const onset of expected) {
    const target = onset.ms + offsetMs
    while (cursor < detected.length && detected[cursor]! < target - windowMs) cursor += 1
    let bestIndex = -1
    let bestDistance = Infinity
    for (let i = cursor; i < detected.length; i += 1) {
      const time = detected[i]!
      if (time > target + windowMs) break
      if (used[i] || time <= lastMatched) continue
      const distance = Math.abs(time - target)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }
    if (bestIndex >= 0) pair(onset, bestIndex)
  }

  const paired = new Set(matched.map((item) => item.ms))
  const leftoverExpected = expected.filter((item) => !paired.has(item.ms))
  const leftoverDetected: number[] = []
  for (let i = 0; i < detected.length; i += 1) if (!used[i]) leftoverDetected.push(i)

  if (leftoverExpected.length && leftoverDetected.length) {
    const limit = Math.max(windowMs * 3, 400)
    let detectedCursor = 0
    lastMatched = -Infinity
    for (const onset of leftoverExpected) {
      let bestIndex = -1
      let bestDistance = Infinity
      for (let k = detectedCursor; k < leftoverDetected.length; k += 1) {
        const index = leftoverDetected[k]!
        const time = detected[index]!
        if (time <= lastMatched) continue
        const distance = Math.abs(time - (onset.ms + offsetMs))
        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = k
        }
      }
      if (bestIndex < 0 || bestDistance > limit) continue
      const index = leftoverDetected[bestIndex]!
      pair(onset, index)
      detectedCursor = bestIndex + 1
    }
    matched.sort((a, b) => a.ms - b.ms)
  }

  const taken = new Set(matched.map((item) => item.ms))
  const missed: MissedOnset[] = expected
    .filter((item) => !taken.has(item.ms))
    .map((item) => ({ ...item, missed: true as const }))

  const extra: number[] = []
  for (let i = 0; i < detected.length; i += 1) if (!used[i]) extra.push(detected[i]!)

  return { matched, missed, extra, offsetMs }
}

/** Runs of onsets whose residual leaves the tolerance. */
export function tempoRegions(
  matched: MatchedOnset[],
  options: { thresholdMs?: number; minRun?: number; padMs?: number } = {},
): TempoRegion[] {
  const threshold = options.thresholdMs ?? 120
  const minRun = options.minRun ?? 2
  const padMs = options.padMs ?? 60
  const regions: TempoRegion[] = []

  let run: MatchedOnset[] = []
  const flush = () => {
    if (!run.length) return
    const severe = run.length === 1 && Math.abs(run[0]!.residual) > threshold * 2
    if (run.length >= minRun || severe) {
      const residuals = run.map((item) => item.residual)
      const avgDt = residuals.reduce((sum, value) => sum + value, 0) / residuals.length
      const worst = residuals.reduce((worst, value) => (Math.abs(value) > Math.abs(worst) ? value : worst), 0)
      const last = run[run.length - 1]!
      regions.push({
        startMs: Math.max(0, run[0]!.ms - padMs),
        endMs: last.ms + padMs,
        avgDt: Math.round(avgDt),
        worstDt: Math.round(worst),
        count: run.length,
        fromIndex: run[0]!.index,
        toIndex: last.index,
        label: `${worst > 0 ? '+' : ''}${Math.round(worst)} мс`,
        onsets: run.map((item) => ({ ms: item.ms, detectedMs: item.detectedMs, dt: item.dt })),
      })
    }
    run = []
  }

  for (const onset of matched) {
    if (Math.abs(onset.residual) > threshold) run.push(onset)
    else flush()
  }
  flush()

  return regions
}

/** Bar number and beat for a score position, from the ruler marks. */
export function barAt(
  ms: number,
  bars: { ms: number; index: number; numerator?: number }[],
): { bar: number; beat: number } | null {
  if (!bars.length) return null
  let found = -1
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i]!.ms <= ms) found = i
    else break
  }
  if (found < 0) return { bar: bars[0]!.index, beat: 1 }
  const current = bars[found]!
  const next = bars[found + 1]
  const numerator = current.numerator || 4
  // The last bar has no successor: its length comes from the previous bar.
  const span = next
    ? next.ms - current.ms
    : found > 0
      ? current.ms - bars[found - 1]!.ms
      : 0
  const beat = span > 0 ? Math.min(numerator, Math.floor(((ms - current.ms) / span) * numerator) + 1) : 1
  return { bar: current.index, beat }
}

/** Least-squares slope of the residual over the onset order + a plain verdict. */
export function tempoTrend(matched: MatchedOnset[]): { slope: number; verdict: TempoSummary['verdict'] } {
  if (matched.length < 4) return { slope: 0, verdict: 'even' }
  const n = matched.length
  const meanX = (n - 1) / 2
  const meanY = matched.reduce((sum, item) => sum + item.residual, 0) / n
  let num = 0
  let den = 0
  matched.forEach((item, index) => {
    num += (index - meanX) * (item.residual - meanY)
    den += (index - meanX) * (index - meanX)
  })
  const slope = den ? num / den : 0
  const verdict: TempoSummary['verdict'] = slope < -8 ? 'rushing' : slope > 8 ? 'dragging' : 'even'
  return { slope, verdict }
}

/** Median absolute lateness — the shift that straightens the whole take. */
export function alignmentOffset(matched: MatchedOnset[]): number {
  if (!matched.length) return 0
  return Math.round(median(matched.map((item) => item.dt)))
}

/** Full analysis entry point. `detected` are onsets already in score time. */
export function analyzeTempo(input: {
  events: TempEvent[]
  tracks: number[]
  /** Detected onsets already converted to score time, ms. */
  detected: number[]
  options?: {
    windowMs?: number
    thresholdMs?: number
    minRun?: number
    padMs?: number
    clusterMs?: number
  }
}): TempoSummary {
  const expected = expectedOnsets(input.events, input.tracks, input.options?.clusterMs ?? 30)
  const { matched, missed, extra, offsetMs } = matchOnsets(
    expected,
    input.detected,
    input.options?.windowMs ?? 80,
  )
  const regions = tempoRegions(matched, input.options)
  const threshold = input.options?.thresholdMs ?? 120
  const errors = matched.filter((onset) => Math.abs(onset.residual) > threshold)
  const inRegion = new Set(regions.flatMap((region) => region.onsets.map((onset) => onset.ms)))
  const stray = errors.filter((onset) => !inRegion.has(onset.ms))
  const absDts = errors.map((onset) => Math.abs(onset.residual))
  const { slope, verdict } = tempoTrend(matched)
  const hits = matched.filter((onset) => Math.abs(onset.residual) <= threshold).length

  return {
    matched,
    missed,
    extra,
    regions,
    stray,
    errors,
    hitRate: matched.length ? hits / matched.length : 0,
    meanAbsDt: absDts.length ? absDts.reduce((sum, value) => sum + value, 0) / absDts.length : 0,
    maxAbsDt: absDts.length ? Math.max(...absDts) : 0,
    driftPerOnset: slope,
    verdict,
    offsetMs,
    expectedCount: expected.length,
    detectedCount: input.detected.length,
  }
}
