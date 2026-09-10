/**
 * The model catalogue and sidecar definitions.
 *
 * Both sidecars are switchable at runtime per decision A8c. Only one Whisper
 * model can be resident alongside the LLM, so switching means restarting that
 * sidecar rather than loading a second copy:
 *
 *   large-v3 + Qwen   5744 of 6144 MiB   fits, ~400 spare
 *   turbo    + Qwen   4889 of 6144 MiB   comfortable
 *   both     + Qwen   6609               does not fit
 */

export type SidecarId = 'whisper' | 'llama'

export interface ModelChoice {
  id: string
  label: string
  /** File name inside <repo>/models/ */
  file: string
  /** Measured on the RTX 3050, see docs/design/03-spike-results.md */
  vramMiB: number
  note: string
}

export const WHISPER_MODELS: ModelChoice[] = [
  {
    id: 'large-v3',
    label: 'Whisper large-v3',
    file: 'ggml-large-v3-q5_0.bin',
    vramMiB: 1720,
    note: 'Most faithful on Hindi, but 2.5x slower. Use it if turbo drops words.',
  },
  {
    id: 'turbo',
    label: 'Whisper large-v3-turbo',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    vramMiB: 865,
    note: 'Default. 2.5x faster, half the VRAM. Rarely drops part of a sentence.',
  },
]

export const LLM_MODELS: ModelChoice[] = [
  {
    id: 'qwen3-4b',
    label: 'Qwen3 4B Instruct',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    vramMiB: 3124,
    note: 'Default. Renders Hindi as English reliably; measured 9 of 9 samples.',
  },
  {
    id: 'gemma3-4b',
    label: 'Gemma 3 4B IT',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    vramMiB: 3100,
    note: 'Good on most Hindi, but returns some of it untranslated. 6 of 9.',
  },
]

export interface SidecarDef {
  id: SidecarId
  /** Path inside <repo>/sidecars/ */
  exe: string
  defaultPort: number
  /** Path that answers when the process is up. */
  healthPath: string
  /**
   * What counts as ready. 'any': any HTTP answer at all. 'ok': a 2xx only.
   *
   * NOT THE SAME FOR BOTH. whisper-server has no health endpoint, so any answer
   * means it is listening. llama-server answers /health with 503 "Loading
   * model" for the seconds it spends loading, and counting that as ready is
   * what sent the English and the summary to a model that could not answer.
   */
  readyWhen: 'any' | 'ok'
  models: ModelChoice[]
  defaultModelId: string
  /** Command line for a given model file and port. */
  args(modelPath: string, port: number): string[]
}

export const SIDECARS: Record<SidecarId, SidecarDef> = {
  whisper: {
    id: 'whisper',
    exe: 'whisper/Release/whisper-server.exe',
    defaultPort: 8178,
    // whisper-server has no /health; the root path answers once it is listening.
    healthPath: '/',
    readyWhen: 'any',
    models: WHISPER_MODELS,
    defaultModelId: 'turbo',
    args: (modelPath, port) => [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
    ],
  },
  llama: {
    id: 'llama',
    exe: 'llama/llama-server.exe',
    defaultPort: 8179,
    healthPath: '/health',
    readyWhen: 'ok',
    models: LLM_MODELS,
    defaultModelId: 'qwen3-4b',
    args: (modelPath, port) => [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      // 4k is plenty: a five-minute dictation is well under it, and 8k cost
      // ~300 MiB we do not have.
      '-c', '4096',
      '-ngl', '99',
      // Default is 4 KV slots, which measured ~3124 MiB. We only ever run one
      // request at a time, so the other three are pure waste.
      '--parallel', '1',
      '--no-webui',
    ],
  },
}

export function findModel(id: SidecarId, modelId: string): ModelChoice | undefined {
  return SIDECARS[id].models.find((m) => m.id === modelId)
}
