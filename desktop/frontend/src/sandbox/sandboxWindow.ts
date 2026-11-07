/**
 * 插件沙箱 · 沙箱那份 Forsion 的渲染层(主进程那侧见 electron/sandboxChild.ts,契约 tangu-agent/docs/plugin-sandbox.md)。
 *
 *  · 首屏种子(语言、主题、跳过引导)在 seed.ts:它得赶在所有 store 之前,是 main.tsx 的第一个 import;
 *  · installSandboxHook:`window.__forsionSandbox`,主进程经 executeJavaScript 调它:状态 / 跑插件命令 / 开视图 / 重载,
 *    以及 agent 动手用的 read(页面大纲 + 引用)/ locate(找元素给坐标,主进程发真鼠标事件)/ scroll / space / settle;
 *  · 插件第一次装好时落到它带的第一个 Space(没带 Space 就开它的第一个视图),之后每次装载落定都报一次给主进程(父进程那边的卡片跟着变);
 *  · Ribbon 上只放这个插件自己的 Space(pureRibbon),内置 Space 照旧注册、只是不上条。
 *
 * 普通实例里 window.tangu.sandbox 不存在,这里的函数全是 no-op。
 */
import { useRibbonStore, useSpaceStore, useWorkspace, activeMainPanel, addRibbonIcon, removeRibbonIcon, setActiveSpace, label as spaceLabel, type RibbonItem } from '@lcl/engine'
import { useNotifications } from '../stores/notificationStore'
import { useUiStore } from '../amadeus/store/uiStore'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { getDevPluginState, reloadDevPlugin } from '../amadeus/plugins/devSandbox'
import { hiddenSpaceForAgent, hiddenSpacesOf } from '../pluginSpaceHealth'
import { pluginSpaceOwner } from '../stores/spaceProgress'
import { SANDBOX_OUTLINE_BUDGET, type SandboxStatus } from '../../../../tangu-agent/src/contracts/pluginSandbox'

export const sandboxSelf = () => window.tangu?.sandbox?.self ?? null

let loads = 0
let settled = false

type HostFields = 'windowVisible' | 'vault' | 'dialog' | 'filesArmed'
/** 一份状态(形状 = SandboxStatus,主进程补 HostFields,父进程再过一道 parseSandboxStatus)。 */
function status(pluginId: string): Omit<SandboxStatus, HostFields> {
  const self = sandboxSelf()!
  const s = usePluginStore.getState()
  const p = s.plugins.find((x) => x.id === pluginId)
  const dev = getDevPluginState(pluginId)
  const views = s.views.filter((v) => v.pluginId === pluginId).map((v) => v.item.id)
  const hidden = hiddenSpacesOf(pluginId)
  const notListed = settled && !p ? 'the host did not list this plugin (manifest.json id changed, or the folder is no longer a plugin)' : null
  const state: SandboxStatus['state'] = !settled ? 'starting'
    : dev.blocked ? 'blocked'
      : dev.active ? 'running'
        : 'failed'
  return {
    v: 1,
    state,
    pluginId,
    name: p?.name || self.name,
    version: p?.version || self.version,
    dir: self.dir,
    views,
    spaces: [...pluginSpaceOwner].filter(([, owner]) => owner === pluginId).map(([id]) => id),
    hiddenSpaces: hidden.map((h) => ({ slug: h.slug, reason: hiddenSpaceForAgent(pluginId, h) })),
    setupError: dev.setupError || notListed,
    blocked: dev.blocked ? `${dev.blocked}${dev.blockedReason ? `: ${dev.blockedReason}` : ''}` : null,
    mountErrors: dev.mountErrors.map((m) => ({ view: m.viewId, message: m.message })),
    logs: dev.logs.slice(-40).map((l) => ({ level: l.level, text: l.text })),
    warnCount: dev.logs.filter((l) => l.level === 'warn').length,
    errorCount: dev.logs.filter((l) => l.level === 'error').length + dev.mountErrors.length,
    loads,
    activeSpace: useSpaceStore.getState().activeSpaceId || null,
    notices: notices.slice(-8).map(({ level, text }) => ({ level, text })),
  }
}

// ── 提示(toast):插件「保存成功」「出错了」这类反馈多半只在这里,agent 截图慢一拍就看不到 ──
const notices: Array<{ seq: number; level: string; text: string }> = []
let noticeSeq = 0
function watchNotices(): void {
  const seen = new Set<string>()
  useNotifications.subscribe((st) => {
    for (const n of [...st.items, ...st.queue]) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      notices.push({ seq: ++noticeSeq, level: n.level, text: (n.title ? `${n.title}: ${n.text}` : n.text).slice(0, 500) })
      if (notices.length > 20) notices.shift()
    }
    if (seen.size > 500) seen.clear() // ponytail: 清掉后同一条还开着会再记一次,只多一行
  })
  // Amadeus 那套的小提示(useUiStore.notify)不进通知中心,另记
  useUiStore.subscribe((st, prev) => {
    if (!st.toast || st.toast === prev.toast) return
    notices.push({ seq: ++noticeSeq, level: 'info', text: String(st.toast).slice(0, 500) })
    if (notices.length > 20) notices.shift()
  })
}

// ── agent 在沙箱里动手(read / click / type / press / scroll / space)。坐标、真输入事件在主进程(sandboxChild.ts)──
const INTERACTIVE = 'button,a[href],input:not([type=hidden]),textarea,select,summary,[contenteditable=""],[contenteditable=true],'
  + '[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=checkbox],[role=radio],'
  + '[role=switch],[role=option],[role=combobox],[role=textbox],[role=slider],[tabindex]:not([tabindex="-1"])'
/** 沙箱条(报告问题 / 安装 / 重置)不给 agent 点:那几颗是给人的。 */
const CHROME = '.sbx-chrome'
const refs = new Map<string, WeakRef<Element>>()

const clip = (t: string, n = 80): string => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x }
function shown(el: Element): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false
  return el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true
}
function labelOf(el: Element): string {
  const h = el as HTMLElement & { value?: unknown; placeholder?: string }
  const own = el.getAttribute('aria-label') || h.innerText || el.getAttribute('title') || h.placeholder || ''
  return clip(own || (typeof h.value === 'string' ? h.value : ''))
}
const roleOf = (el: Element): string => el.getAttribute('role') || ((el as HTMLElement).isContentEditable ? 'editor' : el.tagName.toLowerCase())
function stateOf(el: Element): string {
  const h = el as HTMLInputElement
  const f: string[] = []
  if (h.disabled || el.getAttribute('aria-disabled') === 'true') f.push('disabled')
  if (h.checked === true || el.getAttribute('aria-checked') === 'true') f.push('checked')
  if (el.getAttribute('aria-selected') === 'true') f.push('selected')
  const ex = el.getAttribute('aria-expanded')
  if (ex) f.push(ex === 'true' ? 'expanded' : 'collapsed')
  if (document.activeElement === el) f.push('focused')
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && h.value) f.push(`value "${clip(String(h.value), 60)}"`)
  return f.length ? ` (${f.join(', ')})` : ''
}

/** target:`e12` = read 给的引用;`css:<选择器>`;其余按看得见的字找(先按控件的名字精确,再包含,最后任意元素的字)。 */
function find(target: string): Element | string {
  const t = target.trim()
  if (/^e\d+$/.test(t)) {
    const el = refs.get(t)?.deref()
    return el?.isConnected ? el : `the reference ${t} is gone (the page changed); read again`
  }
  const ok = (el: Element): boolean => !el.closest(CHROME) && shown(el)
  if (t.startsWith('css:')) {
    let list: Element[]
    try { list = [...document.querySelectorAll(t.slice(4))] } catch { return `"${t.slice(4)}" is not a valid CSS selector` }
    return list.find(ok) ?? `nothing visible matches ${t}`
  }
  const want = t.toLowerCase()
  if (!want) return 'target is empty'
  const controls = [...document.querySelectorAll(INTERACTIVE)].filter(ok)
  const exact = controls.find((el) => labelOf(el).toLowerCase() === want)
  if (exact) return exact
  const area = (el: Element): number => { const r = el.getBoundingClientRect(); return r.width * r.height }
  const loose = controls.filter((el) => labelOf(el).toLowerCase().includes(want)).sort((a, b) => area(a) - area(b))[0]
  if (loose) return loose
  const any = [...document.body.querySelectorAll('*')].filter((el) => ok(el) && clip((el as HTMLElement).innerText ?? '', 400).toLowerCase() === want).sort((a, b) => area(a) - area(b))[0]
  return any ?? `nothing visible says "${clip(t, 80)}"; read the page to get exact names and references`
}

function locate(target: string): { x: number; y: number; label: string; covered?: string } | { error: string } {
  const el = find(target)
  if (typeof el === 'string') return { error: el }
  let r = el.getBoundingClientRect()
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) { el.scrollIntoView({ block: 'center', inline: 'center' }); r = el.getBoundingClientRect() }
  const x = r.left + Math.min(r.width / 2, Math.max(1, r.width - 2)), y = r.top + r.height / 2
  const top = document.elementFromPoint(x, y)
  const label = `${roleOf(el)} "${labelOf(el)}"`
  return top && top !== el && !el.contains(top) && !top.contains(el) ? { x, y, label, covered: `${roleOf(top)} "${labelOf(top)}"` } : { x, y, label }
}

/** 页面大纲:看得见的控件带引用([e3] button "Save"),标题与成段的字只列出来;target 收窄到一块。 */
function read(target: string): { outline: string; count: number } | { error: string } {
  const root = target ? find(target) : document.body
  if (typeof root === 'string') return { error: root }
  refs.clear()
  const lines: string[] = []
  let size = 0
  let n = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (el) => ((el as Element).matches(CHROME) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let el: Element | null = root; el; el = walker.nextNode() as Element | null) {
    let line = ''
    if (el.matches(INTERACTIVE)) {
      if (!shown(el)) continue
      const ref = `e${++n}`
      refs.set(ref, new WeakRef(el))
      line = `[${ref}] ${roleOf(el)} "${labelOf(el)}"${stateOf(el)}`
    } else if (/^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading') {
      if (shown(el)) line = `heading "${clip((el as HTMLElement).innerText ?? '', 120)}"`
    } else if (!el.closest(INTERACTIVE)) {
      const own = [...el.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent ?? '').join(' ')
      if (own.trim() && shown(el)) line = `text "${clip(own, 160)}"`
    }
    if (!line) continue
    if (size + line.length > SANDBOX_OUTLINE_BUDGET - 200) { lines.push('… (cut here; pass a narrower target to read the rest)'); break }
    lines.push(line)
    size += line.length + 1
  }
  return { outline: lines.join('\n'), count: n }
}

function scrollable(el: Element | null): Element | null {
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    const cs = getComputedStyle(e)
    if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e
  }
  return null
}
/** 滚动:target 所在的滚动区(缺省 = 屏上最大的那块滚动区);amount 像素,正数往下。 */
function scroll(target: string, amount: number): { did: string; label: string } | { error: string } {
  let box: Element | null
  if (target) {
    const el = find(target)
    if (typeof el === 'string') return { error: el }
    box = scrollable(el)
  } else {
    box = [...document.body.querySelectorAll('*')].filter((e) => !e.closest(CHROME) && shown(e) && scrollable(e) === e)
      .sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0] ?? null
  }
  if (!box) return { error: 'nothing there scrolls' }
  const before = box.scrollTop
  box.scrollBy({ top: Math.max(-20_000, Math.min(20_000, amount)), behavior: 'instant' as ScrollBehavior })
  const max = box.scrollHeight - box.clientHeight
  return { did: `scrolled ${Math.round(box.scrollTop - before)}px (now ${Math.round(box.scrollTop)} of ${Math.round(max)})`, label: `${roleOf(box)} "${labelOf(box).slice(0, 40)}"` }
}

/** space:切到插件带的那个 Space(按 id 或名字)。 */
function space(pluginId: string, want: string): { did: string; label: string } | { error: string } {
  const own = ownSpaces(pluginId)
  // 配方的名字注册成按语言求值的函数:String() 出来是函数源码(Codex 评审),按引擎的 label() 取
  const sp = useSpaceStore.getState().spaces.find((x) => own.includes(x.id) && (x.id === want || spaceLabel(x.name).toLowerCase() === want.trim().toLowerCase()))
  if (!sp) return { error: `this plugin has no Space "${want}"; its Spaces: ${own.join(', ') || 'none'}` }
  setActiveSpace(sp.id)
  return { did: 'switched Space', label: `${sp.id} "${spaceLabel(sp.name)}"` }
}

/** 选中焦点输入框里原有的字(type 缺省替换)。没有可输入的焦点 = false。 */
function selectFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el || el === document.body) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return true }
  if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r); return true }
  return false
}

const frames = (n: number): Promise<void> => new Promise((resolve) => {
  const step = (k: number): void => { if (k <= 0) resolve(); else requestAnimationFrame(() => step(k - 1)) }
  step(n)
})
/** 等界面落定:DOM 静下来 200ms(最多 1.5s),再等两帧画出来。 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    let quiet = setTimeout(done, 200)
    const cap = setTimeout(done, 1500)
    const mo = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(done, 200) })
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    function done(): void { mo.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve() }
  })
  await frames(2)
}

// 动作之间记一个标:做完回「这期间新写的 console / 新弹的提示」。动作是排队一件件来的(父进程 serial),一个标够用
let mark: { last: unknown; notice: number } | null = null
function begin(pluginId: string): boolean {
  const logs = getDevPluginState(pluginId).logs
  mark = { last: logs[logs.length - 1], notice: noticeSeq }
  return true
}
function end(pluginId: string): { newLogs: Array<{ level: string; text: string }>; newNotices: string[] } {
  const logs = getDevPluginState(pluginId).logs
  const from = mark?.last ? logs.lastIndexOf(mark.last as (typeof logs)[number]) + 1 : 0
  const since = mark?.notice ?? noticeSeq
  mark = null
  return {
    newLogs: logs.slice(from).slice(-15).map((l) => ({ level: l.level, text: l.text.slice(0, 300) })),
    newNotices: notices.filter((x) => x.seq > since).map((x) => x.text),
  }
}

function openView(pluginId: string, view?: string): boolean {
  const s = usePluginStore.getState()
  const own = s.views.filter((v) => v.pluginId === pluginId).map((v) => v.item.id)
  const id = view ? own.find((v) => v === view || `plugin:${pluginId}:${v}` === view) : own[0]
  if (!id || !s.viewOpener) return false
  s.viewOpener(`plugin:${pluginId}:${id}`, undefined, {})
  return true
}

/** 插件命令 = ctx.registerCommand 注册的那些;按命令 id(不带插件前缀)找。 */
async function command(pluginId: string, id: string, args: unknown): Promise<{ ok: boolean; error?: string }> {
  const cmd = usePluginStore.getState().commands.find((c) => c.pluginId === pluginId && (c.item.id === id || `amadeus:${pluginId}:${c.item.id}` === id))
  if (!cmd) {
    const have = usePluginStore.getState().commands.filter((c) => c.pluginId === pluginId).map((c) => c.item.id)
    return { ok: false, error: `no command "${id}"; this plugin registered: ${have.join(', ') || 'none'}` }
  }
  try {
    await (cmd.item.run as (a?: unknown) => unknown)(args && typeof args === 'object' ? args : undefined)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const ownSpaces = (pluginId: string): string[] => [...pluginSpaceOwner].filter(([, owner]) => owner === pluginId).map(([id]) => id)

/** 落脚:插件带了 Space 就进它的第一个,否则把它的第一个视图开出来。 */
function land(pluginId: string): void {
  const sp = ownSpaces(pluginId)[0]
  if (sp) setActiveSpace(sp)
  else openView(pluginId)
}

// 从条上撤下的内置 Space 图标收在这里:插件的 Space 没了(space.json 改坏)主位那一格还得放回来
const stashed = new Map<string, RibbonItem>()
/** 沙箱的 Ribbon 只放被测插件自己的 Space;它一个 Space 都没带就留主位那一格,好歹有地方落脚(11-03 反馈:内置的六七个 Space 挤满了条)。 */
function pureRibbon(pluginId: string): void {
  const mine = new Set(ownSpaces(pluginId))
  const keep = (it: RibbonItem): boolean => !it.id.startsWith('space:') || mine.has(it.id.slice('space:'.length)) || (mine.size === 0 && it.side === 'home')
  for (const it of useRibbonStore.getState().items) if (!keep(it)) { stashed.set(it.id, it); removeRibbonIcon(it.id) }
  for (const [id, it] of stashed) if (keep(it)) { stashed.delete(id); addRibbonIcon(it) }
}

/** 重载时插件视图先被关掉、主区空了会补一个「新建标签页」,视图恢复回来后选中的还是那一页(11-03 台架抓到):
 *  主区停在新建标签页 / 主页上、而插件视图就在旁边时,切回插件视图。 */
function refocusPluginView(pluginId: string): void {
  const api = useWorkspace.getState().api
  if (!api) return
  const typeOf = (p: { params?: unknown }): string => String((p.params as { __type?: unknown } | undefined)?.__type ?? '')
  const cur = activeMainPanel(api)
  if (cur && !['launcher', 'home'].includes(typeOf(cur))) return
  const mine = api.panels.find((p) => (p.params as { __loc?: unknown } | undefined)?.__loc === 'main' && typeOf(p).startsWith(`plugin:${pluginId}:`))
  mine?.api.setActive()
}

/** 再扫一遍 Space 配方:插件重载后它带的 Space 才对得上新视图(插件仓的 reloadOne 不管 Space)。 */
async function rescanSpaces(): Promise<void> {
  const m = await import('../userSpaces')
  await m.loadUserSpaces()
}

/** 主窗口的插件第一次装载落定、Space 配方也扫过之后由 amadeusPlugins 调。 */
export function sandboxPluginsLoaded(): void {
  const self = sandboxSelf()
  if (!self || settled) return
  settled = true
  loads += 1
  pureRibbon(self.pluginId)
  land(self.pluginId)
  window.tangu?.sandbox?.changed()
}

export function installSandboxHook(): void {
  const self = sandboxSelf()
  if (!self) return
  const pid = self.pluginId
  watchNotices()
  pureRibbon(pid)
  // 条目随 Space 注册 / 插件 Space 装卸而变,每变一次对一遍;pureRibbon 自己的增删会再触发一次,那一次什么也不改
  useRibbonStore.subscribe((st, prev) => { if (st.items !== prev.items) pureRibbon(pid) })
  ;(window as unknown as { __forsionSandbox: unknown }).__forsionSandbox = {
    status: () => status(pid),
    command: (id: string, args: unknown) => command(pid, id, args),
    openView: (view?: string) => openView(pid, view),
    read: (target: string) => read(target),
    locate: (target: string) => locate(target),
    scroll: (target: string, amount: number) => scroll(target, amount),
    space: (want: string) => space(pid, want),
    selectFocused,
    frames,
    settle,
    begin: () => begin(pid),
    end: () => end(pid),
    reload: async () => {
      const before = usePluginStore.getState().views.some((v) => v.pluginId === pid)
      const hadSpace = ownSpaces(pid).length > 0
      const wasOn = useSpaceStore.getState().activeSpaceId
      const onMine = ownSpaces(pid).includes(wasOn)
      await reloadDevPlugin(pid).catch((e) => console.warn('[sandbox] reload failed', e))
      await rescanSpaces().catch((e) => console.warn('[sandbox] space rescan failed', e))
      loads += 1
      // 换配方时旧的那份先注销、活动 Space 被挪回 tangu(Codex 评审):还在就回到原来那个插件 Space
      if (onMine && ownSpaces(pid).includes(wasOn) && useSpaceStore.getState().activeSpaceId !== wasOn) setActiveSpace(wasOn)
      // 第一次没装上、这次装上了(或这次才带上 Space):落过去(reloadDevPlugin 只恢复「之前开着的」)
      else if (!before || (!hadSpace && ownSpaces(pid).length)) land(pid)
      else refocusPluginView(pid)
      // 插件 Space 的归属是撤完图标之后才删的,订阅那一刻还算它在:扫完再对一遍,最后一个 Space 没了主位要回来(Codex 评审)
      pureRibbon(pid)
      window.tangu?.sandbox?.changed()
    },
  }
}
