/**
 * Microphone/instrument capture for the record page.
 *
 * Chain: MediaStreamSource → highpass(80 Hz) → gain → AudioWorklet → gain(0) → destination.
 * The monitor is never connected to the speakers (only through a zero gain), so
 * there is no acoustic feedback; echo cancellation, noise suppression and auto
 * gain are switched off because their pumping is what sounds like "фон".
 *
 * All timing lives on the shared AudioContext, which lets the page start a
 * recorded take and GTP playback on the same `currentTime` sample.
 */

import { computePeaks, concatBlocks, type Peaks } from './useWaveform'

export type RecorderStatus = 'idle' | 'requesting' | 'countIn' | 'recording' | 'ready' | 'error'

export interface RecorderOptions {
  /** Shared audio context (the synth owns it) — required for sample-accurate sync. */
  getContext: () => AudioContext | null
  /** Asset base URL (GitHub Pages sub-path). */
  base?: string
}

const BLOCK_SAMPLES = 2048

export function createRecorder(options: RecorderOptions) {
  const status = ref<RecorderStatus>('idle')
  const error = ref<string | null>(null)
  const level = ref(0)
  const clipping = ref(0)
  const deviceLabel = ref('')
  const sampleRate = ref(48000)

  /** Full take, mono. */
  const samples = shallowRef<Float32Array | null>(null)
  /** Peaks of the full take (filled on stop). */
  const peaks = shallowRef<Peaks | null>(null)
  /** Growing peaks while recording, so the lane draws itself live. */
  const livePeaks = shallowRef<Peaks | null>(null)
  /** Buffer position (ms) where the score starts. */
  const recordStartMs = ref(0)
  /** Length of the finished take, ms. */
  const durationMs = ref(0)

  let stream: MediaStream | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let highpass: BiquadFilterNode | null = null
  let inputGain: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let worklet: AudioWorkletNode | null = null
  let fallback: ScriptProcessorNode | null = null
  let silent: GainNode | null = null

  let blocks: Float32Array[] = []
  let capturedSamples = 0
  let liveMin: number[] = []
  let liveMax: number[] = []
  let liveFlushed = 0
  let liveTimer = 0
  let levelTimer = 0

  /** Context time when the first sample was captured. */
  let captureStartCtx = 0
  /** Context time of the score's t=0. */
  let zeroCtx = 0
  let countInMs = 0

  let playbackSource: AudioBufferSourceNode | null = null
  let buffer: AudioBuffer | null = null

  function clearTake() {
    blocks = []
    capturedSamples = 0
    liveMin = []
    liveMax = []
    liveFlushed = 0
    samples.value = null
    peaks.value = null
    livePeaks.value = null
    buffer = null
    durationMs.value = 0
    clipping.value = 0
    level.value = 0
    status.value = 'idle'
    error.value = null
  }

  async function openStream() {
    if (stream) return
    status.value = 'requesting'
    const media = navigator.mediaDevices
    if (!media?.getUserMedia) {
      throw new Error('Браузер не даёт доступ к микрофону на этом адресе')
    }
    stream = await media.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      },
    })
    const track = stream.getAudioTracks()[0]
    deviceLabel.value = track?.label || 'Микрофон'
    const settings: any = track?.getSettings?.() ?? {}
    if (settings.sampleRate) sampleRate.value = settings.sampleRate
  }

  function buildGraph(ctx: AudioContext) {
    if (!stream) return
    source = ctx.createMediaStreamSource(stream)
    highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 80
    highpass.Q.value = 0.7
    inputGain = ctx.createGain()
    inputGain.gain.value = 1
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024

    source.connect(highpass)
    highpass.connect(inputGain)
    inputGain.connect(analyser)
  }

  async function attachCapture(ctx: AudioContext) {
    buildGraph(ctx)
    if (!inputGain) return
    silent = ctx.createGain()
    silent.gain.value = 0
    silent.connect(ctx.destination)

    const useWorklet = typeof (ctx as any).audioWorklet !== 'undefined'
    if (useWorklet) {
      const base = options.base || '/'
      await (ctx as any).audioWorklet.addModule(`${base}recorder-worklet.js`)
      worklet = new AudioWorkletNode(ctx, 'mt-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      worklet.port.onmessage = (event: MessageEvent) => pushBlock(event.data as Float32Array)
      inputGain.connect(worklet)
      worklet.connect(silent)
      return
    }

    // Fallback for browsers without AudioWorklet (kept for Safari < 14.1).
    fallback = ctx.createScriptProcessor(BLOCK_SAMPLES, 1, 1)
    fallback.onaudioprocess = (event) => pushBlock(new Float32Array(event.inputBuffer.getChannelData(0)))
    inputGain.connect(fallback)
    fallback.connect(silent)
  }

  function pushBlock(block: Float32Array) {
    if (status.value !== 'recording' && status.value !== 'countIn') return
    blocks.push(block)
    if (!capturedSamples) captureStartCtx = options.getContext()?.currentTime ?? 0
    capturedSamples += block.length
  }

  function flushLivePeaks() {
    const ctx = options.getContext()
    if (!ctx) return
    const fresh = blocks.slice(liveFlushed)
    if (!fresh.length) return
    liveFlushed = blocks.length
    const batch = concatBlocks(fresh)
    const batchPeaks = computePeaks(batch, ctx.sampleRate, 5)
    for (let i = 0; i < batchPeaks.min.length; i += 1) {
      liveMin.push(batchPeaks.min[i]!)
      liveMax.push(batchPeaks.max[i]!)
    }
    livePeaks.value = {
      hopMs: 5,
      min: Float32Array.from(liveMin),
      max: Float32Array.from(liveMax),
      durationMs: (liveMin.length * 5),
    }
    durationMs.value = (capturedSamples / ctx.sampleRate) * 1000
  }

  function startMeters() {
    const ctx = options.getContext()
    if (!ctx) return
    clearInterval(liveTimer)
    clearInterval(levelTimer)
    liveTimer = window.setInterval(flushLivePeaks, 180)
    levelTimer = window.setInterval(() => {
      if (!analyser) return
      const data = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(data)
      let peak = 0
      let clipped = 0
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i]!)
        if (value > peak) peak = value
        if (value >= 0.99) clipped += 1
      }
      level.value = peak
      if (clipped) clipping.value += clipped
    }, 120)
  }

  function stopMeters() {
    clearInterval(liveTimer)
    clearInterval(levelTimer)
  }

  function click(when: number, accent: boolean) {
    const ctx = options.getContext()
    if (!ctx) return
    const oscillator = ctx.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.value = accent ? 1600 : 1000
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(accent ? 0.18 : 0.1, when)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(when)
    oscillator.stop(when + 0.06)
  }

  /**
   * Arms the capture, plays `beats` count-in clicks and returns the context
   * time at which the score must start (the caller passes it to `synth.play`).
   */
  async function begin(beats = 4, beatMs = 500) {
    clearTake()
    const ctx = options.getContext()
    if (!ctx) throw new Error('Аудио-контекст ещё не создан')
    if (ctx.state === 'suspended') await ctx.resume()
    try {
      await openStream()
      await attachCapture(ctx)
    } catch (e: any) {
      status.value = 'error'
      error.value = e?.message || 'Не удалось получить доступ к микрофону'
      throw e
    }

    countInMs = beats * beatMs
    const lead = 0.25
    zeroCtx = ctx.currentTime + lead + countInMs / 1000
    status.value = 'countIn'
    for (let beat = 0; beat < beats; beat += 1) {
      click(zeroCtx - ((beats - beat) * beatMs) / 1000, beat === 0)
    }
    startMeters()
    window.setTimeout(() => {
      if (status.value === 'countIn') status.value = 'recording'
    }, (lead + countInMs / 1000) * 1000)
    return zeroCtx
  }

  /** Context time of the score's t=0 for the take in progress. */
  function zeroTime() {
    return zeroCtx
  }

  function stop() {
    const ctx = options.getContext()
    stopMeters()
    flushLivePeaks()

    if (source) {
      try {
        source.disconnect()
      } catch {
        /* already gone */
      }
      source = null
    }
    try {
      highpass?.disconnect()
      inputGain?.disconnect()
      analyser?.disconnect()
      worklet?.disconnect()
      fallback?.disconnect()
      silent?.disconnect()
    } catch {
      /* ignore */
    }
    highpass = null
    inputGain = null
    analyser = null
    worklet = null
    fallback = null
    silent = null
    stream?.getTracks().forEach((track) => track.stop())
    stream = null

    if (ctx) {
      const merged = concatBlocks(blocks)
      samples.value = merged
      sampleRate.value = ctx.sampleRate
      durationMs.value = (merged.length / ctx.sampleRate) * 1000
      peaks.value = computePeaks(merged, ctx.sampleRate, 5)
      recordStartMs.value = captureStartCtx ? Math.max(0, (zeroCtx - captureStartCtx) * 1000) : countInMs
      buffer = ctx.createBuffer(1, Math.max(1, merged.length), ctx.sampleRate)
      buffer.getChannelData(0).set(merged)
      status.value = merged.length ? 'ready' : 'idle'
    } else {
      status.value = 'idle'
    }
    blocks = []
  }

  /** Plays the take alone or together with the score from `fromScoreMs`. */
  function play(fromScoreMs: number, atCtxTime: number, shiftMs = 0) {
    const ctx = options.getContext()
    if (!ctx || !buffer) return null
    stopPlayback()
    const offsetMs = fromScoreMs + recordStartMs.value + shiftMs
    if (offsetMs >= durationMs.value) return null
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(ctx.destination)
    node.start(Math.max(atCtxTime, ctx.currentTime + 0.02), Math.max(0, offsetMs) / 1000)
    playbackSource = node
    return node
  }

  function stopPlayback() {
    if (!playbackSource) return
    try {
      playbackSource.stop()
    } catch {
      /* already stopped */
    }
    playbackSource.disconnect()
    playbackSource = null
  }

  function destroy() {
    stopMeters()
    stopPlayback()
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
  }

  return {
    status,
    error,
    level,
    clipping,
    deviceLabel,
    sampleRate,
    samples,
    peaks,
    livePeaks,
    recordStartMs,
    durationMs,
    clearTake,
    begin,
    zeroTime,
    stop,
    play,
    stopPlayback,
    destroy,
  }
}
