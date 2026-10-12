import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), showOpenDialog: vi.fn(), add: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '' }, ipcMain: { handle: mocks.handle }, dialog: { showOpenDialog: mocks.showOpenDialog } }))
vi.mock('./registry.js', () => ({ ProjectRegistry: class { add = mocks.add } }))
vi.mock('./terminals.js', () => ({ ProjectTerminals: class {} }))
vi.mock('./browser.js', () => ({ ProjectBrowsers: class {} }))
import { Projects } from './index.js'

describe('project IPC without an open workspace', () => {
  beforeEach(() => vi.clearAllMocks())

  function setup() {
    const webContents = { mainFrame: {}, on: vi.fn(), send: vi.fn() }
    const win = { webContents, on: vi.fn(), isDestroyed: () => false } as unknown as BrowserWindow
    const projects = new Projects(() => win)
    const handler = mocks.handle.mock.calls[0]![1]
    const event = { sender: webContents, senderFrame: webContents.mainFrame }
    return { projects, handler, event }
  }

  it('registers the first folder without treating it as active-project relocation', async () => {
    const { handler, event } = setup()
    const project = { id: 'first', path: 'C:\\project', name: 'project', url: 'http://localhost:3000' }
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [project.path] })
    mocks.add.mockReturnValue(project)
    await expect(handler(event, 'add')).resolves.toEqual(project)
    expect(mocks.add).toHaveBeenCalledWith(project.path, undefined)
  })

  it('does not register a folder when its picker is canceled', async () => {
    const { handler, event } = setup()
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handler(event, 'add')).resolves.toBeNull()
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('allows repeated preview cleanup before opening and after disposal', async () => {
    const { projects, handler, event } = setup()
    await expect(handler(event, 'browserBounds', { id: null, rect: null })).resolves.toBeUndefined()
    projects.dispose()
    await expect(handler(event, 'browserBounds', { id: null, rect: null })).resolves.toBeUndefined()
  })

  it('still rejects displaying a preview or reading files without a project', async () => {
    const { handler, event } = setup()
    await expect(handler(event, 'browserBounds', { id: 'missing', rect: { x: 0, y: 0, width: 100, height: 100 } })).rejects.toThrow('Open a project first')
    await expect(handler(event, 'read', { path: 'hello.ts' })).rejects.toThrow('The active project changed')
  })

  it('still rejects cleanup from an untrusted frame', async () => {
    const { handler, event } = setup()
    await expect(handler({ ...event, senderFrame: {} }, 'browserBounds', { id: null, rect: null })).rejects.toThrow('Project access denied')
  })
})
