import { describe, expect, it } from 'vitest'
import { AFTER_CALL_CANDIDATES, LLM_MODELS, MEETING_MODELS, SIDECARS, findModel } from './models.js'

/**
 * The command lines the language model is started with. Dictation's must not
 * move - it was measured with exactly these - and a meeting model must carry
 * the flags it was measured with, or the numbers that chose it do not apply.
 */
describe('language model command lines', () => {
  const args = (id: string): string[] => SIDECARS.llama.args('m.gguf', 8179, findModel('llama', id))

  it('leaves dictation exactly as measured', () => {
    expect(args('qwen3-4b')).toEqual([
      '-m', 'm.gguf', '--host', '127.0.0.1', '--port', '8179',
      '-c', '4096', '-ngl', '99', '--parallel', '1', '--no-webui',
    ])
  })

  it('runs a meeting model with its own context, slots and measured flags', () => {
    const english = args('gemma4-e4b')
    const e4b = MEETING_MODELS.find((m) => m.id === 'gemma4-e4b')!.serve!
    expect(english.join(' ')).toContain(`-c ${e4b.ctx} --parallel ${e4b.parallel}`)
    expect(english).toContain('--fit')
    // Thinking off: a meeting model that thinks first answers late, or not at all.
    expect(english.join(' ')).toContain('--reasoning-budget 0')
    expect(english).toContain('{"enable_thinking":false}')
    // `--fit` places the layers; a forced -ngl would defeat it.
    expect(english).not.toContain('-ngl')
  })

  it('finds meeting models only for the language model, and keeps them out of the dictation list', () => {
    expect(findModel('llama', 'qwen35-9b')?.label).toBe('Qwen3.5 9B')
    expect(findModel('whisper', 'qwen35-9b')).toBeUndefined()
    expect(LLM_MODELS.map((m) => m.id)).not.toContain('qwen35-9b')
  })

  it('gives the notes a 4k context per request, whichever model writes them', () => {
    // Meeting 17: E4B in the English shape - four slots of 2k - could not take
    // the notes' first chunk, and the summary skipped 19 minutes.
    for (const id of AFTER_CALL_CANDIDATES.notes) {
      const serve = findModel('llama', id)?.serve
      expect(serve ? serve.ctx / serve.parallel : 0, id).toBeGreaterThanOrEqual(4096)
    }
    expect(args('gemma4-e4b-notes').join(' ')).toContain('-c 4096 --parallel 1')
  })
})
