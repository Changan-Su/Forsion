/**
 * Tangu Web — 独立 app(像 AI Studio/Echo:自己的容器/nginx,连 Forsion server /api → tangu worker)。
 * 经别名复用 desktop/frontend/src(不复制源码);自带 webShim 入口。
 * 服务于自身 origin 的根路径(base '/'),产物落 web/dist;部署见同目录 Dockerfile/nginx.conf.template。
 */
import { resolve } from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const DESKTOP_SRC = resolve(__dirname, '../desktop/frontend/src')

/**
 * capacitor 桩闸(2026-08-22 建)。web 整份复用 mobile 壳,壳里的 `@capacitor/*` import 在**本机**
 * 会被一路向上解析到 `mobile/node_modules` 的真包 → `npm run build` **假绿**;而 web 镜像里只有
 * `/app/node_modules`(web 自己的依赖,没有 capacitor)→ 只有 build-web CI 红,且那时 main 已推出去:
 *   [vite]: Rollup failed to resolve import "@capacitor/core" from ".../mobile/src/spaceShortcuts.ts"
 * (2026-08-20 加移动端 Space 快捷方式时实翻。)
 *
 * 闸:凡是**真进了 web 包图**的 `@capacitor/*`,只要没在下面 alias 表里配桩就当场报错 —— 与镜像里
 * 没有 node_modules 时的行为一致,本机与 CI 同构。用 vite 自己的解析而不是静态 grep,是因为 mobile
 * 树里另有几个 capacitor 包(filesystem/browser/preferences)压根不在 web 的包图里,grep 判不了可达性。
 * ⚠️ **必须 `enforce: 'pre'`**:vite 的插件序是 `alias → pre → vite:resolve → normal`。不带 pre 就排在
 *    `vite:resolve` 之后,真包早被 node_modules 解析掉了,闸一次都不响(实测负对照照样绿);而 alias
 *    永远排在 pre 之前,所以配了桩的仍先被改写,只有漏网的才走到这里。
 */
function capacitorStubGate() {
  return {
    name: 'forsion:capacitor-stub-gate',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      if (!id.startsWith('@capacitor/')) return null
      throw new Error(
        `[capacitor-stub-gate] web 包图里出现了没配浏览器桩的 "${id}"(来自 ${importer ?? '未知'})。\n` +
        `web 镜像里没有 capacitor 依赖,这在本机看不出来、只会让 build-web CI 红。\n` +
        `修法:照 web/src/capacitorAppStub.ts 写一个桩,再加进本文件的 resolve.alias 与 web/tsconfig.json 的 paths。`,
      )
    },
  }
}

// dev 把后端相关路径代理到 Forsion server,让 localhost:PORT 同源化(webShim 用 location.origin+/api;
// 登录页 /auth 也代理过去)。生产由各 app 自己的 nginx 代理 /api 等到后端(见 nginx.conf.template)。
const PROXY_PATHS = ['/api', '/auth', '/account', '/shared', '/oauth', '/shop', '/pay', '/legal']

export default defineConfig(({ mode }) => {
  // loadEnv(prefix='') 同时读 .env 文件与 process.env(shell)——所以 .env 里写 PORT/TANGU_DEV_PROXY
  // 才真正生效。注意:只在本地读来配 dev server,不注入客户端 bundle(客户端只认 VITE_ 前缀)。
  const env = loadEnv(mode, __dirname, '')
  const DEV_PORT = Number(env.PORT) || 5273
  const DEV_PROXY = env.TANGU_DEV_PROXY || 'http://localhost:3001'

  return {
    plugins: [react(), capacitorStubGate()],
    // publicDir 用 web 自己的(默认 web/public):白板引擎的自托管副本由 `npm run prepare-board`
    // 生成在那儿(见 package.json,build/dev 都会先跑一遍)。
    // ⚠️ **不能借 desktop 的 public** —— 那是 desktop postinstall 的产物、不入库,而 web 的镜像
    //    只 COPY desktop 的源码、在公共祖先自己 npm ci,借过去在 CI 里必然是空的:
    //    镜像照样构建成功,用户点开白板才 404。
    resolve: {
      alias: {
        // 被复用的 desktop 源里 `@/...` 与 web 自身都解析到 desktop/frontend/src。
        // @amadeus / @amadeus-shared 与 desktop 打包配置(electron.vite.config.ts)保持一致。
        '@lcl': resolve(__dirname, '../lcl'),
        '@amadeus-shared': resolve(__dirname, '../desktop/shared/amadeus'),
        '@amadeus': resolve(DESKTOP_SRC, 'amadeus'),
        '@': DESKTOP_SRC,
        '@web': resolve(__dirname, 'src'),
        // 手机视口装载 Mobile 壳(mobileEntry/MobileRoot),与移动 App 同一套源码(镜像 mobile 侧
        // @webamadeus → web/src/amadeus 的既有先例)。capacitor 一律用浏览器桩顶掉,零原生依赖。
        // ⚠️ 每个用到的 capacitor 包都得有桩:漏一个本机照样绿(vite 会从 mobile/src 向上找到
        //    mobile/node_modules 里的真包),但 web 镜像里只有 /app/node_modules → 只有 CI 红
        //    (2026-08-22 @capacitor/core 实翻)。
        '@mobile': resolve(__dirname, '../mobile/src'),
        '@capacitor/app': resolve(__dirname, 'src/capacitorAppStub.ts'),
        '@capacitor/core': resolve(__dirname, 'src/capacitorCoreStub.ts'),
      },
      // 关键:web 与 desktop 各有 node_modules/react,跨文件夹复用会加载两份 React →
      // hooks 报 "Cannot read properties of null (reading 'useState')" + 白屏。强制单实例。
      dedupe: ['react', 'react-dom'],
    },
    server: {
      // 端口默认 5273(dev URL 固定,配合 docker/nginx 与 /auth 回跳);撞端口时 .env 里设 PORT= 切。
      // strictPort:占用即报错退出(不静默漂移到随机端口)。
      port: DEV_PORT,
      strictPort: true,
      // 允许 dev server 读取上层 desktop 源。
      fs: { allow: [resolve(__dirname, '..')] },
      // 后端/登录页代理到 Forsion server(同源化,免 CORS);SSE 不缓冲。
      proxy: Object.fromEntries(
        PROXY_PATHS.map((p) => [p, { target: DEV_PROXY, changeOrigin: true }]),
      ),
    },
    // base 默认 '/'(独立 app 自有 root);outDir 默认 web/dist。
  }
})
