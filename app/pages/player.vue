<script setup lang="ts">
useHead({ title: 'Табы — music-tools' })

const base = useRuntimeConfig().app.baseURL

type Stave = 'tab' | 'score' | 'tabscore'
const staves: { id: Stave; label: string }[] = [
  { id: 'tab', label: 'Табы' },
  { id: 'score', label: 'Ноты' },
  { id: 'tabscore', label: 'Табы и ноты' },
]

const viewport = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const api = shallowRef<any>(null)
const atRef = shallowRef<any>(null)
const ready = ref(false)
const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const fileName = ref('')
const scoreTitle = ref('')
const scoreArtist = ref('')

const playing = ref(false)
const currentTime = ref(0)
const endTime = ref(0)
const speed = ref(1)
const metronome = ref(false)
const looping = ref(false)
const stave = ref<Stave>('tab')

const tracks = ref<{ index: number; name: string; muted: boolean }[]>([])
const activeTrack = ref(0)

const totalLabel = computed(() => formatTime(endTime.value))
const positionLabel = computed(() => formatTime(currentTime.value))

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** alphaTab draws with its own palette: feed it the CSS variables of the current theme. */
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

async function ensureApi() {
  if (api.value) return api.value
  const at: any = await import('@coderline/alphatab')
  atRef.value = at
  const instance = new at.AlphaTabApi(viewport.value, {
    core: {
      // Bravura and SONiVOX are copied to the build root by @coderline/alphatab-vite
      fontDirectory: `${base}font/`,
      logLevel: 'warning',
    },
    player: {
      playerMode: at.PlayerMode.EnabledSynthesizer,
      outputMode: at.PlayerOutputMode.WebAudioScriptProcessor,
      soundFont: `${base}soundfont/sonivox.sf2`,
      scrollElement: scrollEl.value || 'html,body',
      enableCursor: true,
      enableUserInteraction: true,
      scrollMode: at.ScrollMode.Continuous,
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
    tracks.value = (score.tracks || []).map((t: any, index: number) => ({
      index,
      name: t.name || `Дорожка ${index + 1}`,
      muted: !!t.isMute,
    }))
    activeTrack.value = 0
    endTime.value = instance.endTime || 0
  })

  instance.playerStateChanged.on((args: any) => {
    // PlayerState is not part of the public exports: Paused = 0, Playing = 1
    playing.value = args.state === 1
  })

  instance.playerPositionChanged.on((args: any) => {
    currentTime.value = args.currentTime
    endTime.value = args.endTime
  })

  instance.playerReady.on(() => {
    if (instance.endTime) endTime.value = instance.endTime
  })

  instance.error.on((e: Error) => {
    loading.value = false
    error.value = e?.message || 'Не удалось прочитать файл'
  })

  api.value = instance
  ready.value = true
  return instance
}

function staveToProfile(at: any, value: Stave) {
  switch (value) {
    case 'score':
      return at.StaveProfile.Score
    case 'tabscore':
      return at.StaveProfile.ScoreTab
    default:
      return at.StaveProfile.Tab
  }
}

const allowed = /\.(gp3|gp4|gp5|gpx|gp|musicxml|xml)$/i

async function loadBuffer(buffer: ArrayBuffer, name: string) {
  error.value = null
  loading.value = true
  loaded.value = false
  fileName.value = name
  try {
    const instance = await ensureApi()
    instance.stop()
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
  if (!ready.value || !loaded.value) return
  api.value.playPause()
}

function stopPlayback() {
  api.value?.stop()
}

function toggleMetronome() {
  metronome.value = !metronome.value
  if (api.value) api.value.metronomeVolume = metronome.value ? 0.7 : 0
}

function toggleLoop() {
  looping.value = !looping.value
  if (api.value) api.value.isLooping = looping.value
}

function applyStave() {
  if (!api.value || !atRef.value) return
  const instance = api.value
  instance.settings.display.staveProfile = staveToProfile(atRef.value, stave.value)
  instance.updateSettings()
  instance.render()
}

/** Show only the chosen part on the staves. */
function selectTrack() {
  if (!api.value) return
  const target = api.value.score?.tracks?.[activeTrack.value]
  if (target) api.value.renderTracks([target])
}

function toggleTrack(track: { index: number; name: string; muted: boolean }) {
  if (!api.value) return
  track.muted = !track.muted
  const target = api.value.score?.tracks?.[track.index]
  if (target) api.value.changeTrackMute([target], track.muted)
}

function seekAt(event: MouseEvent) {
  if (!api.value || !loaded.value) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  api.value.timePosition = Math.round(ratio * endTime.value)
}

watch(speed, (value) => {
  if (api.value) api.value.playbackSpeed = value
})

function onKeydown(event: KeyboardEvent) {
  if (event.code === 'Space' && loaded.value) {
    const target = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA'].includes(target?.tagName)) return
    event.preventDefault()
    togglePlay()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
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
            <button type="button" class="button button--primary play" :aria-label="playing ? 'Пауза' : 'Играть'" @click="togglePlay">
              {{ playing ? '❚❚' : '▶' }}
            </button>
            <button type="button" class="button" aria-label="Стоп" @click="stopPlayback">■</button>

            <div class="time">
              <span class="time-now">{{ positionLabel }}</span>
              <span class="time-sep">/</span>
              <span class="time-total">{{ totalLabel }}</span>
            </div>

            <div class="seek" @click="seekAt">
              <div class="seek-fill" :style="{ width: endTime ? `${(currentTime / endTime) * 100}%` : '0%' }" />
            </div>

            <label class="control">
              <span class="control-label">Темп</span>
              <input v-model.number="speed" class="range" type="range" min="0.5" max="1.5" step="0.05">
              <span class="control-value">{{ Math.round(speed * 100) }}%</span>
            </label>

            <button type="button" class="button" :class="{ 'button--on': metronome }" @click="toggleMetronome">
              Метроном
            </button>
            <button type="button" class="button" :class="{ 'button--on': looping }" @click="toggleLoop">
              Цикл
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

            <label v-if="tracks.length > 1" class="control">
              <span class="control-label">Партия</span>
              <select v-model.number="activeTrack" class="select" @change="selectTrack">
                <option v-for="track in tracks" :key="track.index" :value="track.index">
                  {{ track.name }}
                </option>
              </select>
            </label>

            <div v-if="tracks.length > 1" class="tracks">
              <button
                v-for="track in tracks"
                :key="track.index"
                type="button"
                class="track-chip"
                :class="{ 'track-chip--muted': track.muted }"
                :title="`Заглушить/включить: ${track.name}`"
                @click="toggleTrack(track)"
              >
                {{ track.name }}
              </button>
            </div>

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
        <div ref="viewport" class="score" />
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

.tracks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.track-chip {
  font: inherit;
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
}

.track-chip--muted {
  color: var(--muted-foreground);
  text-decoration: line-through;
  background: var(--muted);
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
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--background);
}

.score {
  min-height: 300px;
  padding: 8px;
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
}
</style>
