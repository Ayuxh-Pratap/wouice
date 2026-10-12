import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_IPC, type FileText, type Project, type Workspace } from '../../shared/projects.js'
import { ProjectRegistry } from './registry.js'
import { listFiles, readText, readImage, resolveFile, saveText } from './files.js'
import { ProjectBrowsers } from './browser.js'
import { ProjectTerminals } from './terminals.js'
import { bindProjectShortcuts } from './shortcuts.js'
import { gitRepositories, gitStatus, gitDiff } from './git.js'

export class Projects {
  private registry = new ProjectRegistry(app.getPath('userData'))
  private project: Project | null = null
  private terminals: ProjectTerminals | null = null
  private browsers: ProjectBrowsers | null = null
  private dirty: FileText[] = []
  private owner: BrowserWindow | null = null
  private watchers = new Map<string, { watcher: fs.FSWatcher; ino: number; dev: number }>()
  private watchTimer: ReturnType<typeof setTimeout> | undefined
  constructor(private getWindow: () => BrowserWindow | null) {
    ipcMain.handle(PROJECT_IPC.request, async (event, method: unknown, args: unknown, workspaceId: unknown) => {
      const win = this.getWindow()
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Project access denied')
      this.attach(win)
      if (typeof method !== 'string' || (args !== undefined && (!args || typeof args !== 'object'))) throw new Error('Invalid project request')
      if (['files', 'read', 'readImage', 'save', 'dirty', 'terminalNew', 'browserNew', 'gitRepositories', 'gitStatus', 'gitDiff'].includes(method) && (!this.project || workspaceId !== this.project.id)) throw new Error('The active project changed; retry from its workspace')
      return this.request(method, (args ?? {}) as Record<string, unknown>, win)
    })
  }
  private attach(win: BrowserWindow): void {
    if (this.owner === win) return
    this.owner = win
    bindProjectShortcuts(win.webContents, win)
    win.on('close', event => { if (!this.prepareClose()) event.preventDefault(); else this.dispose() })
    win.webContents.on('render-process-gone', () => this.browsers?.show(null, null))
    win.webContents.on('did-start-navigation', (_e, _url, inPlace, main) => { if (main && !inPlace) this.browsers?.show(null, null) })
    win.on('resize', () => this.browsers?.show(null, null))
  }
  private changed(): void { if (this.owner && !this.owner.isDestroyed()) this.owner.webContents.send(PROJECT_IPC.changed) }
  private watch(relative: string, directory: boolean): void {
    const target = resolveFile(this.root(), relative), dir = directory ? target : path.dirname(target)
    try {
      const stat = fs.statSync(dir), existing = this.watchers.get(dir)
      if (existing && existing.ino === stat.ino && existing.dev === stat.dev) {
        this.watchers.delete(dir); this.watchers.set(dir, existing); return
      }
      existing?.watcher.close(); this.watchers.delete(dir)
      if (this.watchers.size >= 128) {
        const oldest = this.watchers.entries().next().value!
        oldest[1].watcher.close(); this.watchers.delete(oldest[0])
      }
      const notify = (): void => {
        // Deliver during sustained installs too, rather than waiting for silence.
        if (this.watchTimer) return
        this.watchTimer = setTimeout(() => { this.watchTimer = undefined; if (this.owner && !this.owner.isDestroyed()) this.owner.webContents.send(PROJECT_IPC.files) }, 120)
      }
      const watcher = fs.watch(dir, notify)
      watcher.on('error', () => { watcher.close(); if (this.watchers.get(dir)?.watcher === watcher) this.watchers.delete(dir); notify() })
      this.watchers.set(dir, { watcher, ino: stat.ino, dev: stat.dev })
    } catch { /* Focus rechecks and periodic polling cover unavailable watchers. */ }
  }
  private root(): string { if (!this.project) throw new Error('Open a project first'); return this.project.path }
  private snapshot(): Workspace { if (!this.project) throw new Error('Open a project first'); return { project: this.project, terminals: this.terminals!.list(), browsers: this.browsers!.list() } }
  private text(a: Record<string, unknown>, key: string): string { if (typeof a[key] !== 'string') throw new Error(`Invalid ${key}`); return a[key] }
  private confirm(message: string): boolean {
    this.browsers?.show(null, null)
    return dialog.showMessageBoxSync(this.owner!, { type: 'question', message, buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0 }) === 1
  }
  prepareClose(): boolean {
    if (!this.dirty.length) return true
    this.browsers?.show(null, null)
    const answer = dialog.showMessageBoxSync(this.owner!, { type: 'question', message: 'Save project changes before closing?', detail: this.dirty.map(f => f.path).join('\n'), buttons: ['Save all', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2 })
    if (answer === 2) return false
    if (answer === 0) {
      try { for (const file of this.dirty) saveText(this.root(), file) }
      catch (error) { dialog.showMessageBoxSync(this.owner!, { type: 'error', message: 'Could not save changes', detail: String(error) }); return false }
    }
    this.dirty = []; return true
  }
  dispose(): void { clearTimeout(this.watchTimer); this.watchTimer = undefined; for (const { watcher } of this.watchers.values()) watcher.close(); this.watchers.clear(); this.browsers?.dispose(); this.terminals?.dispose(); this.browsers = null; this.terminals = null; this.project = null; this.dirty = [] }
  private async request(method: string, a: Record<string, unknown>, win: BrowserWindow): Promise<unknown> {
    if (method === 'list') return this.registry.list()
    if (method === 'add' || method === 'locate') {
      this.browsers?.show(null, null)
      const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: method === 'add' ? 'Open project folder' : 'Locate project folder' })
      if (result.canceled || !result.filePaths[0]) return null
      const id = method === 'locate' ? this.text(a, 'id') : undefined
      if (method === 'locate' && this.project && id === this.project.id) throw new Error('Close the active workspace before relocating it')
      const p = this.registry.add(result.filePaths[0], id); this.changed(); return p
    }
    if (method === 'open') {
      const project = this.registry.get(this.text(a, 'id'))
      if (this.project?.id === project.id) return this.snapshot()
      if (!fs.existsSync(project.path)) throw new Error('Project folder is missing. Use Locate from the Projects list.')
      if (fs.realpathSync(project.path) !== project.path) throw new Error('The project location changed. Locate its folder again.')
      if (this.project && !this.confirm('Switch projects and stop the current project’s terminals?')) return null
      if (!this.prepareClose()) return null
      this.dispose(); this.project = project
      this.watch('', true)
      this.terminals = new ProjectTerminals(project.path)
      this.browsers = new ProjectBrowsers(win, url => { try { this.registry.url(project.id, url); project.url = url } catch { /* Preview remains usable when preferences cannot be saved. */ } })
      // A missing shell should leave the workspace accessible with an explicit New terminal retry.
      try { this.terminals.create() } catch (error) { dialog.showMessageBoxSync(win, { type: 'error', message: 'Could not start PowerShell', detail: String(error) }) }
      return this.snapshot()
    }
    if (method === 'close') { if (!this.confirm('Close this workspace and stop its terminals?') || !this.prepareClose()) return false; this.dispose(); return true }
    if (method === 'remove') {
      const id = this.text(a, 'id'); this.registry.get(id)
      if (this.project?.id === id) { if (!this.confirm('Remove this project and stop its terminals? Files will stay on disk.') || !this.prepareClose()) return false; this.dispose() }
      this.registry.remove(id); this.changed(); return true
    }
    // Hiding a preview is also valid before opening or after closing a workspace.
    if (method === 'browserBounds' && a.id === null) return this.browsers?.show(null, null)
    const root = this.root()
    switch (method) {
      case 'gitRepositories': return gitRepositories(root)
      case 'gitStatus': return gitStatus(root, this.text(a, 'repository'))
      case 'gitDiff': return gitDiff(root, this.text(a, 'repository'), this.text(a, 'path'), a.staged === true)
      case 'files': { const relative = this.text(a, 'path'); this.watch(relative, true); return listFiles(root, relative, a.excluded === true) }
      case 'read': { const relative = this.text(a, 'path'); this.watch(relative, false); return readText(root, relative) }
      case 'readImage': { const relative = this.text(a, 'path'); this.watch(relative, false); return readImage(root, relative) }
      case 'save': {
        const saved = saveText(root, a as unknown as FileText); this.dirty = this.dirty.filter(f => f.path !== saved.path); return saved
      }
      case 'dirty': {
        if (!Array.isArray(a.files) || a.files.length > 50 || a.files.some(f => !f || typeof f.path !== 'string' || typeof f.text !== 'string' || f.text.length > 2 * 1024 * 1024 || typeof f.revision !== 'string' || typeof f.bom !== 'boolean')) throw new Error('Invalid editor buffers')
        this.dirty = a.files as FileText[]; return
      }
      case 'terminalNew': return this.terminals!.create()
      case 'terminalRestart': {
        const id = this.text(a, 'id'), old = this.terminals!.list().find(t => t.id === id)
        if (!old || old.exitCode === null) throw new Error('Only an exited terminal can be restarted')
        this.terminals!.close(id); const next = this.terminals!.create(); this.terminals!.rename(next.id, old.name); return { ...next, name: old.name }
      }
      case 'terminalRead': return this.terminals!.read(this.text(a, 'id'))
      case 'terminalInput': return this.terminals!.input(this.text(a, 'id'), this.text(a, 'data'))
      case 'terminalResize': return this.terminals!.resize(this.text(a, 'id'), a.cols as number, a.rows as number)
      case 'terminalRename': return this.terminals!.rename(this.text(a, 'id'), this.text(a, 'name'))
      case 'terminalClose': if (!this.confirm('Close this terminal and stop its running commands?')) return false; this.terminals!.close(this.text(a, 'id')); return true
      case 'browserNew': if (this.browsers!.list().length >= 12) throw new Error('Close a preview before opening another (12 maximum)'); return this.browsers!.create(this.project!.url)
      case 'browserState': return this.browsers!.list()
      case 'browserClose': return this.browsers!.close(this.text(a, 'id'))
      case 'browserNavigate': return this.browsers!.navigate(this.text(a, 'id'), this.text(a, 'url'))
      case 'browserAction': return this.browsers!.action(this.text(a, 'id'), this.text(a, 'action'))
      case 'browserBounds': return this.browsers!.show(a.id === null ? null : this.text(a, 'id'), a.rect as Parameters<ProjectBrowsers['show']>[1])
      default: throw new Error('Unknown project operation')
    }
  }
}
