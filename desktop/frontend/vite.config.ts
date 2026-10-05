import { startupAppearanceHtml } from '../frontend/startupAppearancePlugin'
/**
 * 浏览器内调试用的独立 vite 配置(`npx vite frontend`):渲染层不依赖 Electron,
 * window.tangu 缺省时配置走内存/localStorage,便于无显示器环境冒烟与 UI 开发。
 * 打包仍走根目录 electron.vite.config.ts。
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [startupAppearanceHtml(), react()],
  // 依赖预构建缓存放本检出自己的目录,不用 vite 缺省的 node_modules/.vite:worktree 的 node_modules 是指向
  // 主检出的软链,缺省目录等于所有检出共用;配置哈希(含 root)不同的 vite 一启动就把它整份删掉重建,那边正开着
  // 的 dev 之后懒加载的依赖 504(Outdated Optimize Dep)或加载到第二份 React,只能重启。electron-vite dev 的
  // 哈希与这里也不同(多两只内置插件),所以两份配置各用一个子目录。必须是绝对路径(相对的按 root 解析)。
  // 仪器:npm run check:vitecache。FORSION_VITE_CACHE_DIR 仍可显式指定。
  cacheDir: process.env.FORSION_VITE_CACHE_DIR || resolve(__dirname, '../.vite-cache/web'),
  resolve: {
    // 与 Electron renderer 保持一致：浏览器预览/Vitest 也会穿过 lcl workspace，
    // 独立 worktree 下必须强制宿主和链接源共用一份 React。
    // dnd-kit/sortable 内部也消费 core 的 React Context；预构建若拆成两份，外层 DndContext
    // 与 useSortable 会各拿一只 Context，表现为把手存在但 listeners 为空、拖拽完全不启动。
    dedupe: ['react', 'react-dom', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
    // 与根 electron.vite.config.ts renderer 的 alias 保持一致(浏览器冒烟/harness 也要能解析)。
    alias: {
      '@lcl': resolve(__dirname, '../../lcl'),
      '@': resolve(__dirname, 'src'),
      '@amadeus': resolve(__dirname, 'src/amadeus'),
      '@amadeus-shared': resolve(__dirname, '../shared/amadeus'),
    },
  },
  server: { port: 5173, strictPort: true, fs: { allow: [resolve(__dirname, '..'), resolve(__dirname, '../../lcl')] } },
})
