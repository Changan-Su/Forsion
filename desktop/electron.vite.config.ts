import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('electron/main.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('electron/preload.ts') } },
  },
  renderer: {
    root: resolve('frontend'),
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve('frontend/index.html') },
    },
    resolve: {
      alias: { '@': resolve('frontend/src') },
    },
  },
})
