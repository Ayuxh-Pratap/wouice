/**
 * The record types, defined once, here.
 *
 * The desktop's IPC layer re-exports these rather than declaring its own copy.
 * That is not tidiness: the last time a shape was declared in two places and
 * bridged with a cast, one side was missing three fields, the gap became
 * `undefined` at runtime, a comparison against it became NaN, and speech
 * detection silently never fired. One definition, no cast.
 */

/** Which dictionary rules fired, and how often. */
export interface AppliedRule {
  from: string
  to: string
  count: number
}

/** Why the recording ended, and what the audio looked like while it ran. */
export interface CaptureDiagnostics {
  stoppedBy: 'silence' | 'hotkey' | 'cap' | 'unknown'
  speechMs: number
  silenceMs: number
  longestPauseMs: number
  windowMs: number
  chunkAfterMs: number
  chunkPauseMs: number
  peakRms?: number
  meanSpeechRms?: number
  thresholdRms?: number
}

/**
 * One dictation, start to finish.
 *
 * The text of every stage is kept, because when output is wrong the only
 * question worth asking is WHICH stage got it wrong - a mishearing, an
 * over-eager dictionary rule and a model taking liberties need completely
 * different fixes. These are your transcripts on your own disk, which is a
 * deliberate choice for a local single-user tool, and they never leave it.
 */
export interface DictationRecord {
  /** Assigned by the database. Absent until inserted. */
  id?: number
  at: number
  audioMs: number
  asrMs: number
  llmMs: number
  totalMs: number
  chunks: number
  asrModel: string
  llmModel: string
  language: string
  rawChars: number
  finalChars: number
  corrections: number
  degraded: string | null
  /** Straight out of the recogniser, joined across chunks. */
  raw: string
  /** After the deterministic dictionary pass. */
  corrected: string
  /** The real request: instruction and text, not just the text. */
  sentSystem: string
  sentUser: string
  /** Exactly what came back, before any plausibility check. */
  received: string
  applied: AppliedRule[]
  capture: CaptureDiagnostics | null
  /** Retained WAV, when audio retention is on. */
  audioPath: string | null
  /** True when the text reached the cursor, false when it only reached the clipboard. */
  inserted: boolean
  /** How: 'paste', 'type', or 'copy'. */
  delivery: string
  /** Which application it went to. Empty when it went nowhere. */
  targetExe: string
  /** Why it was not inserted, when it was not. Empty on a clean paste. */
  deliveryNote: string
}

export interface ResourceRecord {
  at: number
  vramUsedMiB: number
  vramTotalMiB: number
  rssMiB: number
}

/** One calibration run, kept whether or not it was accepted. */
export interface CalibrationRecord {
  id?: number
  at: number
  device: string
  quality: 'good' | 'weak' | 'unusable'
  silenceLevel: number
  speechLevel: number
  separation: number
  threshold: number
  minNoiseFloor: number
  speechFactor: number
  /** False when the user looked at the result and chose not to take it. */
  applied: boolean
  samples: { label: string; text: string; language: string; durationMs: number }[]
}

export interface Page<T> {
  rows: T[]
  /** Total matching rows, not the page size. Pagination needs the whole count. */
  total: number
  offset: number
  limit: number
}

/**
 * One rule in the user's own dictionary.
 *
 * `term` biases the recogniser before transcription and promises nothing.
 * `correction` rewrites the text afterwards and is the half that guarantees
 * anything - which is also why it is the half that can do damage.
 */
export interface DictionaryRecord {
  id?: number
  kind: 'term' | 'correction'
  /** The trigger, as the recogniser produces it. */
  hear: string
  /** What to write instead. Empty for a term. */
  write: string
  enabled: boolean
  /** How often it has fired. A rule at zero after months is probably wrong. */
  hits: number
  createdAt: number
}

/**
 * Your verdict on one dictation. See `Ratings` and acceptance criterion A4.
 */
export interface RatingRecord {
  dictationAt: number
  /** Would you have shipped this text as it came out? */
  ship: boolean
  /** Optional, and the valuable half of a "no". */
  note: string
  at: number
}

/** How far along A4 is, counted in SQL over everything rated. */
export interface RatingProgress {
  rated: number
  shipped: number
  /** The same two counts over the non-English dictations A4 actually asks about. */
  hinglishRated: number
  hinglishShipped: number
  sampleTarget: number
  shipTarget: number
  met: boolean
}

/* ---------------------------------------------------------- meetings ---- */

/** Which side of the call. Decided by capture topology, never by a model. */
export type MeetingChannel = 'me' | 'them'

export interface MeetingRecord {
  id: number
  startedAt: number
  /** Null means it never reached a clean stop. */
  endedAt: number | null
  title: string | null
  attendees: string[]
  /** The session directory. Unique, and the audio's home. */
  dir: string
  audioPath: string | null
  durationMs: number
  /** What you typed during the call. */
  scratchMd: string
  notesMd: string | null
  /** What happened while it was recorded. See `MeetingDiagnostics`. */
  diagnostics: MeetingDiagnostics
  /** How many transcript segments it has. */
  segments: number
}

export interface SegmentInput {
  channel: MeetingChannel
  startMs: number
  endMs: number
  text: string
  echo: boolean
}

export interface SegmentRecord extends SegmentInput {
  id: number
  meetingId: number
}

export type TaskState = 'open' | 'done' | 'dropped'

export interface TaskInput {
  text: string
  owner: string | null
  /** ISO date, or null when none was said. Never guessed. */
  due: string | null
  /**
   * The segment this was taken from.
   *
   * Not optional by accident. A task you cannot trace back to the moment it was
   * said is one you have to take on faith, and the first wrong one teaches you
   * to distrust every other.
   */
  segmentId: number
}

export interface TaskRecord extends TaskInput {
  id: number
  meetingId: number
  state: TaskState
  createdAt: number
  /** What was actually said. Joined from the segment it cites. */
  quote: string | null
  quoteAtMs: number | null
}

/**
 * What happened while a meeting was recorded, kept per meeting.
 *
 * WHY IT IS STORED. A meeting is an hour long and happens once. When the
 * transcript comes out wrong the question is always "which step failed", and a
 * console line that scrolled past during the call cannot answer it.
 *
 * Every field is optional and unknown keys are preserved, so a new one can be
 * recorded without a migration.
 */
export interface MeetingDiagnostics {
  asrModel?: string
  llmModel?: string
  /** Transcription chunks sent to the speech model, and how many failed. */
  chunksSent?: number
  chunksFailed?: number
  /** Chunks that were silence and were never sent to the model. */
  chunksSkipped?: number
  /** The language every chunk after the first was forced to. */
  language?: string
  segments?: number
  channels?: { channel: MeetingChannel; samples: number; problem: string | null }[]
  /** How far the two channels' clocks drifted apart, in milliseconds. */
  skewMs?: number | null
  driftPpm?: { me: number | null; them: number | null }
  /** True when the merge ran without a manifest, so alignment is approximate. */
  recoveredWithoutManifest?: boolean
  /** One entry per notes run, newest last. */
  notes?: {
    at: number
    ok: boolean
    chunks: number
    gaps: number
    tasks: number
    ms: number
    message?: string
  }[]
  [key: string]: unknown
}
