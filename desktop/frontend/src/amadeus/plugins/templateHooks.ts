/**
 * 插件接进宿主自己的模板流程(2026-11-16):
 *  - ctx.registerTemplateProcessor:宿主的模板流程(选择器插入 / 日记)在替换 {{date}}/{{title}} **之前**,按注册顺序把模板原文
 *    交给插件处理;folders() 给选择器多列几个模板文件夹。移植 Templater 的插件不必再自己造一个模板选择器。
 *  - ctx.registerNoteBirth:用户新建一篇空笔记时,宿主**写盘之前**问插件要初始内容,随出生那一写落盘(pageStore.birthNoteFile)。
 *    此前插件只能 onVaultEvent create → writeFile 补写:本窗渲染层的写不回灌本窗,编辑器挂载时读到的是空的,一直显示空白;
 *    用户一打字,保存撞上 CAS → 本地胜,模板被挪进冲突副本(2026-11-15 实测 3/3,scripts/plugin-birth-race.check.cjs)。
 *
 * 等待规矩:插件可以弹框问用户,所以不设短超时 —— 等一会儿还没答就在右上角挂「「X」正在准备这篇笔记…」+ 取消;
 * 取消 / 10 分钟没答 = 照旧空白出生;某个插件抛错 = 跳过它问下一个。笔记本身永远不会被挡住或丢掉。
 * 本模块不 import pageStore(pageStore 引它),写盘与库根核对都在 birthNoteFile。
 */
import type { NoteBirthContribution, TemplateFlowKind, TemplateProcessorContribution } from './types'
import { notifyApp, useNotifications } from '../../stores/notificationStore'
import { registerMessages, translate } from '../../i18n'
import { windowKind } from '../../windowKind'

registerMessages({
  'plugintpl.birth.waiting': { zh: '「{plugin}」正在准备这篇笔记…', en: '{plugin} is preparing this note…' },
  'plugintpl.birth.cancel': { zh: '取消', en: 'Cancel' },
  'plugintpl.birth.failed': { zh: '「{plugin}」没能准备这篇笔记：{error}', en: '{plugin} couldn’t prepare this note: {error}' },
  'plugintpl.birth.timeout': { zh: '「{plugin}」一直没有回应，笔记已按空白新建', en: '{plugin} didn’t respond, so the note was created empty' },
  'plugintpl.process.failed': { zh: '「{plugin}」处理模板时出错，模板没有插入：{error}', en: '{plugin} couldn’t process the template, so it wasn’t inserted: {error}' },
})

interface Entry<T> {
  key: string
  pluginId: string
  /** 插件显示名(当前语言);提示里点名用。 */
  pluginName: () => string
  item: T
  /** 正在等它的那几问(插件停用 / 重载 / 同 id 被顶替时逐个叫醒);null = 已退役。 */
  waiters: Set<() => void> | null
}

const processors = new Map<string, Entry<TemplateProcessorContribution>>()
const births = new Map<string, Entry<NoteBirthContribution>>()

/** 退役:叫醒所有正在等它的,之后再来等的立刻醒。 */
function retire(entry: Entry<unknown>): void {
  const waiters = entry.waiters
  entry.waiters = null
  if (waiters) for (const wake of waiters) wake()
}

/** 这一问期间盯着插件退役。off 必须在这一问落定时调:反应只挂在这一问上,不往长寿的登记项上累积。 */
function watchGone(entry: Entry<unknown>): { gone: Promise<'gone'>; off: () => void } {
  let off = (): void => {}
  const gone = new Promise<'gone'>((resolve) => {
    if (!entry.waiters) { resolve('gone'); return }
    const wake = (): void => resolve('gone')
    entry.waiters.add(wake)
    off = () => { entry.waiters?.delete(wake) }
  })
  return { gone, off }
}

/** 同 key 登记(同 id 再注册 = 原位顶替,Map.set 保留原来的顺序位;被顶替的那个退役),返回撤销。 */
function enroll<T>(map: Map<string, Entry<T>>, entry: Entry<T>): () => void {
  const prev = map.get(entry.key)
  map.set(entry.key, entry)
  if (prev) retire(prev)
  return () => {
    if (map.get(entry.key) !== entry) return
    map.delete(entry.key)
    retire(entry)
  }
}

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))
function toast(text: string, level: 'error' | 'warning' = 'error'): void {
  if (typeof window === 'undefined') return
  // 与编辑器层同一条提示通道(amadeusOverlays 接:主窗进右上角通知栈,别的窗退回底部吐司)。
  window.dispatchEvent(new CustomEvent('amadeus:toast', { detail: { text, level } }))
}
const validId = (id: unknown): id is string => typeof id === 'string' && !!id.trim()

// ── 模板处理器 ────────────────────────────────────────────────────────────────

export function registerTemplateProcessor(pluginId: string, pluginName: () => string, def: TemplateProcessorContribution): () => void {
  if (!def || !validId(def.id) || typeof def.process !== 'function' || (def.folders != null && typeof def.folders !== 'function')) {
    throw new TypeError('registerTemplateProcessor requires id and process(source, info)')
  }
  return enroll(processors, { key: `${pluginId}:${def.id}`, pluginId, pluginName, item: def, waiters: new Set() })
}

export const hasTemplateProcessors = (): boolean => processors.size > 0

export type TemplateProcessResult = { ok: true; text: string; changed: boolean } | { ok: false }

/** 按注册顺序跑全部处理器;每个拿上一个的输出。返回 null = 不改。抛错 = 整次插入作废(提示点名插件),不写任何东西。
 *  跑的途中插件被停用 / 重载:不再等它(它弹着的框可能永远不答),按「不改」接着跑下一个 —— 停用后它不该再改用户的笔记。 */
export async function runTemplateProcessors(source: string, info: { templatePath: string; targetPath: string; kind: TemplateFlowKind }): Promise<TemplateProcessResult> {
  let text = source
  let changed = false
  for (const entry of [...processors.values()]) {
    if (processors.get(entry.key) !== entry) continue
    let out: unknown
    const watch = watchGone(entry)
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => entry.item.process(text, { ...info })).then((v) => ({ v })),
        watch.gone.then(() => null),
      ])
      if (!r) {
        console.warn(`[amadeus] 插件 ${entry.pluginId} 在处理模板时被停用,按「不改」处理`)
        continue
      }
      out = r.v
    } catch (e) {
      console.error(`[amadeus] 插件 ${entry.pluginId} 的模板处理器 ${entry.item.id} 抛错`, e)
      toast(translate('plugintpl.process.failed', { plugin: entry.pluginName(), error: errText(e) }))
      return { ok: false }
    } finally {
      watch.off()
    }
    if (processors.get(entry.key) !== entry) continue
    if (typeof out === 'string') {
      text = out
      changed = true
    } else if (out != null) {
      console.warn(`[amadeus] 插件 ${entry.pluginId} 的模板处理器 ${entry.item.id} 返回了非字符串,按「不改」处理`)
    }
  }
  return { ok: true, text, changed }
}

/** 库内相对文件夹的规范形;绝对路径、盘符、`..` / `.` / 空段一律不认(null)。 */
export function normTemplateFolder(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\\/g, '/').trim().replace(/\/+$/, '')
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.includes('\0')) return null
  if (s.split('/').some((seg) => !seg.trim() || seg === '.' || seg === '..')) return null
  return s
}

const FOLDERS_TIMEOUT_MS = 2000

/** 插件声明的额外模板文件夹(去重、规范化)。单个 folders() 抛错 / 超时 = 它这次不贡献,别的照常。 */
export async function templateFolders(): Promise<string[]> {
  const asks = [...processors.values()].filter((e) => typeof e.item.folders === 'function').map(async (entry) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const v = await Promise.race([
        Promise.resolve().then(() => entry.item.folders!()),
        new Promise<null>((r) => { timer = setTimeout(() => r(null), FOLDERS_TIMEOUT_MS) }),
      ])
      return Array.isArray(v) ? v : []
    } catch (e) {
      console.warn(`[amadeus] 插件 ${entry.pluginId} 的 folders() 抛错`, e)
      return []
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
  const out = new Set<string>()
  for (const list of await Promise.all(asks)) for (const f of list) { const n = normTemplateFolder(f); if (n) out.add(n) }
  return [...out]
}

// ── 新笔记出生 ────────────────────────────────────────────────────────────────

export function registerNoteBirth(pluginId: string, pluginName: () => string, def: NoteBirthContribution): () => void {
  if (!def || !validId(def.id) || typeof def.initial !== 'function') throw new TypeError('registerNoteBirth requires id and initial(info)')
  return enroll(births, { key: `${pluginId}:${def.id}`, pluginId, pluginName, item: def, waiters: new Set() })
}

export const hasNoteBirthProviders = (): boolean => births.size > 0

/** 等待提示的落点。主窗 = 右上角通知栈(回执:用户刚点的新建,不受通知开关过滤;常驻、带取消);别的窗口没有通知栈,
 *  退回底部吐司(只有文字,取消不了 —— 仍有 10 分钟上限)。可注入:单测换掉它。 */
export interface BirthNoticeHost {
  /** 显示 / 换文案;返回收起函数。onCancel 在用户点取消或关掉提示时调。 */
  show(text: string, cancelLabel: string, onCancel: () => void): () => void
}

let noticeSeq = 0
const defaultNoticeHost: BirthNoticeHost = {
  show(text, cancelLabel, onCancel) {
    if (windowKind() !== 'main') {
      toast(text, 'warning') // 非主窗:amadeusOverlays 退回底部吐司
      return () => {}
    }
    let settled = false
    const key = `note-birth:${++noticeSeq}`
    const id = notifyApp({
      text, level: 'info', sticky: true, receipt: true, dedupeKey: key, replace: true,
      action: { label: cancelLabel, run: onCancel },
      // 点 × / 全部清除 = 不等了。宿主自己收起时先置 settled,别把正常落定当成取消。
      onClose: () => { if (!settled) onCancel() },
    })
    return () => {
      settled = true
      if (id) useNotifications.getState().dismiss(id)
    }
  },
}

export const NOTE_BIRTH_CAP_MS = 10 * 60_000
const NOTICE_DELAY_MS = 400

/** 正在问的那一轮(全局只许一轮):问的途中再来的新建(插件在 initial 里调 createPage、用户又点了一次新建)不再问,
 *  照旧空白出生 —— 防递归,也防两个插件弹框叠在一起。 */
let asking = false

export interface NoteBirthAnswer { text: string; pluginId: string }

/** 问各插件这篇新笔记的初始内容。null = 没人给 / 取消 / 超时 / 都抛错 / 调用方喊停 —— 调用方照旧写空白(喊停时由它决定写不写)。
 *  `opts.signal`:调用方喊停(换了智库:插件不随换库重载,不停的话它的框、等待提示和这把全局锁会挂满 10 分钟,
 *  新库里的新建一律不问)。停了 = 立刻放锁、收提示、abort 正在问的那个插件的 signal。 */
export async function askNoteBirth(path: string, opts?: { capMs?: number; noticeDelayMs?: number; notice?: BirthNoticeHost; signal?: AbortSignal }): Promise<NoteBirthAnswer | null> {
  if (!births.size || asking || opts?.signal?.aborted) return null
  asking = true
  const ctrl = new AbortController()
  type Stop = 'cancel' | 'timeout' | 'stale'
  let stop: (reason: Stop) => void = () => {}
  const stopped = new Promise<Stop>((r) => { stop = (reason) => { if (!ctrl.signal.aborted) { ctrl.abort(); r(reason) } } })
  const cap = setTimeout(() => stop('timeout'), opts?.capMs ?? NOTE_BIRTH_CAP_MS)
  const onStale = (): void => stop('stale')
  opts?.signal?.addEventListener('abort', onStale, { once: true })
  const host = opts?.notice ?? defaultNoticeHost
  let current: Entry<NoteBirthContribution> | null = null
  let hide = null as (() => void) | null // 只在 showNotice 里赋值:写成 as,免得控制流把它收窄成恒为 null
  const showNotice = (): void => {
    if (!current || ctrl.signal.aborted) return
    hide?.()
    hide = host.show(translate('plugintpl.birth.waiting', { plugin: current.pluginName() }), translate('plugintpl.birth.cancel'), () => stop('cancel'))
  }
  // 快答(同步 / 几十毫秒)不闪提示;等过了这一刻还没答才挂上。
  let noticeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => { noticeTimer = null; showNotice() }, opts?.noticeDelayMs ?? NOTICE_DELAY_MS)
  const slash = path.lastIndexOf('/')
  const folder = slash > 0 ? path.slice(0, slash) : ''
  // 每个插件一个自己的 signal:宿主不再等它(它答完 / 抛错 / 被停用或顶替 / 取消 / 超时 / 喊停)那一刻就 abort,
  // 不让被跳过的那个插件的弹框跟下一个插件的同时开着(Codex 复核 P2)。
  let mine: AbortController | null = null
  try {
    for (const entry of [...births.values()]) {
      if (ctrl.signal.aborted) break
      if (births.get(entry.key) !== entry) continue
      current = entry
      if (hide) showNotice() // 提示已挂着:换成这一个插件的名字
      const ac = new AbortController()
      mine = ac
      const signal = ac.signal
      const asked = Promise.resolve().then(() => entry.item.initial({ path, folder, signal })).then(
        (v) => ({ kind: 'value' as const, v }),
        (e: unknown) => ({ kind: 'error' as const, e }),
      )
      const watch = watchGone(entry)
      // 三路都不会 reject(asked 已把抛错收成 error):落定就摘掉这一问挂的反应、abort 这个插件的 signal。
      const r = await Promise.race([asked, watch.gone.then(() => ({ kind: 'gone' as const })), stopped.then((kind): { kind: 'cancel' } | { kind: 'timeout' } | { kind: 'stale' } => (kind === 'cancel' ? { kind } : kind === 'timeout' ? { kind } : { kind }))])
        .finally(() => { watch.off(); ac.abort() })
      mine = null
      if (r.kind === 'cancel' || r.kind === 'stale') return null
      if (r.kind === 'timeout') {
        console.warn(`[amadeus] 插件 ${entry.pluginId} 的 registerNoteBirth 超过上限没有回应,笔记按空白新建`)
        toast(translate('plugintpl.birth.timeout', { plugin: entry.pluginName() }), 'warning')
        return null
      }
      if (r.kind === 'gone' || births.get(entry.key) !== entry) continue // 等的途中被停用:它的答复不要
      if (r.kind === 'error') {
        console.error(`[amadeus] 插件 ${entry.pluginId} 的 registerNoteBirth 抛错`, r.e)
        toast(translate('plugintpl.birth.failed', { plugin: entry.pluginName(), error: errText(r.e) }))
        continue
      }
      if (typeof r.v === 'string') return { text: r.v, pluginId: entry.pluginId }
      if (r.v != null) console.warn(`[amadeus] 插件 ${entry.pluginId} 的 registerNoteBirth 返回了非字符串,按「不给」处理`)
    }
    return null
  } finally {
    asking = false
    clearTimeout(cap)
    opts?.signal?.removeEventListener('abort', onStale)
    if (noticeTimer) clearTimeout(noticeTimer)
    hide?.()
    mine?.abort()
    if (!ctrl.signal.aborted) ctrl.abort()
  }
}
