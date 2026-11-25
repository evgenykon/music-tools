/**
 * Raw PCM capture for the record page.
 *
 * The worklet is fed by the microphone chain and posts blocks of 2048 samples
 * to the main thread, so the recording has an exact sample count (no codec, no
 * `decodeAudioData`, no MediaRecorder mime juggling) and can be redrawn while
 * it is still growing.
 *
 * The first message also carries the audio-context time of its first sample:
 * `currentTime` on the main thread when the message arrives is a few tens of
 * milliseconds later than the audio itself, and that error used to shift the
 * whole take in the timeline.
 */
class MtRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(2048)
    this.offset = 0
    this.started = false
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    let index = 0
    while (index < channel.length) {
      const take = Math.min(channel.length - index, this.block.length - this.offset)
      this.block.set(channel.subarray(index, index + take), this.offset)
      this.offset += take
      index += take
      if (this.offset === this.block.length) {
        if (!this.started) {
          // `currentTime` is the end of the block processed right now.
          this.started = true
          this.port.postMessage({
            samples: this.block,
            startTime: currentTime - this.block.length / sampleRate,
          })
        } else {
          this.port.postMessage({ samples: this.block })
        }
        this.block = new Float32Array(2048)
        this.offset = 0
      }
    }
    return true
  }
}

registerProcessor('mt-recorder', MtRecorderProcessor)
