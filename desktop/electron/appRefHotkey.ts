/**
 * 全局「双 ⌘ / 双 Ctrl」的主进程那一半:别的应用在前台时按下,也能把那扇窗口引用进聊天输入框。
 * 按键由本机助手(Computer Use helper)监听 —— Electron 注册不了「只有修饰键」的全局快捷键 —— 经一条专用长连接推过来:
 *   → {"id","cmd":"hotkeySubscribe","gesture":"modPair","excludePids":[本进程]}
 *   ← {"id","ok":true,"result":{"subscribed":true}}            之后每按一次来一行:
 *   ← {"event":"hotkey","gesture":"modPair","at":<ms>,"front":{"bundleId","app","pid","windowId","title"}}
 *
 * 纪律:
 *  1. **绝不为了这个快捷键拉起助手**(拉起会带出系统权限框):只连已经在听的 socket,连不上隔一阵再试;
 *     别的功能把助手拉起来之后叫一下 poke(),不必等下一轮。
 *  2. 老助手不认这条命令(unknown_command)→ 这次运行不再试。Forsion 自己在前台时窗口内那一半照旧能用。
 *  3. Forsion 在前台时助手不推(excludePids),那一下归窗口内的命令 —— 一次按键不会来两条引用。
 */
import net from 'node:net'
import { isAppRefId, normalizeAppRef, type AppRef } from '../shared/appRefs'

const RETRY_MS = 30_000          // 助手没在跑:本机连一下很便宜
const RETRY_REFUSED_MS = 300_000 // 助手在跑但拒了(没给辅助功能权限):别每半分钟去问一次
const MAX_LINE = 64 * 1024

/** 助手推来的「按键那一刻最前面的窗口」→ 引用(口径同 appRefs.frontmost:没有标题就退成引用那个应用)。
 *  pid / windowId 一并交出:主进程记下这扇窗口,之后它换了标题(浏览器换标签页)也认得。 */
export function frontToAppRef(front: Record<string, unknown>): { ref: AppRef; pid: number; windowId: number } | null {
  const id = front.bundleId
  if (!isAppRefId(id)) return null
  const title = typeof front.title === 'string' ? front.title.trim() : ''
  const ref = normalizeAppRef(title ? { kind: 'window', id, name: title } : { kind: 'app', id, name: typeof front.app === 'string' ? front.app : '' })
  return ref && { ref, pid: Number(front.pid) || 0, windowId: Number(front.windowId) || 0 }
}

export function createAppRefHotkey(deps: {
  /** 助手 socket / 命名管道;空串 = 这个平台没有。 */
  socketPath: () => string
  ownPid: number
  onFire: (front: Record<string, unknown>) => void
  retryMs?: number
}) {
  let wanted = false
  let dead = false // 助手不认这条命令
  let socket: net.Socket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const later = (ms: number): void => {
    if (timer || !wanted || dead) return
    timer = setTimeout(() => { timer = null; connect() }, ms)
    timer.unref?.()
  }

  function connect(): void {
    if (socket || !wanted || dead) return
    const path = deps.socketPath()
    if (!path) return
    const s = net.createConnection(path)
    socket = s
    let buf = ''
    let acked = false
    let refused = false
    s.setEncoding('utf8')
    s.on('connect', () => s.write(`${JSON.stringify({ id: 'appref_hotkey', cmd: 'hotkeySubscribe', gesture: 'modPair', excludePids: [deps.ownPid] })}\n`))
    s.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: { ok?: unknown; error?: { code?: unknown }; event?: unknown; gesture?: unknown; front?: unknown }
        try { msg = JSON.parse(line) } catch { continue }
        if (!acked) {
          if (msg?.ok === true) { acked = true; continue }
          const code = msg?.error?.code
          if (code === 'unknown_command' || code === 'unknown_gesture') dead = true
          refused = true
          s.destroy()
          return
        }
        if (msg?.event === 'hotkey' && msg.gesture === 'modPair' && msg.front && typeof msg.front === 'object') deps.onFire(msg.front as Record<string, unknown>)
      }
      if (buf.length > MAX_LINE) s.destroy()
    })
    s.on('error', () => {}) // 连不上 / 断了都走 close
    s.on('close', () => {
      if (socket === s) socket = null
      later(refused ? RETRY_REFUSED_MS : deps.retryMs ?? RETRY_MS)
    })
  }

  return {
    /** 界面说要不要这个全局快捷键(用户把它改成别的键、或者解绑了 = 不要)。 */
    setWanted(on: boolean): void {
      wanted = on
      if (on) { connect(); return }
      if (timer) { clearTimeout(timer); timer = null }
      socket?.destroy()
      socket = null
    },
    /** 助手刚被别的功能拉起来:现在就连,不等下一轮重试。 */
    poke(): void {
      if (socket || !wanted || dead) return
      if (timer) { clearTimeout(timer); timer = null }
      connect()
    },
    state: (): { wanted: boolean; dead: boolean; connected: boolean } => ({ wanted, dead, connected: !!socket }),
  }
}
