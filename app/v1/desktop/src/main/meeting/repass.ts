import { readFileSync } from 'node:fs'
import { WhisperCppClient } from '@wouice/asr'
import { LIVE_SOURCE, type Meetings, type SegmentInput } from '@wouice/store'
import { rms } from '../capture/silence-policy.js'
import type { SidecarSupervisor } from '../sidecars/supervisor.js'
import { kindOf } from '../../shared/meeting-kind.js'
import { heardSegments } from './heard.js'
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
 * THE LARGE MODEL IS ON THE CARD ONLY WHILE THIS RUNS. It once stayed there
 * after a careful pass - the restore asked for "whatever was loaded before",
 * which was already the large model because an earlier restore had been queued
 * behind a dictation - and the next meeting was transcribed live by it without
 * anybody choosing that. So: it waits for any dictation to finish before
 * swapping, confirms each swap actually happened rather than trusting the call,
 * restores the model your settings name rather than a snapshot, and stops the
 * moment a recording starts.
 *
 * THE LANGUAGE IS CHOSEN PER CHUNK, from what the first pass wrote there. The
 * large model obeys a language setting literally: told a mostly-English meeting
 * was Hindi, it wrote English speech as Hindi-script nonsense. See
 * `languageForChunk`.
 *
 * If anything fails, the swap back still runs and nothing is stored. The caller
 * makes the result a new version beside the first pass, so a careful pass can
 * only ever add a transcript, never destroy one.
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
  /** Lines the model wrote over silence, dropped. See `heardSegments`. */
  unheard: number
  /** Whether the speech model you use every day was confirmed back on the card. */
  restored: boolean
}

export interface RepassDeps {
  supervisor: SidecarSupervisor
  meetings: Meetings
  /** The model to use for the careful pass. */
  modelId: string
  /** The speech model to put back afterwards: the one your settings name. */
  restoreModelId: string
  onProgress(progress: RepassProgress): void
  /** Aborted when a recording starts: recording beats improving. */
  signal?: AbortSignal
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
  const meetingSec = Math.floor((wav.byteLength - 44) / 4 / MEETING_SAMPLE_RATE)

  // What the first pass heard, to choose each chunk's language from.
  const live = meeting.versions.find((v) => v.source === LIVE_SOURCE)
  const heard = live ? deps.meetings.segments(meetingId, live.id) : []
  const languages: Record<string, number> = {}
  let unheard = 0

  deps.onProgress({ meetingId, stage: 'loading', doneSec: 0, totalSec: meetingSec })

  // A dictation in flight holds the speech model, and a swap asked for now
  // would be queued behind it rather than done. Wait it out, or give up
  // before anything has been touched.
  if (!(await deps.supervisor.whenIdle('whisper'))) {
    throw new RepassUnavailable('a dictation is still running; try again when it has finished')
  }

  const segments: SegmentInput[] = []
  let restored = false

  try {
    // The language model has to go first: large-v3 and a 4B will not both fit
    // alongside the desktop on this card, and finding that out as a CUDA
    // allocation failure halfway through an hour of audio is not a failure
    // mode worth having.
    await deps.supervisor.stop('llama')
    await deps.supervisor.switchModel('whisper', deps.modelId)

    // LOADED AND LISTENING, not merely asked for. The large model spends about
    // twenty seconds reading 1.6 GB onto the card; the first run of this raced
    // it and every chunk came back ECONNREFUSED.
    if (!(await deps.supervisor.whenModel('whisper', deps.modelId, 120_000))) {
      throw new RepassUnavailable('the larger model did not finish loading')
    }

    const client = new WhisperCppClient({
      baseUrl: deps.supervisor.baseUrl('whisper'),
      model: deps.modelId,
      // Generous: the careful model hits repetition loops on hard audio and can
      // take most of a minute on a 25 second chunk.
      timeoutMs: 180_000,
    })
    const segmenter = new Segmenter()
    const chunk = CHUNK_SECONDS * MEETING_SAMPLE_RATE

    for (const side of ['me', 'them'] as const) {
      const pcm = channelOf(wav, side)
      for (let at = 0; at < pcm.length; at += chunk) {
        deps.signal?.throwIfAborted()
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
          const kept = heardSegments(result.segments ?? [], slice, MEETING_SAMPLE_RATE)
          unheard += kept.unheard
          segments.push(
            ...segmenter.push(side, { segments: kept.heard, words: result.tokens ?? [] }, fromMs)
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
    // Always, even when the pass threw or was stopped. The model your settings
    // name goes back - never a snapshot of whatever was loaded - and it is
    // confirmed, because a swap queued behind a dictation only happens once
    // that dictation ends.
    deps.onProgress({ meetingId, stage: 'restoring', doneSec: meetingSec, totalSec: meetingSec })
    try {
      await deps.supervisor.switchModel('whisper', deps.restoreModelId)
      await deps.supervisor.start('llama')
      restored = await deps.supervisor.whenModel('whisper', deps.restoreModelId)
      if (!restored) {
        console.error(`[repass] ${deps.restoreModelId} was not confirmed back on the card`)
      }
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
  return {
    segments,
    seconds: Math.round((Date.now() - started) / 1000),
    languages,
    unheard,
    restored,
  }
}
