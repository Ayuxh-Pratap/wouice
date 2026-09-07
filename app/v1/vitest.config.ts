import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'desktop/src/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
})
