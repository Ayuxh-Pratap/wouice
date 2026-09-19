import {
  estimateTokens,
  MEETING_GIST_SYSTEM,
  MEETING_POINTS_SYSTEM,
  MEETING_NOTES_TASKS_SYSTEM,
  MEETING_TASK_PLACE_SYSTEM,
  MEETING_TASK_WRITEUP_SYSTEM,
  MEETING_WORK_ITEMS_SYSTEM,
  type LlmClient,
} from '@wouice/llm'
import type { CheckedSummary, SummaryStats } from '@wouice/store'
import {
  allFailed,
  buildSummary,
  chunkTranscript,
  contentWords,
  dedupePoints,
  gistInput,
  glossaryOf,
  glossaryReference,
  isMine,
  jobGroups,
  keepEnds,
  linesFor,
  mergeOverlapping,
  offerPoints,
  parseNoteTasks,
  parsePoints,
  parsePlacement,
  parseWorkItems,
  parseWriteUp,
  placeByWording,
  placeInput,
  placeItem,
  renderChunk,
  renderLine,
  resolveOwner,
  committedOwner,
  sameTitle,
  summaryMarkdown,
  writeUpInput,
  type Chunk,
  type ChunkOutcome,
  type GlossarySource,
  type Evidence,
  type Group,
  type Job,
  type KeyPoint,
  type ParsedTask,
  type TranscriptLine,
  type WorkItem,
} from './notes.js'

/**
 * Notes and tasks for one meeting, after it has ended.
 *
 * NO LATENCY BUDGET, AND THAT CHANGES THE DESIGN. Dictation is a two second
 * interaction and every millisecond is argued over. This runs once, on a
 * transcript nobody is waiting on with their cursor in a text field, so it can
 * afford to be careful: separate calls for prose and for structured data, and
 * several narrow calls rather than one broad one wherever a small model does
 * better that way.
 *
 * IT MEASURES BEFORE IT SENDS. The first version estimated chunk sizes from a
 * character count calibrated on dictation. On a real hour-long meeting that
 * estimate was out by 1.5 to 1.8x, three of four chunks overflowed the model's
 * context, and the summary came from the last six minutes - while reporting
 * success. The model's own tokenizer is asked, and the budget comes from the
 * prompts that will actually be sent.
 *
 * TASKS ARE WORK, FOUND IN THREE STEPS. Each part lists the work that came out
 * of it, each item quoting a line it cites. One whole-meeting pass groups the
 * same work found in different parts and says where the meeting landed on it,
 * so an idea proposed early and replaced later is dropped rather than kept.
 * Each surviving group is then written up on its own, from its own lines. See
 * `notes.ts` for what a task is and why it changed.
 *
 * A FAILED CHUNK IS A GAP, NOT A FAILED RUN, AND THE GAP IS REPORTED. Only a run
 * where every chunk failed is a failure. Anything else produces notes with the
 * missing stretch marked, and returns exactly which minutes were not read.
 */

export interface NotesProgress {
  stage: 'condensing' | 'extracting' | 'checking' | 'writing'
  /** 1-based, and 0 when the step is not per-chunk. */
  chunk: number
  chunks: number
}

export interface NotesRun {
  notesMd: string
  tasks: ParsedTask[]
  chunks: number
  failedChunks: number
  /** How much of the transcript the summary was built from. */
  coveredLines: number
  totalLines: number
  /** The stretches that could not be read, so the gap can be named. */
  gapsAt: { fromMs: number; toMs: number }[]
  /**
   * The stretches whose tasks could not be read: the tasks step failed there,
   * though the key points were read. Silent before - no tasks from that part,
   * and the run still said it had read the whole meeting.
   */
  tasksGapsAt: { fromMs: number; toMs: number }[]
  /**
   * Work items found, dropped for not being traceable to a line or not saying
   * what, folded into another item as the same work, and dropped as turned
   * down or already done. Found is those three plus the tasks kept.
   */
  candidates: number
  filtered: number
  merged: number
  rejected: number
  ms: number
  /** Why a part could not be read, when one could not: the last failed request's reason. */
  failure?: string
  /** The summary checked against what was said; `notesMd` is the same written out. */
  summary: CheckedSummary
  summaryStats: SummaryStats
}

export interface NotesInput {
  lines: readonly TranscriptLine[]
  /** What the person typed during the call. May be empty. */
  scratch: string
  startedAt: number
  /** Who recorded the meeting, so a task given to them by name is theirs. */
  me?: { name: string }
  /** Your vocabulary: a fixed list, or what a stretch of text calls for. See `glossaryFor`. */
  glossary?: GlossarySource
  onProgress?(progress: NotesProgress): void
  signal?: AbortSignal
}

/** Asks the model's own tokenizer. Null when it cannot, and the estimate is used. */
export type TokenCounter = (text: string) => Promise<number | null>

export class NotesUnavailable extends Error {}

/** What the local model runs with. See `desktop/src/shared/models.ts`. */
const CONTEXT_TOKENS = 4096
const MAX_CHUNK_TOKENS = 700
/** Work items carry a story each; a busy ten minutes can hold six of them. */
const MAX_ITEMS_TOKENS = 1100
/** One small JSON answer: which job, and how. */
const MAX_PLACE_TOKENS = 40
const MAX_WRITEUP_TOKENS = 450
/** Ten key points at most, each a sentence with its lines and a quote. */
const MAX_POINTS_TOKENS = 1000
/** Which points to show, and two or three sentences. */
const MAX_GIST_TOKENS = 500
/** Headroom for chat-template tokens the prompt text does not show. */
const SAFETY_MARGIN = 150
/** Generous: this is a backstop for a stopped model, not a prediction. */
const STALL_MS = 20_000
/**
 * When the tokenizer cannot be asked: the estimate, padded to the worst ratio
 * measured on a real meeting. Wrong in the safe direction.
 */
const FALLBACK_FACTOR = 1.9
/** Parallel tokenizer calls. They are tiny, and there are hundreds of lines. */
const TOKENIZE_WORKERS = 6
/** Lines kept on a task as where it came from. */
const MAX_EVIDENCE = 8
/**
 * Words of substance a task's own lines must hold between them. "Search
 * needed" is a mention, not work: asked to write it up, the model invents the
 * rest - which is how a live call's only task came from two words. Checked in
 * code, because the prompt already asked and the model wrote it up anyway.
 */
const MIN_TASK_BASIS = 5

export class MeetingNotesEngine {
  /** Why the last model call failed, so a failed run can say why. */
  private lastFailure: string | null = null

  constructor(
    private readonly llm: () => LlmClient,
    private readonly countTokens?: TokenCounter
  ) {}

  async generate(input: NotesInput): Promise<NotesRun> {
    const started = Date.now()
    this.lastFailure = null
    const usable = input.lines.filter((line) => !line.echo && line.text.trim())
    if (usable.length === 0) {
      throw new NotesUnavailable('there is no transcript to write notes from')
    }

    // The vocabulary a stretch of text calls for goes in front of every request
    // that reads the transcript, so its size comes out of every budget below -
    // sized from the whole meeting, which calls for as much as any part does.
    const referenceFor = (text: string): string => glossaryReference(glossaryOf(input.glossary, text))
    const referenceCost = await this.count(referenceFor(usable.map((line) => line.text).join('\n')))

    // The budget, from what will actually be sent. Each chunk goes to two
    // prompts; it has to fit beside the larger of them and its answer.
    const reserved =
      referenceCost +
      Math.max(
        (await this.count(MEETING_POINTS_SYSTEM)) + MAX_POINTS_TOKENS,
        (await this.count(MEETING_WORK_ITEMS_SYSTEM)) + 24 + MAX_ITEMS_TOKENS
      )
    const budget = CONTEXT_TOKENS - reserved - SAFETY_MARGIN

    const costs = await this.costs(usable)
    const chunks = chunkTranscript(usable, budget, (text) => costs.get(text) ?? padded(text))

    const outcomes: ChunkOutcome[] = []
    const found: WorkItem[] = []
    const points: KeyPoint[] = []
    const tally = { found: 0, badQuote: 0, offTopic: 0 }
    let dropped = 0
    const tasksMissed: { fromMs: number; toMs: number }[] = []
    const date = new Date(input.startedAt).toISOString().slice(0, 10)

    for (const [index, chunk] of chunks.entries()) {
      input.signal?.throwIfAborted()
      const rendered = renderChunk(chunk)

      // This part's key points, each with the lines it came from - kept only
      // when those lines say it. See `parsePoints`.
      input.onProgress?.({ stage: 'condensing', chunk: index + 1, chunks: chunks.length })
      const reference = referenceFor(rendered)
      const said = await this.tryComplete(MEETING_POINTS_SYSTEM, reference + rendered, MAX_POINTS_TOKENS, input.signal)
      outcomes.push({ chunk, text: said })
      if (said !== null) {
        const checked = parsePoints(said, chunk.lines)
        points.push(...checked.points)
        tally.found += checked.found
        tally.badQuote += checked.badQuote
        tally.offTopic += checked.offTopic
      }

      input.onProgress?.({ stage: 'extracting', chunk: index + 1, chunks: chunks.length })
      const raw = await this.tryComplete(
        MEETING_WORK_ITEMS_SYSTEM,
        `${reference}Meeting date: ${date}\n\n${rendered}`,
        MAX_ITEMS_TOKENS,
        input.signal
      )
      if (raw !== null) {
        // Only THIS chunk's lines: the model can only cite, and quote from,
        // what it was actually shown.
        const parsed = parseWorkItems(raw, chunk.lines)
        found.push(...parsed.items)
        dropped += parsed.dropped
      } else {
        tasksMissed.push({ fromMs: chunk.startMs, toMs: chunk.endMs })
      }
    }

    if (allFailed(outcomes)) {
      throw new NotesUnavailable(this.explain('the model could not summarise any part of this meeting'))
    }

    found.push(...(await this.fromNotes(input, date)))
    const built = await this.buildTasks(found, usable, input, date)

    // The gist, from the points that held up and nothing else: the model picks
    // which to show and writes two or three sentences, each naming the points
    // it rests on, and code keeps only what it can check. No gist is not a
    // failure - the key points still show. See `buildSummary`.
    const kept = dedupePoints(points)
    const offered = offerPoints(kept)
    let gist: string | null = null
    if (offered.length > 0) {
      input.onProgress?.({ stage: 'writing', chunk: 0, chunks: chunks.length })
      const listed = gistInput(offered, input.scratch, new Date(input.startedAt))
      gist = await this.tryComplete(
        MEETING_GIST_SYSTEM,
        glossaryReference(glossaryOf(input.glossary, listed)) + listed,
        MAX_GIST_TOKENS,
        input.signal
      )
    }
    const { summary, gistWritten } = buildSummary(offered, gist, kept)

    const failed = outcomes.filter((o) => o.text === null)
    return {
      notesMd: summaryMarkdown(summary, built.tasks),
      summary,
      summaryStats: {
        found: tally.found,
        kept: kept.length,
        badQuote: tally.badQuote,
        offTopic: tally.offTopic,
        shown: summary.points.length,
        gistKept: summary.gist.length,
        gistWritten,
      },
      tasks: built.tasks,
      chunks: chunks.length,
      failedChunks: failed.length,
      coveredLines: outcomes
        .filter((o) => o.text !== null)
        .reduce((n, o) => n + o.chunk.lines.length, 0),
      totalLines: usable.length,
      gapsAt: failed.map((o) => ({ fromMs: o.chunk.startMs, toMs: o.chunk.endMs })),
      tasksGapsAt: tasksMissed,
      failure: failed.length > 0 ? (this.lastFailure ?? undefined) : undefined,
      candidates: found.length + dropped,
      filtered: dropped,
      merged: found.length - built.groups,
      rejected: built.rejected,
      ms: Date.now() - started,
    }
  }

  /**
   * Work items from what the person typed during the call.
   *
   * Their notes often say what mattered in one line - "he reported the sign-in
   * dialog sticks" - and they join the grouping like any other item, so the
   * same work found in the transcript and in the notes becomes one task.
   */
  private async fromNotes(input: NotesInput, date: string): Promise<WorkItem[]> {
    if (!input.scratch.trim()) return []
    const raw = await this.tryComplete(
      MEETING_NOTES_TASKS_SYSTEM,
      `Meeting date: ${date}\n\nNotes:\n${input.scratch}`,
      MAX_CHUNK_TOKENS,
      input.signal
    )
    return parseNoteTasks(raw ?? '', input.scratch)
      .filter((note) => contentWords(note.text).size >= 2)
      .map((note) => ({
        title: note.text,
        story: '',
        kind: 'other' as const,
        area: 'other' as const,
        owner: note.owner,
        status: 'proposed' as const,
        evidence: [],
        atMs: null,
        source: 'notes' as const,
        noteQuote: note.quote,
      }))
  }

  /**
   * Group the items found, drop what the meeting turned down, write up the rest.
   *
   * Items are placed one at a time against the jobs found so far, in the order
   * they came up - which is where an idea proposed in minute nine is seen being
   * replaced in minute fourteen. Each task is then written up in its own call,
   * from what was found and the transcript lines themselves.
   */
  private async buildTasks(
    found: readonly WorkItem[],
    lines: readonly TranscriptLine[],
    input: NotesInput,
    date: string
  ): Promise<{ tasks: ParsedTask[]; groups: number; rejected: number }> {
    if (found.length === 0) return { tasks: [], groups: 0, rejected: 0 }
    const name = input.me?.name ?? ''
    const byId = new Map(lines.map((line) => [line.id, line]))

    input.onProgress?.({ stage: 'checking', chunk: 0, chunks: 0 })
    const groups = mergeOverlapping(await this.group(found, input.signal), found)
    const live = groups.filter((g) => g.status === 'agreed' || g.status === 'proposed')

    const tasks: ParsedTask[] = []
    let setAside = 0
    for (const [index, group] of live.entries()) {
      input.signal?.throwIfAborted()
      input.onProgress?.({ stage: 'checking', chunk: index + 1, chunks: live.length })

      const members = group.members.map((i) => found[i]!)
      const evidence = mergedEvidence(members, byId)
      const cited = linesFor(lines, evidence.map((e) => e.segmentId))
      // Work from the transcript needs lines that say something about it. Work
      // from the person's own notes has none, and is theirs to judge.
      if (evidence.length > 0 && contentWords(cited.map((line) => line.text).join(' ')).size < MIN_TASK_BASIS) {
        setAside++
        continue
      }
      const writeUp = writeUpInput(members, cited, date)
      const raw = await this.tryComplete(
        MEETING_TASK_WRITEUP_SYSTEM,
        glossaryReference(glossaryOf(input.glossary, writeUp)) + writeUp,
        MAX_WRITEUP_TOKENS,
        input.signal
      )
      const written = raw === null ? null : parseWriteUp(raw)
      // The write-up reads the lines themselves, and they can say what the
      // items did not: "you're unleashed to talk about them, not on the
      // engineering call". Work its own lines set aside is not a task.
      if (written?.status === 'parked' || written?.status === 'rejected') {
        setAside++
        continue
      }

      // The item the meeting was clearest about stands in for anything the
      // write-up did not manage: agreed over proposed, then the fullest story.
      const lead = [...members].sort(
        (a, b) =>
          Number(b.status === 'agreed') - Number(a.status === 'agreed') ||
          b.story.length - a.story.length
      )[0]!

      // An owner has to be somebody the lines name. See `resolveOwner`.
      const first = evidence[0] ? byId.get(evidence[0].segmentId) : undefined
      const speaker = first?.channel ?? 'notes'
      const speakerName = first?.speaker ?? null
      const said = [...cited.map(renderLine), ...members.map((m) => m.noteQuote ?? '')].join('\n')
      // And when the model named nobody, whoever took it on in so many words.
      const owner =
        resolveOwner(written?.owner ?? null, speaker, said, speakerName) ??
        resolveOwner(lead.owner, speaker, said, speakerName) ??
        committedOwner(cited)

      tasks.push({
        text: written?.title ?? lead.title,
        description:
          written?.description ||
          lead.story ||
          members
            .map((m) => m.story)
            .filter(Boolean)
            .join(' '),
        owner,
        due: null,
        segmentId: evidence[0]?.segmentId ?? null,
        evidence: keepEnds(evidence, MAX_EVIDENCE),
        status: group.status === 'agreed' ? 'agreed' : 'proposed',
        kind: written && written.kind !== 'other' ? written.kind : lead.kind,
        area: written && written.area !== 'other' ? written.area : lead.area,
        source: evidence.length > 0 ? 'transcript' : 'notes',
        noteQuote: members.find((m) => m.noteQuote)?.noteQuote ?? null,
        reason: '',
        mine: isMine(owner, name),
      })
    }

    const folded = foldSameTitles(tasks, byId, name)
    return {
      tasks: folded,
      groups: groups.length - (tasks.length - folded.length),
      rejected: groups.length - live.length + setAside,
    }
  }

  /**
   * Sort the items into jobs, one at a time, in the order they came up: each
   * placed by the model against the jobs found so far, or by wording when the
   * model cannot be asked or its answer cannot be read.
   */
  private async group(found: readonly WorkItem[], signal?: AbortSignal): Promise<Group[]> {
    let jobs: Job[] = []
    for (const next of found.keys()) {
      signal?.throwIfAborted()
      if (jobs.length === 0) {
        jobs = placeItem(jobs, found, next, null, 'new')
        continue
      }
      const { text, shown } = placeInput(jobs, found, next)
      const raw = await this.tryComplete(MEETING_TASK_PLACE_SYSTEM, text, MAX_PLACE_TOKENS, signal)
      const placed = raw === null ? null : parsePlacement(raw, shown.length)
      if (placed === null) {
        const near = placeByWording(jobs, found, next)
        jobs = placeItem(jobs, found, next, near, near === null ? 'new' : 'same')
      } else {
        const target = placed.job === null ? null : shown[placed.job]!
        jobs = placeItem(jobs, found, next, target, placed.relation)
      }
    }
    return jobGroups(jobs, found)
  }

  private async count(text: string): Promise<number> {
    if (!text) return 0
    const real = this.countTokens ? await this.countTokens(text) : null
    return real ?? padded(text)
  }

  /** Every line's real cost, asked once, a few at a time. */
  private async costs(lines: readonly TranscriptLine[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!this.countTokens) return out
    const rendered = lines.map(renderLine)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < rendered.length) {
        const text = rendered[next++]!
        const n = await this.countTokens!(text)
        if (n !== null) out.set(text, n)
      }
    }
    await Promise.all(Array.from({ length: TOKENIZE_WORKERS }, worker))
    return out
  }

  /** A failure message, with the reason the last call gave when there was one. */
  private explain(message: string): string {
    return this.lastFailure ? `${message} (${this.lastFailure})` : message
  }

  /**
   * @returns the model's text, or null when the call failed.
   *
   * Failure is a value here rather than an exception because a single failed
   * chunk must not end the run - and a caller that has to remember to catch is
   * a caller that will one day forget. Why it failed is kept, so a run that
   * fails outright can say so instead of only that it failed.
   */
  private async tryComplete(
    system: string,
    user: string,
    maxTokens: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const inputTokens = estimateTokens(user)
    try {
      const result = await this.llm().complete({
        system,
        user,
        maxTokens,
        // The same transcript should produce the same notes. A meeting summary
        // that changes when you regenerate it is one you cannot cite.
        temperature: 0,
        firstTokenTimeoutMs: Math.max(20_000, inputTokens * 40),
        stallTimeoutMs: STALL_MS,
        timeoutMs: Math.max(60_000, (inputTokens + maxTokens) * 120),
        signal,
      })
      return result.text
    } catch (err) {
      if (signal?.aborted) throw err
      this.lastFailure = err instanceof Error ? err.message : String(err)
      console.warn('[meeting] notes step failed:', this.lastFailure)
      return null
    }
  }
}

/** Every line the members cite, once each, in the order they were said. */
function mergedEvidence(
  members: readonly { evidence?: readonly Evidence[] }[],
  byId: ReadonlyMap<number, TranscriptLine>
): Evidence[] {
  const seen = new Map<number, Evidence>()
  for (const member of members) {
    for (const e of member.evidence ?? []) {
      const known = seen.get(e.segmentId)
      if (!known) seen.set(e.segmentId, { ...e })
      else if (!known.quote && e.quote) known.quote = e.quote
    }
  }
  return [...seen.values()].sort(
    (a, b) => (byId.get(a.segmentId)?.startMs ?? 0) - (byId.get(b.segmentId)?.startMs ?? 0)
  )
}

/**
 * Written-up tasks that are one job, folded together.
 *
 * Two groups the model kept apart can still be the same work - a rename argued
 * at minute four and again at minute seventeen. Once the write-up has named
 * each, they look alike. The one whose lines reach later, closer to the last
 * word on it, tells the story; the lines of both are kept, and it sits where
 * the work first came up.
 */
function foldSameTitles(
  tasks: readonly ParsedTask[],
  byId: ReadonlyMap<number, TranscriptLine>,
  name: string
): ParsedTask[] {
  const reach = (task: ParsedTask): number =>
    Math.max(-1, ...(task.evidence ?? []).map((e) => byId.get(e.segmentId)?.startMs ?? -1))

  const kept: ParsedTask[] = []
  for (const task of tasks) {
    const at = kept.findIndex((k) => sameTitle(k.text, task.text))
    if (at < 0) {
      kept.push(task)
      continue
    }
    const other = kept[at]!
    const [last, first] = reach(task) >= reach(other) ? [task, other] : [other, task]
    const evidence = keepEnds(mergedEvidence([first, last], byId), MAX_EVIDENCE)
    const owner = last.owner ?? first.owner
    kept[at] = {
      ...last,
      owner,
      evidence,
      segmentId: evidence[0]?.segmentId ?? null,
      status: first.status === 'agreed' || last.status === 'agreed' ? 'agreed' : 'proposed',
      source: evidence.length > 0 ? 'transcript' : 'notes',
      noteQuote: last.noteQuote ?? first.noteQuote ?? null,
      mine: isMine(owner, name),
    }
  }
  return kept
}

function padded(text: string): number {
  return Math.ceil(estimateTokens(text) * FALLBACK_FACTOR)
}

export type { Chunk, ParsedTask, TranscriptLine }
