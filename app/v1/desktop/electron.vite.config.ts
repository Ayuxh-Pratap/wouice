import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Our own workspace packages are TypeScript SOURCE, not built artifacts, so
// they must be bundled rather than externalized. externalizeDepsPlugin treats
// everything in `dependencies` as external by default, which would leave Node
// resolving `@wouice/asr` at runtime and failing on its `.js` specifiers.
const WORKSPACE = ['@wouice/asr', '@wouice/dictionary', '@wouice/llm', '@wouice/store']

/**
 * The renderer is a web page, and must never pull in code that needs Node.
 *
 * A BUILD ERROR WITH A NAME ON IT. A settings screen once imported a constant
 * from `@wouice/store`, whose index also exports the database, which imports
 * `node:sqlite`. The renderer bundle stopped building while main and preload
 * still built, so the output showed two "built in" lines instead of three and
 * the app went on running the previous interface. Type-only imports are erased
 * before this runs, so it fires only on an import that would really have been
 * bundled - and it says which file, and what to import instead.
 */
const browserOnly = {
  name: 'wouice:browser-only',
  enforce: 'pre' as const,
  resolveId(id: string, importer?: string): null {
    if (id === '@wouice/store' || id.startsWith('node:')) {
      throw new Error(
        `${importer ?? 'the renderer'} imports "${id}", which needs Node and cannot run in a window.` +
          (id === '@wouice/store'
            ? ' Take values from "@wouice/store/types", and types with "import type".'
            : '')
      )
    }
    return null
  },
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE })],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // .mjs so the ESM preload loads correctly under sandbox: false.
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [browserOnly, react(), tailwindcss()],
    build: {
      // outDir is relative to `root`, which is src/renderer, so it must be
      // spelled out or the bundle lands outside desktop/ where main cannot
      // find it at ../renderer/index.html.
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
