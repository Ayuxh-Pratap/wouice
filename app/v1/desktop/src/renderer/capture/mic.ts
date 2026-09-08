/**
 * Microphone capture, delivering exactly the format the pipeline expects.
 *
 * ONE INTERNAL FORMAT: 16 kHz mono Float32, everywhere. Rather than capture at
 * the device rate and resample by hand, the AudioContext is CONSTRUCTED at
 * 16 kHz and Chromium resamples in native code on the audio thread. That is
 * both better quality and less of our code, and it means the frames leaving
 * this module are already what whisper-server wants.
 *
 * The worklet is built from a Blob URL rather than a separate file so it needs
 * no build configuration and cannot break through a bundler path change.
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

export interface MicSession {
  stop(): Promise<void>
  readonly sampleRate: number
  readonly deviceLabel: string
}

export interface MicOptions {
  /** Called with each 20 ms frame of 16 kHz mono Float32. */
  onFrame(frame: Float32Array): void
  /** Specific input device, or the system default. */
  deviceId?: string
}

/**
 * Open the microphone and start delivering frames.
 *
 * Echo cancellation and noise suppression are left ON. They are tuned for
 * speech, which is exactly our signal, and they make the adaptive noise floor's
 * job easier. Auto gain is OFF: it fights the level meter and can pump quiet
 * speech up to the point where room noise reads as speech.
 */
export async function startMic(options: MicOptions): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
    video: false,
  })

  // Chromium resamples to this rate in native code on the audio thread.
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

  node.port.onmessage = (e: MessageEvent<Float32Array>) => options.onFrame(e.data)
  source.connect(node)

  const deviceLabel = stream.getAudioTracks()[0]?.label ?? 'unknown'

  return {
    sampleRate: ctx.sampleRate,
    deviceLabel,
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

/** Input devices, for the settings picker. Labels need permission first. */
export async function listInputs(): Promise<{ deviceId: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
}
