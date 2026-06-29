/**
 * 内置 tangu-server 托管(方案 B):spawn `node dist/standalone/main.js` 子进程。
 *   - 空闲端口探测(listen(0))+ 失败重试
 *   - token:standalone 是单 token 模型(forsion_token 既调云端也作本地端点鉴权),
 *     经 env TANGU_TOKEN 传入(不上进程列表);留空则子进程回退 `tangu login` 存的凭证
 *   - /health 轮询就绪(300ms × 20s 超时)
 *   - stdout/stderr 环形缓冲 200 行(设置页可查看)
 *   - 意外退出指数退避自动重启(≤3 次),before-quit SIGTERM→3s→SIGKILL
 * dev:包根 dist/ 缺失 → 报错引导先 `npm run build`(回落 external 模式)。
 * 打包:extraResources 的 resources/tangu-server/(dist + node_modules 同级,Node 解析自然命中)。
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export type BackendState = 'stopped' | 'starting' | 'ready' | 'crashed'

export interface ManagedBackendSettings {
  cloudUrl: string
  cloudToken: string
  modelId?: string
  sandbox: 'auto' | 'docker' | 'none'
  browserEnabled?: boolean
  browserEngine?: 'auto' | 'chrome' | 'lightpanda'
  browserSearchEngine?: 'duckduckgo' | 'bing' | 'google' | 'baidu'
  browserAllowPrivateUrls?: boolean
  browserCommandTimeoutMs?: number
  wechatEnabled?: boolean
  wechatRemoteApprovalMode?: 'readonly' | 'auto-edit' | 'full-auto'
  wechatStateDir?: string
  /** Forsion/Tangu 默认工作区目录(~/Tangu 或用户自定义);注入后端作微信远程会话的 cwd。 */
  defaultWorkspaceDir?: string
}

export interface BackendStatus {
  state: BackendState
  url: string | null
  pid: number | null
  lastError: string | null
  /** dev 专用:dist 入口在子进程启动后被重建(tsc 重跑)→ 跑的是旧代码,提示重启。 */
  staleDist: boolean
}

const LOG_CAP = 200

export class BackendManager {
  private child: ChildProcess | null = null
  private state: BackendState = 'stopped'
  private port = 0
  private token = ''
  private lastError: string | null = null
  private logs: string[] = []
  private restartCount = 0
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private settings: ManagedBackendSettings | null = null
  private listeners = new Set<(st: BackendStatus) => void>()
  private spawnedEntry: string | null = null
  private spawnedAt = 0

  onStatus(cb: (st: BackendStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** dev:dist 入口 mtime 晚于子进程启动 → 包根重新 build 过,跑的是旧代码。 */
  private isDistStale(): boolean {
    if (app.isPackaged || !this.spawnedEntry || this.state !== 'ready') return false
    try {
      return statSync(this.spawnedEntry).mtimeMs > this.spawnedAt
    } catch {
      return false
    }
  }

  getStatus(): BackendStatus {
    return {
      state: this.state,
      url: this.state === 'ready' ? `http://127.0.0.1:${this.port}` : null,
      pid: this.child?.pid ?? null,
      lastError: this.lastError,
      staleDist: this.isDistStale(),
    }
  }

  /** renderer 鉴权用的有效 token:显式配置 > ~/.tangu/auth.json(tangu login)> 本地回退令牌。
   *  最后一档保证 **未登录 Forsion 也能独立运行**:standalone 后端 validate 强制要 token(没 token 直接
   *  exit),且本地端点用同一 token 鉴权。无 Forsion 凭证时回退一个持久化的本地随机令牌——后端照常启动、
   *  端点仍鉴权(不裸奔),云端调用会 401 但已优雅降级(/agent/models 只少了 forsion 模型,BYOK/订阅照常)。 */
  getToken(): string {
    if (this.token) return this.token
    try {
      const creds = JSON.parse(readFileSync(join(homedir(), '.tangu', 'auth.json'), 'utf8'))
      if (creds.token) return String(creds.token)
    } catch { /* 无 auth.json → 回退本地令牌 */ }
    return this.localToken()
  }

  /** 本地回退令牌(渲染端↔后端的共享密钥;仅在无 Forsion 凭证时用)。持久化到 ~/.tangu/desktop-local-token,
   *  随机生成一次、chmod 600。用随机值而非常量:本地能跑 host shell 的端点不应被任意本机进程命中。 */
  private cachedLocalToken: string | null = null
  private localToken(): string {
    if (this.cachedLocalToken) return this.cachedLocalToken
    const f = join(homedir(), '.tangu', 'desktop-local-token')
    try {
      const v = readFileSync(f, 'utf8').trim()
      if (v) { this.cachedLocalToken = v; return v }
    } catch { /* 不存在 → 生成 */ }
    const tok = randomUUID()
    try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, tok, 'utf8'); chmodSync(f, 0o600) } catch { /* best-effort */ }
    this.cachedLocalToken = tok
    return tok
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  /** standalone 入口路径:dev=包根 dist,打包=resources/tangu-server/dist。 */
  static resolveEntry(): string | null {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'tangu-server', 'dist', 'standalone', 'main.js')]
      : [join(__dirname, '..', '..', '..', 'dist', 'standalone', 'main.js')]
    for (const p of candidates) if (existsSync(p)) return p
    return null
  }

  async start(settings: ManagedBackendSettings): Promise<BackendStatus> {
    await this.stop()
    this.settings = settings
    this.stopping = false
    this.restartCount = 0
    await this.spawnOnce()
    return this.getStatus()
  }

  private async spawnOnce(): Promise<void> {
    const entry = BackendManager.resolveEntry()
    if (!entry) {
      this.setState('crashed', '找不到 tangu-server(dev 下请先在包根执行 npm run build)')
      return
    }
    const s = this.settings!
    this.setState('starting', null)
    this.token = s.cloudToken || ''

    for (let attempt = 0; attempt < 3; attempt++) {
      this.port = await freePort()
      const args = [
        entry,
        '--port', String(this.port),
        '--host', '127.0.0.1',
        // 与 TUI/standalone 默认同指 ~/.tangu/state.db,SQLite WAL 多进程共享 → 桌面与 TUI 会话互通。
        '--data-dir', join(homedir(), '.tangu', 'state.db'),
        '--sandbox', s.sandbox,
      ]
      if (s.cloudUrl) args.push('--cloud-url', s.cloudUrl)
      if (s.modelId) args.push('--model', s.modelId)

      // better-sqlite3 是原生模块,ABI 必须匹配运行时:
      //  - 打包:无系统 Node 保证 → 用 Electron(process.execPath)+ELECTRON_RUN_AS_NODE 跑,
      //    bundled better-sqlite3 已由 build/afterPack.cjs 为 Electron ABI 重建。
      //  - dev:终端必有系统 Node → 直接用系统 node(匹配 ../node_modules 的系统 ABI 预编译
      //    二进制),省去 dev 也要 electron-rebuild。TANGU_NODE_BIN 可覆盖 node 路径。
      const useSystemNode = !app.isPackaged
      const cmd = useSystemNode ? (process.env.TANGU_NODE_BIN || 'node') : process.execPath
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (!useSystemNode) env.ELECTRON_RUN_AS_NODE = '1'
      else delete env.ELECTRON_RUN_AS_NODE
      // 凭证走 env,不出现在 ps 输出。用 getToken()(config.cloudToken > auth.json > 本地回退令牌)——
      // **始终非空**,保证后端 validate(强制要 token)通过、无 Forsion 登录也能独立启动(BYOK/订阅可用)。
      env.TANGU_TOKEN = this.getToken()
      env.TANGU_BROWSER_ENABLED = s.browserEnabled === false ? '0' : '1'
      env.TANGU_BROWSER_ENGINE = s.browserEngine || 'auto'
      env.TANGU_BROWSER_SEARCH_ENGINE = s.browserSearchEngine || 'duckduckgo'
      env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = s.browserAllowPrivateUrls ? '1' : '0'
      env.TANGU_BROWSER_COMMAND_TIMEOUT_MS = String(s.browserCommandTimeoutMs || 30000)
      env.TANGU_WECHAT_ENABLED = s.wechatEnabled === false ? '0' : '1'
      env.TANGU_WECHAT_REMOTE_APPROVAL_MODE = s.wechatRemoteApprovalMode || 'readonly'
      if (s.wechatStateDir) env.TANGU_WECHAT_STATE_DIR = s.wechatStateDir
      // 让后端的微信远程会话落到桌面默认工作区(host 执行 cwd);兜底 ~/Tangu。
      env.TANGU_DEFAULT_WORKSPACE = s.defaultWorkspaceDir?.trim() || join(homedir(), 'Tangu')
      const child = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.spawnedEntry = entry
      this.spawnedAt = Date.now()
      this.child = child
      child.stdout?.on('data', (d) => this.pushLog(String(d)))
      child.stderr?.on('data', (d) => this.pushLog(String(d)))
      child.on('exit', (code, signal) => this.onExit(child, code, signal))

      const ok = await this.waitHealthy(child)
      if (ok) {
        this.restartCount = 0
        this.setState('ready', null)
        return
      }
      // 启动失败(端口被抢/早退):杀掉重试换端口。
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      this.child = null
    }
    this.setState('crashed', this.lastError || '后端启动失败(连续 3 次)')
  }

  private async waitHealthy(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || this.stopping) return false
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1000) })
        if (r.ok) return true
      } catch { /* not yet */ }
      await delay(300)
    }
    this.lastError = '后端 20s 内未就绪'
    return false
  }

  private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child !== child) return // 已被替换(重启路径)
    this.child = null
    if (this.stopping) {
      this.setState('stopped', null)
      return
    }
    this.lastError = `后端退出(code=${code} signal=${signal})`
    this.pushLog(`[manager] ${this.lastError}`)
    // 意外退出:指数退避自动重启 ≤3 次(timer 记账,stop() 必清——否则快速 stop/start 后
    // 陈旧 timer 在 stopping 已复位时触发,产生第二个 spawnOnce 双进程)。
    if (this.restartCount < 3 && this.settings) {
      const wait = 1000 * 2 ** this.restartCount
      this.restartCount++
      this.setState('starting', this.lastError)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (!this.stopping && this.settings) void this.spawnOnce()
      }, wait)
    } else {
      this.setState('crashed', this.lastError)
    }
  }

  async stop(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) {
      this.setState('stopped', null)
      return
    }
    this.stopping = true
    this.child = null
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }, 3000)
      child.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      try { child.kill('SIGTERM') } catch {
        clearTimeout(killTimer)
        resolve()
      }
    })
    this.setState('stopped', null)
  }

  private pushLog(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const t = line.trimEnd()
      if (!t) continue
      this.logs.push(t)
      if (this.logs.length > LOG_CAP) this.logs.shift()
    }
  }

  private setState(state: BackendState, err: string | null): void {
    this.state = state
    if (err !== null) this.lastError = err
    const st = this.getStatus()
    for (const cb of this.listeners) cb(st)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
    srv.on('error', reject)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
