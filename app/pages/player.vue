<script setup lang="ts">
import { EQ_FREQS, createTabSynth, timbreFor } from '~/composables/useTabSynth'

useHead({ title: 'Табы — music-tools' })

const base = useRuntimeConfig().app.baseURL

type Stave = 'tab' | 'score' | 'tabscore'
const staves: { id: Stave; label: string }[] = [
  { id: 'tab', label: 'Табы' },
  { id: 'score', label: 'Ноты' },
  { id: 'tabscore', label: 'Табы и ноты' },
]

const GM_NAMES = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone', 'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ', 'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass', 'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2', 'Choir Aahs', 'Voice Oohs',
  'Synth Voice', 'Orchestra Hit', 'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet', 'French Horn', 'Brass Section',
  'Synth Brass 1', 'Synth Brass 2', 'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax', 'Oboe', 'English Horn',
  'Bassoon', 'Clarinet', 'Piccolo', 'Flute', 'Recorder', 'Pan Flute', 'Blown Bottle', 'Shakuhachi',
  'Whistle', 'Ocarina', 'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)', 'Pad 5 (bowed)', 'Pad 6 (metallic)',
  'Pad 7 (halo)', 'Pad 8 (sweep)', 'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto', 'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock', 'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet', 'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot',
]

const viewport = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const api = shallowRef<any>(null)
const atRef = shallowRef<any>(null)
const synth = createTabSynth()

const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const fileName = ref('')
const scoreTitle = ref('')
const scoreArtist = ref('')

const speed = ref(1)
const metronome = ref(false)
const stave = ref<Stave>('tab')
const activeTrack = ref(0)
const mixerOpen = ref(false)
const cursorBox = ref<{ x: number; y: number; w: number; h: number } | null>(null)

const totalLabel = computed(() => formatTime(synth.duration.value))
const positionLabel = computed(() => formatTime(synth.position.value))
const progress = computed(() =>
  synth.duration.value ? (synth.position.value / synth.duration.value) * 100 : 0,
)

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function scoreResources() {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  const dark = document.documentElement.classList.contains('dark')
  return {
    mainGlyphColor: read('--foreground', dark ? '#ededed' : '#1a1a1a'),
    secondaryGlyphColor: read('--muted-foreground', dark ? '#a3a3a3' : '#666666'),
    staffLineColor: dark ? '#3d3d3d' : '#d4d4d4',
    barSeparatorColor: dark ? '#3d3d3d' : '#d4d4d4',
    scoreInfoColor: read('--foreground', dark ? '#ededed' : '#1a1a1a'),
  }
}

function staveToProfile(at: any, value: Stave) {
  switch (value) {
    case 'score':
      return at.StaveProfile.Score
    case 'tabscore':
      return at.StaveProfile.ScoreTab
    default:
      // Default = auto: tablature for strings, rhythm/slash for percussion.
      // A forced Tab profile renders nothing for drum staves.
      return at.StaveProfile.Default
  }
}

async function ensureApi() {
  if (api.value) return api.value
  const at: any = await import('@coderline/alphatab')
  atRef.value = at

  const instance = new at.AlphaTabApi(viewport.value, {
    core: {
      fontDirectory: `${base}font/`,
      includeNoteBounds: true,
      logLevel: 'warning',
    },
    // Rendering only: playback runs on our own engine (per-track EQ/volume).
    player: {
      playerMode: at.PlayerMode.Disabled,
      enablePlayer: false,
      enableCursor: false,
      enableUserInteraction: false,
    },
    display: {
      staveProfile: staveToProfile(at, stave.value),
      layoutMode: at.LayoutMode.Page,
      scale: 1,
      resources: scoreResources(),
    },
  })

  instance.scoreLoaded.on((score: any) => {
    loaded.value = true
    loading.value = false
    scoreTitle.value = score.title || fileName.value
    scoreArtist.value = score.artist || ''
    activeTrack.value = 0
    synth.loadScore(score)
    applyStave()
  })

  instance.renderFinished.on(() => updateCursor())

  instance.error.on((e: Error) => {
    loading.value = false
    error.value = e?.message || 'Не удалось прочитать файл'
  })

  api.value = instance
  return instance
}

const allowed = /\.(gp3|gp4|gp5|gpx|gp|musicxml|xml)$/i

async function loadBuffer(buffer: ArrayBuffer, name: string) {
  error.value = null
  loading.value = true
  loaded.value = false
  fileName.value = name
  try {
    const instance = await ensureApi()
    synth.stop()
    await instance.load(new Uint8Array(buffer))
  } catch (e: any) {
    loading.value = false
    error.value = e?.message || 'Не удалось открыть файл'
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
  loadBuffer(await file.arrayBuffer(), file.name)
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

function togglePlay() {
  if (!loaded.value) return
  if (synth.playing.value) synth.pause()
  else synth.play()
}

function stopPlayback() {
  synth.stop()
}

function toggleMetronome() {
  metronome.value = !metronome.value
  synth.setMetronome(metronome.value)
}

function toggleLoop() {
  synth.loop.value = !synth.loop.value
}

function seekAt(event: MouseEvent) {
  if (!loaded.value) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  synth.seek(ratio * synth.duration.value)
}

/**
 * View mode is applied per staff: forcing StaveProfile.Tab hides percussion
 * staves entirely, and StaveProfile.Default renders tabs + notation for
 * stringed instruments. Flags keep percussion visible while showing only
 * what the user asked for.
 */
function applyStave() {
  if (!api.value || !atRef.value) return
  const instance = api.value

  instance.settings.display.staveProfile = atRef.value.StaveProfile.Default
  for (const track of instance.score?.tracks || []) {
    const percussionTrack = !!track.isPercussion
    for (const staff of track.staves || []) {
      // Percussion staves have no tablature: forcing the flags turns them
      // into a meaningless 6-line tab full of zeros.
      if (percussionTrack || staff.isPercussion || !staff.isStringed) continue
      if (stave.value === 'tab') {
        staff.showTablature = true
        staff.showStandardNotation = false
      } else if (stave.value === 'score') {
        staff.showTablature = false
        staff.showStandardNotation = true
      } else {
        staff.showTablature = true
        staff.showStandardNotation = true
      }
    }
  }
  instance.updateSettings()
  instance.render()
}

function selectTrack() {
  if (!api.value) return
  const target = api.value.score?.tracks?.[activeTrack.value]
  if (target) api.value.renderTracks([target])
}

function updateCursor() {
  const instance = api.value
  if (!instance || !loaded.value) {
    cursorBox.value = null
    return
  }
  try {
    const indexes = instance.score?.tracks?.map((_t: any, i: number) => i) || [0]
    const { tick } = synth.trackAt(synth.position.value)
    const result = instance.tickCache?.findBeat(new Set(indexes), Math.max(0, tick))
    if (!result) {
      cursorBox.value = null
      return
    }
    const bounds = instance.boundsLookup?.findBeat(result.beat)
    if (!bounds) {
      cursorBox.value = null
      return
    }

    // Align to the actual note heads: beat bounds include the space before the
    // glyph, which made the cursor look shifted to the left of the notes.
    const heads = (bounds.notes || [])
      .map((noteBounds: any) => noteBounds.noteHeadBounds)
      .filter(Boolean)

    if (heads.length) {
      const left = Math.min(...heads.map((b: any) => b.x))
      const right = Math.max(...heads.map((b: any) => b.x + b.w))
      const top = Math.min(...heads.map((b: any) => b.y))
      const bottom = Math.max(...heads.map((b: any) => b.y + b.h))
      cursorBox.value = { x: left, y: top, w: Math.max(right - left, 6), h: Math.max(bottom - top, 12) }
      return
    }

    const box = bounds.visualBounds
    cursorBox.value = box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null
  } catch {
    cursorBox.value = null
  }
}

const cursorStyle = computed(() =>
  cursorBox.value
    ? {
        left: `${cursorBox.value.x}px`,
        top: `${cursorBox.value.y}px`,
        width: `${Math.max(cursorBox.value.w, 12)}px`,
        height: `${cursorBox.value.h}px`,
      }
    : {},
)

watch(() => synth.position.value, updateCursor)

watch(speed, (value) => {
  synth.setSpeed(value)
})

function applyTrack(index: number) {
  const state = synth.tracks.value[index]
  if (state) synth.applyTrackSettings(state)
}

function resetEq(index: number) {
  const state = synth.tracks.value[index]
  if (!state) return
  state.eq = EQ_FREQS.map(() => 0)
  synth.applyTrackSettings(state)
}

function timbreLabel(program: number) {
  return timbreFor(program)
}

function onKeydown(event: KeyboardEvent) {
  if (event.code === 'Space' && loaded.value) {
    const target = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return
    event.preventDefault()
    togglePlay()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  synth.destroy()
  api.value?.destroy?.()
})
</script>

<template>
  <div class="page">
    <header class="header">
      <div class="header-titles">
        <h1 class="title">Табы</h1>
        <p class="subtitle">
          Откройте файл Guitar Pro — табулатура отрисуется и зазвучит. Только просмотр и прослушивание, без редактирования.
        </p>
      </div>
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
        <p class="drop-title">{{ loading ? 'Читаю файл…' : 'Перетащите сюда файл' }}</p>
        <p class="drop-hint">.gp3 · .gp4 · .gp5 · .gpx · .gp · .musicxml — до 25 МБ, всё читается в браузере</p>
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

      <section v-if="loaded" class="transport">
        <div class="transport-row">
          <button type="button" class="button button--primary play" :aria-label="synth.playing.value ? 'Пауза' : 'Играть'" @click="togglePlay">
            {{ synth.playing.value ? '❚❚' : '▶' }}
          </button>
          <button type="button" class="button" aria-label="Стоп" @click="stopPlayback">■</button>

          <div class="time">
            <span class="time-now">{{ positionLabel }}</span>
            <span class="time-sep">/</span>
            <span class="time-total">{{ totalLabel }}</span>
          </div>

          <div class="seek" @click="seekAt">
            <div class="seek-fill" :style="{ width: `${progress}%` }" />
          </div>

          <label class="control">
            <span class="control-label">Темп</span>
            <input v-model.number="speed" class="range" type="range" min="0.5" max="1.5" step="0.05">
            <span class="control-value">{{ Math.round(speed * 100) }}%</span>
          </label>

          <button type="button" class="button" :class="{ 'button--on': metronome }" @click="toggleMetronome">
            Метроном
          </button>
          <button type="button" class="button" :class="{ 'button--on': synth.loop.value }" @click="toggleLoop">
            Цикл
          </button>
          <button type="button" class="button" @click="mixerOpen = true">
            Микшер
          </button>
        </div>

        <div class="transport-row transport-row--second">
          <div class="segmented" role="group" aria-label="Вид">
            <button
              v-for="option in staves"
              :key="option.id"
              type="button"
              class="segmented-item"
              :class="{ 'segmented-item--active': stave === option.id }"
              @click="stave = option.id; applyStave()"
            >
              {{ option.label }}
            </button>
          </div>

          <label v-if="synth.tracks.value.length > 1" class="control">
            <span class="control-label">Партия</span>
            <select v-model.number="activeTrack" class="select" @change="selectTrack">
              <option v-for="track in synth.tracks.value" :key="track.index" :value="track.index">
                {{ track.name }}
              </option>
            </select>
          </label>

          <div class="file-meta">
            <span class="file-name">{{ scoreTitle }}<template v-if="scoreArtist"> — {{ scoreArtist }}</template></span>
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
      </section>

      <div v-show="loaded" ref="scrollEl" class="score-wrap">
        <div ref="viewport" class="score">
          <div v-if="cursorBox" class="cursor" :style="cursorStyle" />
        </div>
      </div>

      <div v-if="mixerOpen" class="backdrop" @click.self="mixerOpen = false">
        <div class="modal" role="dialog" aria-label="Микшер">
          <header class="modal-head">
            <h2 class="modal-title">Микшер</h2>
            <button type="button" class="button button--ghost" @click="mixerOpen = false">Закрыть</button>
          </header>

          <div class="modal-body">
            <section v-for="(track, index) in synth.tracks.value" :key="track.index" class="mixer-track">
              <div class="mixer-head">
                <span class="mixer-name">{{ track.name }}</span>

                <button
                  type="button"
                  class="button"
                  :class="{ 'button--on': track.muted }"
                  @click="track.muted = !track.muted; applyTrack(index)"
                >
                  {{ track.muted ? 'Mute вкл' : 'Mute' }}
                </button>

                <label class="control">
                  <span class="control-label">Громкость</span>
                  <input
                    v-model.number="track.volume"
                    class="range"
                    type="range"
                    min="0"
                    max="1.2"
                    step="0.01"
                    @input="applyTrack(index)"
                  >
                  <span class="control-value">{{ Math.round(track.volume * 100) }}%</span>
                </label>

                <label v-if="!track.isPercussion" class="control">
                  <span class="control-label">Инструмент</span>
                  <select v-model.number="track.program" class="select select--wide" @change="applyTrack(index)">
                    <option v-for="(gm, program) in GM_NAMES" :key="program" :value="program">
                      {{ program }} · {{ gm }}
                    </option>
                  </select>
                  <span class="timbre">тембр: {{ timbreLabel(track.program) }}</span>
                </label>
                <span v-else class="timbre">ударные · GM drum map (банк синтезируется движком)</span>

                <button type="button" class="button button--ghost" @click="resetEq(index)">Сбросить EQ</button>
              </div>

              <div class="eq">
                <div v-for="(freq, band) in EQ_FREQS" :key="freq" class="eq-band">
                  <span class="eq-db">{{ track.eq[band] > 0 ? '+' : '' }}{{ track.eq[band] }}</span>
                  <input
                    v-model.number="track.eq[band]"
                    class="eq-slider"
                    type="range"
                    min="-12"
                    max="12"
                    step="1"
                    @input="applyTrack(index)"
                  >
                  <span class="eq-freq">{{ freq >= 1000 ? `${freq / 1000}k` : freq }}</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

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
  margin-bottom: 24px;
}

.header-titles {
  max-width: 760px;
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
  transition: border-color 0.15s, background 0.15s;
}

.drop--over {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--background));
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

.button--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 85%, var(--foreground));
}

.button--on {
  border-color: var(--accent);
  color: var(--accent);
}

.button--ghost {
  border-color: transparent;
  color: var(--muted-foreground);
}

.play {
  min-width: 44px;
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
  gap: 10px 16px;
}

.time {
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--muted-foreground);
  display: flex;
  gap: 4px;
}

.time-now {
  color: var(--foreground);
}

.seek {
  position: relative;
  flex: 1 1 180px;
  min-width: 140px;
  height: 6px;
  border-radius: 3px;
  background: var(--muted);
  cursor: pointer;
}

.seek-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
}

.control {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.control-label {
  white-space: nowrap;
}

.control-value {
  font-variant-numeric: tabular-nums;
  min-width: 38px;
  color: var(--foreground);
}

.select {
  font: inherit;
  font-size: 12px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  max-width: 220px;
}

.select--wide {
  max-width: 260px;
}

.range {
  width: 100px;
  accent-color: var(--accent);
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
  transition: background 0.15s, color 0.15s;
}

.segmented-item:hover {
  color: var(--foreground);
}

.segmented-item--active {
  background: var(--muted);
  color: var(--foreground);
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
  max-width: 340px;
}

.score-wrap {
  max-height: calc(100vh - var(--app-bar-h) - 190px);
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--background);
}

.score {
  position: relative;
  min-height: 300px;
  padding: 0;
}

.cursor {
  position: absolute;
  z-index: 10;
  pointer-events: none;
  border: 2px solid var(--accent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 55%, transparent);
  transition: left 0.08s linear, top 0.08s linear, width 0.08s linear;
}

.cursor::before {
  content: '';
  position: absolute;
  left: 50%;
  top: -6px;
  width: 6px;
  height: 6px;
  transform: translateX(-50%) rotate(45deg);
  background: var(--accent);
  border-radius: 1px;
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}

.modal {
  width: min(880px, 100%);
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.modal-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.modal-body {
  overflow: auto;
  padding: 14px 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.mixer-track {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
}

.mixer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  margin-bottom: 12px;
}

.mixer-name {
  font-size: 13px;
  font-weight: 600;
  margin-right: 4px;
}

.timbre {
  font-size: 11px;
  color: var(--muted-foreground);
}

.eq {
  display: flex;
  justify-content: space-between;
  gap: 4px;
}

.eq-band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 1 1 0;
}

.eq-db {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
}

.eq-freq {
  font-size: 10px;
  color: var(--muted-foreground);
}

.eq-slider {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 22px;
  height: 110px;
  accent-color: var(--accent);
}

.error {
  margin: 12px 0 0;
  font-size: 13px;
  color: #d9534f;
}

@media (max-width: 720px) {
  .page {
    padding: 20px 12px;
  }

  .file-meta {
    margin-left: 0;
  }

  .file-name {
    max-width: 180px;
  }

  .eq-slider {
    height: 80px;
  }
}
</style>
