/**
 * 插件沙箱 · 沙箱那份 Forsion 的渲染层(主进程那侧见 electron/sandboxChild.ts,契约 tangu-agent/docs/plugin-sandbox.md)。
 *
 *  · 首屏种子(语言、主题、跳过引导)在 seed.ts:它得赶在所有 store 之前,是 main.tsx 的第一个 import;
 *  · installSandboxHook:`window.__forsionSandbox`,主进程经 executeJavaScript 调它:状态 / 跑插件命令 / 开视图 / 重载,
 *    以及 agent 动手用的 read(页面大纲 + 引用)/ locate(找元素给坐标,主进程发真鼠标事件)/ scroll / space / settle;
 *  · 插件第一次装好时落到它带的第一个 Space(没带 Space 就开它的第一个视图),之后每次装载落定都报一次给主进程(父进程那边的卡片跟着变);
 *  · Ribbon 上只放这个插件自己的 Space(pureRibbon),内置 Space 照旧注册、只是不上条。
 *  · 11-15 起设置窗口(独立的浮动面板)里也装这个钩子:agent 经 settings 动作打开「设置 → 插件 → 本插件」,再按 window 选窗口动手。
 *    主窗的引用叫 e12,设置窗口的叫 s12:引用只在给出它的那扇窗里有效,前缀不对就报错,不去点另一扇窗里同号的元素。
 *
 * 普通实例里 window.tangu.sandbox 不存在,这里的函数全是 no-op。
 */
import { useRibbonStore, useSpaceStore, useWorkspace, activeMainPanel, addRibbonIcon, removeRibbonIcon, setActiveSpace, label as spaceLabel, type RibbonItem } from '@lcl/engine'
import { useNotifications } from '../stores/notificationStore'
import { useUiStore } from '../amadeus/store/uiStore'
import { pluginSetupSettled, usePluginStore } from '../amadeus/plugins/pluginStore'
import { getDevPluginState, reloadDevPlugin } from '../amadeus/plugins/devSandbox'
import { recordDevLog } from '../amadeus/plugins/devRecords'
import { hiddenSpaceForAgent, hiddenSpacesOf } from '../pluginSpaceHealth'
import { pluginSpaceOwner } from '../stores/spaceProgress'
import { windowKind } from '../windowKind'
import { SANDBOX_OUTLINE_BUDGET, type SandboxStatus } from '../../../../tangu-agent/src/contracts/pluginSandbox'

export const sandboxSelf = () => window.tangu?.sandbox?.self ?? null

let loads = 0
let settled = false

type HostFields = 'windowVisible' | 'vault' | 'dialog' | 'filesArmed' | 'installed'
/** 一份状态(形状 = SandboxStatus,主进程补 HostFields,父进程再过一道 parseSandboxStatus)。 */
function status(pluginId: string): Omit<SandboxStatus, HostFields> {
  const self = sandboxSelf()!
  if (self.stage) return stageStatus(self.stage.plugins)
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

/** 演示舞台的状态:没有开发副本;就绪 = 点名的插件都列出来、装载落定。有没装上的 / setup 抛了的 → failed,setupError 写明是谁。 */
function stageStatus(want: string[]): Omit<SandboxStatus, HostFields> {
  const self = sandboxSelf()!
  const s = usePluginStore.getState()
  const listed = (id: string) => s.plugins.find((p) => p.id === id)
  const missing = settled ? want.filter((id) => !listed(id)) : []
  const inactive = settled ? want.filter((id) => listed(id) && !s.activeIds.includes(id)) : []
  const errors = settled ? want.filter((id) => s.lastSetupError[id]).map((id) => `${id}: ${s.lastSetupError[id]}`) : []
  const pending = want.some((id) => s.activeIds.includes(id) && !pluginSetupSettled(id) && !s.lastSetupError[id])
  const problems = [
    ...(missing.length ? [`not installed in the stage: ${missing.join(', ')}`] : []),
    ...(inactive.length ? [`did not start in the stage (disabled or missing a dependency): ${inactive.join(', ')}`] : []),
    ...errors,
  ]
  return {
    v: 1,
    state: !settled || pending ? 'starting' : problems.length ? 'failed' : 'running',
    pluginId: self.pluginId, name: self.name, version: self.version, dir: self.dir,
    views: [], spaces: [], hiddenSpaces: [],
    setupError: problems.length ? problems.join('; ').slice(0, 1000) : null,
    blocked: null, mountErrors: [], logs: [], warnCount: 0, errorCount: 0,
    loads,
    activeSpace: useSpaceStore.getState().activeSpaceId || null,
    notices: notices.slice(-8).map(({ level, text }) => ({ level, text })),
  }
}

// ── 演示舞台:截图区域、录像、录像里的假指针(主进程 sandboxChild.ts 经钩子调) ──
/** 选择器 → 舞台窗口里的 CSS 像素矩形(截图用)。找不到 / 不可见 → error。 */
function rectOf(selector: string): { x: number; y: number; width: number; height: number } | { error: string } {
  let el: Element | null = null
  try { el = document.querySelector(selector) } catch { return { error: `"${selector}" is not a valid CSS selector` } }
  if (!el) return { error: `nothing matches "${selector}" in the stage window` }
  const r = el.getBoundingClientRect()
  const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top))
  const width = Math.min(innerWidth, Math.ceil(r.right)) - x, height = Math.min(innerHeight, Math.ceil(r.bottom)) - y
  if (width < 1 || height < 1) return { error: `"${selector}" is not visible in the stage window` }
  return { x, y, width, height }
}

const CURSOR_ID = '__forsion-stage-cursor'
function cursorEl(): HTMLElement {
  let el = document.getElementById(CURSOR_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = CURSOR_ID
  el.setAttribute('aria-hidden', 'true')
  // 只是画给录像看的:不接点击、不进读屏、压在最上面
  el.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:calc(var(--z-stage-overlay, 2147483646) + 1);pointer-events:none;transform:translate(-40px,-40px);transition:transform 320ms cubic-bezier(.3,.7,.2,1);will-change:transform'
  el.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.4 19.1 L10.4 12.6 L16.6 12.6 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  document.body.appendChild(el)
  return el
}
let cursorAt: { x: number; y: number } | null = null
/** 假指针挪到 (x, y),等它到位再回(主进程接着发真点击);点下去时一圈涟漪。 */
async function cursorTo(x: number, y: number): Promise<void> {
  const el = cursorEl()
  const far = !cursorAt || Math.hypot(x - cursorAt.x, y - cursorAt.y) > 4
  el.style.transform = `translate(${x - 3}px, ${y - 2}px)`
  cursorAt = { x, y }
  if (far) await new Promise((r) => setTimeout(r, 360))
  const ring = document.createElement('div')
  ring.setAttribute('aria-hidden', 'true')
  ring.style.cssText = `position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(17,17,17,.55);z-index:var(--z-stage-overlay, 2147483646);pointer-events:none;transition:transform 420ms ease-out,opacity 420ms ease-out`
  document.body.appendChild(ring)
  requestAnimationFrame(() => { ring.style.transform = 'scale(1.6)'; ring.style.opacity = '0' })
  setTimeout(() => ring.remove(), 500)
}

/** pausedMs / pausedAt:暂停的时长不算进 durationMs,也不算进 maxMs(到点自停只数录下来的时间)。 */
type Recording = { rec: MediaRecorder; chunks: Blob[]; started: number; ext: 'mp4' | 'webm'; mime: string; width: number; height: number; stopped: Promise<void>; timer: ReturnType<typeof setTimeout>; tick: () => void; maxMs: number; pausedMs: number; pausedAt: number | null; endedMs: number | null }
let recording: Recording | null = null
/** 录下来的时长(扣掉暂停)。录像停了(到点自停 / 轨道断了)就定格在停的那一刻,取片晚了也不涨。 */
function activeMs(r: Recording, now = performance.now()): number {
  return r.endedMs ?? now - r.started - r.pausedMs - (r.pausedAt !== null ? now - r.pausedAt : 0)
}
/** 到点自停:先定格时长再停。 */
function limitStop(r: Recording): void {
  if (r.rec.state === 'inactive') return
  r.endedMs ??= activeMs(r)
  r.rec.stop()
}

/** 页签录制只在画面有变化时出帧:窗口静着的那几秒没有帧,录出来的视频比实际短、结尾停住的画面被截掉(11-20 台架实测 2.6 秒录成 1.8 秒)。
 *  录着的时候在右下角放一块 2px、透明度只有 1/255 上下的小块,每帧换一下,让窗口一直出帧(肉眼看不见,截图里也看不出)。 */
function startFrameTicker(): () => void {
  const el = document.createElement('div')
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:var(--z-stage-overlay, 2147483646);pointer-events:none'
  document.body.appendChild(el)
  let on = true
  let raf = 0
  const step = (): void => { el.style.background = (on = !on) ? 'rgba(0,0,0,0.004)' : 'rgba(0,0,0,0.008)'; raf = requestAnimationFrame(step) }
  raf = requestAnimationFrame(step)
  return () => { cancelAnimationFrame(raf); el.remove() }
}
/** 录本页签:主进程那头把这个顶层 frame 交给 getDisplayMedia(不录屏幕、不要系统权限);尺寸 = 窗口像素(上限 3840 宽,Chromium 页签录制的帽)。 */
async function recordStart(o: { fps: number; maxMs: number; cursor: boolean; format: 'mp4' | 'webm' }): Promise<{ mime: string } | { error: string }> {
  if (recording) return { error: 'already recording' }
  const W = Math.round(innerWidth * devicePixelRatio), H = Math.round(innerHeight * devicePixelRatio)
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: o.fps, width: { ideal: W, max: W }, height: { ideal: H, max: H } }, audio: false })
  } catch (e) {
    return { error: `could not start recording the stage window: ${e instanceof Error ? e.message : String(e)}` }
  }
  const prefer = o.format === 'webm' ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
  const mime = prefer.find((t) => MediaRecorder.isTypeSupported(t))
  if (!mime) { stream.getTracks().forEach((t) => t.stop()); return { error: 'this Forsion cannot encode video' } }
  // 码率上限 16 Mbit/s:2880×1800@30 够清楚,120 秒封顶约 240 MB(整段经 IPC 交给主进程落盘)
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(16e6, Math.max(4e6, W * H * o.fps * 0.08)) })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  let self: Recording | null = null
  const stopped = new Promise<void>((r) => { rec.onstop = () => { if (self) self.endedMs ??= activeMs(self); stream.getTracks().forEach((t) => t.stop()); r() } })
  const st = stream.getVideoTracks()[0]?.getSettings() ?? {}
  const tick = startFrameTicker()
  rec.start(1000)
  if (o.cursor) cursorEl()
  const r: Recording = self = recording = {
    rec, chunks, started: performance.now(), ext: mime.includes('mp4') ? 'mp4' : 'webm', mime: mime.split(';')[0],
    width: Number(st.width) || W, height: Number(st.height) || H, stopped,
    timer: setTimeout(() => {}, 0),
    tick, maxMs: o.maxMs, pausedMs: 0, pausedAt: null, endedMs: null,
  }
  // 到点自己停:recordStop 照样拿得到这一段
  r.timer = setTimeout(() => limitStop(r), o.maxMs)
  return { mime: r.mime }
}
/** 暂停 / 继续(11-26):插件把等待、准备动作剪出成片。暂停期间 MediaRecorder 不收帧,补帧小块照跑也不进视频。 */
function recordPause(): { ok: true } | { error: string } {
  const r = recording
  if (!r || r.rec.state === 'inactive') return { error: 'not recording' }
  if (r.rec.state === 'paused') return { error: 'the recording is already paused' }
  // 渲染层忙过了到点那一刻、暂停先于自停到达:不许暂停把唯一的计时器清掉,按到点处理
  if (activeMs(r) >= r.maxMs) { limitStop(r); return { error: 'the recording reached its length limit and stopped' } }
  r.rec.pause()
  r.pausedAt = performance.now()
  clearTimeout(r.timer)
  return { ok: true }
}
function recordResume(): { ok: true } | { error: string } {
  const r = recording
  if (!r || r.rec.state === 'inactive') return { error: 'not recording' }
  if (r.rec.state !== 'paused' || r.pausedAt === null) return { error: 'the recording is not paused' }
  const now = performance.now()
  r.pausedMs += now - r.pausedAt
  r.pausedAt = null
  r.rec.resume()
  r.timer = setTimeout(() => limitStop(r), Math.max(0, r.maxMs - activeMs(r, now)))
  return { ok: true }
}
async function recordStop(): Promise<Record<string, unknown>> {
  const r = recording
  if (!r) return { error: 'not recording' }
  recording = null
  clearTimeout(r.timer)
  r.endedMs ??= activeMs(r)
  if (r.rec.state !== 'inactive') r.rec.stop()
  await r.stopped
  r.tick()
  const durationMs = Math.round(r.endedMs)
  document.getElementById(CURSOR_ID)?.remove()
  cursorAt = null
  const bytes = await new Blob(r.chunks, { type: r.mime }).arrayBuffer()
  const path = await window.tangu?.sandbox?.saveRecording?.(bytes, r.ext)
  if (!path) return { error: 'the recording could not be saved' }
  return { path, mime: r.mime, width: r.width, height: r.height, durationMs }
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
/** 沙箱条(报告问题 / 安装 / 重置)、报告框、首次说明不给 agent 读和点:那几块是给人的(SandboxChrome.tsx 打 data-sbx-host)。
 *  11-20 起沙箱条住进引擎的右上角浮钮组,不再有外层 .sbx-chrome;按属性认,别改回按类名。 */
const CHROME = '[data-sbx-host]'
/** 宿主右上角的通知栈(插件 ctx.notify 也弹在这里):卡片压在目标上时先关掉再点(底部吐司 .amx-toast 不接指针,不挡)。 */
const TOASTS = '.ntf-wrap'
const refs = new Map<string, WeakRef<Element>>()
/** 引用前缀:主窗 e、设置窗口(浮动面板)s。 */
const REF = windowKind() === 'main' ? 'e' : 's'

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
/** 收字的控件(只读只对它们有意义;编辑器里 contenteditable=false 的节点包装不算)。 */
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const textEntry = (el: Element): boolean => el.tagName === 'TEXTAREA' || TEXT_ROLES.has(el.getAttribute('role') || '')
  || (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test((el as HTMLInputElement).type))
function stateOf(el: Element): string {
  const h = el as HTMLInputElement
  const f: string[] = []
  if (h.disabled || el.getAttribute('aria-disabled') === 'true') f.push('disabled')
  if (h.checked === true || el.getAttribute('aria-checked') === 'true') f.push('checked')
  if (el.getAttribute('aria-selected') === 'true') f.push('selected')
  // 开关按钮:名字是「它管什么」,状态看这里(11-15 反馈:只看名字的 agent 点了「阅读」都不知道笔记已经进了阅读模式)
  const pr = el.getAttribute('aria-pressed')
  if (pr) f.push(pr === 'true' ? 'pressed' : pr === 'mixed' ? 'partly pressed' : 'not pressed')
  // 打不进字的框(阅读模式 / 锁定的笔记正文、readonly 输入框):不说的话 agent 一路 type,次次被拒还不知道为什么
  if (el.getAttribute('aria-readonly') === 'true' || (textEntry(el) && (h.readOnly === true || el.getAttribute('contenteditable') === 'false'))) f.push('read-only')
  const ex = el.getAttribute('aria-expanded')
  if (ex) f.push(ex === 'true' ? 'expanded' : 'collapsed')
  if (document.activeElement === el) f.push('focused')
  if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && h.value) f.push(`value "${clip(String(h.value), 60)}"`)
  return f.length ? ` (${f.join(', ')})` : ''
}

/** target:`e12` / `s12` = read 给的引用;`css:<选择器>`;其余按看得见的字找(先按控件的名字精确,再包含,最后任意元素的字)。 */
function find(target: string): Element | string {
  const t = target.trim()
  if (/^[es]\d+$/.test(t)) {
    if (t[0] !== REF) return `the reference ${t} comes from the ${t[0] === 's' ? 'settings' : 'main'} window; act on that window (window "${t[0] === 's' ? 'settings' : 'main'}")`
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 目标中心点上压着宿主的通知卡:全关掉(文字 watchNotices 早记下了,状态里照样看得到),等卡片退场让开(退场动画期间还接指针)。
 *  回关掉的那几条;没压着 = null。一秒内还让不开(新的一直在弹)= 'stuck'。
 *  ⚠️ 不先点再说:点下去落在卡片上,碰到的可能是它的「撤销」按钮(11-15 反馈:两次点「编辑」都点在插件的通知上)。 */
async function clearToasts(x: number, y: number): Promise<string[] | 'stuck' | null> {
  const hit = (): boolean => !!document.elementFromPoint(x, y)?.closest(TOASTS)
  if (!hit()) return null
  const st = useNotifications.getState()
  const texts = st.items.map((n) => (n.title ? `${n.title}: ${n.text}` : n.text).slice(0, 200))
  st.dismissAll()
  const end = Date.now() + 1000
  while (hit() && Date.now() < end) await sleep(40)
  return hit() ? 'stuck' : texts
}

/** 首次打开时右下角那张「这是一个沙箱」说明条(SandboxChrome.tsx)。它压着被测插件的按钮时,agent 点下去只会得到
 *  「上面压着别的元素」(11-19 第一轮挡住导入按钮的疑似就是它)。和通知一样:先收起再点。收起 = 当作人点了「知道了」,
 *  说明的原文一直在右上角「沙箱」胶囊的悬停提示里。 */
export const SANDBOX_NOTE_COLLAPSE = 'forsion-sandbox-note-collapse'
const NOTE = '[data-testid="sandbox-note"]'
async function clearNote(x: number, y: number): Promise<boolean> {
  const hit = (): boolean => !!document.elementFromPoint(x, y)?.closest(NOTE)
  if (!hit()) return false
  window.dispatchEvent(new Event(SANDBOX_NOTE_COLLAPSE))
  const end = Date.now() + 1000
  while (hit() && Date.now() < end) await sleep(40)
  return true
}

type Located = { x: number; y: number; label: string; covered?: string; dismissed?: string[] }
async function locate(target: string): Promise<Located | { error: string }> {
  const el = find(target)
  if (typeof el === 'string') return { error: el }
  const point = (): { x: number; y: number } => {
    let r = el.getBoundingClientRect()
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) { el.scrollIntoView({ block: 'center', inline: 'center' }); r = el.getBoundingClientRect() }
    return { x: r.left + Math.min(r.width / 2, Math.max(1, r.width - 2)), y: r.top + r.height / 2 }
  }
  let { x, y } = point()
  const label = `${roleOf(el)} "${labelOf(el)}"`
  const over = (top: Element | null): boolean => !!top && top !== el && !el.contains(top) && !top.contains(el)
  let dismissed: string[] | undefined
  if (!el.closest(NOTE) && over(document.elementFromPoint(x, y)) && await clearNote(x, y)) {
    if (!el.isConnected) return { error: 'the page changed while the sandbox note was being closed; read again' }
    ;({ x, y } = point())
  }
  // 目标本身就在通知卡里(点通知上的按钮)不算被压着
  if (!el.closest(TOASTS) && over(document.elementFromPoint(x, y))) {
    const cleared = await clearToasts(x, y)
    // 不带元素名:报错在数据区外面,名字是插件的字(Codex 评审)
    if (cleared === 'stuck') return { error: 'the target is covered by notifications that keep appearing; wait a moment and try again' }
    if (cleared) {
      if (!el.isConnected) return { error: 'the page changed while a notification was being dismissed; read again' }
      dismissed = cleared
      ;({ x, y } = point())
      // 通知收走以后露出来的可能是说明条(右下角的吐司正好叠在它上面):再看一眼
      if (over(document.elementFromPoint(x, y)) && await clearNote(x, y)) {
        if (!el.isConnected) return { error: 'the page changed while the sandbox note was being closed; read again' }
        ;({ x, y } = point())
      }
    }
  }
  const top = document.elementFromPoint(x, y)
  return { x, y, label, ...(over(top) ? { covered: `${roleOf(top!)} "${labelOf(top!)}"` } : {}), ...(dismissed ? { dismissed } : {}) }
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
      const ref = `${REF}${++n}`
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
  // 舞台:哪个 Space 都能切(内置的 Tangu / 笔记 / 日历,和点名插件带的);开发沙箱只切被测插件自己的
  const own = sandboxSelf()?.stage ? useSpaceStore.getState().spaces.map((x) => x.id) : ownSpaces(pluginId)
  // 配方的名字注册成按语言求值的函数:String() 出来是函数源码(Codex 评审),按引擎的 label() 取
  const sp = useSpaceStore.getState().spaces.find((x) => own.includes(x.id) && (x.id === want || spaceLabel(x.name).toLowerCase() === want.trim().toLowerCase()))
  if (!sp) return { error: sandboxSelf()?.stage ? `no Space "${want}" on the stage; Spaces: ${own.join(', ') || 'none'}` : `this plugin has no Space "${want}"; its Spaces: ${own.join(', ') || 'none'}` }
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

/** 命令跑了这么久还没完,先回「开始了、还在跑」:多半是它弹了自己的选择框 / 对话框在等人点(11-15 反馈:等满主进程的
 *  10 秒被报成「沙箱窗口还在启动」,agent 以为窗口坏了)。 */
const COMMAND_SETTLE_MS = 1500

/** 插件命令 = ctx.registerCommand 注册的那些;按命令 id(不带插件前缀)找。
 *  allowPending = 引擎认得「还在跑」(11-15 起的引擎才带):不带就照旧等它跑完(老引擎把回执当「跑完了」,早回会让它以为写完了)。 */
async function command(pluginId: string, id: string, args: unknown, allowPending = false): Promise<{ ok: boolean; error?: string; pending?: boolean }> {
  const cmd = usePluginStore.getState().commands.find((c) => c.pluginId === pluginId && (c.item.id === id || `amadeus:${pluginId}:${c.item.id}` === id))
  if (!cmd) {
    const have = usePluginStore.getState().commands.filter((c) => c.pluginId === pluginId).map((c) => c.item.id)
    return { ok: false, error: `no command "${id}"; this plugin registered: ${have.join(', ') || 'none'}` }
  }
  const run: Promise<{ ok: boolean; error?: string }> = (async () => { await (cmd.item.run as (a?: unknown) => unknown)(args && typeof args === 'object' ? args : undefined) })()
    .then(() => ({ ok: true }), (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  if (!allowPending) return run
  const first = await Promise.race([run, sleep(COMMAND_SETTLE_MS).then(() => null)])
  if (first) return first
  // 回执已经发出去了:之后才抛的错记进插件的 console,agent 看 logs / 下一个动作的回执就知道
  void run.then((r) => { if (!r.ok) recordDevLog(pluginId, 'error', [`[sandbox] command "${cmd.item.id}" failed after it had started: ${r.error}`]) })
  return { ok: true, pending: true }
}

/** settings 动作(主窗):开「设置 → 插件 → 本插件」的详情页(registerSettingsView / registerSetting 都画在那里)。设置是独立的浮动窗口。 */
async function openSettings(pluginId: string): Promise<{ ok: true } | { error: string }> {
  if (!usePluginStore.getState().plugins.some((p) => p.id === pluginId)) return { error: 'the plugin is not loaded in the sandbox, so it has no settings page; check status' }
  const { useApp } = await import('../stores/appStore')
  useApp.getState().openSettings(`fplugin:${pluginId}`)
  return { ok: true }
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
  // 舞台是一份「正常的」Forsion:Ribbon 照旧、不自动落到哪个 Space(导演的步骤自己切)
  if (!self.stage) { pureRibbon(self.pluginId); land(self.pluginId) }
  window.tangu?.sandbox?.changed()
}

export function installSandboxHook(): void {
  const self = sandboxSelf()
  if (!self) return
  const pid = self.pluginId
  const main = windowKind() === 'main'
  watchNotices()
  if (main && !self.stage) {
    pureRibbon(pid)
    // 条目随 Space 注册 / 插件 Space 装卸而变,每变一次对一遍;pureRibbon 自己的增删会再触发一次,那一次什么也不改
    useRibbonStore.subscribe((st, prev) => { if (st.items !== prev.items) pureRibbon(pid) })
  }
  ;(window as unknown as { __forsionSandbox: unknown }).__forsionSandbox = {
    status: () => status(pid),
    command: (id: string, args: unknown, allowPending?: boolean) => command(pid, id, args, allowPending === true),
    openView: (view?: string) => openView(pid, view),
    openSettings: () => openSettings(pid),
    /** 设置窗口:插件在这扇窗里落定了没有(详情页要等它)。setup 还在 await 时不算(设置面板可能还没注册);
     *  抛了错 / 没激活(停用、被拒载)也算落定:详情页照样画得出来,画的是它为什么没跑。 */
    pluginReady: () => {
      const s = usePluginStore.getState()
      if (!s.plugins.some((p) => p.id === pid)) return false
      return pluginSetupSettled(pid) || !!s.lastSetupError[pid] || !s.activeIds.includes(pid)
    },
    /** 设置窗口跟着主窗重载:每扇窗各有一份插件实例,主窗那次重载管不到这里。 */
    reloadPlugin: () => reloadDevPlugin(pid).catch((e) => console.warn('[sandbox] reload failed', e)),
    read: (target: string) => read(target),
    locate: (target: string) => locate(target),
    scroll: (target: string, amount: number) => scroll(target, amount),
    space: (want: string) => (main ? space(pid, want) : { error: 'Spaces live in the main window' }),
    selectFocused,
    frames,
    settle,
    begin: () => begin(pid),
    end: () => end(pid),
    // 演示舞台(sandboxChild.ts 只在舞台模式下调)
    rectOf,
    cursorTo,
    recordStart,
    recordStop,
    recordPause,
    recordResume,
    reload: async () => {
      if (self.stage) return // 舞台没有开发副本可重载
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
