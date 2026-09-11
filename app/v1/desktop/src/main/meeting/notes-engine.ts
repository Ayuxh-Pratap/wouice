import {
  estimateTokens,
  MEETING_CHUNK_SYSTEM,
  MEETING_NOTES_SYSTEM,
  MEETING_NOTES_TASKS_SYSTEM,
  MEETING_TASK_PLACE_SYSTEM,
  MEETING_TASK_WRITEUP_SYSTEM,
  MEETING_WORK_ITEMS_SYSTEM,
  type LlmClient,
} from '@wouice/llm'
import {
  allFailed,
  assembleCondensed,
  chunkTranscript,
  contentWords,
  isMine,
  jobGroups,
  keepEnds,
  linesFor,
  mergeOverlapping,
  parseNoteTasks,
  parsePlacement,
  parseWorkItems,
  parseWriteUp,
  placeByWording,
  placeInput,
  placeItem,
  reduceInput,
  renderChunk,
  renderLine,
  resolveOwner,
  sameTitle,
  writeUpInput,
  type Chunk,
  type ChunkOutcome,
  type Evidence,
  type Group,
  type Job,
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
   * Work items found, dropped for not being traceable to a line or not saying
   * what, folded into another item as the same work, and dropped as turned
   * down or already done. Found is those three plus the tasks kept.
   */
  candidates: number
  filtered: number
  merged: number
  rejected: number
  ms: number
}

export interface NotesInput {
  lines: readonly TranscriptLine[]
  /** What the person typed during the call. May be empty. */
  scratch: string
  startedAt: number
  /** Who recorded the meeting, so a task given to them by name is theirs. */
  me?: { name: string }
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
const MAX_NOTES_TOKENS = 900
/** Headroom for chat-template tokens the prompt text does not show. */
const SAFETY_MARGIN = 150
/** How many times condensed output may be condensed again before giving up. */
const MAX_FOLDS = 2
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

    // The budget, from what will actually be sent. Each chunk goes to two
    // prompts; it has to fit beside the larger of them and its answer.
    const reserved = Math.max(
      (await this.count(MEETING_CHUNK_SYSTEM)) + MAX_CHUNK_TOKENS,
      (await this.count(MEETING_WORK_ITEMS_SYSTEM)) + 24 + MAX_ITEMS_TOKENS
    )
    const budget = CONTEXT_TOKENS - reserved - SAFETY_MARGIN

    const costs = await this.costs(usable)
    const chunks = chunkTranscript(usable, budget, (text) => costs.get(text) ?? padded(text))

    const outcomes: ChunkOutcome[] = []
    const found: WorkItem[] = []
    let dropped = 0
    const date = new Date(input.startedAt).toISOString().slice(0, 10)

    for (const [index, chunk] of chunks.entries()) {
      input.signal?.throwIfAborted()
      const rendered = renderChunk(chunk)

      input.onProgress?.({ stage: 'condensing', chunk: index + 1, chunks: chunks.length })
      outcomes.push({
        chunk,
        text: await this.tryComplete(MEETING_CHUNK_SYSTEM, rendered, MAX_CHUNK_TOKENS, input.signal),
      })

      input.onProgress?.({ stage: 'extracting', chunk: index + 1, chunks: chunks.length })
      const raw = await this.tryComplete(
        MEETING_WORK_ITEMS_SYSTEM,
        `Meeting date: ${date}\n\n${rendered}`,
        MAX_ITEMS_TOKENS,
        input.signal
      )
      if (raw !== null) {
        // Only THIS chunk's lines: the model can only cite, and quote from,
        // what it was actually shown.
        const parsed = parseWorkItems(raw, chunk.lines)
        found.push(...parsed.items)
        dropped += parsed.dropped
      }
    }

    if (allFailed(outcomes)) {
      throw new NotesUnavailable(this.explain('the model could not summarise any part of this meeting'))
    }

    found.push(...(await this.fromNotes(input, date)))
    const built = await this.buildTasks(found, usable, input, date)

    // The reduce step has to fit too: its own prompt, the person's notes and
    // room for the answer come out of the same 4096.
    const reduceTarget =
      CONTEXT_TOKENS -
      (await this.count(MEETING_NOTES_SYSTEM)) -
      (await this.count(input.scratch)) -
      MAX_NOTES_TOKENS -
      SAFETY_MARGIN -
      40
    const condensed = await this.fold(assembleCondensed(outcomes), reduceTarget, input)

    input.onProgress?.({ stage: 'writing', chunk: 0, chunks: chunks.length })
    const notes = await this.tryComplete(
      MEETING_NOTES_SYSTEM,
      reduceInput(condensed, input.scratch, new Date(input.startedAt)),
      MAX_NOTES_TOKENS,
      input.signal
    )
    if (notes === null || !notes.trim()) {
      throw new NotesUnavailable(this.explain('the model could not write the final notes'))
    }

    const failed = outcomes.filter((o) => o.text === null)
    return {
      notesMd: notes.trim(),
      tasks: built.tasks,
      chunks: chunks.length,
      failedChunks: failed.length,
      coveredLines: outcomes
        .filter((o) => o.text !== null)
        .reduce((n, o) => n + o.chunk.lines.length, 0),
      totalLines: usable.length,
      gapsAt: failed.map((o) => ({ fromMs: o.chunk.startMs, toMs: o.chunk.endMs })),
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
      const raw = await this.tryComplete(
        MEETING_TASK_WRITEUP_SYSTEM,
        writeUpInput(members, cited, date),
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
      const owner =
        resolveOwner(written?.owner ?? null, speaker, said, speakerName) ??
        resolveOwner(lead.owner, speaker, said, speakerName)

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

  /**
   * Condense the condensed notes, when there are too many of them.
   *
   * A one hour meeting fits the reduce step comfortably once each chunk is
   * condensed. A three hour one does not, and without this the reduce call
   * would silently lose whatever did not fit - the exact failure map-reduce
   * exists to prevent, reappearing one level up.
   */
  private async fold(condensed: string, target: number, input: NotesInput): Promise<string> {
    let text = condensed
    for (let depth = 0; depth < MAX_FOLDS; depth++) {
      if ((await this.count(text)) <= target) return text
      const parts = splitParagraphs(text, Math.floor(target / 1.2))
      const folded: string[] = []
      for (const part of parts) {
        input.signal?.throwIfAborted()
        const result = await this.tryComplete(MEETING_CHUNK_SYSTEM, part, MAX_CHUNK_TOKENS, input.signal)
        folded.push(result ?? part)
      }
      text = folded.join('\n\n')
    }
    // Still too long after folding twice. Truncating is a visible loss and the
    // alternative is an invisible one.
    if ((await this.count(text)) > target) {
      const keep = Math.floor(target * 2.5)
      return `${text.slice(0, keep)}\n\n_[the rest could not be condensed enough to fit; read the transcript]_`
    }
    return text
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

/** Split on blank lines, filling to a token budget. Never mid-paragraph. */
function splitParagraphs(text: string, budget: number): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim())
  const parts: string[] = []
  let current: string[] = []
  let tokens = 0

  for (const paragraph of paragraphs) {
    const cost = padded(paragraph)
    if (current.length > 0 && tokens + cost > budget) {
      parts.push(current.join('\n\n'))
      current = []
      tokens = 0
    }
    current.push(paragraph)
    tokens += cost
  }
  if (current.length > 0) parts.push(current.join('\n\n'))
  return parts
}

export type { Chunk, ParsedTask, TranscriptLine }
