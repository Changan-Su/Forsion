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
    // 允许 ?raw 读取 desktop 根目录的 CHANGELOG.md(位于 renderer root=frontend 之外)。
    server: { fs: { allow: [resolve('.')] } },
    build: {
      rollupOptions: { input: resolve('frontend/index.html') },
    },
    resolve: {
      alias: { '@': resolve('frontend/src') },
    },
  },
})
