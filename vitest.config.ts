import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    alias: {
      '@': path.resolve(__dirname, './src')
    },
    // The runner service has its own Jest suite: run `npm test` in services/runner/
    include: ['tests/**/*.{test,spec}.ts', 'services/runner/tests/live/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/live-fixtures/**'],
  },
})
