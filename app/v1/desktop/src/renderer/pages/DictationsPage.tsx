import { DictationTable } from '../dictations/DictationTable.js'

/**
 * Everything you have dictated.
 *
 * The whole history, paged in SQL and searchable, rather than the last twenty
 * rows of a buffer. Opening a row shows what was said; developer mode adds the
 * pipeline behind it - what was heard, what the dictionary changed, what was
 * sent, what came back - which is the only way to answer "why did it write
 * that".
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
