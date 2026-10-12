import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export function TerminalPane({ id, onExit, onError }: { id: string; onExit(code: number): void; onError(error: unknown): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null), exit = useRef(onExit), error = useRef(onError)
  exit.current = onExit; error.current = onError
  useEffect(() => {
    const terminal = new Terminal({ fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 13, scrollback: 5000, cursorBlink: true, theme: { background: '#151515', foreground: '#dedede', cursor: '#cbd5c0', selectionBackground: '#46523f' } })
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!)
    const request = window.wouice.projects.request
    let stopped = false, finished = false, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const data = await request('terminalRead', { id })
        if (stopped) return
        if (data.data) await new Promise<void>(resolve => terminal.write(data.data, resolve))
        if (data.exitCode !== null && !finished) { finished = true; exit.current(data.exitCode); terminal.writeln(`\r\n[Process exited: ${data.exitCode}]`) }
      } catch (e) { if (!stopped) error.current(e); return }
      if (!stopped && !finished) timer = setTimeout(() => void poll(), 80)
    }
    const data = terminal.onData(value => { void request('terminalInput', { id, data: value }).catch(e => error.current(e)) })
    const resize = (): void => {
      if (!host.current || host.current.clientWidth < 20 || host.current.clientHeight < 20) return
      fit.fit(); void request('terminalResize', { id, cols: terminal.cols, rows: terminal.rows }).catch(() => {})
    }
    const observer = new ResizeObserver(resize); observer.observe(host.current!); resize(); void poll()
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') { void navigator.clipboard.writeText(terminal.getSelection()); return false }
      return true
    })
    return () => { stopped = true; clearTimeout(timer); observer.disconnect(); data.dispose(); terminal.dispose() }
  }, [id])
  return <div ref={host} className="project-terminal" data-project-tool="terminal" />
}
