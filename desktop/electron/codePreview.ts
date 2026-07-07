/**
 * Coding Space 的本地静态预览服务器 —— 把当前会话工作区(cwd)整目录挂到 127.0.0.1 随机端口,
 * 渲染端 <iframe src="http://127.0.0.1:port/index.html"> 直接跑多文件 web app(真·相对路径解析)。
 * 进程内单例;`serveDir(dir)` 切根并返回 origin(懒起服务器,端口稳定)。
 *
 * 「AI Studio 式」无构建:请求 .ts/.tsx/.jsx 时用 sucrase **按需转译**成浏览器 ESM(像 vite dev,
 * 逐文件、不打包、不 typecheck、零 npm install);裸依赖(react 等)由页面 importmap → esm.sh CDN 解析。
 *
 * ponytail: 仅绑 127.0.0.1 + 穿越守卫 + 只服务当前 root;不是通用文件服务器,不做目录列表/上传。
 */
import { createServer, type Server } from 'node:http'
import { createReadStream, statSync, readFileSync } from 'node:fs'
import { resolve, join, sep, extname } from 'node:path'
import { transform, type Transform } from 'sucrase'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain', '.xml': 'text/xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
}

/** 该扩展名对应的 sucrase transforms;null = 不转译(原样返回)。 */
function transformsFor(ext: string): Transform[] | null {
  switch (ext) {
    case '.tsx': return ['typescript', 'jsx']
    case '.jsx': return ['jsx']
    case '.ts': case '.mts': case '.cts': return ['typescript']
    default: return null
  }
}

/** 纯函数:按需把 .ts/.tsx/.jsx 源码转成浏览器 ESM(react/jsx-runtime 自动运行时,由页面 importmap 解析);
 *  非转译扩展返回 null。转译失败返回一段 throw 的 JS(错误进 iframe 控制台,不白屏)。供单测。 */
export function transpileForServe(code: string, ext: string, filePath = ''): string | null {
  const transforms = transformsFor(ext)
  if (!transforms) return null
  try {
    return transform(code, { transforms, jsxRuntime: 'automatic', production: true, filePath }).code
  } catch (e) {
    return `console.error(${JSON.stringify(`[preview] transpile error in ${filePath}: ${(e as Error)?.message || String(e)}`)});\nexport default null;`
  }
}

/** 纯函数:把请求路径解析到 root 内的绝对路径;越界返回 null(供单测,无 IO)。 */
export function resolveSafe(root: string, urlPath: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(urlPath.split('?')[0]) } catch { return null }
  if (decoded.includes('\0')) return null
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded))
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null
  return target
}

let server: Server | null = null
let root: string | null = null

/** 切换服务根目录并确保服务器已监听;返回 { origin }。 */
export async function serveDir(dir: string): Promise<{ origin: string }> {
  root = resolve(dir)
  if (!server) {
    server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store') // 实时预览:禁缓存,重载即见新内容
      if (!root) { res.statusCode = 503; res.end('no root'); return }
      const target = resolveSafe(root, req.url || '/')
      if (!target) { res.statusCode = 403; res.end('forbidden'); return }
      let st
      try { st = statSync(target) } catch { res.statusCode = 404; res.end('not found'); return }
      let file = target
      if (st.isDirectory()) {
        file = join(target, 'index.html')
        try { st = statSync(file) } catch { res.statusCode = 404; res.end('not found'); return }
      }
      const ext = extname(file).toLowerCase()
      // .ts/.tsx/.jsx → 按需转译成 ESM(vite dev 式);其余原样流式。
      if (transformsFor(ext)) {
        let out: string | null
        try { out = transpileForServe(readFileSync(file, 'utf8'), ext, file) } catch { res.statusCode = 500; res.end('read error'); return }
        res.setHeader('Content-Type', 'text/javascript')
        res.end(out ?? '')
        return
      }
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
      createReadStream(file).on('error', () => { res.statusCode = 500; res.end('read error') }).pipe(res)
    })
    await new Promise<void>((res) => server!.listen(0, '127.0.0.1', res))
  }
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { origin: `http://127.0.0.1:${port}` }
}

export function stopCodePreview(): void {
  server?.close()
  server = null
  root = null
}
