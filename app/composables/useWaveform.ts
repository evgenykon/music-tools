/**
 * Waveform helpers for the record page.
 *
 * Everything here is pure (no Vue, no DOM) so the container can run it directly
 * from `scripts/check-record.ts`.
 */

export interface Peaks {
  /** Distance between two buckets, ms. */
  hopMs: number
  /** Per-bucket minimum (negative) and maximum (positive). */
  min: Float32Array
  max: Float32Array
  /** Total recorded length, ms. */
  durationMs: number
}

/** Concatenate captured PCM blocks into one buffer. */
export function concatBlocks(blocks: Float32Array[], totalSamples?: number): Float32Array {
  const length = totalSamples ?? blocks.reduce((sum, block) => sum + block.length, 0)
  const out = new Float32Array(length)
  let offset = 0
  for (const block of blocks) {
    if (offset >= length) break
    const take = Math.min(block.length, length - offset)
    out.set(take === block.length ? block : block.subarray(0, take), offset)
    offset += take
  }
  return out
}

/**
 * Downsample audio into min/max peaks. `hopMs` is the time each bucket covers,
 * so drawing is a cheap read no matter how long the take is.
 */
export function computePeaks(samples: Float32Array, sampleRate: number, hopMs = 5): Peaks {
  const samplesPerBucket = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  const buckets = Math.max(1, Math.ceil(samples.length / samplesPerBucket))
  const min = new Float32Array(buckets)
  const max = new Float32Array(buckets)

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = bucket * samplesPerBucket
    const to = Math.min(samples.length, from + samplesPerBucket)
    let lo = 0
    let hi = 0
    for (let i = from; i < to; i += 1) {
      const value = samples[i]!
      if (value < lo) lo = value
      if (value > hi) hi = value
    }
    min[bucket] = lo
    max[bucket] = hi
  }

  return {
    hopMs,
    min,
    max,
    durationMs: (samples.length / sampleRate) * 1000,
  }
}

/** Peak absolute amplitude, 0…1 — used for the clipping indicator. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]!)
    if (value > peak) peak = value
  }
  return peak
}

/** Number of samples at or above the clipping ceiling. */
export function clippedSamples(samples: Float32Array, ceiling = 0.99): number {
  let count = 0
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i]!) >= ceiling) count += 1
  }
  return count
}

/**
 * 16-bit PCM WAV encoder. Mono input is written as a mono file; passing two
 * channels produces a stereo file (same length expected).
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const channelCount = Math.max(1, channels.length)
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = 2
  const dataBytes = frames * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = channels[channel]?.[frame] ?? 0
      const clamped = Math.max(-1, Math.min(1, sample))
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
      offset += bytesPerSample
    }
  }

  return buffer
}
