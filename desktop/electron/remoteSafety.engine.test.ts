/**
 * P1 · K2 契约台架:**真主进程控制器 × 真引擎路由**(独立评审 P2 的覆盖缺口)。
 *
 * electron/remoteSafety.test.ts 的引擎是手写的假 HTTP 服务;e2e:remotesafety 跑外部模式桩引擎(没有 /agent/remote/*,只走待补发);
 * live 台架里是台架自己扮主进程。于是路由改名、快照信封({type:'snapshot', …})变形、鉴权头变了,全部用例照绿、生产急停却永远待补发。
 * 这里按 tangu-agent/src/standalone/main.ts 的装配(createTanguModule + remoteLockGuard + '/' 挂 user / data 路由)在 listen(0) 上起真引擎
 * (内存 SQLite,模型挂住直到被中止),createRemoteSafety 用真 fetch、真锁文件(FORSION_REMOTE_LOCK_FILE 指同一份,同 backendManager)、
 * 真本机令牌鉴权去打它:
 *   SSE 快照喂托盘(调用方名、keepAwake 强制)→ 急停:报告计数、锁文件、引擎闩、run 终态 reason:'remote_estop' → 锁定时远程写 423 →
 *   认证解锁:lock:null 落盘 + 引擎清闩 → 远程写恢复。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createRemoteSafety, type RemoteSafety } from './remoteSafety'
import { REMOTE_LOCK_FILE_ENV, REMOTE_LOCK_FILE } from '../shared/remoteSafety'
import { createTanguModule } from '../../tangu-agent/src/index'
import { createTanguProfile } from '../../tangu-agent/src/profiles/index'
import { createSqliteHost } from '../../tangu-agent/src/adapters/standalone/sqliteHost'
import { toSqliteDDL } from '../../tangu-agent/src/core/dialectDDL'
import { STANDALONE_SCHEMA } from '../../tangu-agent/src/db/schemaStandalone'
import { query } from '../../tangu-agent/src/core/db'
import { createRun, getRun } from '../../tangu-agent/src/services/runStore'
import { subscribe } from '../../tangu-agent/src/services/eventBus'
import { enqueueRun, abortRun } from '../../tangu-agent/src/services/agentLoop'
import { remoteLocked } from '../../tangu-agent/src/services/remoteLock'
import { remoteLockGuard } from '../../tangu-agent/src/standalone/remoteLockGuard'

const require_ = createRequire(import.meta.url)
const express = require_('../../tangu-agent/node_modules/express') as any

const USER = 'u1'
const TOKEN = 'local-engine-token'
let dir: string
let lockFile: string
let srv: Server
let url: string
let rs: RemoteSafety
const forced: boolean[] = []
const notes: Array<{ title: string; body: string }> = []
const trays: Array<{ title: string; tooltip: string }> = []

const until = async (fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'k2-contract-'))
  process.env.TANGU_HOME = join(dir, 'tangu')
  lockFile = join(dir, REMOTE_LOCK_FILE)
  process.env[REMOTE_LOCK_FILE_ENV] = lockFile
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: TOKEN, userId: USER })
  db.exec(toSqliteDDL(STANDALONE_SCHEMA))
  const hang = (o: any): Promise<any> => new Promise((_res, rej) => {
    const fail = (): void => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (o.signal?.aborted) return fail()
    o.signal?.addEventListener('abort', fail, { once: true })
  })
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => (o.onToken ? hang(o) : { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }),
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  }
  const billing: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} }
  const mod = createTanguModule({ host, brain, billing, profile: createTanguProfile({ sandboxMode: 'none' }) } as any)
  await mod.runMigration()
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S1', ?, 'tangu', 't', 'm1', 'user')`, [USER])
  // standalone/main.ts 同款装配
  const app = express()
  app.use(express.json({ limit: '25mb' }))
  app.use((req: any, res: any, next: any) => remoteLockGuard(req, res, next))
  app.use('/', mod.userRouter)
  app.use('/', mod.dataRouter)
  srv = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => srv.once('listening', () => r()))
  url = `http://127.0.0.1:${(srv.address() as any).port}`

  rs = createRemoteSafety({
    file: () => lockFile,
    engine: () => ({ url, token: TOKEN }),
    shortcuts: { register: () => true, unregister: () => {} },
    notify: (title, body) => { notes.push({ title, body }) },
    refreshTray: (ind) => { trays.push(ind) },
    keepAwake: { force: (_k, on) => { forced.push(on); return on } },
    systemAuth: async () => 'ok',
    lang: () => 'en',
    remoteCapable: () => true,
    mac: true,
    log: () => {},
  })
  await rs.start()
}, 60_000)

afterAll(async () => {
  rs?.dispose()
  srv?.closeAllConnections?.()
  await new Promise((r) => srv?.close(r))
  delete process.env.TANGU_HOME
  delete process.env[REMOTE_LOCK_FILE_ENV]
  rmSync(dir, { recursive: true, force: true })
})

describe('主进程急停控制器 × 真引擎路由(契约)', () => {
  it('SSE 快照喂托盘 → 急停(报告 / 锁文件 / 引擎闩 / run 终态)→ 锁定时远程写 423 → 认证解锁清闩 → 远程写恢复', async () => {
    await until(() => rs.state().engine === 'connected') // 真 SSE 首帧(本机令牌鉴权 + {type:'snapshot'} 信封)
    const runId = 'K2C-remote'
    await createRun({
      id: runId, sessionId: 'S1', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
      input: {
        message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: dir },
        remote: { via: 'tunnel', marked: true, callerUnit: '0f5b2c1e-8a3d-4c6b-9e7f-1a2b3c4d5e6f', callerKind: 'phone', callerName: 'Pixel 9' },
      },
    })
    const errors: any[] = []
    subscribe(runId, (ev: any) => { if (ev.type === 'error') errors.push(ev.payload) })
    enqueueRun('S1', runId)
    await until(() => rs.state().remoteRuns.some((r) => r.runId === runId))
    expect(rs.state().remoteRuns.find((r) => r.runId === runId)).toMatchObject({ category: 'remote', label: 'Pixel 9', sessionId: 'S1' })
    expect(rs.trayView()).toMatchObject({ activeLabel: 'Pixel 9', activeCount: 1, locked: false })
    expect(forced.at(-1)).toBe(true) // 远程 run 在跑 → 强制防闲置休眠
    expect(trays.at(-1)).toEqual({ title: ' Remote', tooltip: 'Forsion · Remote session running' })

    const s = await rs.estop('hotkey')
    expect(s).toMatchObject({ locked: true, lockSource: 'hotkey', pendingEstop: false, lockPersistFailed: false, lastEstop: { aborted: 1, engineReached: true } })
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({ v: 1, lock: { locked: true, source: 'hotkey' } })
    expect(remoteLocked()).toBe(true)
    await until(async () => String((await getRun(runId))?.status) === 'aborted')
    expect(errors.at(-1)).toMatchObject({ aborted: true, reason: 'remote_estop' })
    expect(forced.at(-1)).toBe(false)
    expect(notes.at(-1)!.body).toContain('Stopped 1 remote tasks')
    await until(() => rs.state().remoteRuns.length === 0)

    // 锁定:远程来源的写(新起 run)在引擎侧 423 REMOTE_LOCKED
    const post = (): Promise<Response> => fetch(`${url}/agent/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'x-forsion-remote': 'tunnel' },
      body: JSON.stringify({ sessionId: 'S1', message: 'again', modelId: 'm1' }),
    })
    const locked = await post()
    expect(locked.status).toBe(423)
    expect((await locked.json()).code).toBe('REMOTE_LOCKED')

    // 认证解锁:先写 lock:null,再清引擎闩
    expect(await rs.unlock()).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).lock).toBeNull()
    expect(remoteLocked()).toBe(false)
    expect(rs.isLocked()).toBe(false)
    const after = await post()
    expect(after.status).not.toBe(423)
    const body = await after.json().catch(() => null)
    if (body?.runId) { abortRun(body.runId); await until(async () => ['done', 'failed', 'aborted'].includes(String((await getRun(body.runId))?.status))) }
    // 解锁后的快照不会被当成「本机不知道的锁」接回来
    await new Promise((r) => setTimeout(r, 400))
    expect(rs.isLocked()).toBe(false)
  }, 60_000)
})
