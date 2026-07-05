import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@lcl': resolve(__dirname, '../lcl'), '@': resolve(__dirname, 'frontend/src') } },
  test: {
    environment: 'node',
    include: ['frontend/src/**/*.test.ts', 'electron/**/*.test.ts', 'shared/**/*.test.ts', '../lcl/engine/**/*.test.ts', '../lcl/spaces/**/*.test.ts'],
  },
})
