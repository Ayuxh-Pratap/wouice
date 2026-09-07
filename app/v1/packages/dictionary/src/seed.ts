import type { DictionaryEntry } from './types.js'

/**
 * The starter dictionary.
 *
 * Deliberately small and boring. It covers vocabulary any developer dictating
 * about this stack will hit in week one, so the tool is not annoying on day one.
 * The real dictionary is the one that grows from your own corrections in the
 * history view, which is where the personal vocabulary (clients, projects,
 * colleagues) belongs.
 *
 * TWO ENTRIES ARE DELIBERATELY ABSENT, and both are instructive:
 *
 *   "cloud" -> "Claude"   would break "cloud storage", "Cloudflare", "cloud
 *                         function". The phrase "cloud code" is safe because it
 *                         is specific; the bare word is not.
 *   "jason" -> "JSON"     breaks every person named Jason.
 *
 * The rule they illustrate: a correction must be MORE specific than the word it
 * replaces. When in doubt, add it as a `term` so it biases the decoder without
 * ever rewriting anything.
 */

const corrections: [hear: string, write: string][] = [
  // Tools we will actually be talking about
  ['cloud code', 'Claude Code'],
  ['claud code', 'Claude Code'],
  ['super base', 'Supabase'],
  ['supa base', 'Supabase'],
  ['vercell', 'Vercel'],
  ['versell', 'Vercel'],
  ['get hub', 'GitHub'],
  ['git hub', 'GitHub'],
  ['vs code', 'VS Code'],
  ['post gres', 'Postgres'],
  ['postgres ql', 'PostgreSQL'],

  // Language and framework names the decoder splits or lowercases
  ['next js', 'Next.js'],
  ['node js', 'Node.js'],
  ['type script', 'TypeScript'],
  ['java script', 'JavaScript'],
  ['tail wind', 'Tailwind'],
  ['react js', 'React'],
  ['s q lite', 'SQLite'],
  ['sq lite', 'SQLite'],

  // Acronyms that come out lowercase
  ['api', 'API'],
  ['ui', 'UI'],
  ['ux', 'UX'],
  ['cli', 'CLI'],
  ['llm', 'LLM'],
  ['gpu', 'GPU'],
  ['cpu', 'CPU'],
  ['http', 'HTTP'],
  ['url', 'URL'],
]

/**
 * Bias-only vocabulary. These are spelled correctly when the engine gets them
 * right, so there is nothing to rewrite; naming them just improves the odds.
 */
const terms: string[] = [
  'Wouice',
  'Anthropic',
  'Claude',
  'Opus',
  'Sonnet',
  'Whisper',
  'Parakeet',
  'Electron',
  'Vite',
  'Zustand',
  'CUDA',
  'GGUF',
  'llama.cpp',
  'whisper.cpp',
  'sherpa-onnx',
  'Hugging Face',
  'npm',
  'TypeScript',
  'Tailwind',
]

export const SEED_DICTIONARY: DictionaryEntry[] = [
  ...corrections.map(
    ([hear, write]): DictionaryEntry => ({ kind: 'correction', hear, write, enabled: true, hits: 0 })
  ),
  ...terms.map((hear): DictionaryEntry => ({ kind: 'term', hear, enabled: true, hits: 0 })),
]
