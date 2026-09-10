import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What the window is allowed to import.
 *
 * The renderer is a web page. A settings screen once imported a constant from
 * `@wouice/store`, whose index also exports the database, which imports
 * `node:sqlite`; the renderer bundle stopped building while main and preload
 * went on building, and the app kept running the previous interface. The build
 * now refuses such an import by name. This says so in the test run, before
 * anybody builds.
 *
 * It follows the imports the window ACTUALLY bundles - starting from every file
 * in `src/renderer` and walking relative imports into `src/shared` - and skips
 * `import type`, which is erased before bundling. A shared file only main uses
 * may import whatever it likes.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, '../..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

interface Import {
  clause: string
  from: string
}

/** Every static import and re-export, with what it brings in. */
function importsOf(source: string): Import[] {
  const found: Import[] = []
  for (const m of source.matchAll(/^\s*(?:import|export)\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    found.push({ clause: m[1]!.trim(), from: m[2]! })
  }
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    found.push({ clause: '', from: m[1]! })
  }
  return found
}

const typeOnly = (clause: string): boolean => clause.startsWith('type ')

/** `./foo.js` as the TypeScript file it names, or null for anything else. */
function resolveLocal(importer: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(importer), spec.replace(/\.js$/, ''))
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Every file the window bundles, reached through imports that survive compilation. */
function bundled(): string[] {
  const seen = new Set<string>()
  const queue = walk(here)
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const { clause, from } of importsOf(readFileSync(file, 'utf8'))) {
      if (typeOnly(clause)) continue
      const next = resolveLocal(file, from)
      if (next) queue.push(next)
    }
  }
  return [...seen]
}

describe('what the window may import', () => {
  it('reaches into src/shared, so the walk is actually following imports', () => {
    expect(bundled().some((file) => file.includes(`${path.sep}shared${path.sep}`))).toBe(true)
  })

  it('takes only types from the store, and nothing from Node', () => {
    const problems: string[] = []
    for (const file of bundled()) {
      for (const { clause, from } of importsOf(readFileSync(file, 'utf8'))) {
        const node = from.startsWith('node:')
        const storeRoot = from === '@wouice/store' && !typeOnly(clause)
        if (node || storeRoot) {
          problems.push(`${path.relative(desktop, file)}: ${clause || '(side effect)'} from '${from}'`)
        }
      }
    }
    // Values the window needs from the store come from '@wouice/store/types'.
    expect(problems).toEqual([])
  })

  it("keeps the store's types entry free of anything that runs", () => {
    // '@wouice/store/types' is only safe in a window while it imports nothing
    // but types itself.
    const types = path.resolve(desktop, '../packages/store/src/types.ts')
    const runtime = importsOf(readFileSync(types, 'utf8')).filter((i) => !typeOnly(i.clause))
    expect(runtime).toEqual([])
  })
})
