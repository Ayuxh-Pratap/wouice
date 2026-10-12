import { useEffect, useState } from 'react'
import type { GitStatus } from '../../shared/projects.js'
import { FileIcon } from './FileIcon.js'
const request = window.wouice.projects.request
export function GitPanel({ workspaceId, onStatus }: { workspaceId: string; onStatus(status: GitStatus | null): void }): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]), [repo, setRepo] = useState<string | null>(null), [folder, setFolder] = useState('')
  const [status, setStatus] = useState<GitStatus | null>(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState(''), [staged, setStaged] = useState(false), [diff, setDiff] = useState('Select a changed file to inspect its saved diff.')
  useEffect(() => {
    let stopped = false, loading = false
    const discover = async (): Promise<void> => {
      if (loading) return; loading = true
      try { const next = await request('gitRepositories', undefined, workspaceId); if (!stopped) { setRepos(next); setRepo(old => old ?? next[0] ?? null) } }
      catch (e) { if (!stopped) setError(String(e)) }
      finally { loading = false }
    }
    void discover(); const timer = setInterval(() => void discover(), 10000)
    return () => { stopped = true; clearInterval(timer) }
  }, [workspaceId, refresh])
  useEffect(() => {
    if (repo === null) { onStatus(null); return }
    setStatus(null); onStatus(null)
    let stopped = false, loading = false, failed = false
    const load = async (): Promise<void> => {
      if (loading || failed) return; loading = true
      try {
        const next = await request('gitStatus', { repository: repo }, workspaceId)
        if (!stopped) { setStatus(next); onStatus(next); setError('') }
      } catch (e) { failed = true; if (!stopped) { setError(String(e) + ' — Automatic refresh paused. Select a repository or click Refresh Git to retry.'); setStatus(null); onStatus(null) } }
      finally { loading = false }
    }
    void load(); const timer = setInterval(() => void load(), 3000)
    window.addEventListener('focus', load)
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [repo, workspaceId, refresh, onStatus])
  useEffect(() => {
    if (!selected || repo === null) { setDiff('Select a changed file to inspect its saved diff.'); return }
    let stopped = false
    void request('gitDiff', { repository: repo, path: selected, staged }, workspaceId).then(text => { if (!stopped) setDiff(text) }).catch(e => { if (!stopped) setDiff(String(e)) })
    return () => { stopped = true }
  }, [repo, selected, staged, status, workspaceId])
  return <section className="project-git" aria-label="Git changes">
    <div className="project-git-toolbar"><strong>Source control</strong><span>Read-only · saved files</span><button onClick={() => setRefresh(n => n + 1)}>Refresh Git</button></div>
    <form className="project-git-toolbar" onSubmit={e => { e.preventDefault(); setRepo(folder); setSelected(''); setRefresh(n => n + 1) }}>
      <label>Repository <select aria-label="Repository" value={repo ?? '__none'} onChange={e => { setRepo(e.target.value); setSelected('') }}><option value="__none" disabled>Select repository</option>{[...new Set([...repos, ...(repo === null ? [] : [repo])])].map(r => <option key={r} value={r}>{r || 'Project root'}</option>)}</select></label>
      <input aria-label="Repository folder" placeholder="Nested folder, e.g. my-app" value={folder} onChange={e => setFolder(e.target.value)} /><button>Inspect folder</button>
    </form>
    {error && <div role="alert" className="project-error">{error.replace(/^Error: Error invoking remote method '[^']+': (?:Error: )?/, '')}</div>}
    {repo === null && !error && <div className="project-empty">No repository found. Open an existing repository folder or enter its relative path above.</div>}
    {status && <><div className="project-git-branch">⑂ {status.branch} · {status.changes.length} changed files</div><div className="project-git-body"><div className="project-git-files">
      {!status.changes.length && <p>Working tree clean</p>}{status.changes.length > 1000 && <p>Showing the first 1,000 files.</p>}
      {status.changes.slice(0, 1000).map(c => <button key={c.path} className={selected === c.path ? 'selected' : ''} title={c.previousPath ? `${c.previousPath} → ${c.path}` : c.path} onClick={() => { setSelected(c.path); setStaged(c.index !== ' ' && c.index !== '?' && c.worktree === ' ') }}><FileIcon path={c.path} /><span>{c.path}</span><b title="Index / working tree">{c.index}{c.worktree}</b></button>)}
    </div><div className="project-git-diff"><div className="project-git-toolbar"><button aria-pressed={!staged} onClick={() => setStaged(false)}>Working tree</button><button aria-pressed={staged} onClick={() => setStaged(true)}>Staged</button><span>{selected}</span></div>{diff.split('\n').length > 4000 && <p>Preview limited to the first 4,000 lines.</p>}<pre tabIndex={0} aria-label="Git diff">{diff.split('\n').slice(0, 4000).map((line, i) => <div key={i} className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : ''}>{line || ' '}</div>)}</pre></div></div></>}
  </section>
}
