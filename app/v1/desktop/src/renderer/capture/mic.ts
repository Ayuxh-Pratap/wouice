import { tapFrames, TARGET_SAMPLE_RATE, type FrameTap } from './frames.js'

/**
 * Microphone capture, delivering exactly the format the pipeline expects.
 *
 * The framing itself - a 16 kHz AudioContext and a worklet that emits 20 ms
 * blocks - lives in `frames.ts`, shared with the system-audio channel. What is
 * specific to a microphone is here: which constraints to ask for, and which
 * device.
 */

export { TARGET_SAMPLE_RATE }

export interface MicSession extends FrameTap {
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

  const deviceLabel = stream.getAudioTracks()[0]?.label ?? 'unknown'
  const tap = await tapFrames(stream, options.onFrame)
  return { ...tap, deviceLabel }
}

/** Input devices, for the settings picker. Labels need permission first. */
export async function listInputs(): Promise<{ deviceId: string; label: string }[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' }))
}
