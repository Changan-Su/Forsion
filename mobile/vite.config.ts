/**
 * Tangu Mobile — Android(Capacitor)独立 app。经别名复用 desktop/frontend/src(不复制源码);
 * 与 web/ 唯一差异:web 连 Dockview 外壳一起借,mobile **换掉外壳**——用 resolveId 插件按解析后的
 * 绝对路径,把引擎里 3 个 Dockview 耦合模块换成移动版单列实现,views/注册表零改。
 */
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const DESKTOP_SRC = resolve(__dirname, '../desktop/frontend/src')
const HERE = resolve(__dirname, 'src')

// 承重接缝:把 desktop 引擎的 3 个 Dockview 模块按**解析后绝对路径**换成移动替身(比按相对说明符别名稳,
// 且不碰 desktop 源)。workspaceStore → 单列 store;Shell/WorkspaceHost → 空 stub(移动端用 MobileShell)。
function engineSwap(): Plugin {
  const MAP: Array<[string, string]> = [
    ['/engine/workspaceStore.ts', resolve(HERE, 'engine/mobileWorkspaceStore.ts')],
    ['/engine/Shell.tsx', resolve(HERE, 'engine/emptyHost.tsx')],
    ['/engine/WorkspaceHost.tsx', resolve(HERE, 'engine/emptyHost.tsx')],
  ]
  return {
    name: 'mobile-engine-swap',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // 先按常规解析拿到绝对路径,再按后缀改写(不改写就返回 null 交回默认解析)。
      const r = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!r) return null
      const id = r.id.replace(/\\/g, '/')
      for (const [suffix, target] of MAP) if (id.endsWith(suffix)) return target
      return null
    },
  }
}

const DEV_PROXY = process.env.TANGU_DEV_PROXY || 'http://localhost:3001'
const PROXY_PATHS = ['/api', '/auth', '/account', '/shared', '/oauth', '/shop', '/pay', '/legal']

export default defineConfig({
  plugins: [engineSwap(), react()],
  resolve: {
    alias: {
      '@lcl': resolve(__dirname, '../lcl'),
      '@amadeus-shared': resolve(__dirname, '../desktop/shared/amadeus'),
      '@amadeus': resolve(DESKTOP_SRC, 'amadeus'),
      '@': DESKTOP_SRC,
      '@mobile': HERE,
    },
    // 与 web 同：mobile 与 desktop 各有一份 react，跨文件夹复用会加载两份 → hooks 崩溃白屏。强制单实例。
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5274,
    strictPort: true,
    fs: { allow: [resolve(__dirname, '..')] },
    proxy: Object.fromEntries(PROXY_PATHS.map((p) => [p, { target: DEV_PROXY, changeOrigin: true }])),
  },
  // Capacitor 从 file:// 载入资源 → 相对 base。
  base: './',
})
