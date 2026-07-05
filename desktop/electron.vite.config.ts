import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('electron/main.ts') } },
    resolve: { alias: { '@amadeus-shared': resolve('shared/amadeus') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('electron/preload.ts') } },
    resolve: { alias: { '@amadeus-shared': resolve('shared/amadeus') } },
  },
  renderer: {
    root: resolve('frontend'),
    plugins: [react()],
    // 允许 ?raw 读取 desktop 根目录的 CHANGELOG.md(位于 renderer root=frontend 之外)。
    // 端口避开 Amadeus(5173)/老 desktop dev。
    server: { port: 5273, strictPort: false, fs: { allow: [resolve('.'), resolve('../lcl')] } },
    build: {
      rollupOptions: { input: resolve('frontend/index.html') },
    },
    resolve: {
      // @amadeus-shared = vendored Amadeus 同构编译器/IPC 契约;@amadeus = vendored Amadeus 渲染层。
      alias: {
        '@lcl': resolve('../lcl'),
        '@': resolve('frontend/src'),
        '@amadeus': resolve('frontend/src/amadeus'),
        '@amadeus-shared': resolve('shared/amadeus'),
      },
    },
  },
})
