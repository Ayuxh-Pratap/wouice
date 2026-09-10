import type { TaskInput, TaskRecord, TaskState } from '@wouice/store'
import { contentWords, type ParsedTask } from './notes.js'

/**
 * Carrying what you did with tasks from one version of a meeting to the next.
 *
 * THE SAME MEETING SHOULD GIVE THE SAME TASKS. The tasks are found by the same
 * pipeline from two transcripts of one conversation, so a commitment in the
 * first pass should be there in the improved one too - reworded, because the
 * words it was found in are better now, but there. So a task you ticked or
 * dropped keeps that state on its counterpart, and the one thing that must
 * never happen is work you finished quietly reappearing as open.
 *
 * WHAT HAS NO COUNTERPART IS KEPT, MARKED. If the improved transcript does not
 * produce a task you had already acted on, either the first pass invented it or
 * the second missed it. Neither is for this code to decide, so it stays on the
 * list, labelled with where it came from, in the state you left it. Tasks you
 * never touched are not carried: the newer transcript's judgement stands.
 *
 * MATCHED LOOSER THAN "SAID TWICE". Across versions the wording moves more than
 * within one - "check the leader board page" becomes "check the leaderboard
 * page in Safari" - so close in time needs fewer shared words than the
 * duplicate check asks for, and a word split in one transcript and joined in
 * the other counts as the same word. Far apart in time needs nearly the same
 * words.
 */

/** A task the new summary produced, with when its line was said. */
export type NewTask = ParsedTask & { atMs: number | null }

const NEAR_MS = 120_000
const NEAR_WORDS = 0.4
const ANYWHERE_WORDS = 0.7

interface Probe {
  text: string
  atMs: number | null
}

/** Adjacent words joined wherever the other text has them as one word. */
function joinCompounds(words: readonly string[], other: ReadonlySet<string>): Set<string> {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const joined = i + 1 < words.length ? words[i]! + words[i + 1]! : ''
    if (joined && other.has(joined)) {
      out.push(joined)
      i++
    } else {
      out.push(words[i]!)
    }
  }
  return new Set(out)
}

/** Shared words over all words, after "leader board" and "leaderboard" are made one. */
function crossSimilarity(a: string, b: string): number {
  const x = joinCompounds([...contentWords(a)], contentWords(b))
  const y = joinCompounds([...contentWords(b)], x)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / (x.size + y.size - shared)
}

export function sameTaskAcross(a: Probe, b: Probe): boolean {
  const words = crossSimilarity(a.text, b.text)
  const near = a.atMs !== null && b.atMs !== null && Math.abs(a.atMs - b.atMs) <= NEAR_MS
  return words >= (near ? NEAR_WORDS : ANYWHERE_WORDS)
}

/**
 * @param acted every task you ticked or dropped, in any version, most recent
 *   first - so the state you set last is the one that wins.
 * @param sourceOf the source of the version a task came from, for its label.
 */
export function carryOver(
  acted: readonly TaskRecord[],
  next: readonly NewTask[],
  sourceOf: (versionId: number | null) => string
): { tasks: (NewTask & { state?: TaskState })[]; carried: TaskInput[] } {
  const tasks: (NewTask & { state?: TaskState })[] = next.map((task) => ({ ...task }))
  const carried: (TaskInput & { atMs: number | null })[] = []

  for (const old of acted) {
    if (old.state === 'open') continue
    const probe = { text: old.text, atMs: old.quoteAtMs }

    const counterpart = tasks.find((task) => task.state === undefined && sameTaskAcross(probe, task))
    if (counterpart) {
      counterpart.state = old.state
      continue
    }
    // Already on the list, through a newer state or an earlier carry.
    if (tasks.some((task) => sameTaskAcross(probe, task))) continue
    if (carried.some((task) => sameTaskAcross(probe, task))) continue

    carried.push({
      text: old.text,
      owner: old.owner,
      due: old.due,
      segmentId: old.segmentId,
      area: old.area,
      kind: old.kind,
      mine: old.mine,
      source: old.source,
      // The words it came from travel with it, so it can still be checked if
      // the version holding its line is ever replaced.
      noteQuote: old.noteQuote ?? old.quote,
      reason: old.reason,
      description: old.description,
      evidence: old.evidence.map((e) => ({ segmentId: e.segmentId, quote: e.quote })),
      status: old.status,
      state: old.state,
      carriedFrom: old.carriedFrom ?? sourceOf(old.versionId),
      atMs: old.quoteAtMs,
    })
  }

  return { tasks, carried: carried.map(({ atMs: _atMs, ...task }) => task) }
}
