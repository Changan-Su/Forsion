/**
 * Forsion Desktop MCP 端点(HTTP transport,本地聚合器)。
 *
 * 两类消费者、两把钥匙(08-24 引擎原生路 P1):
 *   - **外部 agent**(Claude Code 等)经 `claude mcp add --transport http` 连上 —— 凭 `localSecret`,
 *     仅设置「高级」开关开启时被接受;发现文件 forsion-mcp.json 也只在开启时存在、关闭即删。
 *     开关守的是「外部 agent 的知情启用」这个同意语义(同用户进程本就拿得到引擎 token,这不是安全边界)。
 *   - **Tangu 引擎**(transcribe_audio 桥)—— 凭 `bridgeSecret`(每次启动随机生成),常年被接受;
 *     发现文件 desktop-bridge.json 每次启动重写。服务器因此**常驻**(App 启动即起,不随开关起停)。
 *
 * 住在 Electron 主进程:既能代理引擎 HTTP(inbox),又能直达主进程能力(ASR;后续日历/笔记)。
 * 这是引擎够不着的那些「Forsion Desktop 能力」的唯一聚合层。
 * 安全基线:绑 127.0.0.1 + Bearer 守门 + DNS-rebinding 保护;两份发现文件都 0600。
 *
 * ponytail: 工具 = inbox_send + transcribe_audio,无状态每请求一套 server+transport。日历/笔记/Space 按需加。
 */
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http'
import { writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createSerialQueue } from './configWrite'

const DEFAULT_PORT = 3591
const HOST = '127.0.0.1'

export interface EngineAccess {
  /** 引擎就绪时 http://127.0.0.1:<port>,否则 null(App 未起/后端崩) */
  url: string | null
  /** 引擎 authMiddleware 认的 token(= 渲染端用的那个;云登录后是云 token,否则本地回退令牌) */
  token: string
}

export interface McpDeps {
  /** 取当前引擎地址+token,每次调用现取(引擎端口是动态探测的、登录态会变) */
  getEngine: () => EngineAccess
  /** 外部 agent 那一跳的守门密钥:桌面本地密钥,稳定、不随云登录轮换。仅 externalEnabled() 时被接受。 */
  localSecret: string
  /** 引擎桥那一跳的密钥:每次桌面启动随机生成(限制陈旧凭据寿命),写 desktop-bridge.json,常年被接受。 */
  bridgeSecret: string
  /** 外部 agent 面是否开启(设置「高级」开关);桥面不受它管。 */
  externalEnabled: () => boolean
  /** 主进程 ASR 的路径面(main.ts runTranscribe 包装)。缺席时 transcribe_audio 回错误。 */
  transcribeFile?: (
    path: string,
    req: { timestamps?: boolean; language?: string },
  ) => Promise<string | { text: string; segments?: Array<{ start: number; end: number; text: string }> }>
  /** ~/.forsion 目录(落发现文件) */
  homeDir: string
  log?: (msg: string) => void
}

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
const err = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

/** inbox_send 的实体:代理引擎 POST /agent/inbox。导出供单测直打(不经 MCP transport 仪式)。 */
export async function callInboxSend(
  deps: McpDeps,
  args: { title?: unknown; body?: unknown },
): Promise<CallToolResult> {
  const { url, token } = deps.getEngine()
  if (!url) return err('Forsion engine not ready — is the desktop app running?')
  const title = String(args.title ?? '').trim()
  if (!title) return err('title is required')
  const body = String(args.body ?? '')
  try {
    const r = await fetch(`${url}/agent/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title, body, sender_id: 'mcp' }),
    })
    const j = (await r.json().catch(() => ({}))) as { id?: string; detail?: string }
    if (!r.ok) return err(`inbox POST ${r.status}: ${j.detail ?? r.statusText}`)
    return ok(`Sent to inbox (id=${j.id ?? '?'})`)
  } catch (e) {
    return err(`inbox request failed: ${(e as Error).message}`)
  }
}

/** transcribe_audio 的实体:主进程按路径读盘 + 跑桌面 ASR 链路。导出供单测直打(不经 MCP transport 仪式)。 */
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|opus|flac|webm)$/i
export async function callTranscribeAudio(
  deps: McpDeps,
  args: { path?: unknown; timestamps?: unknown; language?: unknown },
): Promise<CallToolResult> {
  if (!deps.transcribeFile) return err('ASR not available in this desktop build')
  const p = String(args.path ?? '').trim()
  if (!p || !isAbsolute(p)) return err('path must be an absolute local file path')
  if (!AUDIO_EXT.test(p)) return err('unsupported file type — expected an audio file (wav/mp3/m4a/aac/ogg/opus/flac/webm)')
  try {
    const r = await deps.transcribeFile(p, {
      timestamps: args.timestamps === true,
      language: args.language ? String(args.language) : undefined,
    })
    const out = typeof r === 'string' ? { text: r } : { text: r.text, ...(r.segments?.length ? { segments: r.segments } : {}) }
    return ok(JSON.stringify(out))
  } catch (e) {
    return err(`transcribe failed: ${(e as Error).message}`)
  }
}

function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'forsion-desktop', version: '0.1.0' })
  server.registerTool(
    'inbox_send',
    {
      description:
        'Send a message to the Forsion Desktop inbox (shows up in the running app). Use for notifications, reminders, or handoff notes to the user.',
      inputSchema: {
        title: z.string().max(200).describe('Message title. Required.'),
        body: z.string().max(4000).optional().describe('Optional message body.'),
      },
    },
    async (args) => callInboxSend(deps, args),
  )
  server.registerTool(
    'transcribe_audio',
    {
      description:
        'Transcribe a local audio file via the desktop speech-recognition pipeline (local offline model or the ASR provider configured in desktop settings). Returns JSON {text, segments?}.',
      inputSchema: {
        path: z.string().describe('Absolute path to a local audio file (wav/mp3/m4a/aac/ogg/opus/flac/webm).'),
        timestamps: z.boolean().optional().describe('Also return timed segments [{start,end,text}].'),
        language: z.string().optional().describe('Optional language hint, e.g. "zh".'),
      },
    },
    async (args) => callTranscribeAudio(deps, args),
  )
  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

/** 直接拿真服务器绑定,绑不上就顺延(共试 tries 个口)。不先开临时服务器探测:探测放掉端口到真绑定之间会被别的进程抢走,
 *  而没挂 'error' 的 listen 撞上 EADDRINUSE = 主进程未捕获异常 + promise 永不落定(await 它的 config:set 跟着挂死)。
 *  任何绑定错误都顺延(同原探测):Windows 上 Hyper-V/WSL 保留端口段报的是 EACCES 而不是 EADDRINUSE。 */
async function listenFrom(server: Server, first: number, tries: number): Promise<number> {
  for (let port = first; ; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => { server.off('listening', onListening); reject(e) }
        const onListening = () => { server.off('error', onError); resolve() }
        server.once('error', onError).once('listening', onListening).listen(port, HOST)
      })
      return port
    } catch (e) {
      if (port >= first + tries - 1) throw e
    }
  }
}

function writeEndpointFile(f: string, endpoint: string, secret: string, log: (m: string) => void): void {
  try {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ url: endpoint, token: secret }, null, 2), 'utf8')
    chmodSync(f, 0o600)
  } catch (e) {
    log(`[mcp] publish endpoint failed: ${(e as Error).message}`)
  }
}

/** 外部 agent 的发现文件(forsion-mcp.json):仅开关开启时存在 —— 开=发布,关=删除(见文件头「同意语义」)。 */
export function publishExternalEndpoint(homeDir: string, endpoint: string, secret: string, log: (m: string) => void = () => {}): void {
  writeEndpointFile(join(homeDir, 'forsion-mcp.json'), endpoint, secret, log)
  log(`[mcp] claude mcp add --transport http forsion ${endpoint} --header "Authorization: Bearer ${secret}"`)
}
export function unpublishExternalEndpoint(homeDir: string, log: (m: string) => void = () => {}): void {
  try {
    rmSync(join(homeDir, 'forsion-mcp.json'), { force: true })
  } catch (e) {
    log(`[mcp] unpublish endpoint failed: ${(e as Error).message}`)
  }
}

export async function startForsionMcp(
  deps: McpDeps,
  { port: firstPort = DEFAULT_PORT, tries = 20 } = {},
): Promise<{ url: string; port: number; close: () => void }> {
  const log = deps.log ?? (() => {})
  let allowedHosts: string[] = [] // 绑定成功后按实际端口填(请求只可能在那之后到)

  const httpServer = createHttpServer(async (req, res) => {
    try {
      if (!(req.url ?? '').startsWith('/mcp')) {
        res.writeHead(404).end('Not found')
        return
      }
      // 守门(双钥,见文件头):引擎桥密钥常年有效;外部 localSecret 仅开关开启时被接受。
      const auth = req.headers.authorization
      const authorized =
        auth === `Bearer ${deps.bridgeSecret}` || (deps.externalEnabled() && auth === `Bearer ${deps.localSecret}`)
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end('Method not allowed')
        return
      }
      const body = await readBody(req)
      // 无状态:每请求一套 server+transport(避免并发客户端的 request-id 撞车)。
      const server = buildServer(deps)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts,
      })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      log(`[mcp] request error: ${(e as Error).message}`)
      if (!res.headersSent) res.writeHead(500).end('Internal error')
    }
  })

  const port = await listenFrom(httpServer, firstPort, tries)
  httpServer.on('error', (e) => log(`[mcp] server error: ${e.message}`)) // 绑定后的错误(如 accept 报 EMFILE)无监听 = 主进程崩
  allowedHosts = [`${HOST}:${port}`, `localhost:${port}`]
  const endpoint = `http://${HOST}:${port}/mcp`
  // 引擎桥的发现文件:常驻、每次启动重写(端口/密钥都会变);外部面的 forsion-mcp.json 由 createMcpLifecycle 按开关发布/删除。
  writeEndpointFile(join(deps.homeDir, 'desktop-bridge.json'), endpoint, deps.bridgeSecret, log)
  log(`[mcp] Forsion Desktop MCP on ${endpoint}`)
  return { url: endpoint, port, close: () => httpServer.close() }
}

type McpHandle = Awaited<ReturnType<typeof startForsionMcp>>

/** main.ts applyForsionMcp 的实体:服务常驻、只起一次;开关只管外部面(forsion-mcp.json + 守门)。
 *  所有 apply 串行 —— 启动期再来一次开关(启动那次 × config:set)不会起第二个服务、漏一个句柄;启动失败不缓存,
 *  下一次 apply 重试。按调用顺序,**被更新的请求取代的那次直接跳过**(不发布、不启动,交给最新那次)→ 最终态 = 最后一次请求,
 *  中途也不会先发布再撤销。enabled 可传「在队列里现读配置」的函数(启动那次):读配置慢于用户切开关时,读到的旧值作废。
 *  守门读的开关在 apply(boolean) 当下就改(关 = 立刻拒外部密钥);撤销发现文件不等服务起来(起不来也得撤)。 */
export function createMcpLifecycle(o: {
  start: (externalEnabled: () => boolean) => Promise<McpHandle>
  homeDir: () => string
  localSecret: () => string
  log?: (m: string) => void
}): { apply: (enabled: boolean | (() => Promise<boolean>)) => Promise<void>; externalUrl: () => string | null } {
  const queue = createSerialQueue()
  let handle: McpHandle | null = null
  let externalOn = false
  let latest = 0
  return {
    apply(enabled) {
      const me = ++latest
      if (typeof enabled === 'boolean') externalOn = enabled
      return queue(async () => {
        if (me !== latest) return
        const on = typeof enabled === 'boolean' ? enabled : await enabled()
        if (me !== latest) return // 读配置期间用户又切了开关
        externalOn = on
        if (!on) unpublishExternalEndpoint(o.homeDir(), o.log)
        const h = (handle ??= await o.start(() => externalOn))
        if (on && me === latest) publishExternalEndpoint(o.homeDir(), h.url, o.localSecret(), o.log)
      })
    },
    /** 外部面开着且服务已起 → 端点;启动中 / 关着 → null(设置页据此才显示连接信息) */
    externalUrl: () => (externalOn && handle ? handle.url : null),
  }
}
