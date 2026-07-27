/**
 * 内置终端(builtin:terminal)的 PTY 通道:主进程持 node-pty 会话,渲染层 xterm.js 经 IPC 收发字节。
 *
 * node-pty 是原生模块,且是 **optionalDependency**(mac/win 有 N-API 预编译不必 rebuild;
 * Linux 无预编译要现编,缺工具链时装不上)——**缺失不炸主进程**:懒加载 + spawn 返回 `{ error }`,
 * 渲染层原样显示提示,其余功能不受影响。
 *
 * ponytail: 会话按 webContents 归属、窗口销毁即全杀;不做会话持久化/断线重连——
 * 真要「关标签不断会话」再引入会话池。
 */
import { ipcMain, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { statSync } from 'node:fs'

interface PtyProc {
  readonly pid: number
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(d: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
interface PtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProc
}

let mod: PtyModule | null | undefined // undefined=没试过;null=不可用
function loadPty(): PtyModule | null {
  if (mod !== undefined) return mod
  try {
    // 原生 CJS 模块 + main 打成 ESM → 与 sherpa-onnx-node 同款 createRequire 运行期加载
    // (ESM 具名 import 会在运行时报 "Named export not found")。
    mod = createRequire(import.meta.url)('node-pty') as PtyModule
  } catch (e) {
    console.error('[pty] node-pty 加载失败(原生模块缺失或未按 Electron ABI 重建):', e)
    mod = null
  }
  return mod
}

/** 默认 shell:尊重 $SHELL 并走登录 shell(GUI 进程的 PATH 是残缺的,-l 才拿得到用户真实环境)。 */
export function defaultShell(platform: string, env: Record<string, string | undefined>): { file: string; args: string[] } {
  if (platform === 'win32') return { file: env.COMSPEC || 'powershell.exe', args: [] }
  return { file: env.SHELL || '/bin/bash', args: ['-l'] }
}

/** cwd 落点:目录确实存在才用,否则回家目录(cwd 不存在会让 spawn 直接失败)。 */
export function resolveCwd(cwd?: string): string {
  if (cwd) {
    try { if (statSync(cwd).isDirectory()) return cwd } catch { /* 落回家目录 */ }
  }
  return homedir()
}

/** 终端尺寸消毒:非有限数/0/负数会让 pty 直接抛。 */
export function saneSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const n = (v: unknown, d: number): number => (Number.isFinite(v) && (v as number) >= 2 ? Math.min(1000, Math.floor(v as number)) : d)
  return { cols: n(cols, 80), rows: n(rows, 24) }
}

const sessions = new Map<string, { proc: PtyProc; wc: WebContents }>()
const watched = new WeakSet<WebContents>()
let seq = 0

function killOwnedBy(wc: WebContents): void {
  for (const [id, s] of sessions) {
    if (s.wc !== wc) continue
    try { s.proc.kill() } catch { /* 已退出 */ }
    sessions.delete(id)
  }
}

/** 会话绑的是 renderer 的 **document**,不只是 WebContents:reload / 崩溃自愈会换掉 document
 *  但复用同一个 wc → 'destroyed' 不触发、React cleanup 也跑不到,旧 PTY 会变成没人认领的孤儿进程
 *  (新 document 连它的 id 都不知道)。故三处都收:导航换页、渲染进程死亡、wc 真销毁。 */
function watchOwner(wc: WebContents): void {
  if (watched.has(wc)) return
  watched.add(wc)
  wc.once('destroyed', () => killOwnedBy(wc))
  wc.on('render-process-gone', () => killOwnedBy(wc))
  wc.on('did-start-navigation', (d: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (d?.isMainFrame && !d.isSameDocument) killOwnedBy(wc)
  })
}

/** sender 可信判定由主进程注入(避免 pty ← main 的循环 import);缺省保守拒绝。 */
type TrustCheck = (e: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>) => boolean

export function registerPtyIpc(isTrusted: TrustCheck): void {
  ipcMain.handle('pty:spawn', (e, opts: { cols?: number; rows?: number; cwd?: string } = {}) => {
    // ⚠️创建也要鉴权,不能只在 write/resize 上按会话归属校验:归属只防「偷别人的会话」,
    // 防不住「任何拿到 ipcRenderer 的上下文自己开一个登录 shell」。
    if (!isTrusted(e)) return { error: 'forbidden' }
    const pty = loadPty()
    if (!pty) return { error: '终端不可用:node-pty 未安装成功(Linux 需 python3 + make + g++ 后重装依赖)' }
    const { file, args } = defaultShell(process.platform, process.env)
    const { cols, rows } = saneSize(opts.cols, opts.rows)
    const wc = e.sender
    let proc: PtyProc
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: resolveCwd(opts.cwd),
        env: { ...process.env, TERM: 'xterm-256color' },
      })
    } catch (err) {
      return { error: String((err as Error)?.message || err) }
    }
    const id = `pty${++seq}`
    sessions.set(id, { proc, wc })
    proc.onData((d) => { if (!wc.isDestroyed()) wc.send('pty:data', id, d) })
    proc.onExit(({ exitCode }) => {
      sessions.delete(id)
      if (!wc.isDestroyed()) wc.send('pty:exit', id, exitCode)
    })
    watchOwner(wc)
    return { id, shell: file }
  })

  // id 不透明,仍按 sender 校验归属:一个窗口拿不到另一个窗口的会话。
  const own = (e: Pick<Electron.IpcMainEvent, 'sender' | 'senderFrame'>, id: string): PtyProc | null => {
    if (!isTrusted(e)) return null
    const s = sessions.get(id)
    return s && s.wc === e.sender ? s.proc : null
  }
  ipcMain.on('pty:write', (e, id: string, data: string) => {
    try { own(e, id)?.write(String(data)) } catch { /* 已退出 */ }
  })
  ipcMain.on('pty:resize', (e, id: string, cols: unknown, rows: unknown) => {
    const s = saneSize(cols, rows)
    try { own(e, id)?.resize(s.cols, s.rows) } catch { /* 已退出 */ }
  })
  ipcMain.on('pty:kill', (e, id: string) => {
    try { own(e, id)?.kill() } catch { /* 已退出 */ }
    if (own(e, id)) sessions.delete(id)
  })
}
