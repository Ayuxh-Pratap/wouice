import type { BrowserWindow, WebContents } from 'electron'
import { projectShortcut } from '../../shared/project-shortcuts.js'
import { PROJECT_IPC } from '../../shared/projects.js'
export function bindProjectShortcuts(contents: WebContents, window: BrowserWindow): void {
  contents.on('before-input-event', (event, input) => {
    const action = projectShortcut(input)
    if (!action || !/#\/projects\?q=/.test(window.webContents.getURL())) return
    event.preventDefault()
    window.webContents.send(PROJECT_IPC.shortcut, action)
    window.webContents.focus()
  })
}
