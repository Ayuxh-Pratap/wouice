import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inside, resolveFile, readText } from './files.js'
import type { GitStatus, GitChange } from '../../shared/projects.js'

const execute = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', ...args], { cwd, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '' } })
    return stdout
  } catch (error) {
    const e = error as { code?: string; stderr?: string; killed?: boolean }
    if (e.code === 'ENOENT') throw new Error('Git is not installed or is not on PATH. Install Git and restart Wouice.')
    if (e.killed || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git output is too large or the operation timed out.')
    throw new Error(e.stderr?.trim() || 'Could not read this Git repository')
  }
}
async function repository(root: string, relative: string): Promise<string> {
  const candidate = resolveFile(root, relative)
  const top = fs.realpathSync((await git(candidate, ['rev-parse', '--show-toplevel'])).trim())
  if (!inside(root, top)) throw new Error('Open the repository root as a project to inspect its Git changes.')
  return top
}
export async function gitRepositories(root: string): Promise<string[]> {
  root = fs.realpathSync.native(root)
  const candidates = ['']
  // Immediate children cover generated projects such as test/my-app; never crawl dependencies.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', '.git', '.next'].includes(entry.name) && fs.existsSync(path.join(root, entry.name, '.git'))) candidates.push(entry.name)
  }
  const found = new Set<string>()
  for (const candidate of candidates) {
    try { found.add(path.relative(root, await repository(root, candidate))) }
    catch (error) { if (String(error).includes('not installed')) throw error }
  }
  return [...found]
}
export function parseStatus(output: string, root: string): GitStatus {
  const records = output.split('\0'), changes: GitChange[] = []
  let branch = ''
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (!record) continue
    if (record.startsWith('## ')) { branch = record.slice(3); continue }
    const change: GitChange = { index: record[0]!, worktree: record[1]!, path: record.slice(3) }
    if (/[RC]/.test(change.index + change.worktree)) change.previousPath = records[++i]
    changes.push(change)
  }
  return { root, branch, changes }
}
export async function gitStatus(root: string, relative: string): Promise<GitStatus> {
  root = fs.realpathSync.native(root)
  const repo = await repository(root, relative)
  return parseStatus(await git(repo, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']), path.relative(root, repo))
}
export async function gitDiff(root: string, relative: string, file: string, staged: boolean): Promise<string> {
  root = fs.realpathSync.native(root)
  const repo = await repository(root, relative)
  const status = parseStatus(await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), '')
  const change = status.changes.find(c => c.path === file)
  if (!change) return 'This file has no saved changes. Refresh the change list.'
  if (change.index === '?' && !staged) {
    try {
      const text = readText(repo, file).text
      return `New untracked file: ${file}\n` + text.split('\n').map(line => '+' + line).join('\n')
    } catch { return 'Untracked file preview unavailable (binary, too large, or outside the repository).' }
  }
  return await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(staged ? ['--cached'] : []), '--', file, ...(change.previousPath ? [change.previousPath] : [])]) || 'No changes in this view.'
}
