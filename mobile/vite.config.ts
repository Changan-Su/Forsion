/**
 * Tangu Mobile — Android(Capacitor)独立 app。经别名复用 desktop/frontend/src(不复制源码);
 * 与 web/ 唯一差异:web 连 Dockview 外壳一起借,mobile **换掉外壳**——用 resolveId 插件按解析后的
 * 绝对路径,把引擎里 3 个 Dockview 耦合模块换成移动版单列实现,views/注册表零改。
 */
import { resolve } from 'path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const DESKTOP_SRC = resolve(__dirname, '../desktop/frontend/src')
const HERE = resolve(__dirname, 'src')

// 承重接缝:把 desktop 引擎的 3 个 Dockview 模块按**解析后绝对路径**换成移动替身(比按相对说明符别名稳,
// 且不碰 desktop 源)。workspaceStore → 单列 store;Shell/WorkspaceHost → 空 stub(移动端用 MobileShell)。
function engineSwap(): Plugin {
  const MAP: Array<[string, string]> = [
    ['/engine/workspaceStore.ts', resolve(__dirname, '../lcl/engine/singleColumnStore.ts')],
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

/**
 * 原生侧(PhoneControlPlugin)自取的 API 基址:构建时写进产物根的 `forsion-native.json`,
 * cap sync 后落在 APK 的 `assets/public/forsion-native.json`,原生用 AssetManager 读 —— 绝不经 JS 传入
 * (见 Forsion-Genesis/tangu-agent/docs/phone-control.md §1)。
 * ⚠️ 规则必须与 src/capacitorAuth.ts 的 native 分支 apiOrigin()/apiBase() 逐字一致
 *    (VITE_API_ORIGIN 覆盖,缺省生产网关,去一个尾斜杠,再拼 /api);改一边必须改另一边。
 */
function nativeConfig(apiOriginEnv: string | undefined): Plugin {
  const apiBase = String(apiOriginEnv || 'https://api.forsion.net').replace(/\/$/, '') + '/api'
  return {
    name: 'mobile-native-config',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'forsion-native.json', source: JSON.stringify({ apiBase }) + '\n' })
    },
  }
}

const PROXY_PATHS = ['/api', '/auth', '/account', '/shared', '/oauth', '/shop', '/pay', '/legal']

// 前端环境变量约定:PORT/BACKEND_URL 经 loadEnv 读(config 阶段 process.env 读不到 .env)。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const DEV_PORT = Number(env.PORT) || 5274
  const DEV_PROXY = env.BACKEND_URL || env.TANGU_DEV_PROXY || 'http://localhost:3001'
  return {
  plugins: [engineSwap(), react(), nativeConfig(env.VITE_API_ORIGIN)],
  // Vite 默认递归扫描 root 下的所有 HTML；Capacitor sync 生成的 android/.../public/index.html
  // 也会因此被当成 dev 入口，继而扫描旧 bundle/可选 peer dependency。dev 只认正典入口。
  optimizeDeps: {
    entries: ['index.html'],
  },
  // 静态资产借 desktop 的 public(postinstall copy-excalidraw-assets 生成的自托管 excalidraw 字体 +
  // pdfjs-annot):CSP 同源、离线 APK 可用;否则 excalidraw 回落 esm.sh CDN 被 font-src 拒。
  publicDir: resolve(__dirname, '../desktop/frontend/public'),
  resolve: {
    alias: {
      '@lcl': resolve(__dirname, '../lcl'),
      '@amadeus-shared': resolve(__dirname, '../desktop/shared/amadeus'),
      '@amadeus': resolve(DESKTOP_SRC, 'amadeus'),
      // 云端 vault 桥复用 web 的实现(零外部依赖,纯 @amadeus-shared+相对导入;alias 先例=上面的 desktop 渲染层)。
      '@webamadeus': resolve(__dirname, '../web/src/amadeus'),
      '@': DESKTOP_SRC,
      '@mobile': HERE,
    },
    // 与 web 同：mobile 与 desktop 各有一份 react，跨文件夹复用会加载两份 → hooks 崩溃白屏。强制单实例。
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    fs: { allow: [resolve(__dirname, '..')] },
    proxy: Object.fromEntries(PROXY_PATHS.map((p) => [p, { target: DEV_PROXY, changeOrigin: true }])),
  },
  // Capacitor 从 file:// 载入资源 → 相对 base。
  base: './',
  }
})
