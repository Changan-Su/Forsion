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
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, statSync, readFileSync, realpathSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { resolve, join, sep, extname } from 'node:path'
import { transform, type Transform } from 'sucrase'

export const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain', '.xml': 'text/xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
  // 3D / 图形资产:three.js 之类的场景要靠这些。多数 loader 用 fetch 不看 MIME,但
  // .hdr/.exr(环境贴图)与 .ktx2/.basis 被当 text/* 会解码失败,.gltf 是 JSON 也得说清。
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.hdr': 'image/vnd.radiance', '.exr': 'image/aces', '.ktx2': 'image/ktx2', '.basis': 'application/octet-stream',
  '.obj': 'text/plain', '.mtl': 'text/plain', '.fbx': 'application/octet-stream',
  '.usdz': 'model/vnd.usdz+zip', '.ply': 'application/octet-stream', '.stl': 'model/stl', '.drc': 'application/octet-stream',
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

// ── 令牌根:单文件 HTML 预览(wsfile / Agent Desk / 笔记内嵌)用 ────────────────
// 为什么不复用上面那个单根:serveDir 是**切根**语义,第二个消费者一调就把 Coding Space 的根换掉了。
// 令牌根各自独立,URL 形如 http://<token>.localhost:<port>/index.html;token 不可猜 → 本机其它进程
// 摸不到被挂出的目录,且每个 token 一个源(详见下方 ensurePreviewServer 的三条理由)。
// 按目录 memo(同一目录反复预览复用同一 token,不产生垃圾)。上限只是防病态循环的兜底,**故意设得很高**:
// 一条记录就一个路径串,而淘汰掉还开着的预览会让它刷新即 404(没有租约/引用计数,只能靠留得够久)。
const TOKEN_CAP = 1024
const tokenToRoot = new Map<string, string>()
const rootToToken = new Map<string, string>()

/** 取(或首次发放)某目录的预览令牌。命中即刷新到队尾:淘汰按 **LRU**,别把还开着的预览挤掉。 */
export function previewToken(dir: string): string {
  const abs = resolve(dir)
  const hit = rootToToken.get(abs)
  if (hit) { tokenToRoot.delete(hit); tokenToRoot.set(hit, abs); return hit }
  const token = randomBytes(16).toString('hex')
  if (tokenToRoot.size >= TOKEN_CAP) {
    const oldest = tokenToRoot.keys().next().value as string | undefined
    if (oldest) { rootToToken.delete(tokenToRoot.get(oldest)!); tokenToRoot.delete(oldest) }
  }
  tokenToRoot.set(token, abs)
  rootToToken.set(abs, token)
  return token
}

// 无本机路径的 HTML(云沙箱文件 / 对话内联的 agent 产物)也必须落在**真实源**上,否则只能退回
// srcdoc —— 那条路继承宿主 CSP + 不透明源,three.js 空白、指针锁/文件选择器全废(整类问题的老巢)。
// 内容进内存不落盘:这类页面本来就没有兄弟资源要加载,只需要一个源。按内容哈希 memo(同一份重复
// 预览复用同一 token),LRU 淘汰,上限小得多——每条是整份 HTML 文本,不是一个路径串。
const INLINE_CAP = 64
const tokenToInline = new Map<string, string>()
const inlineToToken = new Map<string, string>()

/** 把一段 HTML 文本挂到一个令牌源下,返回可直接加载的 URL。 */
export async function serveInlineHtml(html: string): Promise<{ url: string }> {
  const port = await ensurePreviewServer()
  const key = createHash('sha1').update(html).digest('hex')
  let token = inlineToToken.get(key)
  if (token) { tokenToInline.delete(token); tokenToInline.set(token, html) } // 命中刷到队尾(LRU)
  else {
    token = randomBytes(16).toString('hex')
    if (tokenToInline.size >= INLINE_CAP) {
      const oldest = tokenToInline.keys().next().value as string | undefined
      if (oldest) {
        for (const [k, v] of inlineToToken) if (v === oldest) { inlineToToken.delete(k); break }
        tokenToInline.delete(oldest)
      }
    }
    tokenToInline.set(token, html)
    inlineToToken.set(key, token)
  }
  return { url: `http://${token}.localhost:${port}/index.html` }
}

/** Forsion Connect 预览挂钩：/forsion-connect.js（local SDK）与 /__forsion/*（主进程云代理）。由 main 注入。 */
export interface ForsionPreviewHooks {
  sdkJs?: string
  proxy?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
let forsionHooks: ForsionPreviewHooks = {}
export function setForsionPreviewHooks(h: ForsionPreviewHooks): void { forsionHooks = h }

/** Connect 两个特殊端点,**两种根都要供**(Coding Space 主根 + 令牌根):Agent Desk / wsfile / 笔记内嵌
 *  预览走的是令牌根,agent 在普通聊天里生成的 AI 页面若只在主根有 SDK,预览里 window.forsion 直接 404
 *  (实测事故:tangu-session-9d1fa366)。命中返回 true。 */
function serveForsionEndpoint(urlPath: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (urlPath === '/forsion-connect.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(forsionHooks.sdkJs || 'console.warn("[forsion-connect] preview SDK unavailable");')
    return true
  }
  if (urlPath.startsWith('/__forsion/')) {
    if (forsionHooks.proxy) {
      // 观察 proxy Promise:req 中断等异步 reject 必须收口,否则 unhandled rejection + 响应悬挂。
      void Promise.resolve(forsionHooks.proxy(req, res)).catch(() => {
        try { if (!res.headersSent) { res.statusCode = 502; res.end('{"detail":"connect proxy error"}') } else res.end() } catch { /* ignore */ }
      })
    } else { res.statusCode = 501; res.end('{"detail":"connect proxy unavailable"}') }
    return true
  }
  return false
}

/** 在 root 内解析并吐出一个文件(穿越守卫 + 目录补 index.html + 按需转译)。两种根共用。
 *  `deref`=令牌根专用:`resolveSafe` 只做路径算术,拦不住**根内的软链指到根外**(有人往被预览的
 *  目录里塞一条 `x -> ~/.ssh`,页面 fetch 它就读到了)。Coding Space 不开这条 —— 用户自己的项目里
 *  `node_modules` 之类软链是常态,按真实落点判会误伤。 */
function serveFrom(rootDir: string, urlPath: string, res: ServerResponse, deref = false): void {
  const target = resolveSafe(rootDir, urlPath)
  if (!target) { res.statusCode = 403; res.end('forbidden'); return }
  let st
  try { st = statSync(target) } catch { res.statusCode = 404; res.end('not found'); return }
  let file = target
  if (st.isDirectory()) {
    file = join(target, 'index.html')
    try { st = statSync(file) } catch { res.statusCode = 404; res.end('not found'); return }
  }
  // ⚠️包含性检查必须在**目录补 index.html 之后**对最终 file 做:先查 target 再补 index 的话,
  //   `leak/index.html -> ~/.ssh/id_rsa` 这种目录索引软链会整条绕过(codex High-1)。
  if (deref) {
    try {
      const realRoot = realpathSync(rootDir)
      const realFile = realpathSync(file)
      if (!realFile.startsWith(realRoot + sep)) { res.statusCode = 403; res.end('forbidden'); return }
      if (!statSync(realFile).isFile()) { res.statusCode = 404; res.end('not found'); return }
      file = realFile
    } catch { res.statusCode = 404; res.end('not found'); return }
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
}

/**
 * 令牌根服务器 —— 独立端口,且**每个 token 一个源**:`http://<token>.localhost:<port>/`。
 *  ① 与 Coding Space 那台不共源:否则被预览页能 `fetch('http://127.0.0.1:同端口/')` 读走整个项目;
 *  ② 每 token 独立主机名 → 浏览器眼里是**不同源**:两个预览之间不共享 localStorage/IndexedDB,
 *     也拿不到彼此的 DOM(同源兄弟 iframe 可经 `parent.frames[i]` 互读,codex High-3);
 *  ③ 该 token 的目录直接挂在 `/` 上 → 页面里的**绝对路径**(`/app.js`、`/model.glb`)照样解析得到
 *     (放在 `/p/<token>/` 前缀下时它们会全部 404,codex Medium-5)。
 * Chromium 按 RFC 6761 把 `*.localhost` 一律解析到回环,不查 DNS。
 */
let previewServer: Server | null = null
let previewStarting: Promise<string> | null = null
/** stop 代数:每次 stopCodePreview() +1,让「启动中」的服务器知道自己已经被作废了。 */
let stopGen = 0

/** Host 头 → token(`<token>.localhost:port`);形状不对返回 null。 */
export function tokenFromHost(host: string | undefined): string | null {
  if (!host) return null
  const name = host.split(':')[0].toLowerCase()
  const m = /^([0-9a-f]{32})\.localhost$/.exec(name)
  return m ? m[1] : null
}

function ensurePreviewServer(): Promise<string> {
  // ⚠️必须 memo 整个「启动中」的 Promise:先赋值 previewServer 再 await listen 的话,
  //   并发的第二个调用会看到非 null 的 server 直接读 address() → 拿到 port 0(codex Medium-4)。
  if (previewStarting) return previewStarting
  previewStarting = (async () => {
    const srv = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const token = tokenFromHost(req.headers.host)
      const inline = token ? tokenToInline.get(token) : null
      const tRoot = token ? tokenToRoot.get(token) : null
      if (inline == null && !tRoot) { res.statusCode = 404; res.end('not found'); return }
      const path = (req.url || '/').split('?')[0]
      if (serveForsionEndpoint(path, req, res)) return // 内联页同样会用 window.forsion
      if (inline != null) {
        // 内联根只有这一份文档,没有兄弟资源可供;其余路径一律 404,别让它看起来像个目录。
        if (path !== '/' && path !== '/index.html') { res.statusCode = 404; res.end('not found'); return }
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(inline)
        return
      }
      serveFrom(tRoot!, req.url || '/', res, true)
    })
    const gen = stopGen
    await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(0, '127.0.0.1', () => r()) })
    // 启动期间有人调过 stopCodePreview:那次 stop 看到的 previewServer 还是 null,什么都没关掉。
    // 这里补关,别把一台服务器连同它的令牌留在身后(codex Low-8)。
    if (gen !== stopGen) { srv.close(); throw new Error('preview server stopped') }
    previewServer = srv
    const addr = srv.address()
    return `${typeof addr === 'object' && addr ? addr.port : 0}`
  })().catch((e) => { previewStarting = null; throw e })
  return previewStarting
}

/** 把 dir 挂到一个令牌源下,返回可直接放进 iframe src 的基址(`http://<token>.localhost:<port>`)。 */
export async function servePathRoot(dir: string): Promise<{ origin: string; token: string; base: string }> {
  const port = await ensurePreviewServer()
  const token = previewToken(dir)
  const origin = `http://${token}.localhost:${port}`
  return { origin, token, base: origin }
}

/** 切换服务根目录并确保服务器已监听;返回 { origin }。 */
export async function serveDir(dir: string): Promise<{ origin: string }> {
  root = resolve(dir)
  return { origin: await ensureListening() }
}

/** 懒起服务器(端口稳定),返回 origin。 */
let starting: Promise<string> | null = null
async function ensureListening(): Promise<string> {
  // 同 ensurePreviewServer:memo 整个启动 Promise,并发调用不能在 listen 回调前读 address()。
  if (starting) return starting
  starting = (async () => {
    const srv = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store') // 实时预览:禁缓存,重载即见新内容
      // Forsion Connect:与发布态同一条 <script src="/forsion-connect.js"> 契约,预览下走本地变体 + 云代理。
      if (serveForsionEndpoint((req.url || '/').split('?')[0], req, res)) return
      if (!root) { res.statusCode = 503; res.end('no root'); return }
      serveFrom(root, req.url || '/', res)
    })
    const gen = stopGen
    await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(0, '127.0.0.1', () => r()) })
    if (gen !== stopGen) { srv.close(); throw new Error('preview server stopped') } // 同令牌根:启动期间被 stop 过 → 补关
    server = srv
    const addr = srv.address()
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })().catch((e) => { starting = null; throw e })
  return starting
}

export function stopCodePreview(): void {
  stopGen++
  server?.close()
  server = null
  starting = null
  root = null
  previewServer?.close()
  previewServer = null
  previewStarting = null
  tokenToRoot.clear()
  rootToToken.clear()
  tokenToInline.clear()
  inlineToToken.clear()
}
