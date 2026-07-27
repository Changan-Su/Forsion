/**
 * Forsion Desktop MCP 端点(HTTP transport,本地聚合器)。
 *
 * 外部 agent(Claude Code 等)经 `claude mcp add --transport http` 连上,调用桌面能力。
 * 住在 Electron 主进程:既能代理引擎 HTTP(inbox),又能直接调 Amadeus(后续 v1/v2 日历/笔记)。
 * 这是引擎够不着的那些「Forsion Desktop 能力」的唯一聚合层。
 *
 * 安全(信任边界,不裸奔):绑 127.0.0.1 + Bearer 守门(桌面本地密钥,≠ 引擎/云 token)
 * + DNS-rebinding 保护。端点+密钥落 ~/.forsion/forsion-mcp.json(0600),启动打印 `claude mcp add` 行。
 *
 * ponytail: v0 只有 inbox_send 一个工具,无状态每请求一套 server+transport。日历/笔记/Space 后续按需加。
 */
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

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
  /** Claude→MCP 这一跳的守门密钥:桌面本地密钥,稳定、不随云登录轮换 */
  localSecret: string
  /** ~/.forsion 目录(落 forsion-mcp.json 供发现) */
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
  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : undefined
}

/** 空闲端口探测:默认口占用则递增找,全占也返回默认(交给 listen 报错)。 */
function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createNetServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, HOST)
  })
}
async function pickPort(start: number): Promise<number> {
  for (let p = start; p < start + 20; p++) if (await tryListen(p)) return p
  return start
}

function publishEndpoint(homeDir: string, endpoint: string, secret: string, log: (m: string) => void): void {
  const f = join(homeDir, 'forsion-mcp.json')
  try {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify({ url: endpoint, token: secret }, null, 2), 'utf8')
    chmodSync(f, 0o600)
  } catch (e) {
    log(`[mcp] publish endpoint failed: ${(e as Error).message}`)
  }
}

export async function startForsionMcp(deps: McpDeps): Promise<{ url: string; port: number; close: () => void }> {
  const log = deps.log ?? (() => {})
  const port = await pickPort(DEFAULT_PORT)
  const allowedHosts = [`${HOST}:${port}`, `localhost:${port}`]

  const httpServer = createHttpServer(async (req, res) => {
    try {
      if (!(req.url ?? '').startsWith('/mcp')) {
        res.writeHead(404).end('Not found')
        return
      }
      // 守门:Claude→MCP 这一跳。其他本机进程不该能驱动桌面能力。
      if (req.headers.authorization !== `Bearer ${deps.localSecret}`) {
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

  await new Promise<void>((resolve) => httpServer.listen(port, HOST, resolve))
  const endpoint = `http://${HOST}:${port}/mcp`
  publishEndpoint(deps.homeDir, endpoint, deps.localSecret, log)
  log(`[mcp] Forsion Desktop MCP on ${endpoint}`)
  log(`[mcp] claude mcp add --transport http forsion ${endpoint} --header "Authorization: Bearer ${deps.localSecret}"`)
  return { url: endpoint, port, close: () => httpServer.close() }
}
