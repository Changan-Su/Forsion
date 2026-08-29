import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 产品档案:FORSION_PRODUCT 选 products/<id>.json(缺省 forsion=全家桶),define 注入三端。
const PRODUCT_ID = process.env.FORSION_PRODUCT || 'forsion'
const PRODUCT = JSON.parse(readFileSync(resolve(`products/${PRODUCT_ID}.json`), 'utf8'))
if (PRODUCT.id !== PRODUCT_ID) throw new Error(`products/${PRODUCT_ID}.json 的 id 与文件名不一致`)
const DEFINE = { __FORSION_PRODUCT__: JSON.stringify(PRODUCT) }

export default defineConfig({
  main: {
    define: DEFINE,
    plugins: [externalizeDepsPlugin()],
    build: { lib: { entry: resolve('electron/main.ts') } },
    resolve: { alias: { '@amadeus-shared': resolve('shared/amadeus') } },
  },
  preload: {
    define: DEFINE,
    plugins: [externalizeDepsPlugin()],
    // p2pPreload = 扶桑根 P2P 隐藏窗专用(RTCPeerConnection 住 renderer 侧,主进程没有);
    // 多入口下产物名跟 entry 键走:out/preload/preload.mjs + out/preload/p2pPreload.mjs。
    build: { lib: { entry: { preload: resolve('electron/preload.ts'), p2pPreload: resolve('electron/p2pPreload.ts') } } },
    resolve: { alias: { '@amadeus-shared': resolve('shared/amadeus') } },
  },
  renderer: {
    root: resolve('frontend'),
    define: DEFINE,
    plugins: [react()],
    // 允许 ?raw 读取 desktop 根目录的 CHANGELOG.md(位于 renderer root=frontend 之外)。
    // 端口避开 Amadeus(5173)/老 desktop dev。
    server: { port: 5273, strictPort: false, fs: { allow: [resolve('.'), resolve('../lcl')] } },
    build: {
      rollupOptions: { input: resolve('frontend/index.html') },
    },
    resolve: {
      // lcl 是直接链进源码的 workspace 目录。独立 worktree 下 Vite/Rollup 可能把宿主与
      // 链接源各解析一份 React，最终在打包版直接触发 invalid hook call。
      // @dnd-kit 三件必须与 frontend/vite.config.ts 同列:sortable 消费 core 的 React Context,
      // 预构建拆成两份后外层 DndContext 与 useSortable 各拿一只 Context —— 表现为仪表盘
      // 拖拽把手存在但 listeners 为空、卡片完全拖不动(dev 实测,A/B 负对照坐实)。
      dedupe: ['react', 'react-dom', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
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
