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
 * Your vocabulary: the names and words your meetings and dictation use.
 * See `Vocabulary` and docs/design/09-vocabulary.md.
 */
export type VocabularyKind = 'person' | 'product' | 'tool' | 'term' | 'place'

/** In the order the page shows them. */
export const VOCABULARY_KINDS: readonly VocabularyKind[] = ['person', 'product', 'tool', 'term', 'place']

/** you: added or changed by hand. roster: from a Meet call's participant list. learned: a suggestion you accepted. shipped: came with the app. */
export type VocabularySource = 'you' | 'roster' | 'learned' | 'shipped'

/** active: used. suggested: waiting for your yes. rejected: "not a word", and never suggested again. */
export type VocabularyState = 'active' | 'suggested' | 'rejected'

/**
 * What an entry tends to be misheard as - "Lord" and "लॉर्ड" for Claude.
 *
 * `rewrite` makes it a guaranteed replacement in dictation. Only for a
 * sound-alike that is never a real word: "coin" is one, so for Qwen it hints
 * and never rewrites.
 */
export interface VocabularyAlias {
  text: string
  rewrite: boolean
}

export interface VocabularyEntry {
  id: number
  /** The spelling to use. */
  term: string
  kind: VocabularyKind
  aliases: VocabularyAlias[]
  /** One line on what it is, for the notes: "the team's knowledge-base document". */
  meaning: string
  source: VocabularySource
  state: VocabularyState
  /** Sent with every request, whatever the text. */
  pinned: boolean
  /** Times a dictation rewrite of it fired. */
  hits: number
  /** Meetings that mentioned it, and when the last did. */
  meetings: number
  lastSeenAt: number | null
  createdAt: number
  updatedAt: number
}

/** What you set on an entry. The rest is kept by the app. */
export interface VocabularyInput {
  term: string
  kind: VocabularyKind
  aliases: VocabularyAlias[]
  meaning: string
  pinned: boolean
  source: VocabularySource
  state: VocabularyState
}

/** 'new': a name or word not in your vocabulary. 'heard': what one of its entries seems to be misheard as. */
export type SuggestionType = 'new' | 'heard'

/** candidate: kept quietly until it earns a place. suggested: waiting for you. accepted. rejected: "not a word", for good. */
export type SuggestionState = 'candidate' | 'suggested' | 'accepted' | 'rejected'

/** Where a suggestion was seen: one line of one meeting, quoted exactly. */
export interface SuggestionEvidence {
  meetingId: number
  quote: string
  at: number
}

export interface VocabularySuggestion {
  id: number
  type: SuggestionType
  /** The new word, or - for 'heard' - the entry it is a sound-alike of. */
  term: string
  /** The sound-alike, for 'heard'. Empty for 'new'. */
  heard: string
  kind: VocabularyKind
  evidence: SuggestionEvidence[]
  /** Meetings it was seen in. */
  meetings: number
  state: SuggestionState
  createdAt: number
  updatedAt: number
}

/** What the mining step found, once. */
export interface SuggestionInput {
  type: SuggestionType
  term: string
  heard?: string
  kind?: VocabularyKind
  meetingId: number
  quote: string
  /** Backed by something outside the transcript: the call's participant list, your notes. */
  corroborated?: boolean
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
  /** What you typed during the call. Shared by every version. */
  scratchMd: string
  /** The main version's summary. */
  notesMd: string | null
  /** Which kind of meeting: see `MeetingKind` in shared. */
  kind: string
  /** What happened while it was recorded. See `MeetingDiagnostics`. */
  diagnostics: MeetingDiagnostics
  /** How many lines the main version's transcript has. */
  segments: number
  /** The version read by default: tasks are ticked on it, search looks through it. */
  mainVersionId: number | null
  /** Every transcript made of this meeting, oldest first. */
  versions: VersionRecord[]
}

/** The source of the transcript written during the call. */
export const LIVE_SOURCE = 'live'

/** The source of a transcript taken from Google Meet's own captions, by the meeting bot. */
export const MEET_CAPTIONS_SOURCE = 'meet-captions'

/** What happened to one version: how it was transcribed, rendered and summarised. */
/**
 * What the vocabulary did to one English run, entry by entry: how many lines
 * said it (as spelled, a heard-as, or by sound), how many the English wrote it
 * in, and the lines it was written in though nothing said there sounded like
 * it - the ones to check for a name put where nobody said it.
 * See docs/design/09-vocabulary.md §7.
 */
export interface VocabularyUse {
  at: number
  /** Entries sent with at least one request. */
  sent: number
  entries: {
    term: string
    /** Lines that said it. */
    said: number
    /** Lines whose English writes it, spelled as the entry is. */
    written: number
    /** The heard-as forms found in what was said: "Lord", "लॉर्ड". */
    as: string[]
    /** How many lines wrote it without anything said there, or just before, sounding like it. */
    unheard: number
    /** The first few of those. */
    check: { atMs: number; said: string; written: string }[]
  }[]
}

export interface VersionDiagnostics {
  /** What the vocabulary did to the English, when a vocabulary was sent. */
  vocabulary?: VocabularyUse
  /** The step after the notes that looks for new names: what it found, and what it put in front of you. */
  mining?: { at: number; found: number; suggested: number; ms: number }
  /** How a version made after the call was transcribed. Absent on the live one. */
  transcription?: {
    at: number
    model: string
    segments: number
    ms: number
    /** How many chunks were sent to the model as each language. */
    languages?: Record<string, number>
    /** Lines written over silence and dropped. */
    unheard?: number
    /** Whether the everyday speech model was confirmed back on the card afterwards. */
    restored?: boolean
  } | null
  english?: MeetingDiagnostics['english'] | null
  notes?: MeetingDiagnostics['notes'] | null
  [key: string]: unknown
}

/**
 * One transcript of a meeting, and everything built from it.
 *
 * The transcript, its English rendering, the summary and the tasks all belong
 * to exactly one version. Showing one version's summary above another's
 * transcript is the confusion versions exist to remove.
 */
export interface VersionRecord {
  id: number
  meetingId: number
  /** `LIVE_SOURCE` for the transcript written during the call, else the model that made it. */
  source: string
  createdAt: number
  /** Null until a summary has been written from THIS transcript. */
  notesMd: string | null
  diagnostics: VersionDiagnostics
  segments: number
  main: boolean
}

export interface SegmentInput {
  channel: MeetingChannel
  startMs: number
  endMs: number
  /** What was said, as the recogniser heard it. Never rewritten. */
  text: string
  echo: boolean
  /**
   * Who said it, by name, when the transcript knows. Meet's captions do; two
   * channels of local audio only know "you" and "them".
   */
  speaker?: string | null
}

export interface SegmentRecord extends SegmentInput {
  id: number
  meetingId: number
  /**
   * The same line rendered into English, or null when it has not been.
   *
   * Alongside `text`, never instead of it. The raw line is what settles a
   * disagreement about what was said; this is what makes it readable.
   */
  textEn: string | null
  speaker: string | null
}

export type TaskState = 'open' | 'done' | 'dropped'

/** Which part of the work a task belongs to. */
export type TaskArea = 'frontend' | 'backend' | 'design' | 'product' | 'business' | 'ops' | 'other'

/** What sort of work it is. */
export type TaskKind =
  | 'feature'
  | 'bug'
  | 'change'
  | 'research'
  | 'content'
  | 'followup'
  | 'chore'
  | 'other'

/** Where the meeting landed on a task. Empty for tasks from before this was recorded. */
export type TaskStatus = 'agreed' | 'proposed' | ''

/** A line of the transcript a task came from. */
export interface TaskEvidence {
  segmentId: number
  /** The words quoted from it; empty when the line was cited without a quote. */
  quote: string
  /** When it was said. Null when the line is gone. */
  atMs: number | null
  /** The line itself, in English where there is one. Null when the line is gone. */
  line: string | null
}

export const TASK_AREAS: readonly TaskArea[] = [
  'frontend',
  'backend',
  'design',
  'product',
  'business',
  'ops',
  'other',
]
export const TASK_KINDS: readonly TaskKind[] = [
  'feature',
  'bug',
  'change',
  'research',
  'content',
  'followup',
  'chore',
  'other',
]

export interface TaskInput {
  text: string
  owner: string | null
  /** ISO date, or null when none was said. Never guessed. */
  due: string | null
  /**
   * The segment this was taken from, or null for a task from your own notes.
   *
   * A task you cannot trace back to something is one you have to take on
   * faith, and the first wrong one teaches you to distrust every other - so a
   * task with no segment must carry `noteQuote` instead.
   */
  segmentId: number | null
  area?: TaskArea
  kind?: TaskKind
  /** Yours to do: assigned to the person recording, by role or by name. */
  mine?: boolean
  source?: 'transcript' | 'notes'
  /** The words from your notes, when that is where it came from. */
  noteQuote?: string | null
  /** Why it was judged a real commitment. */
  reason?: string
  /**
   * A state carried over from another version. Without one, a task keeps the
   * state it had under the same wording in its own version, or starts open.
   */
  state?: TaskState
  /** The source of the version this was carried from, when it was. */
  carriedFrom?: string | null
  /** The story: what exactly, how it should work, and why - from what was said. */
  description?: string
  /** Every line it came from. */
  evidence?: { segmentId: number; quote: string }[]
  status?: TaskStatus
}

export interface TaskRecord extends TaskInput {
  id: number
  meetingId: number
  versionId: number | null
  carriedFrom: string | null
  state: TaskState
  createdAt: number
  area: TaskArea
  kind: TaskKind
  mine: boolean
  source: 'transcript' | 'notes'
  reason: string
  /** What was actually said. Joined from the segment it cites. */
  quote: string | null
  quoteAtMs: number | null
  description: string
  /** Every line it came from, with when and what was said. */
  evidence: TaskEvidence[]
  status: TaskStatus
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
  /** Lines the speech model wrote over silence, dropped by their own audio level. */
  segmentsUnheard?: number
  /** The language every chunk after the first was forced to. */
  language?: string
  segments?: number
  channels?: { channel: MeetingChannel; samples: number; problem: string | null }[]
  /** How far the two channels' clocks drifted apart, in milliseconds. */
  skewMs?: number | null
  driftPpm?: { me: number | null; them: number | null }
  /** True when the merge ran without a manifest, so alignment is approximate. */
  recoveredWithoutManifest?: boolean
  /** The English rendering pass, when it has run. */
  english?: {
    at: number
    rendered: number
    missed: number
    failedBatches: number
    ms: number
    /** The language model that wrote it. Absent on runs from before this was kept. */
    model?: string
    /** False when the pass failed outright; `message` says why. */
    ok?: boolean
    message?: string
  }
  /** The careful re-transcription, when it has been run. */
  repass?: { at: number; model: string; segments: number; ms: number }
  /** One entry per notes run, newest last. */
  notes?: {
    at: number
    ok: boolean
    /** The language model that wrote them. Absent on runs from before this was kept. */
    model?: string
    chunks: number
    gaps: number
    tasks: number
    ms: number
    message?: string
    /** How much of the transcript the summary was actually built from. */
    coveredLines?: number
    totalLines?: number
    /** The stretches that could not be read. */
    gapsAt?: { fromMs: number; toMs: number }[]
    /**
     * Proposed, dropped by the word filter, merged as the same task said twice,
     * refused by the checker. Proposed is the sum of the other three and kept.
     */
    candidates?: number
    filtered?: number
    merged?: number
    rejected?: number
    /** The vocabulary entries sent with the notes' requests. */
    vocabulary?: string[]
  }[]
  [key: string]: unknown
}
