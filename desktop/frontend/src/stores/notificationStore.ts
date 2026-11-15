/**
 * 右上角通知系统(升级自旧 appStore.toast):小卡片从右侧滑入、按序向下堆叠、鼠标悬停暂停、
 * error 常驻手动关;事件级开关 + 插件来源开关在设置「通知与状态栏」里管理(localStorage)。
 * 纯逻辑 store(无 DOM/i18n 依赖):文案由调用方(wiring / appStore.tr / 插件)传入;
 * 渲染在 components/NotificationHost(仅主窗 Root 挂载,与旧 toast-wrap 同决策)。
 *
 * 手机横幅(`banner`,窄屏手机壳由 NotificationHost 打开;桌面 / Pad 不变):一次只显示一条、其余排队(前一条走后
 * PHONE.gap 再出下一条,不显示 +N);停留 5 秒,撤销回执 8 秒,读屏开着 10 秒,常驻 / error 一直留着;同 key 原地换
 * 文案和按钮、不出 ×N、停留从第一次出现起算不顺延;同一来源(event:一个插件 / 宿主的一类提示)一张卡收起后
 * 冷却一段时间不出卡(到点走的 30 秒,用户自己收的 2 分钟),插件照常调、不报错。见 PHONE 与 throttleFree。
 * 一切「不出卡」都不挡系统通知(App 在后台时的横幅):sendOs 先于节流。
 */
import { create } from 'zustand'
import { translate } from '../i18n'

export type NotifyLevel = 'info' | 'success' | 'warning' | 'error'

export interface NotifyInput {
  text: string
  title?: string
  level?: NotifyLevel
  /** 事件类型(设置里按它开关);缺省 'system.generic';插件来源 = 'plugin:<id>'。 */
  event?: string
  /** 来源小字(插件名等),渲染在标题行。 */
  sourceLabel?: string
  /** 相同 key 的通知合并为一条(更新文案 + 计数 + 重置停留),防轰炸。 */
  dedupeKey?: string
  /** 常驻(手动关);缺省 error 常驻、其余按 level 自动消失。 */
  sticky?: boolean
  /** 无视开关强制弹出(仅设置页「发送测试通知」用,预览位置/样式)。 */
  force?: boolean
  action?: { label: string; run(): void }
  /** 自定义停留时长(ms,>0 才生效);缺省按 level。带撤销钮的提示用它留够反应时间(U-06:约 8 秒)。sticky 优先。 */
  durationMs?: number
  /** 只在应用内显示,不跟发系统通知。给「用户刚在本应用里点出来的即时反馈」用 —— 比如从设置浮窗触发的
   *  恢复布局:那一刻主窗恰好没焦点,照常规会多弹一条系统横幅,而用户就在看着这个应用。 */
  inAppOnly?: boolean
  /** 操作回执:用户刚亲手做的动作所附带的撤销入口(如「已恢复默认布局 · 撤销」)。它是那次操作的一部分,
   *  不是一条「通知」—— 不受通知总开关 / 事件开关过滤(关了通知,重置照样清空布局,撤销入口不能跟着没了;
   *  Codex 第一轮 C-2)。隐含 inAppOnly。别拿它给自动事件绕开用户的开关。 */
  receipt?: boolean
  /** 这条提示离开屏幕(到期、点 ×、点动作钮、全部清除)时调一次。撤销型回执靠它决定「到点才真做」:
   *  停留从真正上屏才开始计、悬停会暂停,都跟着这条提示走(排队中 / 悬停时不会提前落定)。去重合并时新值覆盖旧值。 */
  onClose?: () => void
  /** 收尾:把同 dedupeKey 的那条原地换成操作的结果(如日历撤销后的「已撤销」)—— 不算重复(计数回 1),
   *  到点淡出而不是滑走。动作钮要拿掉就同时显式给 `action: undefined`。 */
  settle?: boolean
  /** 顶替:同 dedupeKey 的后一条整条顶掉前一条 —— 计数回 1(不出 ×N),标题、文案、按钮、级别、常驻与停留都换成这一条的,
   *  不沿用前一条;停留从这一刻重新算。插件 `ctx.notify` 带 key 时用它(插件手册承诺「同 key 的后一张顶掉前一张」:
   *  插件自己数件数,比如「(3) 张三：…」,宿主再叠 ×3 就重了;key 也可能管着内容不同的卡,比如手机上合成的那一张)。
   *  顶替的是新的一件事,窗口在后台时照常跟发系统通知(门控同新弹的一条)。宿主自己的去重(防轰炸计数)不带它,照旧累计、不重发。 */
  replace?: boolean
  /** 撤销回执(删了 / 改了之后的「撤销」):手机横幅停 8 秒(缺省 5 秒),也不受手机节流 —— 那是用户刚做的一件事的退路。
   *  插件经 `ctx.notify(msg, { undo: true })` 传进来;宿主的 receipt + action 视同。桌面不看它(桌面按 durationMs / level)。 */
  undo?: boolean
  /** 有人 / Agent 正停着等用户(待批、在问):手机上不受节流。不等于常驻,停留照常。 */
  urgent?: boolean
}

export interface AppNotification {
  id: string
  text: string
  title?: string
  level: NotifyLevel
  event: string
  sourceLabel?: string
  createdAt: number
  sticky: boolean
  count: number
  dedupeKey?: string
  action?: { label: string; run(): void }
  /** 自定义停留时长(见 NotifyInput.durationMs);缺省按 level。补位 / 去重重置停留时都用它。 */
  durationMs?: number
  onClose?: () => void
  settle?: boolean
  undo?: boolean
  urgent?: boolean
  /** 手机节流管不着它(见 throttleFree);同 key 换内容时重算。 */
  free?: boolean
  /** 手机横幅:这张卡上屏的时刻。同 key 换内容时停留从它算起,不顺延。 */
  shownAt?: number
  /** 够格发系统通知、但来的时候 App 在前台没发:排着队等到 App 退到后台才上屏、或在后台被节流丢下时补发一次(见 payOs)。 */
  osOwed?: boolean
}

/** 卡怎么离开的:到点 / 用户点 × 或上滑 / 用户点了卡上的动作。程序自己撤(调用方 dismiss(id))不带。 */
export type DismissReason = 'timeout' | 'user' | 'action'

/** 内置事件注册表(设置页开关列表的数据源;插件事件 plugin:<id> 动态出现,默认开)。 */
export const NOTIFY_EVENTS: Array<{ id: string; labelKey: string; defaultOn: boolean }> = [
  { id: 'system.generic', labelKey: 'ntf.event.system', defaultOn: true },
  { id: 'sync.error', labelKey: 'ntf.event.syncError', defaultOn: true },
  { id: 'sync.done', labelKey: 'ntf.event.syncDone', defaultOn: true }, // 远程同步一轮报告(带变更条数),默认开
  // Amadeus 在线同步每轮完成:后台自动跑、一天几十轮且没有信息量,**默认关**(用户实报「太烦」)。
  // 独立事件 id 而非复用 sync.done —— 否则想关它就得把有用的远程同步报告一起关掉。
  { id: 'sync.doneOnline', labelKey: 'ntf.event.syncDoneOnline', defaultOn: false },
  { id: 'agent.done', labelKey: 'ntf.event.agentDone', defaultOn: true },
  { id: 'inbox.message', labelKey: 'ntf.event.inbox', defaultOn: true },
  { id: 'dm.message', labelKey: 'ntf.event.dmMessage', defaultOn: true },
  // 私聊里有人等你(Muse 问了一句 / 它后台有待批,10-18 方案 B):主动消息另外走 dm.message。
  { id: 'dm.waiting', labelKey: 'ntf.event.dmWaiting', defaultOn: true },
  // 笔记正文 `@remind:2026-09-01T09:00` 到点提醒(见 notificationWiring 的 E 段)。
  { id: 'note.reminder', labelKey: 'ntf.event.noteReminder', defaultOn: true },
  // Historian 自动档提名了工作笔记候选(chat2/HistorianStatus 轮询处接线):点「复盘」就地发 /refine。自动档 09-18 起默认开,在设置 → 特殊 Agent 里可关。
  { id: 'harness.candidates', labelKey: 'ntf.event.harnessCandidates', defaultOn: true },
  // 后台从项目会话里记下、但带网址 / 命令 / 权限字眼的事实:没有直接写进项目记忆,等用户在项目详情里逐条采纳或丢弃。
  { id: 'memory.projectCandidates', labelKey: 'ntf.event.projectCandidates', defaultOn: true },
  // 项目记忆写满、Agent 把它压缩了一遍(有损:合并重复、去掉被取代的):告诉用户,项目详情里能逐句恢复。
  { id: 'memory.projectCompacted', labelKey: 'ntf.event.projectCompacted', defaultOn: true },
]

export function eventDefaultOn(event: string): boolean {
  const def = NOTIFY_EVENTS.find((e) => e.id === event)
  return def ? def.defaultOn : true // 未注册(含 plugin:*)默认开
}

const MAX_VISIBLE = 4
/** 常驻由 sticky 决定；显式 sticky:false 的错误也必须有有限停留时长。 */
const DURATION: Record<NotifyLevel, number> = { success: 3200, info: 5000, warning: 8000, error: 10_000 }
const customDuration = (ms: unknown): number | undefined => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, 120_000) : undefined)
const durationOf = (n: Pick<AppNotification, 'level' | 'durationMs'>): number => n.durationMs ?? DURATION[n.level]

/** 手机横幅的几个数(方案定稿):停留 5 秒,撤销 8 秒,读屏开着 10 秒;前一条走后隔 300ms 出下一条;
 *  同一来源一张卡到点走后冷却 30 秒,用户自己收(上滑 / 点 ×)的冷却 2 分钟。 */
export const PHONE = { dwell: 5000, undo: 8000, reader: 10_000, gap: 300, coolTimeout: 30_000, coolUser: 120_000 } as const
/** 同 key 换内容时停留不顺延,但剩下的不足这么多就补到这么多(刚换上的字至少露一下,和 resume 的下限同一个数)。 */
const MIN_LEFT = 800

/** 不受手机节流的卡:常驻、出错、有人在等(urgent),以及用户自己动作的回执(撤销、receipt、inAppOnly、带 onClose 的、
 *  测试通知 force)—— 节流管的是没人要、自己找上门的那些。`system.generic` 是宿主各处即时反馈的缺省类(「已复制」「保存失败」),
 *  不是「一类提示」,不按来源节流。这些卡收起也不开始冷却。 */
function throttleFree(input: NotifyInput, sticky: boolean, level: NotifyLevel, event: string): boolean {
  return sticky || level === 'error' || !!input.urgent || isUndo(input) || !!input.receipt || !!input.inAppOnly || !!input.force
    || typeof input.onClose === 'function' || event === 'system.generic'
}
const isUndo = (input: NotifyInput): boolean => input.undo === true || (input.receipt === true && !!input.action)

/** 读屏(TalkBack 一类)开着:原生外壳把它写在 <html data-reader>(mobile/src/nativeChrome.ts applyChromeLayout)。 */
function readerOn(): boolean {
  try { return typeof document !== 'undefined' && !!document.documentElement?.hasAttribute('data-reader') } catch { return false }
}

const PREFS_KEY = 'forsion.ntf.prefs'
interface NtfPrefs {
  enabled: boolean
  /** 系统(OS)通知:与应用内通知同步发,窗口在后台时弹。默认开。 */
  osEnabled: boolean
  /** 事件 id → 开关;缺省回落 eventDefaultOn。 */
  events: Record<string, boolean>
}
function readPrefs(): NtfPrefs {
  try {
    const v = localStorage.getItem(PREFS_KEY)
    if (v) return { enabled: true, osEnabled: true, events: {}, ...(JSON.parse(v) as Partial<NtfPrefs>) }
  } catch { /* ignore */ }
  return { enabled: true, osEnabled: true, events: {} }
}
function writePrefs(p: NtfPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* ignore */ }
}

interface NtfState {
  /** 可见堆叠(时间序:最旧在上,新的排下面;最上面的先到期消失,下面自动上移补位)。手机横幅下最多一条。 */
  items: AppNotification[]
  /** 溢出队列(同屏超过 MAX_VISIBLE 条时排队,腾位后按序顶上)。 */
  queue: AppNotification[]
  prefs: NtfPrefs
  paused: boolean
  /** 手机横幅(窄屏手机壳;NotificationHost 打开 / 关上):一次一条、手机停留、同 key 不顺延、同一来源节流。 */
  banner: boolean
  notify(input: NotifyInput): string | null
  dismiss(id: string, reason?: DismissReason): void
  /** 点了卡上的动作(按钮 / 手机横幅的正文):跑动作;动作没把这条换成别的(settle)就收起。 */
  activate(id: string): void
  dismissAll(): void
  setEnabled(on: boolean): void
  setOsEnabled(on: boolean): void
  setEventOn(event: string, on: boolean): void
  setBanner(on: boolean): void
  pause(): void
  resume(): void
}

/** 手机上每个请求都是出网的:断网时各处把浏览器的原话(`Failed to fetch`)原样、或拼在自己那句后面交过来。
 *  那几个词对用户没有信息量,在出口统一换成一句人话。只在手机上换:桌面连的是本机引擎,连不上不等于没网。 */
function plainNetworkError(text: string): string {
  if (typeof window === 'undefined' || !window.tangu?.mobile || !/Failed to fetch/i.test(text)) return text
  return text.replace(/(?:TypeError:\s*)?Failed to fetch/gi, translate('net.unavailable'))
}

// 定时器簿记(React/zustand 外):active = {handle,deadline};paused = {handle:null,remaining}。
type TimerRec = { handle: ReturnType<typeof setTimeout> | null; deadline: number; remaining: number }
const timers = new Map<string, TimerRec>()
function clearTimer(id: string): void {
  const t = timers.get(id)
  if (t?.handle) clearTimeout(t.handle)
  timers.delete(id)
}
let seq = 0

// 手机横幅的簿记:来源 → 冷却到哪一刻;前一条走后的间隔(到点才出下一条)。
const cooldown = new Map<string, number>()
let gapTimer: ReturnType<typeof setTimeout> | null = null
let gapUntil = 0
const cooling = (event: string): boolean => (cooldown.get(event) ?? 0) > Date.now()

/** 测试用:清掉冷却与间隔(模块级簿记,store 的 setState 碰不到)。 */
export function resetNotificationThrottle(): void {
  cooldown.clear()
  if (gapTimer) clearTimeout(gapTimer)
  gapTimer = null
  gapUntil = 0
}

export const useNotifications = create<NtfState>((set, get) => {
  const startTimer = (id: string, ms: number): void => {
    clearTimer(id)
    if (ms <= 0) return
    if (get().paused) {
      timers.set(id, { handle: null, deadline: 0, remaining: ms })
      return
    }
    timers.set(id, { handle: setTimeout(() => get().dismiss(id, 'timeout'), ms), deadline: Date.now() + ms, remaining: 0 })
  }

  /** 停留多久。桌面:按 durationMs / level。手机横幅:读屏 10 秒 > 收尾(settle)按调用方给的 > 撤销 8 秒 > 5 秒。 */
  const dwellOf = (n: AppNotification): number => {
    if (!get().banner) return durationOf(n)
    if (readerOn()) return PHONE.reader
    if (n.settle && n.durationMs) return n.durationMs
    return n.undo ? PHONE.undo : PHONE.dwell
  }

  const closed = (n: AppNotification | undefined): void => {
    try { n?.onClose?.() } catch { /* 回调抛错不砸通知栈 */ }
  }

  /** 手机横幅:一条上屏(记下上屏时刻,非常驻的开始计时)。 */
  const showBanner = (n: AppNotification, queue: AppNotification[]): void => {
    payOs(n)
    // 上了屏就不再欠:用户在前台看到了,或者刚补发过。常驻那张让位后再回来、宽屏的卡收进队列,都不再发第二次
    const shown = { ...n, shownAt: Date.now(), osOwed: undefined }
    set({ items: [shown], queue })
    if (!shown.sticky) startTimer(shown.id, dwellOf(shown))
  }

  /** 手机横幅:屏上空着、间隔已过 → 下一条上屏;冷却中的(节流管得着的)直接丢掉(onClose 照调,在后台就补发系统通知)。
   *  常驻的排在所有不常驻的后面:让过位的常驻一回来就不走了,它后面排着的会永远出不来。 */
  const promoteBanner = (): void => {
    gapTimer = null
    const s = get()
    if (!s.banner || s.items.length) return
    const dropped: AppNotification[] = []
    let next: AppNotification | undefined
    for (const nx of s.queue) {
      if (nx.sticky) continue
      if (!nx.free && cooling(nx.event)) dropped.push(nx)
      else { next = nx; break }
    }
    next ??= s.queue.find((nx) => nx.sticky)
    const queue = s.queue.filter((nx) => nx !== next && !dropped.includes(nx))
    if (next) showBanner(next, queue)
    else if (queue.length !== s.queue.length) set({ queue })
    for (const d of dropped) { payOs(d); closed(d) }
  }

  /** 前一条刚走:隔 PHONE.gap 再出下一条(原生横幅的退场 160ms 走完,两张不叠)。 */
  const scheduleGap = (): void => {
    gapUntil = Date.now() + PHONE.gap
    if (gapTimer) clearTimeout(gapTimer)
    gapTimer = setTimeout(promoteBanner, PHONE.gap)
  }

  // 系统通知:与应用内通知同步发(所有事件,不止收件箱);仅窗口在后台时(前台已有卡片,免重复横幅);
  // osEnabled 门控。web 无 window.tangu.notify → 可选链忽略(安卓有:mobile/src/liveIsland.ts)。
  // inAppOnly / receipt:调用方声明这是应用内即时反馈(见 NotifyInput.inAppOnly),不跟发。
  // 「在后台」:桌面 = 窗口失焦。安卓 WebView 退到后台后 hasFocus() 仍是 true(模拟器实测),那里只有可见性说真话;
  // 桌面上看不见的窗口本来就没有焦点,多看这一项不改变它的行为。
  // 谁调:新弹的一条;以及 replace 顶掉同 key 的前一条(那是新的一件事,只是借同一张卡显示 —— 比如手机上插件把几件合成一张、
  // 上一张还停着时又来一件,不发的话 App 在后台时这一件就没有横幅)。宿主自己的去重合并(防轰炸计数)不重发。
  // 手机节流挡的只是应用内的卡:被节流的这一条照样走到这里(调用在节流判断之前)。
  const away = (): boolean => typeof document !== 'undefined' && (!document.hasFocus() || document.visibilityState === 'hidden')
  const postOs = (n: Pick<AppNotification, 'title' | 'sourceLabel' | 'text'>, event: string): void => {
    try { window.tangu?.notify?.(n.title || n.sourceLabel || 'Forsion', n.text, { event }) } catch { /* 无桥/web 忽略 */ }
  }
  /** 返回这次有没有发出去;够格(不是 inAppOnly / receipt)却因为 App 在前台没发的,由调用方记成 osOwed。 */
  const sendOs = (input: NotifyInput, n: Pick<AppNotification, 'title' | 'sourceLabel' | 'text'>, event: string): boolean => {
    if (input.inAppOnly || input.receipt || !get().prefs.osEnabled) return false
    if (!away()) return false
    postOs(n, event)
    return true
  }
  const owesOs = (input: NotifyInput): boolean => !input.inAppOnly && !input.receipt
  /** 手机横幅一次一条:排在队里的卡,来时 App 在前台(没发系统通知),等它上屏或被节流丢下时 App 已经在后台 ——
   *  用户两边都看不到它。这时补发一次(门控同 sendOs:系统通知开关 + 在后台)。返回补发了没有。 */
  const payOs = (n: AppNotification): boolean => {
    if (!n.osOwed || !get().prefs.osEnabled || !away()) return false
    postOs(n, n.event)
    return true
  }

  return {
    items: [],
    queue: [],
    prefs: readPrefs(),
    paused: false,
    banner: false,

    notify: (input) => {
      const level: NotifyLevel = input.level && ['info', 'success', 'warning', 'error'].includes(input.level) ? input.level : 'info'
      const event = input.event ?? 'system.generic'
      const st = get()
      if (!input.force && !input.receipt) {
        if (!st.prefs.enabled) return null
        if (!(st.prefs.events[event] ?? eventDefaultOn(event))) return null
      }
      const sticky = input.sticky ?? level === 'error'
      const durationMs = customDuration(input.durationMs)
      const text = plainNetworkError(String(input.text ?? '')).slice(0, 500) // 防插件超长字符串撑爆卡片
      const title = input.title ? String(input.title).slice(0, 120) : undefined
      const undo = isUndo(input) || undefined
      const urgent = input.urgent === true || undefined

      // 去重合并:同 dedupeKey 更新原条(计数 + 文案 + 重置停留),可见或排队中皆然。replace:整条换成这一条,计数回 1。
      if (input.dedupeKey) {
        const found = st.items.find((n) => n.dedupeKey === input.dedupeKey) || st.queue.find((n) => n.dedupeKey === input.dedupeKey)
        if (found) {
          const visible = st.items.some((n) => n.id === found.id)
          const upd: AppNotification = input.replace
            ? {
                ...found, text, title, level, sourceLabel: input.sourceLabel ?? found.sourceLabel, count: 1, settle: input.settle,
                createdAt: Date.now(), sticky, action: input.action, durationMs, onClose: input.onClose ?? found.onClose,
              }
            : {
                ...found, text, title: title ?? found.title, level, count: input.settle ? 1 : found.count + 1, settle: input.settle,
                createdAt: Date.now(), sticky: input.sticky ?? (input.settle || level !== found.level ? sticky : found.sticky), action: 'action' in input ? input.action : found.action, // 显式给了(含 undefined)就换,没给才沿用
                durationMs: durationMs ?? found.durationMs, onClose: input.onClose ?? found.onClose,
              }
          upd.undo = undo
          upd.urgent = urgent
          upd.free = throttleFree({ ...input, onClose: upd.onClose }, upd.sticky, upd.level, upd.event)
          if (st.banner) upd.count = 1 // 手机:同 key 直接换文案和按钮,不出 ×N
          // 顶替是新的一件事:跟发系统通知;在前台没发的记下,它若还排着队、等到后台才上屏 / 被丢下时补发
          if (input.replace) upd.osOwed = (!sendOs(input, upd, event) && owesOs(input) && !visible) || undefined
          set((s) => ({
            items: s.items.map((n) => (n.id === found.id ? upd : n)),
            queue: s.queue.map((n) => (n.id === found.id ? upd : n)),
          }))
          if (visible) {
            if (upd.sticky) clearTimer(found.id)
            else if (!st.banner) startTimer(found.id, durationOf(upd))
            // 手机:停留从第一次上屏起算、不顺延。例外:收尾(settle,用户点撤销后的结果)与撤销回执(又删了一个,新的退路)
            // 重新计满;原来常驻的变成不常驻也计满(它本来没有到点)。
            else if (input.settle || upd.undo || found.sticky || !found.shownAt) {
              upd.shownAt = Date.now()
              set((s) => ({ items: s.items.map((n) => (n.id === found.id ? { ...n, shownAt: upd.shownAt } : n)) }))
              startTimer(found.id, dwellOf(upd))
            } else startTimer(found.id, Math.max(MIN_LEFT, found.shownAt + dwellOf(upd) - Date.now()))
          }
          return found.id
        }
      }

      const n: AppNotification = {
        id: `ntf-${++seq}-${Date.now()}`, text, title, level, event,
        sourceLabel: input.sourceLabel, createdAt: Date.now(), sticky, count: 1,
        dedupeKey: input.dedupeKey, action: input.action, durationMs, onClose: input.onClose, settle: input.settle,
        undo, urgent, free: throttleFree(input, sticky, level, event),
      }
      // 系统通知(见 sendOs);非 replace 的去重合并上面已经 return,不重发。先于手机节流:后台的横幅不受它管
      if (!sendOs(input, n, event) && owesOs(input)) n.osOwed = true

      if (st.banner) {
        // 手机节流:同一来源刚收起过一张,冷却期间不出卡(插件照常调,不报错;不该出的卡也就没有 onClose 可等:它们都 free)
        if (!n.free && cooling(event)) return null
        const vis = st.items[0]
        if (vis?.sticky) {
          // 常驻的那张让一让:新来的先上,它排回新来的后面,等新来的走了再回来(不然一张常驻就把后面的全堵住)
          clearTimer(vis.id)
          set({ items: [], queue: [n, vis, ...st.queue] })
          scheduleGap()
        } else if (!vis && Date.now() >= gapUntil && !st.queue.length) {
          showBanner(n, st.queue)
        } else {
          // 排队:有人在等的(urgent)排到不急的前面,其余先来后到
          const at = n.urgent ? st.queue.findIndex((q) => !q.urgent) : -1
          const queue = at < 0 ? [...st.queue, n] : [...st.queue.slice(0, at), n, ...st.queue.slice(at)]
          set({ queue })
          if (!vis && !gapTimer) scheduleGap()
        }
        return n.id
      }

      if (st.items.length < MAX_VISIBLE) {
        set((s) => ({ items: [...s.items, n] }))
        if (!sticky) startTimer(n.id, durationOf(n))
      } else {
        set((s) => ({ queue: [...s.queue, n] }))
      }
      return n.id
    },

    dismiss: (id, reason) => {
      clearTimer(id)
      const s = get()
      const gone = s.items.find((n) => n.id === id) || s.queue.find((n) => n.id === id)
      let items = s.items.filter((n) => n.id !== id)
      let queue = s.queue.filter((n) => n.id !== id)
      if (items.length === s.items.length && queue.length === s.queue.length) return
      if (s.banner) {
        const wasShown = items.length !== s.items.length
        set({ items, queue })
        if (wasShown) {
          // 同一来源冷却:到点 / 点了动作 30 秒,用户自己收的 2 分钟。程序自己撤的(没有 reason)与节流管不着的卡不算。
          if (reason && gone && !gone.free) cooldown.set(gone.event, Date.now() + (reason === 'user' ? PHONE.coolUser : PHONE.coolTimeout))
          scheduleGap()
        }
        closed(gone)
        return
      }
      // 补位:队列头按序顶上(保持时间序,最上面的仍是最旧)。
      const promoted: AppNotification[] = []
      while (items.length < MAX_VISIBLE && queue.length) {
        const nx = queue[0]
        queue = queue.slice(1)
        items = [...items, nx]
        promoted.push(nx)
      }
      set({ items, queue })
      for (const nx of promoted) if (!nx.sticky) startTimer(nx.id, durationOf(nx))
      closed(gone)
    },

    activate: (id) => {
      // 也找队列:手机上常驻的那张可能刚被新来的顶回队列(点按还在路上,或它的动作自己弹了一条新的)
      const find = (): AppNotification | undefined => get().items.find((x) => x.id === id) ?? get().queue.find((x) => x.id === id)
      const n = find()
      if (!n?.action) return
      const before = n.action
      try { n.action.run() } catch { /* 插件 action 抛错不砸宿主 */ }
      // 动作自己把这条换成了结果(日历撤销 → 「已撤销」,settle):留着,到点淡出
      if (find()?.action === before) get().dismiss(id, 'action')
    },

    dismissAll: () => {
      for (const id of [...timers.keys()]) clearTimer(id)
      if (gapTimer) clearTimeout(gapTimer)
      gapTimer = null
      gapUntil = 0
      const { items, queue } = get()
      set({ items: [], queue: [] })
      for (const n of [...items, ...queue]) closed(n)
    },

    setEnabled: (on) => {
      const prefs = { ...get().prefs, enabled: on }
      set({ prefs })
      writePrefs(prefs)
    },

    setOsEnabled: (on) => {
      const prefs = { ...get().prefs, osEnabled: on }
      set({ prefs })
      writePrefs(prefs)
    },

    setEventOn: (event, on) => {
      const prefs = { ...get().prefs, events: { ...get().prefs.events, [event]: on } }
      set({ prefs })
      writePrefs(prefs)
    },

    // 横幅 ↔ 堆叠(旋转、分屏把窗口拉宽 / 收窄):横幅只留最早那条,其余按序回到队首;回到堆叠时队列按序补满。
    setBanner: (on) => {
      const s = get()
      if (on === s.banner) return
      if (on) {
        const [first, ...rest] = s.items
        for (const r of rest) clearTimer(r.id)
        // 宽屏时已经在屏上的那几张用户看过了:收回队列也不再欠系统通知
        const seen = rest.map((r) => ({ ...r, osOwed: undefined }))
        set({ banner: true, items: first ? [{ ...first, shownAt: first.shownAt ?? Date.now(), osOwed: undefined }] : [], queue: [...seen, ...s.queue] })
        if (!first && s.queue.length) scheduleGap()
        return
      }
      if (gapTimer) clearTimeout(gapTimer)
      gapTimer = null
      gapUntil = 0
      let items = s.items
      let queue = s.queue
      const promoted: AppNotification[] = []
      while (items.length < MAX_VISIBLE && queue.length) {
        promoted.push(queue[0])
        items = [...items, queue[0]]
        queue = queue.slice(1)
      }
      set({ banner: false, items, queue })
      for (const nx of promoted) if (!nx.sticky) startTimer(nx.id, durationOf(nx))
    },

    // 鼠标悬停暂停(NotificationHost 只在 pointerType === 'mouse' 时调;触屏点按不暂停):冻结全部在飞定时器记剩余;移出后续走剩余(下限 800ms,防恢复即消失)。
    pause: () => {
      if (get().paused) return
      set({ paused: true })
      for (const [id, t] of timers) {
        if (t.handle) {
          clearTimeout(t.handle)
          timers.set(id, { handle: null, deadline: 0, remaining: Math.max(800, t.deadline - Date.now()) })
        }
      }
    },
    resume: () => {
      if (!get().paused) return
      set({ paused: false })
      for (const [id, t] of timers) {
        if (!t.handle) {
          const ms = t.remaining || 1500
          timers.set(id, { handle: setTimeout(() => get().dismiss(id, 'timeout'), ms), deadline: Date.now() + ms, remaining: 0 })
        }
      }
    },
  }
})

/** 便捷入口(store 外调用:appStore.toast 垫片 / wiring / 插件宿主)。 */
export const notifyApp = (input: NotifyInput): string | null => useNotifications.getState().notify(input)
