import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listFiles, readText, readImage, resolveFile, saveText } from './files.js'
import { ProjectRegistry } from './registry.js'

let dir: string, root: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wouice-projects-')); root = path.join(dir, 'project'); fs.mkdirSync(root) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
describe('project file boundary', () => {
  it('returns bounded read-only image data without changing binary files', () => {
    const bytes = Buffer.from([0, 0, 1, 0, 1, 0]), file = path.join(root, 'favicon.ico')
    fs.writeFileSync(file, bytes)
    const image = readImage(root, 'favicon.ico')
    expect(image.image).toBe('data:image/x-icon;base64,' + bytes.toString('base64'))
    expect(image.text).toBe(''); expect(fs.readFileSync(file)).toEqual(bytes)
    expect(() => readText(root, 'favicon.ico')).toThrow('Binary')
    expect(() => readImage(root, '../outside.ico')).toThrow('outside')
    fs.writeFileSync(path.join(root, 'large.png'), Buffer.alloc(10 * 1024 * 1024 + 1))
    expect(() => readImage(root, 'large.png')).toThrow('10 MiB')
  })
  it('rejects traversal, absolute paths and junctions outside the root', () => {
    const outside = path.join(dir, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
    expect(() => resolveFile(root, '../outside/secret.txt')).toThrow('outside')
    expect(() => resolveFile(root, path.join(outside, 'secret.txt'))).toThrow('Invalid')
    fs.symlinkSync(outside, path.join(root, 'external'), 'junction')
    expect(() => readText(root, 'external/secret.txt')).toThrow('outside')
    expect(listFiles(root, '', false).find(f => f.name === 'external')?.blocked).toBe(true)
  })
  it('preserves Unicode, BOM and CRLF and rejects stale saves', () => {
    const file = path.join(root, 'hello.ts'); fs.writeFileSync(file, '\ufeffहैलो\r\nworld\r\n')
    const read = readText(root, 'hello.ts'); expect(read.bom).toBe(true); expect(read.text).toBe('हैलो\r\nworld\r\n')
    const saved = saveText(root, { ...read, text: read.text + '// changed\r\n' })
    expect(fs.readFileSync(file, 'utf8')).toBe('\ufeff' + saved.text)
    expect(() => saveText(root, { ...read, text: 'stale' })).toThrow('Changed on disk')
    fs.unlinkSync(file); expect(() => saveText(root, saved)).toThrow(); expect(fs.existsSync(file)).toBe(false)
  })
  it('rejects binary, invalid UTF-8 and oversized files', () => {
    fs.writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2])); expect(() => readText(root, 'binary')).toThrow('Binary')
    fs.writeFileSync(path.join(root, 'invalid'), Buffer.from([255])); expect(() => readText(root, 'invalid')).toThrow()
    fs.writeFileSync(path.join(root, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65)); expect(() => readText(root, 'large')).toThrow('2 MiB')
  })
})
describe('project registry', () => {
  it('deduplicates canonical paths, persists URLs, removes entries without deleting files', () => {
    const registry = new ProjectRegistry(dir); const first = registry.add(root)
    expect(registry.add(root).id).toBe(first.id)
    registry.url(first.id, 'http://localhost:5173/')
    expect(new ProjectRegistry(dir).get(first.id).url).toContain('5173')
    registry.remove(first.id); expect(registry.list()).toEqual([]); expect(fs.existsSync(root)).toBe(true)
  })
  it('preserves a corrupt registry and refuses to overwrite it', () => {
    const file = path.join(dir, 'projects.json'); fs.writeFileSync(file, '{corrupt')
    const registry = new ProjectRegistry(dir)
    expect(() => registry.add(root)).toThrow('preserved'); expect(fs.readFileSync(file, 'utf8')).toBe('{corrupt')
  })
})
