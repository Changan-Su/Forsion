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
import { createReadStream, lstatSync, statSync, readFileSync, realpathSync } from 'node:fs'
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
export const TOKEN_CAP = 1024
const tokenToRoot = new Map<string, string>()
const rootToToken = new Map<string, string>()
/** 产物令牌(serveProductRoot 发的)**钉死**,不参与 LRU:淘汰它 = 已启动的 web 产物刷新即 404,
 *  而且下次拿到的是新 token = 新源 = localStorage/IndexedDB 全丢。跨 stop 保留(见 stopCodePreview)。 */
const pinnedTokens = new Set<string>()

/** 淘汰最旧的**非钉死**令牌。全钉死(病态)就不淘汰——超限也比掀翻产物的源强。 */
function evictOldestToken(): void {
  for (const old of tokenToRoot.keys()) {
    if (pinnedTokens.has(old)) continue
    const dir = tokenToRoot.get(old)!
    tokenToRoot.delete(old)
    // 该目录的 rootToToken 可能已被产物令牌接管(serveProductRoot 覆盖过),别把新映射误删。
    if (rootToToken.get(dir) === old) rootToToken.delete(dir)
    return
  }
}

/** 取(或首次发放)某目录的预览令牌。命中即刷新到队尾:淘汰按 **LRU**,别把还开着的预览挤掉。 */
export function previewToken(dir: string): string {
  const abs = resolve(dir)
  const hit = rootToToken.get(abs)
  if (hit) { tokenToRoot.delete(hit); tokenToRoot.set(hit, abs); return hit }
  const token = randomBytes(16).toString('hex')
  if (tokenToRoot.size >= TOKEN_CAP) evictOldestToken()
  tokenToRoot.set(token, abs)
  rememberRoot(abs)
  rootToToken.set(abs, token)
  return token
}

// ── 稳定源:产物令牌 + 粘性端口 ───────────────────────────────────────────────
// 令牌是随机的、端口是 listen(0) 的 → 每次开机都是**新源**,被「启动」的 web 产物每次重启都丢
// localStorage/IndexedDB(对用户就是每次打开都失忆)。所以产物按 productId 记一个固定令牌,端口也记一个。
// 怎么落盘由宿主注入(本文件不许碰 Electron / forsionHomeDir);注入缺席 / 读写抛异常一律退化回今天的
// 行为(随机源),**但绝不反过来破坏盘上已有的东西** —— load() 抛过就整轮只读,详见 loadFailed。
// ⚠️落盘的是令牌本身 → 那个文件的可读性就是被挂出目录的可读性(能读它的进程本来也读得到项目文件),
//   宿主把它放进用户家目录即可,别写到共享/世界可读的位置。
// ponytail: 只记不删 —— 产物删了它那条令牌还留在文件里(几十字节),没有 GC;端口全产物共一个
//   (本来就一台服务器),被占的那次所有产物一起换源。真出问题再做,不为此加租约/引用计数。

export interface PreviewPersistedState {
  /** 上次实际监听到的端口,下次优先复用。 */
  port?: number
  /** productId → 32 hex 令牌。 */
  tokens?: Record<string, string>
}
export interface PreviewPersistence {
  load(): PreviewPersistedState | null
  save(state: PreviewPersistedState): void
}

let persistence: PreviewPersistence | null = null
/** load() 的结果缓存(也是后续 save 的那个对象);null = 还没加载过。 */
let persisted: PreviewPersistedState | null = null
/** load() **抛过** → 这一轮启动对持久化降级成**只读**,一次 save 都不再发。
 *  为什么必须这么绝:读盘失败(EACCES / EMFILE / 断电后剩半截文件…)时缓存只是个空壳,而 save 收到的是
 *  **整份状态** —— 写回去就等于把盘上所有产物的令牌与端口一次抹光,全程无报错,所有已启动产物的
 *  localStorage/IndexedDB 当场永久孤儿化(正是这套稳定源要挡的事)。
 *  ⚠️load() **返回 null 不算失败**:那是「还没有这个文件」的正常空状态,照常写回。
 *  配套口径在宿主那半:productsIpc 的 load() 只吞 ENOENT,坏 JSON 挪到一旁留证后返回 null,其余原样抛。 */
let loadFailed = false

/** 注入落盘钩子。换钩子即丢缓存(连同只读标志),下次按新钩子重新 load。 */
export function setPreviewPersistence(p: PreviewPersistence | null): void {
  persistence = p
  persisted = null
  loadFailed = false
}

/** 落盘文件可能被手改 / 损坏成任何形状,当字典用之前先验形状。数组尤其阴:`typeof [] === 'object'`
 *  能过闸,而往数组上写字符串键会被 `JSON.stringify` **原样丢弃** —— 盘上永远是 `[]`,每次启动都换源,
 *  且不报错不崩溃,人工基本抓不到。 */
function isPlainObject(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 懒加载 + 兜底:钩子没装、load 抛了、或返回的不是对象,一律当作「没有持久化」,预览照常起。
 *  抛的那一种额外记 loadFailed(见上),此后只读。 */
function persistedState(): PreviewPersistedState {
  if (!persisted) {
    let loaded: PreviewPersistedState | null = null
    try { loaded = persistence ? persistence.load() : null } catch { loaded = null; loadFailed = true }
    persisted = loaded && isPlainObject(loaded) ? loaded : {}
  }
  return persisted
}

/** 写盘失败就失败:源退化成不稳定,但预览不能因此开不出来。读盘失败过则**压根不写**。 */
function persistSave(state: PreviewPersistedState): void {
  if (loadFailed) return
  try { persistence?.save(state) } catch { /* ignore */ }
}

const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 原型链保留字:`_` 在 PRODUCT_ID_RE 的字符类里,`__proto__` 能过闸,而 `({})['__proto__'] = '<hex 串>'`
 *  是**静默 no-op** —— 写不进去也读不出来,那个产物于是每次启动都换一个源。在信任边界直接拒掉,
 *  下方 tokens 容器的 null 原型是第二道。 */
const RESERVED_PRODUCT_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const TOKEN_RE = /^[0-9a-f]{32}$/
/** productId → 令牌。**跨 stopCodePreview 保留**:它只是身份不是内容(内容映射照常清空),
 *  没装持久化时也得靠它保证「停了再开还是同一个源」。 */
const productToToken = new Map<string, string>()

/** 取(或首次发放并落盘)某产物的稳定令牌。 */
function productToken(productId: string): string {
  const live = productToToken.get(productId)
  if (live) return live
  const state = persistedState()
  const table = isPlainObject(state.tokens) ? (state.tokens as Record<string, string>) : null // 形状不对就当没有
  const stored = table ? table[productId] : undefined
  // 撞上在用的令牌(随机撞是天文数字,但持久化文件被手改 / 两个 id 抄成同一串就不是)→ 重发一个:
  // 两个产物共源 = 互相读得到对方的 localStorage,正是令牌源隔离要挡的事。
  // ⚠️pinnedTokens 那一项不是冗余:stopCodePreview() 之后 tokenToRoot 清空、钉死集保留,只有它还认得出
  //   「这个令牌正被另一个产物占着」。缺了它,停了再开的第二个产物会拿到第一个产物**正在用**的令牌。
  const ok = typeof stored === 'string' && TOKEN_RE.test(stored)
    && !tokenToRoot.has(stored) && !tokenToInline.has(stored) && !pinnedTokens.has(stored)
  const token = ok ? stored : randomBytes(16).toString('hex')
  productToToken.set(productId, token)
  pinnedTokens.add(token)
  if (!ok) {
    let tokens = table
    // 容器形状不对(数组 / null / 字符串)就整个换掉,否则这次写入会被 JSON.stringify 静默丢掉。
    // 新建的用 null 原型:`__proto__` 之类的键在它上面只是普通字符串键,没有特殊含义。
    if (!tokens) { tokens = Object.create(null) as Record<string, string>; state.tokens = tokens }
    tokens[productId] = token
    persistSave(state)
  }
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
/** 令牌根登记时记下目录的身份(dev+ino)。之后每个请求都核一遍:根必须还是**同一个真目录**,不是软链。
 *  不核的话,产物已经在页面里跑着的时候把它的目录换成一条指向 ~/.ssh 的软链,页面 `fetch('/id_rsa')` 就读到了 ——
 *  下面的 realpath 包含性检查是相对「此刻的根」做的,根自己被调了包它看不出来(Codex 评审)。 */
const rootIdentity = new Map<string, { dev: number; ino: number }>()
function rememberRoot(abs: string): void {
  try { const st = lstatSync(abs); if (st.isDirectory()) rootIdentity.set(abs, { dev: st.dev, ino: st.ino }) } catch { /* 目录不在:请求时自然 404 */ }
}
function sameRoot(abs: string): boolean {
  const want = rootIdentity.get(abs)
  if (!want) return true // 没登记过身份的根(登记那一刻目录还不存在)沿用原有检查
  try { const st = lstatSync(abs); return st.isDirectory() && st.dev === want.dev && st.ino === want.ino } catch { return false }
}

function serveFrom(rootDir: string, urlPath: string, res: ServerResponse, deref = false): void {
  if (deref && !sameRoot(rootDir)) { res.statusCode = 404; res.end('not found'); return }
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

/** 上次记下的端口;不合法就当没记(特权端口 <1024 一律不试:失败一次多一次重试成本)。 */
function stickyPort(): number {
  const p = persistedState().port
  return typeof p === 'number' && Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : 0
}

/** listen 成功后**常驻**的 error 兜底。为什么不能摘光:监听数归零后 server 再 emit 'error',
 *  EventEmitter 会直接把它 throw 出去 —— 在 Electron 主进程里就是 uncaughtException,整个应用跟着倒。
 *  而 net.Server 在 accept 阶段(EMFILE / ENFILE / ECONNABORTED…)本来就还会发 'error'。
 *  这里只记日志:预览服务器出点事最多预览打不开,不值得掀翻主进程。 */
function guardServerErrors(srv: Server, label: string): void {
  srv.on('error', (e: Error) => { console.error(`[preview] ${label}服务器运行期出错(已兜底,不崩主进程):`, e) })
}

/** 一次 listen 尝试。失败(EADDRINUSE/EACCES…)收口成 reject,且把这次的 error 监听摘干净 —— 同一个
 *  server 还能再 listen 一次(Node 的标准重试姿势);成功则换上常驻兜底(见 guardServerErrors)。 */
function listenOn(srv: Server, port: number, label: string): Promise<void> {
  return new Promise<void>((res, rej) => {
    const fail = (e: Error): void => rej(e)
    srv.once('error', fail)
    srv.listen(port, '127.0.0.1', () => { srv.removeListener('error', fail); guardServerErrors(srv, label); res() })
  })
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
    // 粘性端口:先试上次那个(源里带端口,换端口=换源=数据丢)。被别的进程占了 / 没权限一律退回
    // listen(0) —— 宁可这次换源,也不能开不出预览。
    const want = stickyPort()
    if (want) await listenOn(srv, want, '令牌根').catch(() => listenOn(srv, 0, '令牌根'))
    else await listenOn(srv, 0, '令牌根')
    // 启动期间有人调过 stopCodePreview:那次 stop 看到的 previewServer 还是 null,什么都没关掉。
    // 这里补关,别把一台服务器连同它的令牌留在身后(codex Low-8)。
    if (gen !== stopGen) { srv.close(); throw new Error('preview server stopped') }
    previewServer = srv
    const addr = srv.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    // ⚠️只在**还没有**首选端口时才落盘。首选端口这次被别的进程占了 → 本次会话用临时端口,**盘上的首选不动**,
    //   下次启动再试它。原先这里会把临时端口写回去:一次偶然的占用就让所有产物永久搬到新源,旧源里的
    //   localStorage / IndexedDB 再也够不着(Codex 评审)。代价:首选端口若被长期霸占,每次启动都是临时源 ——
    //   数据还在原地等着,比一次性丢光强。
    if (port && !want) { const state = persistedState(); state.port = port; persistSave(state) }
    return `${port}`
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

/** 把某个**产物**的目录挂到它的稳定令牌源下 —— 与 servePathRoot 同形,区别只在 token 不随机、不淘汰。
 *  产物根也是令牌根 → serveFrom 的 deref 照常开着(根内软链指到根外一律拒)。 */
export async function serveProductRoot(productId: string, dir: string): Promise<{ origin: string; token: string; base: string }> {
  // 令牌源的主机名形如 <token>.localhost,productId 只进 key 不进 URL,但仍是信任边界:
  // 来自 renderer/IPC 的串不设限,持久化文件里就能塞进任意键。
  if (!PRODUCT_ID_RE.test(productId) || RESERVED_PRODUCT_IDS.has(productId)) throw new Error(`invalid productId: ${productId}`)
  const port = await ensurePreviewServer()
  const abs = resolve(dir)
  const token = productToken(productId)
  // 项目被挪走 / 改名:令牌不动,只把它重新指到新目录(源不变 = 产物数据不丢)。
  const prev = tokenToRoot.get(token)
  if (prev && prev !== abs && rootToToken.get(prev) === token) rootToToken.delete(prev)
  tokenToRoot.set(token, abs)
  rememberRoot(abs)
  // 让 servePathRoot(同一目录) 也落到这个令牌上:Coding Studio 里编辑时的预览与「启动」后的产物
  // 同源 → 调试时写进 localStorage 的东西启动后还在。原来那个随机令牌不回收(可能正开着,回收了
  // 刷新就 404),它自己会 LRU 掉。
  rootToToken.set(abs, token)
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
    // 与令牌根共用 listenOn:失败收口成 reject,成功后换上常驻 error 兜底(原来那个 once('error', j)
    // 在 listen 成功后就是个已 settle 的空转 reject,晚到的 server error 等于没人接)。
    await listenOn(srv, 0, 'Coding Space 主根')
    if (gen !== stopGen) { srv.close(); throw new Error('preview server stopped') } // 同令牌根:启动期间被 stop 过 → 补关
    server = srv
    const addr = srv.address()
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })().catch((e) => { starting = null; throw e })
  return starting
}

/** 全停:服务器关掉,所有令牌不再服务任何内容。**不动**落盘的令牌/端口,也不动 productToToken ——
 *  那是产物的身份(停了再开还得是同一个源),不是内容。 */
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
  rootIdentity.clear()
  rootToToken.clear()
  tokenToInline.clear()
  inlineToToken.clear()
}
