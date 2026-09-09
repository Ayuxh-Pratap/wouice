import { tapFrames, type FrameTap } from './frames.js'

/**
 * The far side of the call: system audio, captured as the "Them" channel.
 *
 * WHY THIS IS NOT DIARIZATION. Speaker separation comes from capture topology.
 * The microphone is you and the loopback tap is everyone else, which is faster
 * and more accurate than any model and, unlike a model, cannot mislabel. See
 * decisions §UC2.
 *
 * WHAT SPIKE V4 ESTABLISHED, because two of these are not obvious:
 *
 *   - It is a genuine digital tap. The floor between sounds is EXACTLY zero and
 *     a played tone comes back as 100% of the captured energy. That is what
 *     lets the segmenter's echo suppression assume bleed flows one way.
 *   - Audio-only is refused. Answering the request with `{ audio: 'loopback' }`
 *     and no video source throws, and Chromium rejects `video: false` outright,
 *     so a video track must be both asked for and supplied.
 *   - It can then be stopped immediately, and the audio is unchanged - same
 *     level, same purity, track still live. Which is why this stops it: an hour
 *     of screen capture to throw every frame away is not a cost worth paying on
 *     a machine already running two models.
 *   - Our own output is IN the mix. Harmless here, because the app makes no
 *     sound during a meeting. It is a problem for the companion in Phase 3.
 *
 * Main must have installed a `setDisplayMediaRequestHandler`, or this rejects.
 */

export interface SystemAudioSession extends FrameTap {
  readonly label: string
}

export async function startSystemAudio(
  onFrame: (frame: Float32Array) => void
): Promise<SystemAudioSession> {
  // Video is requested because the specification rejects `video: false`, and
  // supplied because Electron rejects a loopback answer without a source.
  // Neither of those is a preference of ours.
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })

  const audio = stream.getAudioTracks()[0]
  if (!audio) {
    for (const track of stream.getTracks()) track.stop()
    throw new Error('system audio was not offered by the capture request')
  }

  // The frames we throw away, not thrown away for an hour.
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }

  const tap = await tapFrames(stream, onFrame)
  return { ...tap, label: audio.label || 'System audio' }
}
