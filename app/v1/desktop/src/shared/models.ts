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
  /** The name where there is room for two words, like the sidebar's status card. */
  short?: string
  /** File name inside <repo>/models/ */
  file: string
  /** Measured on the RTX 3050, see docs/design/03-spike-results.md */
  vramMiB: number
  note: string
  /**
   * How llama-server runs this model, when it is not the dictation shape.
   * Absent for the dictation models, which keep the arguments they were
   * measured with.
   */
  serve?: LlamaServe
}

export interface LlamaServe {
  /** Context across all slots together; each slot gets `ctx / parallel`. */
  ctx: number
  /** Requests served at once. */
  parallel: number
  /** Further flags, exactly as the model was measured with. */
  extra: string[]
}

export const WHISPER_MODELS: ModelChoice[] = [
  {
    id: 'large-v3',
    label: 'Whisper large-v3',
    short: 'Whisper large-v3',
    file: 'ggml-large-v3-q5_0.bin',
    vramMiB: 1720,
    note: 'Most faithful on Hindi, but 2.5x slower. Use it if turbo drops words.',
  },
  {
    id: 'turbo',
    label: 'Whisper large-v3-turbo',
    short: 'Whisper turbo',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    vramMiB: 865,
    note: 'Default. 2.5x faster, half the VRAM. Rarely drops part of a sentence.',
  },
]

export const LLM_MODELS: ModelChoice[] = [
  {
    id: 'qwen3-4b',
    label: 'Qwen3 4B Instruct',
    short: 'Qwen3 4B',
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    vramMiB: 3124,
    note: 'Default. Renders Hindi as English reliably; measured 9 of 9 samples.',
  },
  {
    id: 'gemma3-4b',
    label: 'Gemma 3 4B IT',
    short: 'Gemma 3 4B',
    file: 'gemma-3-4b-it-Q4_K_M.gguf',
    vramMiB: 3100,
    note: 'Good on most Hindi, but returns some of it untranslated. 6 of 9.',
  },
]

/**
 * How the meeting models were measured, and so how they are run: flash
 * attention, an 8-bit KV cache, thinking off, and `--fit` keeping 256 MiB of
 * the card free. `--fit` is the second safety net - given too little room it
 * moves layers to the processor rather than failing to allocate - and the
 * memory check after loading is what notices it did. See 08-after-call-models.md.
 */
const MEETING_FLAGS = [
  '-fa', 'on',
  '-ctk', 'q8_0',
  '-ctv', 'q8_0',
  '--fit', 'on',
  '--fit-target', '256',
  '--reasoning-budget', '0',
  '--chat-template-kwargs', '{"enable_thinking":false}',
]

/**
 * Larger models for a meeting's English, summary and tasks, run only after the
 * call with both dictation models off the card - never beside them.
 *
 * Chosen by measurement on three real meetings graded against rubrics written
 * before any of them ran; the numbers are in docs/design/08-after-call-models.md.
 * `vramMiB` is what loading one adds to the card with these arguments.
 */
export const MEETING_MODELS: ModelChoice[] = [
  {
    id: 'gemma4-e4b',
    label: 'Gemma 4 E4B',
    file: 'google_gemma-4-E4B-it-Q6_K.gguf',
    // With four slots; one slot measured 4085.
    vramMiB: 4180,
    note: 'Meeting English. The best English of the four measured, and the most precise tasks.',
    // Four lines at once: the English pass sends one line per request, and no
    // request depends on another's answer. Meeting 10's 514 lines took 303 s
    // on two slots and 244 s on four, every line rendered either way.
    serve: { ctx: 8192, parallel: 4, extra: MEETING_FLAGS },
  },
  {
    id: 'qwen35-9b',
    label: 'Qwen3.5 9B',
    file: 'Qwen_Qwen3.5-9B-IQ4_XS.gguf',
    // Measured +4,598 to +4,796: `--fit` sizes its working buffers to the room
    // it is given, so it takes more on an emptier card. 4,650 is what it needs;
    // the 300 MiB margin keeps llama.cpp's own 256 free on top.
    vramMiB: 4650,
    note: 'Meeting summary and tasks. Found all eight real bugs in an hour of noisy Hindi.',
    // One slot: the notes engine sends one request at a time and sizes its
    // chunks to a 4k context.
    serve: { ctx: 4096, parallel: 1, extra: MEETING_FLAGS },
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
  args(modelPath: string, port: number, model?: ModelChoice): string[]
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
    args: (modelPath, port, model) => {
      const serve = model?.serve
      if (serve) {
        // A meeting model: its own context, slots and flags, and no `-ngl` -
        // `--fit` decides the layers, and was measured placing all of them on
        // the card when the room is there.
        return [
          '-m', modelPath,
          '--host', '127.0.0.1',
          '--port', String(port),
          '-c', String(serve.ctx),
          '--parallel', String(serve.parallel),
          '--no-webui',
          ...serve.extra,
        ]
      }
      return [
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
      ]
    },
  },
}

/** A model by id: the sidecar's own list, and for the language model the meeting models too. */
export function findModel(id: SidecarId, modelId: string): ModelChoice | undefined {
  return (
    SIDECARS[id].models.find((m) => m.id === modelId) ??
    (id === 'llama' ? MEETING_MODELS.find((m) => m.id === modelId) : undefined)
  )
}
