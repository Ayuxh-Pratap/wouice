export type ProjectShortcut = 'terminal' | 'code' | 'browser' | 'previous' | 'next'
export function projectShortcut(input: { control: boolean; alt: boolean; shift: boolean; meta: boolean; code?: string; key?: string; type: string; isComposing?: boolean }): ProjectShortcut | null {
  if (!['keyDown', 'keydown'].includes(input.type) || !input.control || !input.alt || input.shift || input.meta || input.isComposing) return null
  const actions: Record<string, ProjectShortcut> = { Digit1: 'terminal', Digit2: 'code', Digit3: 'browser', Numpad1: 'terminal', Numpad2: 'code', Numpad3: 'browser', '1': 'terminal', '2': 'code', '3': 'browser', ArrowLeft: 'previous', ArrowRight: 'next', Left: 'previous', Right: 'next' }
  return actions[input.code ?? ''] ?? actions[input.key ?? ''] ?? null
}
