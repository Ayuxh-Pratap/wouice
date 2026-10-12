import { WebContentsView, session, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { BrowserTab, Rect } from '../../shared/projects.js'
import { bindProjectShortcuts } from './shortcuts.js'

export function previewUrl(input: string): string {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('Invalid preview URL')
  let raw = input.trim()
  if (/^\d{2,5}$/.test(raw)) raw = `http://localhost:${raw}`
  else if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) raw = `http://${raw}`
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = `https://${raw}`
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Enter a website address, such as example.com, or localhost:3000') }
  if (url.username || url.password) throw new Error('URLs with credentials are not supported')
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS website address')
  return url.href
}

export class ProjectBrowsers {
  private tabs = new Map<string, { view: WebContentsView; state: BrowserTab }>()
  private attached: string | null = null
  private partition: string
  constructor(private window: BrowserWindow, private onUrl: (url: string) => void) {
    this.partition = `projects-${randomUUID()}`
    const isolated = session.fromPartition(this.partition)
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.on('will-download', event => event.preventDefault())
  }
  list(): BrowserTab[] { return [...this.tabs.values()].map(t => ({ ...t.state })) }
  create(url: string): BrowserTab {
    const id = randomUUID()
    const view = new WebContentsView({ webPreferences: { partition: this.partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    const state: BrowserTab = { id, url: previewUrl(url), title: 'Preview', loading: false, error: '', back: false, forward: false }
    this.tabs.set(id, { view, state })
    const wc = view.webContents
    bindProjectShortcuts(wc, this.window)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: Electron.Event, target: string): void => { try { previewUrl(target) } catch { event.preventDefault(); state.error = 'This navigation is not allowed' } }
    wc.on('will-navigate', guard); wc.on('will-redirect', guard)
    const sync = (): void => {
      state.title = wc.getTitle() || 'Preview'; state.back = wc.navigationHistory.canGoBack(); state.forward = wc.navigationHistory.canGoForward()
    }
    wc.on('did-start-loading', () => { state.loading = true; state.error = '' })
    wc.on('did-stop-loading', () => { state.loading = false; sync() })
    wc.on('page-title-updated', sync)
    wc.on('did-navigate', (_e, next) => { state.url = next; sync(); this.onUrl(next) })
    wc.on('did-navigate-in-page', (_e, next, main) => { if (main) { state.url = next; sync() } })
    wc.on('did-fail-load', (_e, code, description, _url, main) => { if (main && code !== -3) { state.error = `Cannot connect: ${description}`; state.loading = false; if (this.attached === id) this.show(null, null) } })
    wc.on('render-process-gone', () => { state.error = 'The preview stopped. Reload to try again.'; if (this.attached === id) this.show(null, null) })
    void wc.loadURL(state.url).catch(() => {})
    return { ...state }
  }
  private get(id: string) { const tab = this.tabs.get(id); if (!tab) throw new Error('Browser tab not found'); return tab }
  navigate(id: string, url: string): void { const tab = this.get(id); tab.state.url = previewUrl(url); tab.state.error = ''; void tab.view.webContents.loadURL(tab.state.url).catch(() => {}) }
  action(id: string, action: string): void {
    const { view, state } = this.get(id); const wc = view.webContents
    if (action === 'reload') { state.error = ''; wc.reload() }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }
  show(id: string | null, rect: Rect | null): void {
    if (this.attached && (this.attached !== id || !rect)) {
      const old = this.tabs.get(this.attached); if (old) this.window.contentView.removeChildView(old.view)
      this.attached = null
    }
    if (!id || !rect || this.window.isDestroyed()) return
    const tab = this.get(id)
    if (tab.state.error) return
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error('Invalid preview bounds')
    const zoom = this.window.webContents.getZoomFactor(), bounds = this.window.getContentBounds()
    const x = Math.max(0, Math.min(bounds.width, Math.round(rect.x * zoom))), y = Math.max(0, Math.min(bounds.height, Math.round(rect.y * zoom)))
    const width = Math.max(0, Math.min(bounds.width - x, Math.round(rect.width * zoom))), height = Math.max(0, Math.min(bounds.height - y, Math.round(rect.height * zoom)))
    if (!width || !height) { this.show(null, null); return }
    tab.view.setBounds({ x, y, width, height })
    if (this.attached !== id) { this.window.contentView.addChildView(tab.view); this.attached = id }
  }
  close(id: string): void { const tab = this.get(id); if (this.attached === id) this.show(null, null); tab.view.webContents.close(); this.tabs.delete(id) }
  dispose(): void { for (const id of this.tabs.keys()) this.close(id); void session.fromPartition(this.partition).clearStorageData() }
}
