/**
 * A MediaStream, turned into 20 ms frames of 16 kHz mono Float32.
 *
 * ONE INTERNAL FORMAT: 16 kHz mono Float32, everywhere. Rather than capture at
 * the device rate and resample by hand, the AudioContext is CONSTRUCTED at
 * 16 kHz and Chromium resamples in native code on the audio thread. That is
 * both better quality and less of our code, and it means the frames leaving
 * here are already what whisper-server wants.
 *
 * The worklet is built from a Blob URL rather than a separate file so it needs
 * no build configuration and cannot break through a bundler path change.
 *
 * Shared by the microphone and the system-audio channel. They differ entirely
 * in how the stream is OBTAINED and not at all in what is done with it, so the
 * two callers keep their own permission and lifecycle problems and hand the
 * result here.
 */

export const TARGET_SAMPLE_RATE = 16_000
/** 320 samples at 16 kHz = 20 ms, which is the policy's frame granularity. */
const FRAME_SAMPLES = 320

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = new Float32Array(${FRAME_SAMPLES})
    this._n = 0
  }
  process(inputs) {
    const input = inputs[0]
    // No input yet, or the track ended. Keep the node alive either way:
    // returning false would tear the graph down permanently.
    if (!input || !input[0]) return true
    const ch = input[0]
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._n++] = ch[i]
      if (this._n === ${FRAME_SAMPLES}) {
        // Transfer a copy: the worklet reuses its buffer every render quantum,
        // so posting the same one would deliver overwritten samples.
        const out = this._buf.slice()
        this.port.postMessage(out, [out.buffer])
        this._n = 0
      }
    }
    return true
  }
}
registerProcessor('wouice-capture', CaptureProcessor)
`

export interface FrameTap {
  readonly sampleRate: number
  stop(): Promise<void>
}

/**
 * Start delivering frames from `stream`.
 *
 * The stream's tracks are stopped on `stop()`, so the caller hands ownership
 * over. That is deliberate: a capture whose graph is torn down while its tracks
 * stay live leaves the operating system believing it is still recording.
 */
export async function tapFrames(
  stream: MediaStream,
  onFrame: (frame: Float32Array) => void
): Promise<FrameTap> {
  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })

  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  const source = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'wouice-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  })

  node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)
  source.connect(node)

  return {
    sampleRate: ctx.sampleRate,
    async stop() {
      node.port.onmessage = null
      try {
        source.disconnect()
        node.disconnect()
      } catch {
        // Already torn down.
      }
      for (const track of stream.getTracks()) track.stop()
      await ctx.close()
    },
  }
}
