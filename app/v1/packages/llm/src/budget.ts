/**
 * How long the cleanup pass is allowed to take, and how much it may produce.
 *
 * WHY THIS EXISTS. Both numbers used to be constants: a 4000 ms timeout and a
 * 1024-token cap, chosen when every test dictation was ten seconds long. A real
 * 85-second dictation then arrived, and the timeout killed it:
 *
 *     dictation #14 · 218 words · needed 7048 ms · allowed 4000 ms
 *     result: degraded llm-timeout, raw Hinglish delivered instead of English
 *
 * The failure was not that 4000 was too small. It was that a constant cannot be
 * right, because the work scales with what the person said. Cleanup returns
 * roughly what it was given, generation is the dominant cost, and generation is
 * paid per output token. So the budget is computed from the input.
 *
 * Measured on this machine (gemma-3-4b-it Q4_K_M, RTX 3050 6 GB):
 *
 *     generation        ~39 tokens/s, flat across lengths
 *     first token       186-817 ms for inputs up to 275 tokens
 *     25 words          1596 ms      100 words   3418 ms
 *     218 words         7048 ms
 *
 * Pure: no clock, no network. Every number below can be argued with in a test.
 */

export interface CleanupBudget {
  /** Cap on generated tokens. Never the thing that truncates a real dictation. */
  maxTokens: number
  /** Nothing at all yet: covers prompt processing, which scales with input. */
  firstTokenTimeoutMs: number
  /** Gap between tokens. This is a STALL, not slowness. */
  stallTimeoutMs: number
  /** Backstop for a model that streams forever without finishing. */
  totalTimeoutMs: number
}

/**
 * Tokens per character, worst case across the languages this app sees.
 *
 * Measured with the running model's own tokeniser: English 0.19, Devanagari
 * 0.23, romanised Hinglish 0.22. Rounded up, because underestimating the input
 * means underestimating every number derived from it.
 */
const TOKENS_PER_CHAR = 0.25

/**
 * Generation rate assumed when budgeting, in tokens per second.
 *
 * Far below the 39/s measured here, on purpose. This runs on other people's
 * machines - slower GPUs, CPU-only fallbacks, a laptop with something else
 * using the card - and a budget tuned to the fastest machine it was tested on
 * is how the original constant went wrong. Being generous costs nothing when
 * the model is healthy: the stall timeout is what catches a broken one.
 */
const ASSUMED_TOKENS_PER_SECOND = 12

/**
 * Milliseconds of prompt processing to allow per input token, plus a floor.
 *
 * Prompt processing is much faster than generation, but it is not free and it
 * grows with the input, which is exactly what the first-token wait is.
 */
const FIRST_TOKEN_MS_PER_TOKEN = 12
const FIRST_TOKEN_FLOOR_MS = 3_000

/**
 * How long a gap between tokens means the model has stopped, not slowed.
 *
 * At 39 tokens/s they arrive every 26 ms; even a machine ten times slower sends
 * one every 260 ms. Four seconds of nothing is not slow, it is broken - and
 * catching that quickly is the whole reason the original timeout existed.
 */
const STALL_MS = 4_000

/** Cleanup should return about what it was given; this bounds "about". */
const OUTPUT_RATIO = 1.6
const MIN_OUTPUT_TOKENS = 256

export function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR)
}

/**
 * Work out the budget for cleaning this text.
 *
 * `inputTokens` may be passed when the real count is known - the server exposes
 * a tokeniser - and is estimated from length otherwise.
 */
export function cleanupBudget(text: string, inputTokens?: number): CleanupBudget {
  const tokens = Math.max(1, inputTokens ?? estimateTokens(text))
  const maxTokens = Math.max(MIN_OUTPUT_TOKENS, Math.ceil(tokens * OUTPUT_RATIO))

  const firstTokenTimeoutMs = FIRST_TOKEN_FLOOR_MS + Math.ceil(tokens * FIRST_TOKEN_MS_PER_TOKEN)
  // The backstop assumes the model produces its full allowance at the assumed
  // rate. It should never be the thing that fires on a healthy machine.
  const totalTimeoutMs =
    firstTokenTimeoutMs + Math.ceil((maxTokens / ASSUMED_TOKENS_PER_SECOND) * 1000)

  return { maxTokens, firstTokenTimeoutMs, stallTimeoutMs: STALL_MS, totalTimeoutMs }
}

/**
 * Roughly how long cleanup should take, for telling the user.
 *
 * Uses the rate actually measured rather than the pessimistic budgeting rate,
 * because this answers "how long will this take" and not "when should I give
 * up". Deliberately separate: conflating the two is what produced a timeout
 * that was also, implicitly, a prediction.
 */
const OBSERVED_TOKENS_PER_SECOND = 35
export function estimateCleanupMs(text: string, inputTokens?: number): number {
  const tokens = Math.max(1, inputTokens ?? estimateTokens(text))
  return Math.round(500 + (tokens / OBSERVED_TOKENS_PER_SECOND) * 1000)
}
