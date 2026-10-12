import { describe, expect, it } from 'vitest'
import { projectShortcut } from './project-shortcuts.js'
describe('workspace keyboard chords', () => {
  const input = { control: true, alt: true, shift: false, meta: false, code: 'Digit1', type: 'keyDown' }
  it('maps tools and child tabs', () => {
    expect(projectShortcut(input)).toBe('terminal')
    expect(projectShortcut({ ...input, code: 'Digit2' })).toBe('code')
    expect(projectShortcut({ ...input, code: 'Digit3' })).toBe('browser')
    expect(projectShortcut({ ...input, code: 'ArrowRight' })).toBe('next')
    expect(projectShortcut({ ...input, code: 'ArrowLeft' })).toBe('previous')
  })
  it('does not capture typing, keyup, or the dictation chord', () => {
    expect(projectShortcut({ ...input, alt: false })).toBeNull()
    expect(projectShortcut({ ...input, type: 'keyUp' })).toBeNull()
    expect(projectShortcut({ ...input, code: 'KeyW' })).toBeNull()
  })
  it('accepts renderer key events, numpad keys, and key fallback without a physical code', () => {
    expect(projectShortcut({ ...input, type: 'keydown', code: 'Digit2' })).toBe('code')
    expect(projectShortcut({ ...input, code: 'Numpad3' })).toBe('browser')
    expect(projectShortcut({ ...input, code: '', key: 'ArrowRight' })).toBe('next')
    expect(projectShortcut({ ...input, code: undefined, key: '1' })).toBe('terminal')
    expect(projectShortcut({ ...input, isComposing: true })).toBeNull()
  })
})
