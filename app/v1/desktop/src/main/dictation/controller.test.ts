import { describe, expect, it, vi } from 'vitest'
import type { SidecarId } from '../../shared/models.js'

// The speech model, answering at once: this test is about what the controller
// does around it, not about recognition.
vi.mock('@wouice/asr', async (original) => ({
  ...(await original<typeof import('@wouice/asr')>()),
  WhisperCppClient: class {
    async transcribe() {
      return { text: 'hello there', latencyMs: 5, language: 'en' }
    }
  },
}))

const { DictationController } = await import('./controller.js')

/**
 * The sidecars a dictation holds must be let go when it ends.
 *
 * They were not, after a dictation that worked: the release ran while the
 * machine was still delivering - which counts as busy - and the step to idle
 * released nothing. Both sidecars stayed "busy" for the rest of the session,
 * so the after-call swap waited seven minutes for a dictation that had ended
 * and every model switch from the tray waited for ever (meeting 16).
 */
describe('a dictation lets go of the sidecars', () => {
  it('once it has been delivered', async () => {
    const busy: Record<SidecarId, boolean> = { whisper: false, llama: false }
    const supervisor = {
      setBusy: (id: SidecarId, on: boolean) => {
        busy[id] = on
      },
      canServe: () => true,
      baseUrl: () => 'http://127.0.0.1:1',
      snapshot: (id: SidecarId) => ({ modelId: id === 'whisper' ? 'turbo' : 'qwen3-4b' }),
    }
    const dictation = new DictationController({
      supervisor: supervisor as never,
      cleanupEnabled: () => false,
      retainAudio: () => false,
      saveAudio: async () => null,
    })
    const result = new Promise((resolve) => dictation.once('result', resolve))

    dictation.send({ type: 'hotkey', now: 0 })
    expect(busy).toEqual({ whisper: true, llama: true })
    dictation.send({ type: 'micReady' })
    for (let i = 0; i < 10; i++) dictation.pushFrame(dictation.sessionId, new Float32Array(320).fill(0.1))
    dictation.send({ type: 'hotkey', now: 1_000 })

    await result
    // Delivering: the text is on its way, and the sidecars are still held.
    expect(dictation.phase).toBe('delivering')
    dictation.send({ type: 'delivered' })
    expect(dictation.phase).toBe('idle')
    expect(busy).toEqual({ whisper: false, llama: false })
  })
})
