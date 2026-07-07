/**
 * Tangu Web — 独立 app(像 AI Studio/Echo:自己的容器/nginx,连 Forsion server /api → tangu worker)。
 * 经别名复用 desktop/frontend/src(不复制源码);自带 webShim 入口。
 * 服务于自身 origin 的根路径(base '/'),产物落 web/dist;部署见同目录 Dockerfile/nginx.conf.template。
 */
import { resolve } from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const DESKTOP_SRC = resolve(__dirname, '../desktop/frontend/src')

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
    plugins: [react()],
    resolve: {
      alias: {
        // 被复用的 desktop 源里 `@/...` 与 web 自身都解析到 desktop/frontend/src。
        // @amadeus / @amadeus-shared 与 desktop 打包配置(electron.vite.config.ts)保持一致。
        '@lcl': resolve(__dirname, '../lcl'),
        '@amadeus-shared': resolve(__dirname, '../desktop/shared/amadeus'),
        '@amadeus': resolve(DESKTOP_SRC, 'amadeus'),
        '@': DESKTOP_SRC,
        '@web': resolve(__dirname, 'src'),
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
