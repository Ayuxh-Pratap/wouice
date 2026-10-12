import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { FileImage, FileText, ProjectFile } from '../../shared/projects.js'

export const MAX_TEXT = 2 * 1024 * 1024
export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
export function resolveFile(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Invalid project path')
  const candidate = path.resolve(root, relative)
  if (!inside(root, candidate)) throw new Error('Path is outside the project')
  const real = fs.realpathSync(candidate)
  if (!inside(root, real)) throw new Error('This link points outside the project')
  return real
}
export function listFiles(root: string, relative: string, excluded: boolean): ProjectFile[] {
  const dir = resolveFile(root, relative)
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => excluded || !['.git', 'node_modules'].includes(e.name)).map(e => {
    const child = path.join(relative, e.name)
    try { const real = resolveFile(root, child); return { name: e.name, path: child, directory: fs.statSync(real).isDirectory(), blocked: false } }
    catch { return { name: e.name, path: child, directory: false, blocked: true } }
  }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
}
export function readText(root: string, relative: string): FileText {
  const real = resolveFile(root, relative)
  const fd = fs.openSync(real, 'r')
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_TEXT) throw new Error('Only text files up to 2 MiB can be edited')
    const bytes = Buffer.alloc(MAX_TEXT + 1)
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (length > MAX_TEXT) throw new Error('This file is too large to edit')
    const data = bytes.subarray(0, length)
    if (data.includes(0)) throw new Error('Binary files cannot be edited')
    const bom = data.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bom ? data.subarray(3) : data)
    return { path: path.relative(root, real), text, bom, revision: createHash('sha256').update(data).digest('hex') }
  } finally { fs.closeSync(fd) }
}
export function saveText(root: string, file: FileText): FileText {
  if (typeof file.text !== 'string' || Buffer.byteLength(file.text, 'utf8') > MAX_TEXT || typeof file.bom !== 'boolean') throw new Error('Invalid text file')
  const current = readText(root, file.path)
  if (current.revision !== file.revision) throw new Error('Changed on disk. Reload the file or explicitly resolve the conflict before saving.')
  const real = resolveFile(root, file.path)
  // Preserve the original inode/permissions, including files watched by dev servers.
  fs.writeFileSync(real, (file.bom ? '\ufeff' : '') + file.text, 'utf8')
  return readText(root, file.path)
}

export function readImage(root: string, relative: string): FileImage {
  const real = resolveFile(root, relative)
  const mime = ({ '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' } as Record<string, string>)[path.extname(real).toLowerCase()]
  if (!mime) throw new Error('This file type has no image preview')
  const fd = fs.openSync(real, 'r'), limit = 10 * 1024 * 1024
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('Image previews support files up to 10 MiB')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1)), length = fs.readSync(fd, bytes, 0, bytes.length, 0)
    if (length > stat.size || !length) throw new Error('Image changed while reading or is empty. Try opening it again.')
    const data = bytes.subarray(0, length)
    return { path: path.relative(root, real), text: '', bom: false, revision: createHash('sha256').update(data).digest('hex'), image: `data:${mime};base64,${data.toString('base64')}` }
  } finally { fs.closeSync(fd) }
}
