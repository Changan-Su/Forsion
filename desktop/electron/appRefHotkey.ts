/**
 * 全局「双 ⌘ / 双 Ctrl」的主进程那一半:别的应用在前台时按下,也能把那扇窗口引用进聊天输入框。
 * 按键由本机助手(Computer Use helper)监听 —— Electron 注册不了「只有修饰键」的全局快捷键 —— 经一条专用长连接推过来
 * (助手那边的实现与规则见 tangu-computer-use 的 README「全局手势」;macOS 协议 15 起、Windows 的 windows-bridge.exe 同批):
 *   → {"id","cmd":"hotkeySubscribe","gesture":"modPair","excludePids":[本进程]}
 *   ← {"id","ok":true,"result":{"subscribed":true}}            之后每按一次来一行(信封和电脑历史的事件流同一种):
 *   ← {"ev":{"t":<ms>,"kind":"hotkey","gesture":"modPair","front":{…}|null}}
 *      front:macOS {"bundleId","app","pid","windowId","title"};Windows {"exe","path","app","pid","windowId","title"}
 *      别的 kind(写队列溢出时的 system 行)跳过。
 *
 * 纪律:
 *  1. macOS **绝不为了这个快捷键拉起助手**(拉起会带出系统权限框):只连已经在听的 socket,连不上隔一阵再试;
 *     别的功能把助手拉起来之后叫一下 poke(),不必等下一轮。助手升级时会重启,连接断了自己重连。
 *     Windows 没有要授的权限,连不上就拉起一次(target 给了 launch);最后一个订阅者走后助手 60 秒自己退。
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
export function frontToAppRef(
  front: Record<string, unknown>,
  /** 应用标识怎么来:macOS 就是 bundleId;Windows 由 exe 路径算(appRefsWin.winAppIdOf),算不出来回 null。 */
  idOf: (front: Record<string, unknown>) => unknown = (f) => f.bundleId,
): { ref: AppRef; pid: number; windowId: number } | null {
  const id = idOf(front)
  if (!isAppRefId(id)) return null
  const title = typeof front.title === 'string' ? front.title.trim() : ''
  const ref = normalizeAppRef(title ? { kind: 'window', id, name: title } : { kind: 'app', id, name: typeof front.app === 'string' ? front.app : '' })
  return ref && { ref, pid: Number(front.pid) || 0, windowId: Number(front.windowId) || 0 }
}

export interface HotkeyTarget {
  /** 助手的 socket(macOS)/ 命名管道(Windows)。 */
  path: string
  /** 给了 = 连不上时可以把助手拉起来(只有 Windows 给)。 */
  launch?: () => Promise<void>
}

const MAX_LAUNCHES = 3 // 拉起来还是连不上(被安全软件拦 / exe 起不来):试几次就算了,别每半分钟起一个进程

export function createAppRefHotkey(deps: {
  /** 这次连哪里(每次现取:助手的包可能在运行中被换掉);null = 现在没有助手,过一阵再问。 */
  target: () => Promise<HotkeyTarget | null> | HotkeyTarget | null
  ownPid: number
  /** front = 助手报的最前面的窗口;null = 它判断不出来(调用方自己再去问一次)。 */
  onFire: (front: Record<string, unknown> | null) => void
  retryMs?: number
}) {
  let wanted = false
  let dead = false // 助手不认这条命令 / 拉不起来
  let socket: net.Socket | null = null
  let busy = false // 正在取 target / 拉起助手
  let launches = 0
  let attempts = 0 // 连过几次(诊断 / 测试用)
  let timer: ReturnType<typeof setTimeout> | null = null
  const retryMs = deps.retryMs ?? RETRY_MS

  const later = (ms: number): void => {
    if (timer || !wanted || dead) return
    timer = setTimeout(() => { timer = null; void connect() }, ms)
    timer.unref?.()
  }

  async function connect(): Promise<void> {
    if (socket || busy || !wanted || dead) return
    busy = true
    let target: HotkeyTarget | null = null
    try { target = await deps.target() } catch { /* 取不到当没有 */ }
    busy = false
    if (!wanted || dead || socket) return
    if (!target?.path) { later(retryMs); return }
    const s = net.createConnection(target.path)
    socket = s
    attempts++
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
        let msg: { ok?: unknown; error?: { code?: unknown }; ev?: { kind?: unknown; gesture?: unknown; front?: unknown } }
        try { msg = JSON.parse(line) } catch { continue }
        if (!acked) {
          if (msg?.ok === true) { acked = true; launches = 0; continue }
          const code = msg?.error?.code
          if (code === 'unknown_command' || code === 'unknown_gesture') dead = true
          refused = true
          s.destroy()
          return
        }
        const ev = msg?.ev
        if (ev?.kind !== 'hotkey' || ev.gesture !== 'modPair') continue
        deps.onFire(ev.front && typeof ev.front === 'object' ? ev.front as Record<string, unknown> : null)
      }
      if (buf.length > MAX_LINE) s.destroy()
    })
    s.on('error', () => {}) // 连不上 / 断了都走 close
    s.on('close', () => {
      if (socket === s) socket = null
      if (!wanted || dead) return
      // 没连上(助手没在跑)且允许拉起:拉一次,稍后再连
      if (!acked && !refused && target?.launch) {
        if (++launches > MAX_LAUNCHES) { dead = true; return }
        busy = true
        void target.launch().catch(() => {}).then(() => { busy = false; later(Math.min(1_000, retryMs)) }) // 给它一秒把管道建起来
        return
      }
      later(refused ? RETRY_REFUSED_MS : retryMs)
    })
  }

  return {
    /** 界面说要不要这个全局快捷键(用户把它改成别的键、或者解绑了 = 不要)。 */
    setWanted(on: boolean): void {
      wanted = on
      if (on) { void connect(); return }
      if (timer) { clearTimeout(timer); timer = null }
      socket?.destroy()
      socket = null
    },
    /** 助手刚被别的功能拉起来:现在就连,不等下一轮重试。 */
    poke(): void {
      if (socket || !wanted || dead) return
      if (timer) { clearTimeout(timer); timer = null }
      void connect()
    },
    state: (): { wanted: boolean; dead: boolean; connected: boolean; attempts: number } => ({ wanted, dead, connected: !!socket, attempts }),
  }
}
