import { isPlausibleCleanup } from '@wouice/llm'

/**
 * What to do with what the language model gave back.
 *
 * PULLED OUT OF THE CONTROLLER so acceptance criterion A8 - "every degradation
 * path exercised at least once and logged with its reason" - can actually be
 * exercised. The rules were four `if`s inside an async method that needs a
 * supervisor, a model server and a microphone to reach, which meant the paths
 * that matter most on a bad day were the only ones no test had ever run.
 *
 * EVERY PATH KEEPS THE TEXT. A dictation has already been spoken by the time
 * this is reached; there is no way to ask for it again. So a failure here
 * always falls back to the words that went in, tagged with why - never an
 * empty insert, never a throw.
 */

export interface CleanupOutcome {
  /** What to actually insert. */
  text: string
  /** Null when the cleanup was used. Otherwise why it was not. */
  degraded: string | null
  /** Exactly what came back, kept for the history whatever we did with it. */
  received: string
}

/** The reply, reduced to the two things the decision depends on. */
export interface CleanupReply {
  text: string
  /**
   * `'length'` means the token cap cut it off mid-sentence.
   *
   * Nullable as well as optional, because that is what the client reports when
   * a server does not send one.
   */
  finishReason?: string | null
}

/** Cleanup is switched off in settings. Not a degradation - a choice. */
export function cleanupDisabled(input: string): CleanupOutcome {
  return { text: input, degraded: null, received: '(cleanup disabled)' }
}

/** The model is not up yet. Common for the first dictation after a launch. */
export function cleanupUnavailable(input: string): CleanupOutcome {
  return { text: input, degraded: 'llm-unavailable', received: '(model not ready)' }
}

/**
 * The call threw: a timeout, a stall, a dead socket.
 *
 * The kind is carried through from the client rather than flattened, so the
 * history distinguishes "it never answered" from "it stopped halfway".
 */
export function cleanupFailed(input: string, err: unknown): CleanupOutcome {
  const kind = (err as { kind?: string }).kind ?? 'llm-failed'
  const detail = err instanceof Error ? err.message : String(err)
  return { text: input, degraded: `llm-${kind}`, received: `(${detail})` }
}

/**
 * The call succeeded. Whether the answer is usable is a different question.
 *
 * Order matters. Truncation is checked first because a cut-off answer can still
 * look plausible - it is a valid prefix of a good transcript - and accepting it
 * would hand somebody a sentence that stops mid-word while looking finished.
 */
export function cleanupSucceeded(input: string, reply: CleanupReply): CleanupOutcome {
  if (reply.finishReason === 'length') {
    return { text: input, degraded: 'llm-truncated', received: reply.text }
  }

  const verdict = isPlausibleCleanup(input, reply.text)
  if (!verdict.ok) {
    return { text: input, degraded: `llm-rejected: ${verdict.reason}`, received: reply.text }
  }

  // An empty answer means the model found it unintelligible. Keeping the raw
  // words beats inserting nothing: the person can read them and decide.
  if (!reply.text.trim()) {
    return { text: input, degraded: 'llm-empty', received: reply.text }
  }

  return { text: reply.text, degraded: null, received: reply.text }
}
