import { useEffect, useState } from 'react'
import type { Project } from '../../shared/projects.js'
import { hashFor, parseHash } from '../shell/routes.js'
import { Icon } from '../shell/Icon.js'

export function ProjectNav({ collapsed, active }: { collapsed: boolean; active: boolean }): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState('')
  useEffect(() => {
    const load = (): void => { void window.wouice.projects.request('list', undefined).then(setProjects).catch(() => {}) }
    const route = (): void => setSelected(parseHash(location.hash).query)
    load(); route(); const off = window.wouice.projects.onChanged(load)
    window.addEventListener('hashchange', route)
    return () => { off(); window.removeEventListener('hashchange', route) }
  }, [])
  const add = async (): Promise<void> => {
    try { const project = await window.wouice.projects.request('add', undefined); if (project) location.hash = hashFor('projects', project.id) }
    catch { location.hash = hashFor('projects') }
  }
  return <div>
    <div className={`mb-1 flex items-center justify-between text-neutral-500 ${collapsed ? 'justify-center' : 'px-3'}`}>
      <a href={hashFor('projects')} title="All projects" className="text-[10px] font-medium tracking-widest uppercase">{collapsed ? <Icon name="folder" /> : 'Projects'}</a>
      {!collapsed && <button onClick={() => void add()} aria-label="Add project" className="px-1 text-base hover:text-white">+</button>}
    </div>
    {projects.map(p => <a key={p.id} href={hashFor('projects', p.id)} title={p.path} aria-current={active && selected === p.id ? 'page' : undefined}
      className={`my-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] ${active && selected === p.id ? 'lift-active bg-white/[0.07] text-neutral-100 ring-1 ring-white/[0.08]' : 'text-neutral-500 hover:bg-white/5 hover:text-neutral-300'} ${collapsed ? 'justify-center px-0' : ''}`}>
      <span className="grid size-5 shrink-0 place-items-center rounded border border-white/10 text-[10px]">{p.name.slice(0, 1).toUpperCase()}</span>{!collapsed && <span className="truncate">{p.name}</span>}
    </a>)}
    {!projects.length && !collapsed && <button onClick={() => void add()} className="px-3 py-2 text-xs text-neutral-500 hover:text-white">Open a folder…</button>}
  </div>
}
