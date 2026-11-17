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
}

interface NoteEvent {
  track: number
  note: number
  start: number
  dur: number
  velocity: number
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

  /** Convert score ticks into a millisecond tempo map. */
  function buildSegments(score: any) {
    segments = []
    let tick = 0
    let ms = 0
    let lastTempo = 120
    for (const bar of score.masterBars) {
      // alphaTab keeps an imported tempo in tempoAutomations; bars without an
      // automation inherit the tempo of the previous bar.
      const automated = bar.tempoAutomations?.[0]?.value
      const tempo = automated && automated > 0 ? automated : bar.tempo && bar.tempo > 0 ? bar.tempo : lastTempo
      lastTempo = tempo
      const length = bar.calculateDuration()
      const barMs = (length / QUARTER_TICKS) * (60000 / tempo)
      segments.push({ startTick: tick, endTick: tick + length, startMs: ms, endMs: ms + barMs, tempo })
      tick += length
      ms += barMs
    }
    duration.value = ms
    loopStart.value = 0
    loopEnd.value = ms
    barTicks = new Set(segments.map((s) => s.startTick))
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
                })
              }
            }
          }
        }
      }
    })
    events.sort((a, b) => a.start - b.start)
    beatTicks.sort((a, b) => a.tick - b.tick)
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

  function scheduleNote(event: NoteEvent, when: number, trackState: TrackState) {
    const channel = channels[event.track]
    if (!channel || !ctx) return
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

  function scheduleAll(from: number) {
    if (!ctx) return
    stopVoices()
    const now = ctx.currentTime + 0.05
    startedFrom = from
    startedAtCtx = now

    const rate = speed.value
    for (const event of events) {
      if (event.start + event.dur <= from) continue
      if (event.start < from) {
        // note already sounding: start it immediately, shortened
        scheduleNote(
          { ...event, start: from, dur: event.dur - (from - event.start) },
          now,
          tracks.value[event.track]!,
        )
        continue
      }
      const when = now + ((event.start - from) / 1000) / rate
      scheduleNote(event, when, tracks.value[event.track]!)
    }

    if (metronome.value) {
      for (const beat of beatTicks) {
        if (beat.ms < from) continue
        const when = now + ((beat.ms - from) / 1000) / rate
        scheduleClick(when, barTicks.has(beat.tick))
      }
    }
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

  function tick() {
    if (!ctx || !playing.value) return
    const elapsed = (ctx.currentTime - startedAtCtx) * 1000 * speed.value
    position.value = Math.min(duration.value, startedFrom + elapsed)
    if (loop.value && loopEnd.value > loopStart.value && position.value >= loopEnd.value) {
      seek(loopStart.value)
    } else if (position.value >= duration.value) {
      stop()
      return
    }
    raf = requestAnimationFrame(tick)
  }

  async function play() {
    const context = ensureContext()
    if (context.state === 'suspended') await context.resume()
    if (position.value >= duration.value - 1) position.value = 0
    scheduleAll(position.value)
    playing.value = true
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(tick)
  }

  function pause() {
    if (!playing.value) return
    playing.value = false
    cancelAnimationFrame(raf)
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
    /** Diagnostics: live WebAudio channels per track. */
    get channels() {
      return channels
    },
  }
}
