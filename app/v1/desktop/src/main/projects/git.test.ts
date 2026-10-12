import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gitRepositories, gitStatus, gitDiff, parseStatus } from './git.js'
let root: string, repo: string
const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wouice-git-'))); repo = path.join(root, 'my-app'); fs.mkdirSync(repo)
  run('init'); run('config', 'user.email', 'fixture@example.invalid'); run('config', 'user.name', 'Test fixture')
  fs.writeFileSync(path.join(repo, 'file.ts'), 'original\n'); run('add', '.'); run('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
describe('read-only Git', () => {
  it('discovers a generated child repository and separates staged and disk changes without changing its index', async () => {
    expect(await gitRepositories(root)).toEqual(['my-app'])
    fs.writeFileSync(path.join(repo, 'file.ts'), 'staged\n'); run('add', 'file.ts'); fs.writeFileSync(path.join(repo, 'file.ts'), 'working\n')
    const index = fs.readFileSync(path.join(repo, '.git/index')), head = run('rev-parse', 'HEAD')
    const status = await gitStatus(root, 'my-app')
    expect(status.changes[0]).toMatchObject({ path: 'file.ts', index: 'M', worktree: 'M' })
    expect(await gitDiff(root, 'my-app', 'file.ts', true)).toContain('+staged')
    expect(await gitDiff(root, 'my-app', 'file.ts', false)).toContain('+working')
    expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(index); expect(run('rev-parse', 'HEAD')).toEqual(head)
  })
  it('handles deletion, rename, Unicode untracked paths, and rejects paths outside the project', async () => {
    run('mv', 'file.ts', 'renamed.ts'); fs.writeFileSync(path.join(repo, 'नया file.ts'), 'new text')
    const status = await gitStatus(root, 'my-app')
    expect(status.changes).toContainEqual({ path: 'renamed.ts', previousPath: 'file.ts', index: 'R', worktree: ' ' })
    expect(await gitDiff(root, 'my-app', 'नया file.ts', false)).toContain('+new text')
    fs.unlinkSync(path.join(repo, 'renamed.ts'))
    expect(await gitDiff(root, 'my-app', 'renamed.ts', false)).toContain('-original')
    await expect(gitStatus(root, '..')).rejects.toThrow('outside')
  })
  it('supports an initial repository without commits', async () => {
    const empty = path.join(root, 'empty'); fs.mkdirSync(empty)
    execFileSync('git', ['init', empty], { stdio: 'ignore', windowsHide: true })
    expect((await gitStatus(root, 'empty')).changes).toEqual([])
  })
  it('parses paths containing newlines without splitting records', () => {
    expect(parseStatus('## main\0 M a\nb.ts\0', '').changes[0]?.path).toBe('a\nb.ts')
  })
})
