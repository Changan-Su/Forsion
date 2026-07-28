/**
 * Forsion Connect（桌面侧）：Coding Space 项目发布 + 预览态 AI 代理。
 *
 *  - collectProjectFiles：把项目目录打包成发布载荷（跳过 node_modules/隐藏文件；
 *    .ts/.tsx/.jsx 用与预览完全相同的 sucrase 转译落成 JS —— 发布产物 = 预览所见）。
 *  - makePreviewProxy：codePreview 本地服务器 /__forsion/* → Forsion 云端（token 从 auth.json，
 *    只活在主进程，不进渲染层也不进预览页面 JS）。
 *  - connect:* IPC 用的云端 API 薄封装。
 */
import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { transpileForServe, MIME } from './codePreview'

export const CONNECT_MAX_FILES = 300
export const CONNECT_MAX_FILE_BYTES = 5 * 1024 * 1024
export const CONNECT_MAX_TOTAL_BYTES = 20 * 1024 * 1024
/** 预览代理 POST body 上限（预览页与代理同源，防超大请求体撑爆主进程内存）。对齐 server body limit 50MB。 */
const MAX_PROXY_BODY = 50 * 1024 * 1024

const SKIP_DIRS = new Set(['node_modules'])
const TRANSPILE_EXT = new Set(['.ts', '.tsx', '.jsx', '.mts', '.cts'])

export interface PackedFile { path: string; content_b64: string; content_type: string; size: number }

/** 打包项目目录。超限直接抛错（中文消息面向发布对话框）。 */
export function collectProjectFiles(root: string): { files: PackedFile[]; totalBytes: number } {
  const files: PackedFile[] = []
  let total = 0
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue // .git / .DS_Store / .forsion-connect.json 等
      const abs = join(dir, name)
      let st
      try { st = lstatSync(abs) } catch { continue } // lstat 不跟随：symlink 原样识别
      if (st.isSymbolicLink()) continue // 跳过软链：防跟随到项目外文件、防循环软链无限递归
      const relPath = rel ? `${rel}/${name}` : name
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(abs, relPath); continue }
      if (!st.isFile()) continue
      if (name.endsWith('.d.ts')) continue
      if (files.length >= CONNECT_MAX_FILES) throw new Error(`文件数超过 ${CONNECT_MAX_FILES}，请精简项目（node_modules 与隐藏文件已自动跳过）`)
      const ext = extname(name).toLowerCase()
      let buf: Buffer
      let ct = MIME[ext] || 'application/octet-stream'
      if (TRANSPILE_EXT.has(ext)) {
        const out = transpileForServe(readFileSync(abs, 'utf8'), ext, relPath)
        buf = Buffer.from(out ?? '', 'utf8')
        ct = 'text/javascript'
      } else {
        buf = readFileSync(abs)
      }
      if (buf.length > CONNECT_MAX_FILE_BYTES) throw new Error(`单文件超过 5MB：${relPath}`)
      total += buf.length
      if (total > CONNECT_MAX_TOTAL_BYTES) throw new Error('项目总大小超过 20MB，无法发布')
      files.push({ path: relPath, content_b64: buf.toString('base64'), content_type: ct, size: buf.length })
    }
  }
  walk(root, '')
  if (!files.length) throw new Error('项目为空，没有可发布的文件')
  return { files, totalBytes: total }
}

// ── 每项目发布记忆（slug 记回项目根，republish 免重填；dotfile 天然不进发布包） ──

const META_FILE = '.forsion-connect.json'

export function readConnectMeta(dir: string): { slug?: string } {
  try { return JSON.parse(readFileSync(join(dir, META_FILE), 'utf8')) } catch { return {} }
}

export function writeConnectMeta(dir: string, meta: { slug: string }): void {
  try { writeFileSync(join(dir, META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf8') } catch { /* best-effort */ }
}

// ── 云端 ──

export interface CloudCreds { base: string; token: string }
export type CloudResolver = () => Promise<CloudCreds>

export async function cloudJson(
  c: CloudCreds, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeoutMs = 60_000,
): Promise<{ status: number; json: any }> {
  const r = await fetch(c.base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Project-Source': 'connect',
      ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, json }
}

/**
 * 预览页 /__forsion/* → 云端转发。哑管道：模型选择等逻辑都在 SDK 里（与发布态壳页同款），
 * 这里只补 token 和 Origin 侧信任（本地服务器只绑 127.0.0.1）。SSE 流式直通。
 */
export function makePreviewProxy(resolveCloud: CloudResolver): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  type Route = { method: 'GET' | 'POST'; path: string; auth: boolean; timeoutMs?: number; agentRun?: boolean }
  const MAP: Record<string, Route> = {
    '/__forsion/chat': { method: 'POST', path: '/api/chat/completions', auth: true },
    '/__forsion/images': { method: 'POST', path: '/api/images/generations', auth: true },
    '/__forsion/user': { method: 'GET', path: '/api/brain/users/me', auth: true },
    '/__forsion/models': { method: 'GET', path: '/api/models', auth: false },
    '/__forsion/config': { method: 'GET', path: '/api/connect/config', auth: false },
    '/__forsion/agent': { method: 'POST', path: '/api/agent/runs', auth: true, agentRun: true },
  }
  /** agent-events 带动态 runId,静态 MAP 装不下;runId 白名单字符防路径拼接注入。
   *  timeout 放宽到 15min:agent run(检索+沙箱)天然比一次 chat 长。 */
  function resolveRoute(urlPath: string): Route | undefined {
    if (MAP[urlPath]) return MAP[urlPath]
    const P = '/__forsion/agent-events/'
    if (urlPath.startsWith(P)) {
      const runId = urlPath.slice(P.length)
      if (/^[A-Za-z0-9-]{1,64}$/.test(runId)) {
        return { method: 'GET', path: `/api/agent/runs/${runId}/events`, auth: true, timeoutMs: 900_000 }
      }
    }
    return undefined
  }
  return async (req, res) => {
    const [urlPath, qs] = (req.url || '').split('?')
    const fail = (code: number, detail: string): void => {
      if (!res.headersSent) { res.statusCode = code; res.setHeader('Content-Type', 'application/json') }
      res.end(JSON.stringify({ detail }))
    }
    const m = resolveRoute(urlPath)
    if (!m) return fail(404, 'unknown connect endpoint')
    if ((req.method || 'GET') !== m.method) return fail(405, 'method not allowed')
    let base = ''; let token = ''
    try { ({ base, token } = await resolveCloud()) } catch { /* fail below */ }
    if (!base) return fail(502, '未配置 Forsion 云端地址')
    if (m.auth && !token) return fail(401, '请先在 Forsion Desktop 中登录 Forsion 账号')
    let body: Buffer | undefined
    if (m.method === 'POST') {
      const chunks: Buffer[] = []
      let n = 0
      try {
        for await (const c of req) {
          n += (c as Buffer).length
          if (n > MAX_PROXY_BODY) { req.destroy(); return fail(413, '请求体过大') }
          chunks.push(c as Buffer)
        }
      } catch (e) {
        return fail(400, `请求体读取失败：${(e as Error)?.message || String(e)}`)
      }
      body = Buffer.concat(chunks)
    }
    // agent run 的转发体主进程重建:只放行 session_id/message——app_id/agent_config 钉死,
    // **model_id 也不放行**(模型完全由网关按 Connect 策略决定;预览页是任意用户代码,
    // 绕过 SDK 直 POST 也指不了模型/塞不了 execMode 之类的私货)。
    if (m.agentRun) {
      let j: any
      try { j = JSON.parse((body || Buffer.alloc(0)).toString('utf8') || '{}') } catch { return fail(400, 'agent 请求体必须是 JSON') }
      body = Buffer.from(JSON.stringify({
        session_id: typeof j.session_id === 'string' ? j.session_id : '',
        message: typeof j.message === 'string' ? j.message : '',
        app_id: 'connect',
        agent_config: {},
      }))
    }
    // 超时 + 客户端断开双源 abort:预览页关掉后不再拖着上游 SSE 干挂(15min 泄漏,codex 评审#4)。
    const ac = new AbortController()
    const tm = setTimeout(() => ac.abort(new Error('proxy timeout')), m.timeoutMs ?? 300_000)
    req.on('close', () => ac.abort())
    try {
      const upstream = await fetch(base + m.path + (qs ? `?${qs}` : ''), {
        method: m.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Source': 'connect',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body && body.length ? new Uint8Array(body) : undefined,
        signal: ac.signal,
      })
      res.statusCode = upstream.status
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      if (upstream.body) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
      }
      res.end()
    } catch (e) {
      // 流已开始（headers 已发）→ 追加合法 SSE error frame。裸 JSON 会被 SDK 解析器（只认 data: 行）
      // 忽略 → EOF 被当成功截断，把失败伪装成部分成功。
      const msg = `云端请求中断：${(e as Error)?.message || String(e)}`
      if (res.headersSent) {
        try { res.write(`data: ${JSON.stringify({ error: msg })}\n\n`) } catch { /* ignore */ }
        res.end()
      } else {
        fail(502, msg)
      }
    } finally {
      clearTimeout(tm)
    }
  }
}
