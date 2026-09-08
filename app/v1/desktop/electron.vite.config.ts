import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Our own workspace packages are TypeScript SOURCE, not built artifacts, so
// they must be bundled rather than externalized. externalizeDepsPlugin treats
// everything in `dependencies` as external by default, which would leave Node
// resolving `@wouice/asr` at runtime and failing on its `.js` specifiers.
const WORKSPACE = ['@wouice/asr', '@wouice/dictionary', '@wouice/llm']

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
    plugins: [react(), tailwindcss()],
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
