import { DictationTable } from '../DictationTable.js'

/**
 * Everything you have dictated.
 *
 * The whole history, paged in SQL and searchable, rather than the last twenty
 * rows of a buffer. Developer mode adds the per-stage text to each row - what
 * was heard, what the dictionary changed, what was sent, what came back - which
 * is the only way to answer "why did it write that".
 */
export function DictationsPage({
  developerMode,
  query,
}: {
  developerMode: boolean
  query: string
}): React.JSX.Element {
  return <DictationTable developerMode={developerMode} query={query} />
}
