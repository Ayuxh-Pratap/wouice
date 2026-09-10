import { readFileSync } from 'node:fs'
import { WhisperCppClient } from '@wouice/asr'
import { LIVE_SOURCE, type Meetings, type SegmentInput } from '@wouice/store'
import { rms } from '../capture/silence-policy.js'
import type { SidecarSupervisor } from '../sidecars/supervisor.js'
import { kindOf } from '../../shared/meeting-kind.js'
import { heardIn, languageForChunk } from './language.js'
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
 * THE LANGUAGE IS CHOSEN PER CHUNK, from what the first pass wrote there. The
 * large model obeys a language setting literally: told a mostly-English
 * meeting was Hindi, it wrote English speech as Hindi-script nonsense. See
 * `languageForChunk`.
 *
 * THE ORDER MATTERS AND IS THE WHOLE DESIGN:
 *
 *   1. stop the language model            free ~3.1 GB
 *   2. load the large speech model        ~1.6 GB
 *   3. re-transcribe from audio.wav       nothing is live, no latency budget
 *   4. put both back the way they were
 *
 * If anything fails, step 4 still runs and nothing is stored. The caller makes
 * the result a new version beside the first pass, so a careful pass can only
 * ever add a transcript, never destroy one.
 */

export interface RepassProgress {
  meetingId: number
  stage: 'loading' | 'transcribing' | 'restoring'
  /** The side of the call being transcribed: yours first, then theirs. */
  side?: Channel
  /**
   * How far through this side, in meeting time, and how long the meeting is.
   * One side at a time: adding the two together once called a two-minute
   * meeting "4 min".
   */
  doneSec: number
  totalSec: number
}

export interface RepassResult {
  /** The new transcript, in time order. Not stored: the caller makes it a version. */
  segments: SegmentInput[]
  /** Seconds of wall clock the whole thing took. */
  seconds: number
  /** How many chunks were sent as each language, so a wrong choice can be seen. */
  languages: Record<string, number>
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

  const meetingLanguage = kindOf(meeting.kind).language
  const before = deps.supervisor.snapshot('whisper').modelId
  const meetingSec = Math.floor((wav.byteLength - 44) / 4 / MEETING_SAMPLE_RATE)

  // What the first pass heard, to choose each chunk's language from.
  const live = meeting.versions.find((v) => v.source === LIVE_SOURCE)
  const heard = live ? deps.meetings.segments(meetingId, live.id) : []
  const languages: Record<string, number> = {}

  deps.onProgress({ meetingId, stage: 'loading', doneSec: 0, totalSec: meetingSec })

  // The language model has to go first: large-v3 and a 4B will not both fit
  // alongside the desktop on this card, and finding that out as a CUDA
  // allocation failure halfway through an hour of audio is not a failure mode
  // worth having.
  await deps.supervisor.stop('llama')
  await deps.supervisor.switchModel('whisper', deps.modelId)

  const segments: SegmentInput[] = []

  try {
    const client = new WhisperCppClient({
      baseUrl: deps.supervisor.baseUrl('whisper'),
      model: deps.modelId,
      // Generous: the careful model hits repetition loops on hard audio and can
      // take most of a minute on a 25 second chunk.
      timeoutMs: 180_000,
    })

    // WAIT FOR IT TO BE LISTENING, not merely spawned.
    //
    // `switchModel` returns once the process exists; the large model then
    // spends about twenty seconds reading 1.6 GB off disk and onto the card.
    // The first run of this raced it and every single chunk came back
    // ECONNREFUSED - a completely failed pass that looked like a transcription
    // problem. Asking the server directly is the only thing that actually
    // answers "can I use it yet".
    if (!(await waitUntilListening(client))) {
      throw new RepassUnavailable('the larger model did not finish loading')
    }
    const segmenter = new Segmenter()
    const chunk = CHUNK_SECONDS * MEETING_SAMPLE_RATE

    for (const side of ['me', 'them'] as const) {
      const pcm = channelOf(wav, side)
      for (let at = 0; at < pcm.length; at += chunk) {
        const slice = pcm.subarray(at, Math.min(at + chunk, pcm.length))
        const fromMs = (at / MEETING_SAMPLE_RATE) * 1000
        const toMs = ((at + slice.length) / MEETING_SAMPLE_RATE) * 1000
        deps.onProgress({
          meetingId,
          stage: 'transcribing',
          side,
          doneSec: Math.round(toMs / 1000),
          totalSec: meetingSec,
        })
        if (rms(slice) < SILENCE_RMS) continue

        const language = languageForChunk(
          meetingLanguage,
          heardIn(heard, side, fromMs, toMs),
          meeting.diagnostics.language
        )
        languages[language] = (languages[language] ?? 0) + 1

        try {
          const result = await client.transcribe(slice, { language, wantTimings: true })
          segments.push(
            ...segmenter.push(
              side,
              { segments: result.segments ?? [], words: result.tokens ?? [] },
              fromMs
            )
          )
        } catch (err) {
          // One lost chunk, as in the live path. The words are on disk and can
          // be tried again; ending the run would throw away everything before.
          console.warn(
            `[repass] ${side} at ${Math.round(fromMs / 1000)}s failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
    }
    segments.push(...segmenter.flush())
  } finally {
    // Both, always, even when the pass threw. Leaving the card holding a model
    // nothing is going to use is how the next dictation fails.
    deps.onProgress({ meetingId, stage: 'restoring', doneSec: meetingSec, totalSec: meetingSec })
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
  // Handed back rather than written: the caller stores them as a new version,
  // beside the transcript this was made from and never over it.
  return { segments, seconds: Math.round((Date.now() - started) / 1000), languages }
}

/**
 * Poll until whisper answers, or give up.
 *
 * `health()` counts any HTTP response, including a 404: a running server that
 * does not serve the path we probed is still running. Only a refused connection
 * means it is not up yet.
 */
async function waitUntilListening(client: WhisperCppClient, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const health = await client.health()
    if (health.ok) return true
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return false
}
