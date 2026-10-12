// Built by smoke-projects.cjs; uses the production renderer, preload and Projects
// service with an isolated profile and fixtures, without starting voice sidecars.
import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Projects } from '../desktop/src/main/projects/index.js'
import { DEFAULT_SETTINGS } from '../desktop/src/shared/settings.js'
import { IPC } from '../desktop/src/shared/ipc.js'

const root = path.resolve(process.cwd(), '.projects-probe/ui')
fs.mkdirSync(root, { recursive: true }); app.setPath('userData', path.join(root, 'profile'))
app.whenReady().then(async () => {
  const fixture = path.join(root, 'fixture'); fs.mkdirSync(fixture, { recursive: true })
  fs.writeFileSync(path.join(fixture, 'hello.ts'), 'export const greeting = "hello"\r\n')
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Project smoke preview</title><h1>Preview works</h1><a href="/next">Next page</a><p>' + req.url + '</p>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(path.join(app.getPath('userData'), 'projects.json'), JSON.stringify({ version: 1, projects: [] }))
  ipcMain.handle(IPC.getSettings, () => DEFAULT_SETTINGS)
  ipcMain.handle(IPC.getMeetingState, () => null)
  ipcMain.handle(IPC.getMeetingJobs, () => ({ running: null, queued: [] }))
  ipcMain.handle(IPC.getVocabularySuggestions, () => [])
  ipcMain.handle(IPC.getEngine, () => null)
  // Test-owned dialogs only. No production dialog behavior is changed.
  dialog.showMessageBoxSync = () => 1
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] })
  const win = new BrowserWindow({ width: 1040, height: 720, show: false, webPreferences: { backgroundThrottling: false, preload: path.resolve('desktop/out/preload/index.mjs'), sandbox: false, contextIsolation: true, nodeIntegration: false } })
  const projects = new Projects(() => win)
  Object.assign(globalThis, { projectProbe: projects, projectPreviewUrl: `http://127.0.0.1:${address.port}` })
  await win.loadFile(path.resolve('desktop/out/renderer/index.html'), { hash: '/projects' })
  app.on('before-quit', () => { projects.dispose(); server.close() })
})
