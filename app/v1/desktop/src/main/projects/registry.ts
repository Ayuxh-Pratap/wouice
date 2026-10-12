import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Project } from '../../shared/projects.js'

export class ProjectRegistry {
  private items: Project[] = []
  private error: string | null = null
  private file: string
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'projects.json')
    if (fs.existsSync(this.file)) {
      try {
        const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        const parsed = data as { version?: number; projects?: Project[] }
        if (parsed.version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.some(p => !p || !['id', 'name', 'path', 'url'].every(k => typeof p[k as keyof Project] === 'string'))) throw new Error('Invalid projects file')
        this.items = parsed.projects
      } catch { this.error = `Cannot read ${this.file}. The original file has been preserved; repair it or move it aside and restart Wouice.` }
    }
  }
  list(): Project[] { if (this.error) throw new Error(this.error); return this.items.map(p => ({ ...p })) }
  get(id: string): Project { const p = this.list().find(p => p.id === id); if (!p) throw new Error('Project not found'); return p }
  private persist(items: Project[]): void {
    if (this.error) throw new Error(this.error)
    const temp = this.file + '.tmp'
    fs.writeFileSync(temp, JSON.stringify({ version: 1, projects: items }, null, 2), 'utf8')
    fs.renameSync(temp, this.file); this.items = items
  }
  add(folder: string, id?: string): Project {
    const real = fs.realpathSync(folder)
    if (!fs.statSync(real).isDirectory()) throw new Error('Choose a folder')
    const existing = this.list().find(p => p.path.toLowerCase() === real.toLowerCase())
    if (existing && existing.id !== id) return existing
    const project = { id: id ?? randomUUID(), path: real, name: path.basename(real) || real, url: id ? this.get(id).url : 'http://localhost:3000' }
    this.persist([...this.items.filter(p => p.id !== project.id), project]); return project
  }
  remove(id: string): void { this.get(id); this.persist(this.items.filter(p => p.id !== id)) }
  url(id: string, url: string): void { this.persist(this.items.map(p => p.id === id ? { ...p, url } : p)) }
}
