/**
 * Playback engine for the tab viewer.
 *
 * alphaTab is used only for parsing and rendering: its own synthesizer mixes
 * all tracks internally, so per-track volume/EQ/instrument is impossible with
 * it. Here every track gets its own WebAudio channel:
 *
 *   voices → track gain → 10 peaking filters → master gain → destination
 *
 * Timings are taken from the alphaTab score model (MIDI ticks, 960 per quarter)
 * and converted to milliseconds with the tempo map of the master bars.
 */

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export type Timbre = 'piano' | 'guitar' | 'bass' | 'organ' | 'strings' | 'pad' | 'brass' | 'lead'

export interface TrackState {
  index: number
  name: string
  volume: number
  muted: boolean
  eq: number[]
  program: number
  isPercussion: boolean
}

interface NoteEvent {
  track: number
  note: number
  start: number
  dur: number
  velocity: number
  drum: boolean
}

interface Channel {
  gain: GainNode
  bands: BiquadFilterNode[]
}

interface Segment {
  startTick: number
  endTick: number
  startMs: number
  endMs: number
  tempo: number
}

const QUARTER_TICKS = 960

/** GM program → one of the built-in timbres. */
export function timbreFor(program: number): Timbre {
  if (program <= 7) return 'piano'
  if (program >= 16 && program <= 23) return 'organ'
  if (program >= 24 && program <= 31) return 'guitar'
  if (program >= 32 && program <= 39) return 'bass'
  if (program >= 40 && program <= 51) return 'strings'
  if (program >= 56 && program <= 63) return 'brass'
  if (program >= 80 && program <= 87) return 'lead'
  if (program >= 88 && program <= 95) return 'pad'
  return 'piano'
}

export function createTabSynth() {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let channels: Channel[] = []
  let events: NoteEvent[] = []
  let segments: Segment[] = []
  let beatTicks: { tick: number; ms: number }[] = []
  let barTicks = new Set<number>()
  let active: { src: AudioScheduledSourceNode; gain: GainNode }[] = []

  const tracks = ref<TrackState[]>([])
  const playing = ref(false)
  const position = ref(0)
  const duration = ref(0)
  const speed = ref(1)
  const metronome = ref(false)
  const loop = ref(false)
  const loopStart = ref(0)
  const loopEnd = ref(0)

  let startedAtCtx = 0
  let startedFrom = 0
  let raf = 0
  let scheduler = 0
  let clock = 0
  let clockWorker: Worker | null = null
  let nextEvent = 0
  let nextClick = 0
  // rAF is throttled in background tabs, so the clock and the look-ahead
  // scheduler both run on timers.
  const LOOKAHEAD_MS = 3000

  function ensureContext() {
    if (ctx) return ctx
    const Ctor = window.AudioContext || (window as any).webkitAudioContext
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.85
    master.connect(ctx.destination)
    return ctx
  }

  function buildChannels(count: number) {
    ensureContext()
    channels.forEach((channel) => channel.gain.disconnect())
    channels = []
    for (let i = 0; i < count; i += 1) {
      const gain = ctx!.createGain()
      gain.gain.value = 0.8
      const bands = EQ_FREQS.map((freq) => {
        const filter = ctx!.createBiquadFilter()
        filter.type = 'peaking'
        filter.frequency.value = freq
        filter.Q.value = 1.1
        filter.gain.value = 0
        return filter
      })
      let node: AudioNode = gain
      bands.forEach((band) => {
        node.connect(band)
        node = band
      })
      node.connect(master!)
      channels.push({ gain, bands })
    }
  }

  function applyTrackSettings(state: TrackState) {
    const channel = channels[state.index]
    if (!channel) return
    const target = state.muted ? 0 : state.volume
    channel.gain.gain.setTargetAtTime(target, ctx?.currentTime ?? 0, 0.02)
    state.eq.forEach((db, index) => {
      const band = channel.bands[index]
      if (band) band.gain.setTargetAtTime(db, ctx?.currentTime ?? 0, 0.05)
    })
  }

  /** Tempo per master bar (imported tempo lives in tempoAutomations). */
  function resolveTempos(score: any) {
    const tempos = new Map<any, number>()
    let last = 120
    for (const bar of score.masterBars) {
      const automated = bar.tempoAutomations?.[0]?.value
      const tempo = automated && automated > 0 ? automated : bar.tempo && bar.tempo > 0 ? bar.tempo : last
      last = tempo
      tempos.set(bar, tempo)
    }
    return tempos
  }

  /**
   * Build the tick → millisecond map from the beats themselves.
   * `beat.absolutePlaybackStart` is already expanded by alphaTab (repeats are
   * unfolded), so walking bars would lose repeated sections.
   */
  function buildSegments(score: any) {
    const tempos = resolveTempos(score)
    const tempoByTick = new Map<number, number>()
    const barStarts = new Set<number>()
    let maxTick = 0

    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const bar of staff.bars) {
          const tempo = tempos.get(bar.masterBar) ?? 120
          let barStart = -1
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              const tick = beat.absolutePlaybackStart
              if (!tempoByTick.has(tick)) tempoByTick.set(tick, tempo)
              if (barStart < 0 || tick < barStart) barStart = tick
              maxTick = Math.max(maxTick, tick + (beat.playbackDuration || 0))
            }
          }
          if (barStart >= 0) barStarts.add(barStart)
        }
      }
    }

    const ticks = [...tempoByTick.keys()].sort((a, b) => a - b)
    segments = []
    let ms = 0
    for (let i = 0; i < ticks.length; i += 1) {
      const startTick = ticks[i]!
      const endTick = i + 1 < ticks.length ? ticks[i + 1]! : Math.max(maxTick, startTick + 1)
      const tempo = tempoByTick.get(startTick) || 120
      const spanMs = ((endTick - startTick) / QUARTER_TICKS) * (60000 / tempo)
      segments.push({ startTick, endTick, startMs: ms, endMs: ms + spanMs, tempo })
      ms += spanMs
    }

    duration.value = ms
    loopStart.value = 0
    loopEnd.value = ms
    // Metronome accents: ticks where a bar begins (repeat instances included).
    barTicks = barStarts
  }

  function msForTick(tick: number) {
    const segment = segments.find((s) => tick >= s.startTick && tick < s.endTick) || segments[segments.length - 1]
    if (!segment) return 0
    return segment.startMs + ((tick - segment.startTick) / QUARTER_TICKS) * (60000 / segment.tempo)
  }

  function tickForMs(ms: number) {
    const segment = segments.find((s) => ms >= s.startMs && ms < s.endMs) || segments[segments.length - 1]
    if (!segment) return 0
    return segment.startTick + ((ms - segment.startMs) / (60000 / segment.tempo)) * QUARTER_TICKS
  }

  /** Flatten the score model into note events + a beat grid for the cursor. */
  function buildEvents(score: any) {
    events = []
    beatTicks = []
    const seenBeat = new Set<string>()
    score.tracks.forEach((track: any, trackIndex: number) => {
      for (const staff of track.staves) {
        const isDrumStaff = !!staff.isPercussion
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              const beatMs = msForTick(beat.absolutePlaybackStart)
              const key = `${trackIndex}:${beat.absolutePlaybackStart}`
              if (!seenBeat.has(key)) {
                seenBeat.add(key)
                beatTicks.push({ tick: beat.absolutePlaybackStart, ms: beatMs })
              }
              if (beat.isRest) continue
              const beatStartMs = beatMs
              const beatEndMs = msForTick(beat.absolutePlaybackStart + beat.playbackDuration)
              const beatDur = beatEndMs - beatStartMs
              for (const note of beat.notes) {
                if (note.isTieDestination) continue
                events.push({
                  track: trackIndex,
                  note: note.realValue,
                  start: beatMs,
                  dur: Math.max(40, beatDur * (note.durationPercent || 1)),
                  velocity: note.velocity || 95,
                  drum: isDrumStaff,
                })
              }
            }
          }
        }
      }
    })
    events.sort((a, b) => a.start - b.start)
    beatTicks.sort((a, b) => a.tick - b.tick)

    // Repeats and tempo automations can leave the bar map shorter than the
    // real timeline: never cut playback before the last sounding note.
    const lastNote = events.reduce((max, event) => Math.max(max, event.start + event.dur), 0)
    const lastBeat = beatTicks.length ? beatTicks[beatTicks.length - 1]!.ms : 0
    duration.value = Math.max(duration.value, lastNote, lastBeat)
    loopEnd.value = duration.value
  }

  function loadScore(score: any) {
    buildSegments(score)
    buildEvents(score)
    tracks.value = score.tracks.map((track: any, index: number) => ({
      index,
      name: track.name || `Дорожка ${index + 1}`,
      volume: 0.8,
      muted: false,
      eq: EQ_FREQS.map(() => 0),
      program: track.playbackInfo?.program ?? 25,
      isPercussion: !!track.isPercussion || !!track.staves?.some((staff: any) => staff.isPercussion),
    }))
    buildChannels(score.tracks.length)
    tracks.value.forEach(applyTrackSettings)
    position.value = 0
    playing.value = false
  }

  function timbreVoices(timbre: Timbre, freq: number, velocity: number) {
    // [oscillator type, gain, detune cents]
    switch (timbre) {
      case 'guitar':
        return [['sawtooth', 0.5, 0], ['triangle', 0.25, 7]] as const
      case 'bass':
        return [['sine', 0.9, 0], ['triangle', 0.35, -1200]] as const
      case 'organ':
        return [['sine', 0.5, 0], ['sine', 0.35, 1200], ['sine', 0.2, 1900]] as const
      case 'strings':
        return [['sawtooth', 0.42, -6], ['sawtooth', 0.3, 6]] as const
      case 'pad':
        return [['triangle', 0.4, -900], ['sine', 0.4, 0], ['triangle', 0.25, 900]] as const
      case 'brass':
        return [['square', 0.35, 0], ['sawtooth', 0.3, 5]] as const
      case 'lead':
        return [['square', 0.4, 0], ['sawtooth', 0.2, 1200]] as const
      default:
        return [['triangle', 0.55, 0], ['sine', 0.3, 1200]] as const
    }
  }


  /** GM drum key → synthesized percussion hit (no samples needed). */
  function scheduleDrum(event: NoteEvent, when: number, channel: Channel) {
    if (!ctx) return
    const key = event.note
    const isKick = key === 35 || key === 36
    const isSnare = key === 38 || key === 40 || key === 37
    const isHat = key === 42 || key === 44 || key === 46
    const isCymbal = key === 49 || key === 51 || key === 52 || key === 53 || key === 55 || key === 57 || key === 59
    const isTom = key >= 41 && key <= 50 && !isHat && !isCymbal
    const peak = Math.min(0.9, (event.velocity / 127) * 0.55)

    const noise = () => {
      const buffer = ctx!.createBuffer(1, Math.floor(ctx!.sampleRate * 0.35), ctx!.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
      const source = ctx!.createBufferSource()
      source.buffer = buffer
      return source
    }

    if (isKick) {
      const oscillator = ctx.createOscillator()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(120, when)
      oscillator.frequency.exponentialRampToValueAtTime(45, when + 0.12)
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(peak, when)
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.28)
      oscillator.connect(gain)
      gain.connect(channel.gain)
      oscillator.start(when)
      oscillator.stop(when + 0.3)
      active.push({ src: oscillator, gain })
      return
    }

    if (isHat || isCymbal || isSnare || isTom) {
      const source = noise()
      const filter = ctx.createBiquadFilter()
      filter.type = isHat || isCymbal ? 'highpass' : 'bandpass'
      filter.frequency.value = isHat ? 8000 : isCymbal ? 5200 : isSnare ? 1800 : 320
      filter.Q.value = isTom ? 1.6 : 0.9
      const gain = ctx.createGain()
      const decay = isCymbal ? 0.9 : isHat ? 0.09 : isSnare ? 0.18 : 0.32
      gain.gain.setValueAtTime(peak * (isHat ? 0.5 : isCymbal ? 0.45 : 0.9), when)
      gain.gain.exponentialRampToValueAtTime(0.0001, when + decay)
      source.connect(filter)
      filter.connect(gain)
      gain.connect(channel.gain)
      source.start(when)
      source.stop(when + decay + 0.05)
      active.push({ src: source, gain })
      if (isSnare) {
        // body of the snare
        const body = ctx.createOscillator()
        body.type = 'triangle'
        body.frequency.setValueAtTime(190, when)
        const bodyGain = ctx.createGain()
        bodyGain.gain.setValueAtTime(peak * 0.35, when)
        bodyGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.12)
        body.connect(bodyGain)
        bodyGain.connect(channel.gain)
        body.start(when)
        body.stop(when + 0.14)
        active.push({ src: body, gain: bodyGain })
      }
      return
    }

    // any other percussion key: short click
    scheduleClick(when, key === 39)
  }

  function scheduleNote(event: NoteEvent, when: number, trackState: TrackState) {
    const channel = channels[event.track]
    if (!channel || !ctx) return
    if (event.drum) {
      scheduleDrum(event, when, channel)
      return
    }
    const timbre = timbreFor(trackState.program)
    const freq = 440 * Math.pow(2, (event.note - 69) / 12)
    const peak = Math.min(0.9, (event.velocity / 127) * 0.5)
    const release = timbre === 'strings' || timbre === 'pad' ? 0.35 : 0.08
    const attack = timbre === 'strings' || timbre === 'pad' ? 0.08 : 0.005

    const envelope = ctx.createGain()
    envelope.gain.setValueAtTime(0, when)
    envelope.gain.linearRampToValueAtTime(peak, when + attack)
    envelope.gain.setTargetAtTime(peak * 0.55, when + attack, Math.max(0.05, event.dur / 2000))
    envelope.gain.setTargetAtTime(0.0001, when + event.dur / 1000, release)
    envelope.connect(channel.gain)

    for (const [type, level, cents] of timbreVoices(timbre, freq, event.velocity)) {
      const oscillator = ctx.createOscillator()
      oscillator.type = type
      oscillator.frequency.value = freq
      oscillator.detune.value = cents
      const voiceGain = ctx.createGain()
      voiceGain.gain.value = level
      oscillator.connect(voiceGain)
      voiceGain.connect(envelope)
      oscillator.start(when)
      oscillator.stop(when + event.dur / 1000 + release * 4 + 0.05)
      active.push({ src: oscillator, gain: voiceGain })
    }
    if (timbre === 'guitar' || timbre === 'bass') {
      const noise = ctx.createBufferSource()
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.02), ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
      noise.buffer = buffer
      const noiseGain = ctx.createGain()
      noiseGain.gain.value = peak * 0.18
      noise.connect(noiseGain)
      noiseGain.connect(channel.gain)
      noise.start(when)
      active.push({ src: noise, gain: noiseGain })
    }
  }

  function scheduleClick(when: number, accent: boolean) {
    if (!ctx || !master) return
    const oscillator = ctx.createOscillator()
    oscillator.type = 'square'
    oscillator.frequency.value = accent ? 1600 : 1000
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(accent ? 0.16 : 0.09, when)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(when)
    oscillator.stop(when + 0.06)
    active.push({ src: oscillator, gain })
  }

  /** Schedule only a short window ahead: big scores have thousands of notes. */
  function pump() {
    if (!ctx || !playing.value) return
    const rate = speed.value
    const horizonMs = startedFrom + (ctx.currentTime - startedAtCtx) * 1000 * rate + LOOKAHEAD_MS

    while (nextEvent < events.length && events[nextEvent]!.start <= horizonMs) {
      const event = events[nextEvent]!
      nextEvent += 1
      if (event.start + event.dur <= startedFrom) continue
      const offset = Math.max(0, event.start - startedFrom) / 1000 / rate
      const when = startedAtCtx + offset
      const trimmed = event.start < startedFrom
        ? { ...event, dur: event.dur - (startedFrom - event.start) }
        : event
      scheduleNote(trimmed, Math.max(when, ctx.currentTime), tracks.value[event.track]!)
    }

    if (metronome.value) {
      while (nextClick < beatTicks.length && beatTicks[nextClick]!.ms <= horizonMs) {
        const beat = beatTicks[nextClick]!
        nextClick += 1
        if (beat.ms < startedFrom) continue
        const when = startedAtCtx + (beat.ms - startedFrom) / 1000 / rate
        scheduleClick(Math.max(when, ctx.currentTime), barTicks.has(beat.tick))
      }
    }
  }

  function startScheduling(from: number) {
    if (!ctx) return
    stopVoices()
    startedFrom = from
    startedAtCtx = ctx.currentTime + 0.12

    nextEvent = events.findIndex((event) => event.start + event.dur > from)
    if (nextEvent < 0) nextEvent = events.length
    nextClick = beatTicks.findIndex((beat) => beat.ms >= from)
    if (nextClick < 0) nextClick = beatTicks.length

    pump()
    clearInterval(scheduler)
    scheduler = window.setInterval(pump, 250)
  }

  function stopVoices() {
    for (const item of active) {
      try {
        item.src.stop()
      } catch {
        /* already stopped */
      }
      item.src.disconnect()
      item.gain.disconnect()
    }
    active = []
  }


  /**
   * Background tabs throttle `setInterval` to ~1/minute, which kills the
   * look-ahead scheduler. A dedicated worker keeps ticking.
   */
  function startTicking() {
    clearInterval(clock)
    clock = window.setInterval(() => {
      updateClock()
    }, 60)

    if (clockWorker) return
    try {
      const source = 'let t=null;self.onmessage=function(e){if(e.data==="start"){clearInterval(t);t=setInterval(function(){self.postMessage(1)},250)}else{clearInterval(t)}}'
      const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }))
      clockWorker = new Worker(url)
      clockWorker.onmessage = () => {
        if (!playing.value) return
        updateClock()
        pump()
      }
      clockWorker.postMessage('start')
    } catch {
      clockWorker = null
    }
  }

  function stopTicking() {
    clearInterval(clock)
    if (clockWorker) {
      try {
        clockWorker.postMessage('stop')
      } catch {
        /* ignore */
      }
      clockWorker.terminate()
      clockWorker = null
    }
  }

  function updateClock() {
    if (!ctx || !playing.value) return
    const elapsed = (ctx.currentTime - startedAtCtx) * 1000 * speed.value
    position.value = Math.min(duration.value, Math.max(0, startedFrom + elapsed))

    if (loop.value && loopEnd.value > loopStart.value && position.value >= loopEnd.value) {
      seek(loopStart.value)
      return
    }
    if (position.value >= duration.value) {
      stop()
      return
    }
    pump()
  }

  async function play() {
    const context = ensureContext()
    if (context.state === 'suspended') await context.resume()
    if (position.value >= duration.value - 1) position.value = 0
    startScheduling(position.value)
    playing.value = true
    startTicking()
  }

  function pause() {
    if (!playing.value) return
    playing.value = false
    stopTicking()
    clearInterval(scheduler)
    stopVoices()
  }

  function stop() {
    pause()
    position.value = 0
  }

  function seek(ms: number) {
    const target = Math.min(Math.max(0, ms), duration.value)
    const wasPlaying = playing.value
    pause()
    position.value = target
    if (wasPlaying) play()
  }

  function setMetronome(value: boolean) {
    metronome.value = value
    if (value && playing.value) seek(position.value)
  }

  function setSpeed(value: number) {
    speed.value = value
    if (playing.value) seek(position.value)
  }

  function destroy() {
    pause()
    stopTicking()
    channels.forEach((channel) => channel.gain.disconnect())
    channels = []
    master?.disconnect()
    master = null
    ctx?.close().catch(() => {})
    ctx = null
  }

  function trackAt(ms: number) {
    const current = tickForMs(ms)
    const beats = beatTicks.filter((b) => b.ms <= ms)
    return { tick: current, beat: beats[beats.length - 1] || null }
  }

  return {
    tracks,
    playing,
    position,
    duration,
    speed,
    metronome,
    loop,
    loopStart,
    loopEnd,
    loadScore,
    play,
    pause,
    stop,
    seek,
    setMetronome,
    setSpeed,
    applyTrackSettings,
    destroy,
    trackAt,
    /** Diagnostics: audio context state/time. */
    get context() {
      return ctx
    },
    /** Diagnostics: live WebAudio channels per track. */
    get channels() {
      return channels
    },
  }
}
