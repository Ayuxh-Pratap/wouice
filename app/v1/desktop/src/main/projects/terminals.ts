import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { TerminalSession } from '../../shared/projects.js'

interface Session { process: pty.IPty; state: TerminalSession; pending: string; paused: boolean }
export class ProjectTerminals {
  private sessions = new Map<string, Session>()
  constructor(private root: string) {}
  list(): TerminalSession[] { return [...this.sessions.values()].map(s => ({ ...s.state })) }
  create(): TerminalSession {
    if (this.sessions.size >= 16) throw new Error('Close a terminal before opening another (16 maximum)')
    let shell = 'powershell.exe'
    try { shell = execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0]! } catch { /* Windows PowerShell is installed with Windows. */ }
    const child = pty.spawn(shell, ['-NoLogo'], { cwd: this.root, env: process.env, name: 'xterm-256color', cols: 100, rows: 28 })
    const s: Session = { process: child, state: { id: randomUUID(), name: `PowerShell ${this.sessions.size + 1}`, exitCode: null }, pending: '', paused: false }
    this.sessions.set(s.state.id, s)
    child.onData(data => {
      s.pending += data
      if (s.pending.length >= 256 * 1024 && !s.paused) { s.paused = true; child.pause() }
    })
    child.onExit(({ exitCode }) => { s.state.exitCode = exitCode })
    return { ...s.state }
  }
  private get(id: string): Session { const s = this.sessions.get(id); if (!s) throw new Error('Terminal not found'); return s }
  read(id: string): { data: string; exitCode: number | null } {
    const s = this.get(id), data = s.pending; s.pending = ''
    if (s.paused && s.state.exitCode === null) { s.paused = false; s.process.resume() }
    return { data, exitCode: s.state.exitCode }
  }
  input(id: string, data: string): void {
    if (typeof data !== 'string' || data.length > 128 * 1024) throw new Error('Terminal input is too large')
    const s = this.get(id); if (s.state.exitCode !== null) throw new Error('This terminal has exited'); s.process.write(data)
  }
  resize(id: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 1000) throw new Error('Invalid terminal dimensions')
    const s = this.get(id); if (s.state.exitCode === null) s.process.resize(cols, rows)
  }
  rename(id: string, name: string): void { if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Use a terminal name of 1–80 characters'); this.get(id).state.name = name.trim() }
  close(id: string): void {
    const s = this.get(id); this.sessions.delete(id)
    if (s.state.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(s.process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }) } catch { /* The process may have exited meanwhile. */ }
      try { s.process.kill() } catch { /* Already exited. */ }
    }
  }
  dispose(): void { for (const id of this.sessions.keys()) this.close(id) }
}
