import { readFileSync } from 'node:fs'
import { WhisperCppClient } from '@wouice/asr'
import type { Meetings } from '@wouice/store'
import { rms } from '../capture/silence-policy.js'
import type { SidecarSupervisor } from '../sidecars/supervisor.js'
import { kindOf } from '../../shared/meeting-kind.js'
import { Segmenter } from './segmenter.js'
import { MEETING_SAMPLE_RATE, type Channel } from './session.js'

/**
 * Transcribe a finished meeting again, with the larger speech model.
 *
 * WHY THIS IS A SEPARATE, MANUAL THING. Measured on a real Hindi meeting, on
 * the microphone channel:
 *
 *   turbo     "मतलब नामला था, मतलब उनकी लेशेरी 1500 है, 1500 हैं, 1500 है"
 *   large-v3  "मतलब मैं तो यही चीज सोच रहा था कि सुपने वे कितना बढ़िया है यार"
 *
 * The second is essentially what Google's own captions say. That is not a
 * marginal gain - turbo lost the whole first clause and looped on a number.
 * On the far side of a call it helps less, because that audio reaches us
 * already damaged by the network, but it still helps.
 *
 * It costs about 2.7x the recognition time, and the two models cannot be
 * resident together with the language model on a 6 GB card, so this is not
 * something to do on every meeting automatically. It is a button you press
 * about the meetings you care about.
 *
 * THE ORDER MATTERS AND IS THE WHOLE DESIGN:
 *
 *   1. stop the language model            free ~3.1 GB
 *   2. load the large speech model        ~1.6 GB
 *   3. re-transcribe from audio.wav       nothing is live, no latency budget
 *   4. put both back the way they were
 *
 * If anything fails, step 4 still runs and the previous transcript is left
 * exactly where it was. A re-pass that could destroy the transcript it was
 * trying to improve would not be worth offering.
 */

export interface RepassProgress {
  meetingId: number
  stage: 'loading' | 'transcribing' | 'restoring'
  /** Seconds of audio done, and in total. Both channels counted. */
  doneSec: number
  totalSec: number
}

export interface RepassResult {
  segments: number
  /** Seconds of wall clock the whole thing took. */
  seconds: number
}

export interface RepassDeps {
  supervisor: SidecarSupervisor
  meetings: Meetings
  /** The model to use for the careful pass. */
  modelId: string
  onProgress(progress: RepassProgress): void
}

export class RepassUnavailable extends Error {}

const CHUNK_SECONDS = 25
/** Below this a chunk is silence; the same gate the live path uses. */
const SILENCE_RMS = 0.001

/** Read one channel out of the merged stereo file. */
function channelOf(wav: Buffer, side: Channel): Float32Array {
  const frames = Math.floor((wav.byteLength - 44) / 4)
  const offset = side === 'me' ? 0 : 2
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = wav.readInt16LE(44 + i * 4 + offset) / 32768
  return out
}

export async function repassMeeting(meetingId: number, deps: RepassDeps): Promise<RepassResult> {
  const started = Date.now()
  const meeting = deps.meetings.byId(meetingId)
  if (!meeting) throw new RepassUnavailable('that meeting is gone')
  if (!meeting.audioPath) throw new RepassUnavailable('this meeting has no saved audio')

  let wav: Buffer
  try {
    wav = readFileSync(meeting.audioPath)
  } catch {
    throw new RepassUnavailable('the audio file could not be read')
  }

  const language = kindOf(meeting.kind).language
  const before = deps.supervisor.snapshot('whisper').modelId
  const totalSec = Math.floor((wav.byteLength - 44) / 4 / MEETING_SAMPLE_RATE) * 2

  deps.onProgress({ meetingId, stage: 'loading', doneSec: 0, totalSec })

  // The language model has to go first: large-v3 and a 4B will not both fit
  // alongside the desktop on this card, and finding that out as a CUDA
  // allocation failure halfway through an hour of audio is not a failure mode
  // worth having.
  await deps.supervisor.stop('llama')
  await deps.supervisor.switchModel('whisper', deps.modelId)

  const segments: { channel: Channel; startMs: number; endMs: number; text: string; echo: boolean }[] = []

  try {
    const client = new WhisperCppClient({
      baseUrl: deps.supervisor.baseUrl('whisper'),
      model: deps.modelId,
      // Generous: the careful model hits repetition loops on hard audio and can
      // take most of a minute on a 25 second chunk.
      timeoutMs: 180_000,
    })
    const segmenter = new Segmenter()
    const chunk = CHUNK_SECONDS * MEETING_SAMPLE_RATE
    let done = 0

    for (const side of ['me', 'them'] as const) {
      const pcm = channelOf(wav, side)
      for (let at = 0; at < pcm.length; at += chunk) {
        const slice = pcm.subarray(at, Math.min(at + chunk, pcm.length))
        done += slice.length / MEETING_SAMPLE_RATE
        deps.onProgress({
          meetingId,
          stage: 'transcribing',
          doneSec: Math.round(done),
          totalSec,
        })
        if (rms(slice) < SILENCE_RMS) continue

        try {
          const result = await client.transcribe(slice, { language, wantTimings: true })
          segments.push(
            ...segmenter.push(
              side,
              { segments: result.segments ?? [], words: result.tokens ?? [] },
              (at / MEETING_SAMPLE_RATE) * 1000
            )
          )
        } catch (err) {
          // One lost chunk, as in the live path. The words are on disk and can
          // be tried again; ending the run would throw away everything before.
          console.warn(
            `[repass] ${side} at ${Math.round(at / MEETING_SAMPLE_RATE)}s failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
    }
    segments.push(...segmenter.flush())
  } finally {
    // Both, always, even when the pass threw. Leaving the card holding a model
    // nothing is going to use is how the next dictation fails.
    deps.onProgress({ meetingId, stage: 'restoring', doneSec: totalSec, totalSec })
    try {
      await deps.supervisor.switchModel('whisper', before)
      await deps.supervisor.start('llama')
    } catch (err) {
      console.error('[repass] could not restore the sidecars:', err)
    }
  }

  if (segments.length === 0) {
    throw new RepassUnavailable('the careful pass produced nothing; the previous transcript is untouched')
  }

  segments.sort((a, b) => a.startMs - b.startMs)
  // Only now, once there is something to replace it with.
  deps.meetings.replaceSegments(meetingId, segments)

  return { segments: segments.length, seconds: Math.round((Date.now() - started) / 1000) }
}
