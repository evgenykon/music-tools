<script setup lang="ts">
/**
 * One canvas for the whole studio timeline: ruler, one lane per track, the
 * recorded take and the tempo-error regions.
 *
 * There is a single horizontal scroller, so every lane and the waveform always
 * stay in sync. Lanes never scroll vertically: the page scrolls.
 */
import type { Peaks } from '~/composables/useWaveform'
import type { TempoRegion } from '~/composables/useTempoAnalysis'

const props = defineProps<{
  events: { track: number; note: number; start: number; dur: number; drum?: boolean }[]
  tracks: { index: number; name: string; muted: boolean; hidden: boolean; isPercussion: boolean }[]
  bars: { ms: number; index: number }[]
  scoreDuration: number
  peaks: Peaks | null
  recordStartMs: number
  shiftMs: number
  regions: TempoRegion[]
  errors: { ms: number; detectedMs: number; dt: number; residual?: number }[]
  missed: number[]
  playheadMs: number
  follow: boolean
}>()

const pxPerMs = defineModel<number>('pxPerMs', { required: true })

const emit = defineEmits<{
  (event: 'seek', ms: number): void
  (event: 'toggle-hidden', index: number): void
  (event: 'toggle-mute', index: number): void
}>()

const RULER_H = 22
const LANE_H = 44
const WAVE_H = 84
const GAP = 4

const scrollEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const viewWidth = ref(600)

const laneRows = computed(() => props.tracks)
const totalHeight = computed(() => RULER_H + laneRows.value.length * LANE_H + GAP + WAVE_H)

/** Recording occupies score time [start, …]; it usually starts before t=0. */
const recordStartScore = computed(() => -(props.recordStartMs + props.shiftMs))
const recordEndScore = computed(() => recordStartScore.value + (props.peaks?.durationMs ?? 0))

const viewStart = computed(() => Math.min(0, recordStartScore.value))
const viewEnd = computed(() => Math.max(props.scoreDuration, recordEndScore.value, 1000) + 400)
const contentWidth = computed(() => Math.max(200, (viewEnd.value - viewStart.value) * pxPerMs.value))

const noteRange = computed(() => {
  const ranges = new Map<number, { min: number; max: number }>()
  for (const event of props.events) {
    if (event.drum) continue
    const range = ranges.get(event.track)
    if (!range) ranges.set(event.track, { min: event.note, max: event.note })
    else {
      if (event.note < range.min) range.min = event.note
      if (event.note > range.max) range.max = event.note
    }
  }
  return ranges
})

function readColors() {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const dark = document.documentElement.classList.contains('dark')
  return {
    background: read('--background', dark ? '#0a0a0a' : '#ffffff'),
    foreground: read('--foreground', dark ? '#ededed' : '#1a1a1a'),
    muted: read('--muted', dark ? '#262626' : '#f2f2f2'),
    mutedForeground: read('--muted-foreground', dark ? '#a3a3a3' : '#666666'),
    border: read('--border', dark ? '#333333' : '#dddddd'),
    accent: read('--accent', dark ? '#7aa2f7' : '#2563eb'),
  }
}

function drawLane(
  ctx: CanvasRenderingContext2D,
  track: { index: number; hidden: boolean },
  top: number,
  timeFrom: number,
  timeTo: number,
  colors: ReturnType<typeof readColors>,
) {
  const xs = (ms: number) => (ms - timeFrom) * pxPerMs.value
  if (track.hidden) return

  // lane background + bottom border
  ctx.fillStyle = colors.background
  ctx.fillRect(0, top, viewWidth.value, LANE_H)
  ctx.strokeStyle = colors.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, top + LANE_H - 0.5)
  ctx.lineTo(viewWidth.value, top + LANE_H - 0.5)
  ctx.stroke()

  const range = noteRange.value.get(track.index)
  const min = range?.min ?? 60
  const max = range?.max ?? 72
  const span = Math.max(1, max - min)

  for (const event of props.events) {
    if (event.track !== track.index) continue
    if (event.start + event.dur < timeFrom || event.start > timeTo) continue
    const x = xs(event.start)
    // Drum hits are points in time, not sustained notes: a fixed tick per hit
    // reads as a rhythm instead of a solid line at slow zoom.
    const width = event.drum ? 3 : Math.max(2, event.dur * pxPerMs.value)
    let y: number
    let height: number
    if (event.drum) {
      y = top + LANE_H - 9
      height = 4
    } else {
      const ratio = (max - event.note) / span
      y = top + 6 + ratio * (LANE_H - 16)
      height = 4
    }
    const alpha = props.tracks.find((item) => item.index === track.index)?.muted ? 0.3 : 0.9
    ctx.globalAlpha = alpha
    ctx.fillStyle = colors.accent
    ctx.fillRect(x, y, width, height)
    ctx.globalAlpha = 1
  }
}

function draw() {
  const canvas = canvasEl.value
  const scroll = scrollEl.value
  if (!canvas || !scroll) return

  const dpr = window.devicePixelRatio || 1
  const width = Math.max(120, Math.round(viewWidth.value))
  const height = totalHeight.value
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const colors = readColors()

  const timeFrom = viewStart.value + scroll.scrollLeft / pxPerMs.value
  const timeTo = timeFrom + width / pxPerMs.value
  const xs = (ms: number) => (ms - timeFrom) * pxPerMs.value

  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, width, height)

  // count-in: the part of the take recorded before the score starts
  const countFrom = recordStartScore.value
  const countTo = recordStartScore.value + props.recordStartMs
  if (props.recordStartMs > 0) {
    ctx.fillStyle = colors.muted
    ctx.fillRect(xs(countFrom), RULER_H, Math.max(0, xs(countTo) - xs(countFrom)), height - RULER_H)
  }

  // bar grid + numbers
  ctx.strokeStyle = colors.border
  ctx.fillStyle = colors.mutedForeground
  ctx.font = '10px ui-sans-serif, system-ui'
  ctx.textBaseline = 'middle'
  let previousLabelX = -Infinity
  for (const bar of props.bars) {
    const x = xs(bar.ms)
    if (x < -40 || x > width + 40) continue
    ctx.globalAlpha = 0.65
    ctx.beginPath()
    ctx.moveTo(Math.round(x) + 0.5, RULER_H)
    ctx.lineTo(Math.round(x) + 0.5, height - WAVE_H - GAP)
    ctx.stroke()
    ctx.globalAlpha = 1
    if (x - previousLabelX > 22) {
      ctx.fillText(String(bar.index), Math.round(x) + 3, RULER_H / 2)
      previousLabelX = x
    }
  }
  ctx.strokeStyle = colors.border
  ctx.beginPath()
  ctx.moveTo(0, RULER_H - 0.5)
  ctx.lineTo(width, RULER_H - 0.5)
  ctx.stroke()

  // note lanes
  let top = RULER_H
  for (const track of laneRows.value) {
    drawLane(ctx, track, top, timeFrom, timeTo, colors)
    top += LANE_H
  }

  // waveform
  const waveTop = top + GAP
  ctx.strokeStyle = colors.border
  ctx.beginPath()
  ctx.moveTo(0, waveTop - 0.5)
  ctx.lineTo(width, waveTop - 0.5)
  ctx.stroke()

  const peaks = props.peaks
  if (peaks) {
    const middle = waveTop + WAVE_H / 2
    const amplitude = (WAVE_H / 2) * 0.92
    ctx.strokeStyle = colors.accent
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    for (let px = 0; px < width; px += 1) {
      const fromMs = timeFrom + px / pxPerMs.value
      const toMs = fromMs + 1 / pxPerMs.value
      const bucketFrom = Math.floor((fromMs - recordStartScore.value) / peaks.hopMs)
      const bucketTo = Math.ceil((toMs - recordStartScore.value) / peaks.hopMs)
      if (bucketTo < 0 || bucketFrom >= peaks.min.length) continue
      let lo = 0
      let hi = 0
      for (let bucket = Math.max(0, bucketFrom); bucket < Math.min(peaks.min.length, bucketTo + 1); bucket += 1) {
        if (peaks.min[bucket]! < lo) lo = peaks.min[bucket]!
        if (peaks.max[bucket]! > hi) hi = peaks.max[bucket]!
      }
      if (!lo && !hi) continue
      const x = px + 0.5
      ctx.moveTo(x, middle - hi * amplitude)
      ctx.lineTo(x, middle - lo * amplitude)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // Out-of-tempo bands, tinted by direction (late = red, early = blue).
  for (const region of props.regions) {
    const from = Math.max(xs(region.startMs), 0)
    const to = Math.min(xs(region.endMs), width)
    if (to <= 0 || from >= width) continue
    const late = region.avgDt > 0
    ctx.fillStyle = late ? 'rgba(220, 38, 38, 0.13)' : 'rgba(37, 99, 235, 0.13)'
    ctx.fillRect(from, RULER_H, Math.max(2, to - from), height - RULER_H)
    ctx.fillStyle = late ? 'rgba(220, 38, 38, 0.95)' : 'rgba(37, 99, 235, 0.95)'
    ctx.font = '10px ui-sans-serif, system-ui'
    ctx.fillText(region.label, from + 3, waveTop - 6)
  }

  // Every note outside the tolerance gets its own mark: a dashed line where the
  // score puts it, an arrow where it was played, and a connector between them.
  const markColor = (dt: number, strong: boolean) => {
    if (dt > 0) return strong ? 'rgba(220, 38, 38, 0.95)' : 'rgba(248, 113, 113, 0.95)'
    return strong ? 'rgba(37, 99, 235, 0.95)' : 'rgba(96, 165, 250, 0.95)'
  }
  const showAmounts = pxPerMs.value > 0.1

  for (const error of props.errors) {
    // residual is the mistake after the whole-take offset is removed
    const deviation = error.residual ?? error.dt
    const expectedX = Math.round(xs(error.ms)) + 0.5
    const playedX = Math.round(xs(error.detectedMs)) + 0.5
    if (expectedX > -4 && expectedX < width + 4) {
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = markColor(deviation, false)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(expectedX, RULER_H)
      ctx.lineTo(expectedX, height)
      ctx.stroke()
      ctx.restore()
    }
    if (playedX > -4 && playedX < width + 4) {
      ctx.strokeStyle = markColor(deviation, true)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(playedX, RULER_H)
      ctx.lineTo(playedX, height - 10)
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.fillStyle = markColor(deviation, true)
      ctx.beginPath()
      ctx.moveTo(playedX - 3.5, height - 10)
      ctx.lineTo(playedX + 3.5, height - 10)
      ctx.lineTo(playedX, height - 3)
      ctx.closePath()
      ctx.fill()
      if (showAmounts) {
        ctx.font = '9px ui-sans-serif, system-ui'
        ctx.fillText(`${deviation > 0 ? '+' : ''}${Math.round(deviation)}`, playedX + 4, RULER_H + 9)
      }
    }
    if (Math.abs(playedX - expectedX) > 3) {
      const left = Math.min(expectedX, playedX)
      const right = Math.max(expectedX, playedX)
      ctx.strokeStyle = markColor(deviation, false)
      ctx.globalAlpha = 0.45
      ctx.beginPath()
      ctx.moveTo(left, waveTop - 12)
      ctx.lineTo(right, waveTop - 12)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  // Notes the player never played: violet cross where they belong.
  for (const ms of props.missed) {
    const expectedX = Math.round(xs(ms)) + 0.5
    if (expectedX < -4 || expectedX > width + 4) continue
    ctx.save()
    ctx.setLineDash([2, 5])
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.9)'
    ctx.beginPath()
    ctx.moveTo(expectedX, RULER_H)
    ctx.lineTo(expectedX, height)
    ctx.stroke()
    ctx.restore()
    ctx.strokeStyle = 'rgba(124, 58, 237, 0.95)'
    ctx.beginPath()
    ctx.moveTo(expectedX - 3, waveTop + 4)
    ctx.lineTo(expectedX + 3, waveTop + 10)
    ctx.moveTo(expectedX + 3, waveTop + 4)
    ctx.lineTo(expectedX - 3, waveTop + 10)
    ctx.stroke()
  }

  // playhead
  const headX = xs(props.playheadMs)
  if (headX >= -2 && headX <= width + 2) {
    ctx.strokeStyle = colors.foreground
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(Math.round(headX) + 0.5, 0)
    ctx.lineTo(Math.round(headX) + 0.5, height)
    ctx.stroke()
    ctx.lineWidth = 1
  }
}

let frame = 0
function scheduleDraw() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

function onScroll() {
  scheduleDraw()
}

const MIN_PX = 0.008
const MAX_PX = 0.6

/** Zoom keeping the time under the pointer (or the centre) in place. */
function zoomAround(factor: number, anchorClientX?: number) {
  const scroll = scrollEl.value
  if (!scroll) return
  const next = Math.min(MAX_PX, Math.max(MIN_PX, pxPerMs.value * factor))
  if (Math.abs(next - pxPerMs.value) < 1e-9) return
  const anchorOffset = anchorClientX == null
    ? scroll.clientWidth / 2
    : anchorClientX - scroll.getBoundingClientRect().left
  const anchorTime = viewStart.value + (scroll.scrollLeft + anchorOffset) / pxPerMs.value
  pxPerMs.value = Math.round(next * 10000) / 10000
  nextTick(() => {
    const element = scrollEl.value
    if (!element) return
    element.scrollLeft = Math.max(0, (anchorTime - viewStart.value) * pxPerMs.value - anchorOffset)
    scheduleDraw()
  })
}

/** Ctrl/⌘ + колесо — зум вокруг курсора, обычное колесо — обычный скролл. */
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  zoomAround(event.deltaY < 0 ? 1.18 : 1 / 1.18, event.clientX)
}

function msFromEvent(event: MouseEvent | PointerEvent) {
  const scroll = scrollEl.value
  if (!scroll) return 0
  const rect = scroll.getBoundingClientRect()
  const x = event.clientX - rect.left + scroll.scrollLeft
  return viewStart.value + x / pxPerMs.value
}

let scrubbing = false

function onPointerDown(event: PointerEvent) {
  if ((event.target as HTMLElement)?.closest('.labels')) return
  scrubbing = true
  emit('seek', msFromEvent(event))
}

function onPointerMove(event: PointerEvent) {
  if (!scrubbing) return
  emit('seek', msFromEvent(event))
}

function onPointerUp() {
  scrubbing = false
}

// keep the playhead visible while playing
watch(
  () => props.playheadMs,
  (ms) => {
    scheduleDraw()
    const scroll = scrollEl.value
    if (!scroll || !props.follow) return
    const x = (ms - viewStart.value) * pxPerMs.value
    const right = scroll.scrollLeft + scroll.clientWidth
    if (x > right - 80) scroll.scrollLeft = x - scroll.clientWidth * 0.35
    else if (x < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, x - 80)
  },
)

watch(
  () => [pxPerMs.value, props.peaks, props.regions, props.errors, props.missed, props.tracks, props.shiftMs, props.bars],
  () => scheduleDraw(),
  { deep: true },
)

let observer: ResizeObserver | null = null

onMounted(() => {
  const scroller = scrollEl.value
  if (scroller) viewWidth.value = scroller.clientWidth
  observer = new ResizeObserver(() => {
    if (scrollEl.value) viewWidth.value = scrollEl.value.clientWidth
    scheduleDraw()
  })
  if (scroller) observer.observe(scroller)
  scroller?.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('pointerup', onPointerUp)
  scheduleDraw()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  scrollEl.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('pointerup', onPointerUp)
  if (frame) cancelAnimationFrame(frame)
})

defineExpose({ redraw: scheduleDraw, zoomAround })
</script>

<template>
  <div class="studio">
    <div class="labels">
      <div class="labels-ruler">Такты</div>
      <div v-for="track in laneRows" :key="track.index" class="label-row">
        <span class="label-name" :class="{ 'label-name--off': track.hidden }" :title="track.name">
          {{ track.name }}
        </span>
        <div class="label-actions">
          <button
            type="button"
            class="mini"
            :class="{ 'mini--on': !track.hidden }"
            :aria-label="track.hidden ? 'Показать дорожку' : 'Скрыть дорожку'"
            @click="emit('toggle-hidden', track.index)"
          >
            {{ track.hidden ? '—' : '👁' }}
          </button>
          <button
            type="button"
            class="mini"
            :class="{ 'mini--muted': track.muted }"
            aria-label="Заглушить дорожку"
            @click="emit('toggle-mute', track.index)"
          >
            M
          </button>
        </div>
      </div>
      <div class="label-wave">Запись</div>
    </div>

    <div ref="scrollEl" class="scroll" @scroll="onScroll" @pointerdown="onPointerDown" @pointermove="onPointerMove">
      <div class="content" :style="{ width: `${contentWidth}px`, height: `${totalHeight}px` }">
        <canvas
          ref="canvasEl"
          class="canvas"
          :style="{ height: `${totalHeight}px`, width: `${viewWidth}px` }"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.studio {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--background);
}

.labels {
  flex: 0 0 132px;
  border-right: 1px solid var(--border);
  background: var(--muted);
  /* keeps the column in place while the canvas scrolls */
  z-index: 1;
}

.labels-ruler {
  height: 22px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted-foreground);
  border-bottom: 1px solid var(--border);
}

.label-row {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
}

.label-name {
  font-size: 11px;
  line-height: 1.15;
  color: var(--foreground);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.label-name--off {
  color: var(--muted-foreground);
  text-decoration: line-through;
}

.label-actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mini {
  font: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--background);
  color: var(--muted-foreground);
  cursor: pointer;
}

.mini--on {
  color: var(--foreground);
}

.mini--muted {
  color: #d9534f;
  border-color: #d9534f;
}

.label-wave {
  height: 84px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--foreground);
  border-top: 4px solid transparent;
}

.scroll {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  cursor: crosshair;
  touch-action: pan-x;
}

.content {
  position: relative;
}

.canvas {
  position: sticky;
  left: 0;
  display: block;
  width: 100%;
}
</style>
