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
}
interface BirthEntry extends Entry<NoteBirthContribution> {
  /** 插件停用 / 重载 / 同 id 被顶替时落定:正在等它的那一问立刻跳过它。 */
  gone: Promise<void>
  release: () => void
}

const processors = new Map<string, Entry<TemplateProcessorContribution>>()
const births = new Map<string, BirthEntry>()

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
  const key = `${pluginId}:${def.id}`
  const entry: Entry<TemplateProcessorContribution> = { key, pluginId, pluginName, item: def }
  processors.set(key, entry) // 同 key 再注册 = 原位顶替(Map.set 保留原来的顺序位)
  return () => { if (processors.get(key) === entry) processors.delete(key) }
}

export const hasTemplateProcessors = (): boolean => processors.size > 0

export type TemplateProcessResult = { ok: true; text: string; changed: boolean } | { ok: false }

/** 按注册顺序跑全部处理器;每个拿上一个的输出。返回 null = 不改。抛错 = 整次插入作废(提示点名插件),不写任何东西。
 *  跑的途中被停用的插件:它的结果不要(停用后它不该再改用户的笔记)。 */
export async function runTemplateProcessors(source: string, info: { templatePath: string; targetPath: string; kind: TemplateFlowKind }): Promise<TemplateProcessResult> {
  let text = source
  let changed = false
  for (const entry of [...processors.values()]) {
    if (processors.get(entry.key) !== entry) continue
    let out: unknown
    try {
      out = await entry.item.process(text, { ...info })
    } catch (e) {
      console.error(`[amadeus] 插件 ${entry.pluginId} 的模板处理器 ${entry.item.id} 抛错`, e)
      toast(translate('plugintpl.process.failed', { plugin: entry.pluginName(), error: errText(e) }))
      return { ok: false }
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
  const key = `${pluginId}:${def.id}`
  let release = (): void => {}
  const gone = new Promise<void>((r) => { release = r })
  const entry: BirthEntry = { key, pluginId, pluginName, item: def, gone, release }
  births.get(key)?.release() // 被同 id 顶替的那个:正在等它的立刻放手
  births.set(key, entry)
  return () => {
    if (births.get(key) !== entry) return
    births.delete(key)
    release()
  }
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

/** 问各插件这篇新笔记的初始内容。null = 没人给 / 取消 / 超时 / 都抛错 —— 调用方照旧写空白。 */
export async function askNoteBirth(path: string, opts?: { capMs?: number; noticeDelayMs?: number; notice?: BirthNoticeHost }): Promise<NoteBirthAnswer | null> {
  if (!births.size || asking) return null
  asking = true
  const ctrl = new AbortController()
  let stop: (reason: 'cancel' | 'timeout') => void = () => {}
  const stopped = new Promise<'cancel' | 'timeout'>((r) => { stop = (reason) => { if (!ctrl.signal.aborted) { ctrl.abort(); r(reason) } } })
  const cap = setTimeout(() => stop('timeout'), opts?.capMs ?? NOTE_BIRTH_CAP_MS)
  const host = opts?.notice ?? defaultNoticeHost
  let current: BirthEntry | null = null
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
  // 每个插件一个自己的 signal:宿主不再等它(它答完 / 抛错 / 被停用或顶替 / 取消 / 超时)那一刻就 abort,
  // 不让被跳过的那个插件的弹框跟下一个插件的同时开着(Codex 复核 P2)。
  let mine: AbortController | null = null
  try {
    for (const entry of [...births.values()]) {
      if (ctrl.signal.aborted) break
      if (births.get(entry.key) !== entry) continue
      current = entry
      if (hide) showNotice() // 提示已挂着:换成这一个插件的名字
      mine = new AbortController()
      const signal = mine.signal
      const asked = Promise.resolve().then(() => entry.item.initial({ path, folder, signal })).then(
        (v) => ({ kind: 'value' as const, v }),
        (e: unknown) => ({ kind: 'error' as const, e }),
      )
      const r = await Promise.race([asked, entry.gone.then(() => ({ kind: 'gone' as const })), stopped.then((reason) => (reason === 'cancel' ? { kind: 'cancel' as const } : { kind: 'timeout' as const }))])
      mine.abort()
      mine = null
      if (r.kind === 'cancel') return null
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
    if (noticeTimer) clearTimeout(noticeTimer)
    hide?.()
    mine?.abort()
    if (!ctrl.signal.aborted) ctrl.abort()
  }
}
