export interface Project { id: string; name: string; path: string; url: string }
export interface ProjectFile { name: string; path: string; directory: boolean; blocked: boolean }
export interface FileText { path: string; text: string; revision: string; bom: boolean }
export interface FileImage extends FileText { image: string }
export interface TerminalSession { id: string; name: string; exitCode: number | null }
export interface BrowserTab { id: string; url: string; title: string; loading: boolean; error: string; back: boolean; forward: boolean }
export interface Workspace { project: Project; terminals: TerminalSession[]; browsers: BrowserTab[] }
export interface Rect { x: number; y: number; width: number; height: number }
export interface GitChange { path: string; previousPath?: string; index: string; worktree: string }
export interface GitStatus { root: string; branch: string; changes: GitChange[] }
export interface ProjectCommands {
  gitRepositories: { args: undefined; result: string[] }
  gitStatus: { args: { repository: string }; result: GitStatus }
  gitDiff: { args: { repository: string; path: string; staged: boolean }; result: string }
  list: { args: undefined; result: Project[] }
  add: { args: undefined; result: Project | null }
  remove: { args: { id: string }; result: boolean }
  locate: { args: { id: string }; result: Project | null }
  open: { args: { id: string }; result: Workspace | null }
  close: { args: undefined; result: boolean }
  files: { args: { path: string; excluded: boolean }; result: ProjectFile[] }
  read: { args: { path: string }; result: FileText }
  readImage: { args: { path: string }; result: FileImage }
  save: { args: FileText; result: FileText }
  dirty: { args: { files: FileText[] }; result: void }
  terminalNew: { args: undefined; result: TerminalSession }
  terminalClose: { args: { id: string }; result: boolean }
  terminalRestart: { args: { id: string }; result: TerminalSession }
  terminalRename: { args: { id: string; name: string }; result: void }
  terminalInput: { args: { id: string; data: string }; result: void }
  terminalResize: { args: { id: string; cols: number; rows: number }; result: void }
  terminalRead: { args: { id: string }; result: { data: string; exitCode: number | null } }
  browserNew: { args: undefined; result: BrowserTab }
  browserClose: { args: { id: string }; result: void }
  browserNavigate: { args: { id: string; url: string }; result: void }
  browserAction: { args: { id: string; action: 'back' | 'forward' | 'reload' }; result: void }
  browserBounds: { args: { id: string | null; rect: Rect | null }; result: void }
  browserState: { args: undefined; result: BrowserTab[] }
}
export interface ProjectsApi {
  request<K extends keyof ProjectCommands>(method: K, args: ProjectCommands[K]['args'], workspaceId?: string): Promise<ProjectCommands[K]['result']>
  onChanged(cb: () => void): () => void
  onFilesChanged(cb: () => void): () => void
  onShortcut(cb: (action: import('./project-shortcuts.js').ProjectShortcut) => void): () => void
}
export const PROJECT_IPC = { request: 'projects:request', changed: 'projects:changed', files: 'projects:filesChanged', shortcut: 'projects:shortcut' } as const
