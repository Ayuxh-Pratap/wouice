/**
 * Two entry kinds, because biasing and correcting are different mechanisms and
 * one alone is not enough.
 *
 * A `term` is passed to the ASR decoder as context before transcription. That
 * raises the odds of the right word and promises nothing.
 *
 * A `correction` is applied deterministically to the text afterwards. This is
 * the half that actually guarantees anything.
 */
export type DictionaryEntry =
  | { kind: 'term'; hear: string; write?: undefined; enabled: boolean; hits?: number }
  | { kind: 'correction'; hear: string; write: string; enabled: boolean; hits?: number }

/** One rule that actually fired, so history can show the dictionary earning its place. */
export interface AppliedCorrection {
  /** The text as the engine produced it, not the rule's trigger. */
  from: string
  /** What it was rewritten to. */
  to: string
  /** How many times this pair fired in one transcript. */
  count: number
}

export interface CorrectResult {
  text: string
  applied: AppliedCorrection[]
}
