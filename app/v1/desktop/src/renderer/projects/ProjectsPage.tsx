import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserTab, FileText, GitStatus, Project, ProjectFile, TerminalSession, Workspace } from '../../shared/projects.js'
import { hashFor } from '../shell/routes.js'
import { TerminalPane } from './TerminalPane.js'
import { FileIcon } from './FileIcon.js'
import { GitPanel } from './GitPanel.js'
import { ImagePreview } from './ImagePreview.js'
import { projectShortcut, type ProjectShortcut } from '../../shared/project-shortcuts.js'
import './projects.css'

const EditorPane = lazy(() => import('./EditorPane.js').then(module => ({ default: module.EditorPane })))

const request = window.wouice.projects.request
type Mode = 'terminal' | 'code' | 'browser'
interface Buffer extends FileText { base: string; conflict?: FileText; issue?: string; image?: string }
const buffer = (f: FileText): Buffer => ({ ...f, base: f.text })
const preferDockedFiles = (): boolean => { try { return localStorage.getItem('projects.files.docked') !== 'false' } catch { return true } }

function FileTree({ open, workspaceId, activePath, buffers, docked, setDocked, git }: { open(path: string): void; workspaceId: string; activePath: string; buffers: Buffer[]; docked: boolean; setDocked(value: boolean): void; git: GitStatus | null }): React.JSX.Element {
  const [excluded, setExcluded] = useState(false), [expanded, setExpanded] = useState<string[]>(['']), [entries, setEntries] = useState<Record<string, ProjectFile[]>>({})
  const [issues, setIssues] = useState<Record<string, string>>({})
  const gitBadge = (path: string): string => {
    const change = git?.changes.find(c => [git.root, c.path].filter(Boolean).join('/').replaceAll('\\', '/') === path.replaceAll('\\', '/'))
    return change ? change.index === '?' ? 'U' : (change.worktree.trim() || change.index.trim()) : ''
  }
  useEffect(() => {
    let stopped = false, loading = false, pending = false
    const load = async (): Promise<void> => {
      pending = true
      if (loading) return
      loading = true
      try {
        while (pending && !stopped) {
          pending = false
          const next: Record<string, ProjectFile[]> = {}, failures: Record<string, string> = {}
          const visit = async (path: string): Promise<void> => {
            if (stopped) return
            try {
              const children = await request('files', { path, excluded }, workspaceId)
              if (stopped) return
              next[path] = children
              // Only descend through folders that still exist in the fresh parent listing.
              await Promise.all(children.filter(f => f.directory && !f.blocked && expanded.includes(f.path)).map(f => visit(f.path)))
            } catch (e) { if (!stopped) { next[path] = []; failures[path] = String(e) } }
          }
          await visit('')
          if (!stopped) { setEntries(next); setIssues(failures) }
        }
      } finally { loading = false }
    }
    void load(); const timer = setInterval(() => void load(), 10000)
    const off = window.wouice.projects.onFilesChanged(() => void load())
    window.addEventListener('focus', load)
    return () => { stopped = true; clearInterval(timer); off(); window.removeEventListener('focus', load) }
  }, [excluded, expanded, workspaceId])
  const tree = (path: string, depth: number): React.ReactNode => entries[path]?.map(f => <div key={f.path}>
    <button className={`project-tree-row ${activePath === f.path ? 'selected' : ''}`} aria-current={activePath === f.path ? 'true' : undefined} aria-expanded={f.directory ? expanded.includes(f.path) : undefined} disabled={f.blocked} title={f.blocked ? 'Unavailable or outside the project' : f.path} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => f.directory ? setExpanded(old => old.includes(f.path) ? old.filter(p => p !== f.path) : [...old, f.path]) : open(f.path)}>
      <span className="project-tree-chevron" aria-hidden="true">{f.directory ? expanded.includes(f.path) ? '⌄' : '›' : ''}</span><FileIcon path={f.path} directory={f.directory} expanded={expanded.includes(f.path)} /><span className="project-tree-name">{f.name}</span>
      {buffers.some(b => b.path === f.path && (b.conflict || b.issue)) ? <span className="project-file-state warning" title="File needs attention" aria-label="File needs attention">!</span> : buffers.some(b => b.path === f.path && b.text !== b.base) ? <span className="project-file-state" title="Unsaved changes" aria-label="Unsaved changes">●</span> : null}
      {gitBadge(f.path) && <span className="project-git-badge" title="Git status (saved file)">{gitBadge(f.path)}</span>}
    </button>{f.directory && expanded.includes(f.path) && <>{issues[f.path] && <div role="alert">{issues[f.path]}</div>}{tree(f.path, depth + 1)}</>}
  </div>)
  return <aside className={`project-files ${docked ? 'docked' : 'drawer'}`} aria-label="File explorer"><div className="project-explorer-tools"><span className="project-files-label">EXPLORER</span><button aria-label="Collapse folders" title="Collapse folders" onClick={() => setExpanded([''])}>⊟</button></div><label className="project-dock-option"><input type="checkbox" checked={docked} onChange={e => setDocked(e.target.checked)} /> Keep files docked</label><label><input type="checkbox" checked={excluded} onChange={e => setExcluded(e.target.checked)} /> Show excluded</label>{issues[''] && <div role="alert">{issues['']}</div>}{tree('', 0)}<div className="project-explorer-hint">{docked ? 'Drag the lower corner to resize' : 'Compact drawer on small windows'}</div></aside>
}

export function ProjectsPage({ visible, projectId }: { visible: boolean; projectId: string }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]), [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [mode, setMode] = useState<Mode>('terminal'), [terminalId, setTerminalId] = useState(''), [browserId, setBrowserId] = useState(''), [filePath, setFilePath] = useState('')
  const [files, setFiles] = useState<Buffer[]>([]), buffers = useRef<Buffer[]>([])
  const [showFiles, setShowFiles] = useState(preferDockedFiles), [overview, setOverview] = useState(false), [url, setUrl] = useState('http://localhost:3000')
  const [docked, setDocked] = useState(preferDockedFiles)
  const [git, setGit] = useState<GitStatus | null>(null), [showGit, setShowGit] = useState(false)
  const [autosave, setAutosave] = useState(() => { try { return localStorage.getItem('projects.autosave') !== 'false' } catch { return true } })
  const saving = useRef(new Set<string>())
  const autoSaveFile = useRef<(path: string) => Promise<void>>(async () => {})
  const changeDocked = (value: boolean): void => { setDocked(value); try { localStorage.setItem('projects.files.docked', String(value)) } catch { /* Session preference still applies. */ } }
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [suspended, setSuspended] = useState(false)
  const [decision, setDecision] = useState<{ message: string; buttons: string[]; resolve(value: number): void } | null>(null)
  const browserSlot = useRef<HTMLDivElement>(null), page = useRef<HTMLDivElement>(null), [narrow, setNarrow] = useState(false)
  const current = useRef(workspace); current.current = workspace
  const report = useCallback((e: unknown): void => setError((e instanceof Error ? e.message : String(e)).replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:\w*Error: )?/, '')), [])
  const work = async (fn: () => Promise<void>): Promise<void> => { setBusy(true); setError(''); try { await fn() } catch (e) { report(e) } finally { setBusy(false) } }
  const updateFiles = useCallback((next: Buffer[]): void => {
    buffers.current = next; setFiles(next)
    void request('dirty', { files: next.filter(f => f.text !== f.base).map(({ path, text, revision, bom }) => ({ path, text, revision, bom })) }, current.current?.project.id).catch(report)
  }, [report])
  const refresh = useCallback((): void => { void request('list', undefined).then(setProjects).catch(report) }, [report])
  useEffect(() => { refresh(); return window.wouice.projects.onChanged(refresh) }, [refresh])
  useEffect(() => {
    if (!visible || !projectId || current.current?.project.id === projectId) return
    let stopped = false
    setBusy(true); setError('')
    void request('open', { id: projectId }).then(next => {
      if (stopped) return
      if (!next) { location.hash = hashFor('projects', current.current?.project.id); return }
      setWorkspace(next); buffers.current = []; setFiles([]); setFilePath(''); setTerminalId(next.terminals[0]?.id ?? ''); setBrowserId(next.browsers[0]?.id ?? ''); setMode('terminal'); setOverview(false)
      setGit(null); setShowGit(false)
    }).catch(report).finally(() => { if (!stopped) setBusy(false) })
    return () => { stopped = true }
  }, [projectId, visible, report])
  useEffect(() => {
    if (!page.current) return
    const observer = new ResizeObserver(() => setNarrow((page.current?.clientWidth ?? 0) < 680))
    observer.observe(page.current); return () => observer.disconnect()
  }, [])
  // Recheck open files even when another tool is selected. This also catches editor
  // atomic replacement and missed native watcher events without watching entire repos.
  useEffect(() => {
    if (!workspace) return
    let stopped = false, checking = false, pending = false
    const check = async (): Promise<void> => {
      pending = true
      if (checking) return; checking = true
      try {
        while (pending && !stopped) {
        pending = false
        for (const original of [...buffers.current]) {
          try {
            const disk = original.image ? await request('readImage', { path: original.path }, workspace.project.id) : await request('read', { path: original.path }, workspace.project.id); if (stopped) return
            const latest = buffers.current.find(f => f.path === original.path); if (!latest) continue
            // A save or explicit reload completed while the disk read was in flight.
            if (latest.revision !== original.revision) { pending = true; continue }
            if (disk.revision !== latest.revision) updateFiles(buffers.current.map(f => f.path !== original.path ? f : f.text === f.base ? buffer(disk) : { ...f, conflict: disk, issue: undefined }))
            else if (latest.issue || latest.conflict) updateFiles(buffers.current.map(f => f.path === original.path ? { ...f, issue: undefined, conflict: undefined } : f))
          } catch (e) {
            if (!stopped) {
              const issue = `File unavailable on disk. Your open copy is preserved. ${String(e)}`
              const latest = buffers.current.find(f => f.path === original.path)
              if (latest && latest.revision === original.revision && latest.issue !== issue) updateFiles(buffers.current.map(f => f.path === original.path ? { ...f, issue, conflict: undefined } : f))
            }
          }
        }
        }
      } finally { checking = false }
    }
    const timer = setInterval(() => void check(), 10000); window.addEventListener('focus', check)
    const off = window.wouice.projects.onFilesChanged(() => void check())
    return () => { stopped = true; clearInterval(timer); off(); window.removeEventListener('focus', check) }
  }, [workspace?.project.id, updateFiles])
  useEffect(() => {
    if (!workspace) return
    let stopped = false
    const tick = async (): Promise<void> => { try { const tabs = await request('browserState', undefined); if (!stopped) setWorkspace(old => old ? { ...old, browsers: tabs } : old) } catch { /* Workspace is closing. */ } }
    const timer = setInterval(() => void tick(), 500)
    return () => { stopped = true; clearInterval(timer) }
  }, [workspace?.project.id])
  const selectedBrowser = workspace?.browsers.find(b => b.id === browserId)
  useEffect(() => { if (selectedBrowser) setUrl(selectedBrowser.url) }, [selectedBrowser?.url, browserId])
  const shown = visible && !!projectId && workspace?.project.id === projectId
  const handleShortcut = useRef<(action: ProjectShortcut) => void>(() => {})
  handleShortcut.current = action => {
    if (!shown || decision) return
    if (action === 'terminal' || action === 'code' || action === 'browser') { setMode(action); if (action === 'code') setShowFiles(true); return }
    const ids = mode === 'terminal' ? workspace!.terminals.map(t => t.id) : mode === 'browser' ? workspace!.browsers.map(b => b.id) : ['__changes', ...files.map(f => 'file:' + f.path)]
    const selected = mode === 'terminal' ? terminalId : mode === 'browser' ? browserId : showGit ? '__changes' : 'file:' + filePath
    const next = ids[(Math.max(0, ids.indexOf(selected)) + (action === 'next' ? 1 : -1) + ids.length) % ids.length]
    if (!next) return
    if (mode === 'terminal') { setTerminalId(next); setOverview(false) } else if (mode === 'browser') setBrowserId(next); else { if (next !== '__changes') setFilePath(next.slice(5)); setShowGit(next === '__changes') }
  }
  useEffect(() => {
    const off = window.wouice.projects.onShortcut(action => handleShortcut.current(action))
    const keydown = (event: KeyboardEvent): void => {
      const action = projectShortcut({ type: event.type, code: event.code, key: event.key, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, isComposing: event.isComposing })
      if (!action || !current.current || !page.current?.querySelector('.project-workspace:not(.project-hidden)') || page.current?.querySelector('[role="dialog"]')) return
      event.preventDefault(); event.stopImmediatePropagation(); handleShortcut.current(action)
    }
    window.addEventListener('keydown', keydown, true)
    return () => { off(); window.removeEventListener('keydown', keydown, true) }
  }, [])
  useEffect(() => {
    if (!shown || decision) return
    const timer = setTimeout(() => {
      const selector = mode === 'terminal' ? '.project-terminal-card:not(.project-hidden) textarea' : mode === 'browser' ? '.project-urlbar input' : showGit ? '.project-git-diff pre' : '.project-editor-wrap:not(.project-hidden) textarea'
      page.current?.querySelector<HTMLElement>(selector)?.focus()
    }, 50)
    return () => clearTimeout(timer)
  }, [shown, mode, terminalId, browserId, filePath, showGit, decision])
  useEffect(() => {
    if (!autosave || !workspace) return
    const timer = setTimeout(() => { for (const file of buffers.current) if (file.text !== file.base && !file.conflict && !file.issue) void autoSaveFile.current(file.path).catch(report) }, 1200)
    return () => clearTimeout(timer)
  }, [files, autosave, workspace?.project.id, report])
  useEffect(() => {
    if (shown) page.current?.querySelector('.project-tab.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [shown, mode, terminalId, browserId, filePath, workspace?.terminals.length, workspace?.browsers.length, files.length])
  useEffect(() => {
    if (!shown || mode !== 'browser' || !browserId || suspended || (showFiles && narrow && !docked) || selectedBrowser?.error) return
    const position = (): void => {
      const slot = browserSlot.current
      if (!slot) return
      const rect = slot.getBoundingClientRect()
      void request('browserBounds', { id: browserId, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }).catch(() => {})
    }
    position(); const timer = setInterval(position, 150)
    return () => { clearInterval(timer); void request('browserBounds', { id: null, rect: null }).catch(() => {}) }
  }, [shown, mode, browserId, suspended, showFiles, narrow, docked, selectedBrowser?.error])
  const choose = async (message: string, buttons: string[]): Promise<number> => {
    setSuspended(true); await request('browserBounds', { id: null, rect: null }).catch(() => {})
    return new Promise(resolve => setDecision({ message, buttons, resolve: value => { setDecision(null); setSuspended(false); resolve(value) } }))
  }
  const confirm = async (message: string): Promise<boolean> => (await choose(message, ['Cancel', 'Continue'])) === 1
  const openFile = (path: string): void => { void work(async () => {
    let selected = path
    if (!buffers.current.some(f => f.path === path)) {
      if (buffers.current.length >= 30) throw new Error('Close a file before opening another (30 maximum)')
      const owner = workspace?.project.id, opened = /\.(ico|png|jpe?g|gif|webp|bmp)$/i.test(path) ? await request('readImage', { path }, owner) : await request('read', { path }, owner)
      if (current.current?.project.id !== owner) return
      selected = opened.path
      if (!buffers.current.some(f => f.path === opened.path)) updateFiles([...buffers.current, buffer(opened)])
    }
    setFilePath(selected); setMode('code'); setShowGit(false); if (narrow && !docked) setShowFiles(false)
  }) }
  const save = async (path: string, automatic = false): Promise<void> => {
    const file = buffers.current.find(f => f.path === path); if (!file || file.image) return
    const owner = workspace?.project.id, key = owner + ':' + path
    if (saving.current.has(key) || (automatic && (file.conflict || file.issue || file.text === file.base))) return
    let revision = file.revision
    if (file.conflict) {
      if (!await confirm('This file changed on disk. Replace that version with your edits?')) return
      revision = file.conflict.revision
    }
    saving.current.add(key)
    try {
      const saved = await request('save', { path, text: file.text, revision, bom: file.bom }, owner)
      if (current.current?.project.id === owner) updateFiles(buffers.current.map(f => f.path !== path ? f : f.text === file.text ? buffer(saved) : { ...f, revision: saved.revision, base: saved.text, issue: undefined }))
    } catch (e) {
      if (automatic && current.current?.project.id === owner) updateFiles(buffers.current.map(f => f.path === path ? { ...f, issue: `Autosave paused: ${String(e)}` } : f))
      throw e
    } finally { saving.current.delete(key) }
  }
  autoSaveFile.current = path => save(path, true)
  const closeFile = (path: string): void => { void work(async () => {
    const file = buffers.current.find(f => f.path === path)
    if (file && file.text !== file.base) {
      const answer = await choose('Save changes to ' + path + '?', ['Save', 'Discard', 'Cancel'])
      if (answer === 2) return
      if (answer === 0) {
        await save(path)
        if (buffers.current.some(f => f.path === path && f.text !== f.base)) return
      }
    }
    const next = buffers.current.filter(f => f.path !== path); updateFiles(next); if (filePath === path) setFilePath(next[0]?.path ?? '')
  }) }
  const addTerminal = (): void => { void work(async () => { const t = await request('terminalNew', undefined, workspace?.project.id); setWorkspace(old => old ? { ...old, terminals: [...old.terminals, t] } : old); setTerminalId(t.id); setOverview(false) }) }
  const addBrowser = (): void => { void work(async () => { const b = await request('browserNew', undefined, workspace?.project.id); setWorkspace(old => old ? { ...old, browsers: [...old.browsers, b] } : old); setBrowserId(b.id) }) }
  const closeTerminal = (id: string): void => { void work(async () => {
    setSuspended(true)
    try { if (await request('terminalClose', { id })) setWorkspace(old => { if (!old) return old; const next = old.terminals.filter(t => t.id !== id); if (terminalId === id) setTerminalId(next[0]?.id ?? ''); return { ...old, terminals: next } }) }
    finally { setSuspended(false) }
  }) }
  const closeBrowser = (id: string): void => { void work(async () => { await request('browserClose', { id }); setWorkspace(old => { if (!old) return old; const next = old.browsers.filter(b => b.id !== id); if (browserId === id) setBrowserId(next[0]?.id ?? ''); return { ...old, browsers: next } }) }) }
  const terminalExit = (id: string, exitCode: number): void => setWorkspace(old => old ? { ...old, terminals: old.terminals.map(t => t.id === id ? { ...t, exitCode } : t) } : old)
  const renameTerminal = (terminal: TerminalSession, name: string): void => { if (terminal.name === name) return; void work(async () => { await request('terminalRename', { id: terminal.id, name }); setWorkspace(old => old ? { ...old, terminals: old.terminals.map(t => t.id === terminal.id ? { ...t, name } : t) } : old) }) }
  const addProject = (): void => { void work(async () => { const project = await request('add', undefined); refresh(); if (project) location.hash = hashFor('projects', project.id) }) }
  const navigate = (tab: BrowserTab): void => { void work(() => request('browserNavigate', { id: tab.id, url })) }
  const activeFile = files.find(f => f.path === filePath)
  return <div ref={page} className="projects-page">
    {decision && <div className="project-modal-backdrop"><div className="project-modal" role="dialog" aria-modal="true" aria-label={decision.message} onKeyDown={e => { if (e.key === 'Escape') decision.resolve(decision.buttons.indexOf('Cancel')); if (e.key === 'Tab') { const buttons = [...e.currentTarget.querySelectorAll('button')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement); e.preventDefault(); buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus() } }}><p>{decision.message}</p><div>{decision.buttons.map((button, index) => <button key={button} autoFocus={button === 'Cancel'} onClick={() => decision.resolve(index)}>{button}</button>)}</div></div></div>}
    {error && <div className="project-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {!shown && <div className="projects-list"><header><div><h1>Projects</h1><p>Your folders, terminals, code and previews.</p></div><button disabled={busy} onClick={addProject}>Open folder</button></header>
      {!projects.length && <div className="project-empty">Open a folder to start a workspace.</div>}
      {projects.map(p => <div className="project-row" key={p.id}><a href={hashFor('projects', p.id)}><strong>{p.name}</strong><span>{p.path}</span><small>{p.url}</small></a><button disabled={busy} onClick={() => void work(async () => { await request('locate', { id: p.id }); refresh() })}>Locate</button><button disabled={busy} onClick={() => void work(async () => { if (await request('remove', { id: p.id })) { if (workspace?.project.id === p.id) { setWorkspace(null); buffers.current = []; setFiles([]) } refresh() } })}>Remove</button></div>)}
    </div>}
    {workspace && <div className={`project-workspace ${shown ? '' : 'project-hidden'}`}>
      <div className="project-header"><a className="project-name" href={hashFor('projects')} title={workspace.project.path}>{workspace.project.name}</a>
        <div className="project-modes">{(['terminal', 'code', 'browser'] as const).map(m => <button key={m} title={m === 'code' ? 'Browse project files and open editors' : undefined} aria-pressed={mode === m} onClick={() => { setMode(m); if (m === 'code') setShowFiles(true) }}>{m === 'terminal' ? 'Terminal' : m === 'code' ? 'Code' : 'Browser'}<span title={m === 'code' ? 'Open editor tabs' : undefined}>{m === 'terminal' ? workspace.terminals.length : m === 'code' ? files.length : workspace.browsers.length}</span></button>)}</div>
        <button className="project-files-toggle" aria-pressed={showFiles} onClick={() => setShowFiles(!showFiles)}>▱ Files</button><button className="project-close" title="Close workspace" onClick={() => void work(async () => { setSuspended(true); try { if (await request('close', undefined)) { setWorkspace(null); buffers.current = []; setFiles([]); location.hash = hashFor('projects') } } finally { setSuspended(false) } })}>×</button>
      </div>
      <div className="project-workspace-tools"><button aria-pressed={showGit && mode === 'code'} onClick={() => { setShowGit(!showGit); setMode('code') }}>⑂ Changes{git ? ` · ${git.changes.length}` : ''}</button><label><input type="checkbox" checked={autosave} onChange={e => { setAutosave(e.target.checked); try { localStorage.setItem('projects.autosave', String(e.target.checked)) } catch { /* Session preference applies. */ } }} /> Autosave</label><span title="Only active inside this project's window">Ctrl+Alt+1 / 2 / 3 · tools　 Ctrl+Alt+← / → · tabs</span></div>
      <div className="project-sessionbar">
        {mode === 'terminal' && <button className="project-overview" aria-label="Show all terminals" aria-pressed={overview} onClick={() => setOverview(!overview)}>▦</button>}
        <div className="project-tabs">
          {mode === 'code' && <div className={`project-tab ${showGit ? 'selected' : ''}`}><button onClick={() => setShowGit(true)}>⑂ Changes</button></div>}
          {mode === 'terminal' && workspace.terminals.map(t => <div key={t.id} className={`project-tab ${terminalId === t.id && !overview ? 'selected' : ''}`}><button onClick={() => { setTerminalId(t.id); setOverview(false) }}>{t.name}{t.exitCode !== null ? ' · exited' : ''}</button><button aria-label={`Close ${t.name}`} onClick={() => closeTerminal(t.id)}>×</button></div>)}
          {mode === 'code' && files.map(f => <div key={f.path} className={`project-tab project-code-tab ${filePath === f.path && !showGit ? 'selected' : ''}`}><button title={f.path} onClick={() => { setFilePath(f.path); setShowGit(false) }}><FileIcon path={f.path} /><span>{f.path.split(/[\\/]/).pop()}</span>{f.text !== f.base && <span className="project-file-state" aria-label="Unsaved changes" title="Unsaved changes">●</span>}{(f.conflict || f.issue) && <span className="project-file-state warning" title="File needs attention">!</span>}</button><button aria-label={`Close ${f.path}`} onClick={() => closeFile(f.path)}>×</button></div>)}
          {mode === 'browser' && workspace.browsers.map(b => <div key={b.id} className={`project-tab ${browserId === b.id ? 'selected' : ''}`}><button title={b.url} onClick={() => setBrowserId(b.id)}>{b.loading ? '◌ ' : ''}{b.title}</button><button aria-label={`Close ${b.title}`} onClick={() => closeBrowser(b.id)}>×</button></div>)}
        </div><button disabled={busy} className="project-add" aria-label={mode === 'code' ? 'Open file tree' : `New ${mode}`} onClick={() => mode === 'terminal' ? addTerminal() : mode === 'browser' ? addBrowser() : setShowFiles(true)}>+</button>
      </div>
      <div className="project-body">
        {showFiles && <FileTree key={workspace.project.id} workspaceId={workspace.project.id} open={openFile} activePath={filePath} buffers={files} docked={docked} setDocked={changeDocked} git={git} />}
        <div className="project-canvas">
          <div className={mode === 'code' && showGit ? 'project-git-container' : 'project-hidden'}><GitPanel key={workspace.project.id} workspaceId={workspace.project.id} onStatus={setGit} /></div>
          <div className={`project-terminals ${overview ? 'overview' : ''} ${mode !== 'terminal' ? 'project-hidden' : ''}`}>
            {workspace.terminals.map(t => <section key={t.id} className={`project-terminal-card ${!overview && terminalId !== t.id ? 'project-hidden' : ''}`}>
              <div className="project-terminal-heading"><input aria-label="Terminal name" defaultValue={t.name} key={t.name} onBlur={e => renameTerminal(t, e.target.value)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />{overview && <button onClick={() => { setTerminalId(t.id); setOverview(false) }}>Focus ↗</button>}{t.exitCode !== null && <button onClick={() => void work(async () => { const next = await request('terminalRestart', { id: t.id }); setWorkspace(old => old ? { ...old, terminals: old.terminals.map(s => s.id === t.id ? next : s) } : old); setTerminalId(next.id) })}>Restart</button>}</div>
              <TerminalPane id={t.id} onExit={code => terminalExit(t.id, code)} onError={report} />
            </section>)}
            {!workspace.terminals.length && <div className="project-empty"><button onClick={addTerminal}>New terminal</button></div>}
          </div>
          <div className={`project-editors ${mode !== 'code' || showGit ? 'project-hidden' : ''}`}>
            {activeFile?.conflict && <div className="project-conflict">Changed on disk. Your edits are preserved.<button onClick={() => void work(async () => { if (await confirm('Discard your edits and reload from disk?')) updateFiles(buffers.current.map(f => f.path === filePath ? buffer(f.conflict!) : f)) })}>Reload disk</button><button onClick={() => void work(() => save(filePath))}>Save my edits…</button></div>}
            {activeFile?.issue && <div className="project-error">{activeFile.issue}</div>}
            {files.map(f => <div key={`${workspace.project.id}:${f.path}`} className={`project-editor-wrap ${filePath !== f.path ? 'project-hidden' : ''}`}><div className="project-filebar"><span className="project-breadcrumb" title={f.path}><FileIcon path={f.path} />{f.path.split(/[\\/]/).map((part, i) => <span key={i}>{i > 0 && <i aria-hidden="true">›</i>}{part}</span>)}</span><span className="project-save-state">{f.image ? 'Read-only image' : f.issue ? 'Unavailable on disk' : f.conflict ? 'Changed on disk' : f.text !== f.base ? 'Unsaved' : 'Saved'}</span>{!f.image && <button disabled={f.text === f.base || busy} onClick={() => void work(() => save(f.path))}>Save · Ctrl+S</button>}</div>{f.image ? <ImagePreview key={f.revision} path={f.path} src={f.image} /> : <Suspense fallback={<div className="project-empty">Loading editor…</div>}><EditorPane file={f} onChange={text => updateFiles(buffers.current.map(old => old.path === f.path ? { ...old, text } : old))} onSave={() => void work(() => save(f.path))} /></Suspense>}</div>)}
            {!files.length && <div className="project-empty"><button onClick={() => setShowFiles(true)}>Choose a file from Files</button></div>}
          </div>
          {mode === 'browser' && <div className="project-browser">
            {selectedBrowser ? <><form className="project-urlbar" onSubmit={e => { e.preventDefault(); navigate(selectedBrowser) }}><button type="button" aria-label="Back" disabled={!selectedBrowser.back} onClick={() => void work(() => request('browserAction', { id: browserId, action: 'back' }))}>←</button><button type="button" aria-label="Forward" disabled={!selectedBrowser.forward} onClick={() => void work(() => request('browserAction', { id: browserId, action: 'forward' }))}>→</button><button type="button" aria-label="Reload" onClick={() => void work(() => request('browserAction', { id: browserId, action: 'reload' }))}>↻</button><input aria-label="Preview URL" value={url} onChange={e => setUrl(e.target.value)} /><button type="submit">Go</button></form><div ref={browserSlot} className="project-browser-slot">{selectedBrowser.error && <div className="project-empty">{selectedBrowser.error}<button onClick={() => navigate(selectedBrowser)}>Retry</button></div>}</div></> : <div className="project-empty"><button onClick={addBrowser}>New browser tab</button></div>}
          </div>}
        </div>
      </div><div className="project-status"><span>{workspace.project.path}</span><span>{busy ? 'Working…' : mode === 'terminal' ? 'PowerShell · commands run as your user' : mode === 'code' ? (autosave ? 'UTF-8 · autosave after 1.2s' : 'UTF-8 · manual save') : 'Isolated preview'}</span></div>
    </div>}
  </div>
}
