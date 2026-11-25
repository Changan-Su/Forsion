/**
 * 插件登记的翻译引擎(2026-11-24,翻译插件接 DeepL 等服务;契约:仓根 docs/ToBeImproved/翻译插件设置与服务方案_2026-11-24/契约.md §2–§3)。
 *
 * 插件经 `ctx.registerTranslationEngine` 把一家服务登记到这里;用户在本机选了哪家,存
 * `localStorage['forsion_translate_engine'] = '<pluginId>:<id>'`(不同步:密钥也只在这台电脑上)。
 * 宿主的翻译口子(tanguProbe.translateInline:编辑器的翻译、划线翻译、插件 ctx.tangu.translate)先看这里:
 *  · 选了、登记着、ready → 走引擎(宿主包一层公式保护与校验,见 engineTranslate);
 *  · 选了、登记着、没 ready → 报 translation_engine_unavailable,**不悄悄换**(11-04 定:用户指定的服务失败要看得见);
 *  · 选了但没登记(插件停用 / 卸载、手机网页)→ 当没选,走 Forsion 模型。
 * 只放渲染层纯逻辑:amadeus 这侧不 import 应用层 store(tanguSeam 顶注)。
 */
import { pluginText } from './pluginText'

export const TRANSLATE_ENGINE_PREF = 'forsion_translate_engine'
export const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export interface TranslationEngineRequest { text: string; to: string; before?: string; signal: AbortSignal }

export interface RegisteredTranslationEngine {
  /** `<pluginId>:<id>` */
  readonly key: string
  readonly pluginId: string
  readonly id: string
  name(): string
  ready(): boolean
  translate(req: TranslationEngineRequest): Promise<string>
}

const engines = new Map<string, RegisteredTranslationEngine>()
const listeners = new Set<() => void>()
const notify = (): void => { for (const cb of [...listeners]) { try { cb() } catch { /* 订阅方自己的错不打断别人 */ } } }

export const engineKey = (pluginId: string, id: string): string => `${pluginId}:${id}`

/** 宿主内部:插件登记(pluginStore 已校验形状)。同 key 重登记 = 替换。返回撤销。 */
export function registerTranslationEngine(pluginId: string, def: { id: string; name: unknown; ready?: () => boolean; translate: (req: TranslationEngineRequest) => Promise<string> }): () => void {
  const key = engineKey(pluginId, def.id)
  const entry: RegisteredTranslationEngine = {
    key, pluginId, id: def.id,
    name: () => pluginText(def.name, def.id) || def.id,
    ready: () => { if (!def.ready) return true; try { return def.ready() !== false } catch { return false } },
    translate: (req) => def.translate(req),
  }
  engines.set(key, entry)
  notify()
  return () => {
    if (engines.get(key) !== entry) return // 已被同 key 的新登记替换
    engines.delete(key)
    notify()
  }
}

/** 已登记的引擎(readyOnly:只要这一刻用得了的)。按登记顺序。 */
export function listTranslationEngines(opts: { readyOnly?: boolean } = {}): RegisteredTranslationEngine[] {
  const all = [...engines.values()]
  return opts.readyOnly ? all.filter((e) => e.ready()) : all
}

export function findTranslationEngine(key: string | null | undefined): RegisteredTranslationEngine | undefined {
  return key ? engines.get(key) : undefined
}

/** 本机选的引擎 key(原值,不管登记没登记)。localStorage 读不了 = 没选。 */
export function chosenEngineKey(): string | null {
  try { const v = localStorage.getItem(TRANSLATE_ENGINE_PREF); return v && v.includes(':') ? v : null } catch { return null }
}

/** 这一次翻译该怎么走:engine = 走它;unavailable = 用户选了它但它这一刻用不了(报错,不换);都没有 = 走 Forsion 模型。 */
export function activeTranslationEngine(): { engine?: RegisteredTranslationEngine; unavailable?: RegisteredTranslationEngine } {
  const e = findTranslationEngine(chosenEngineKey())
  if (!e) return {}
  return e.ready() ? { engine: e } : { unavailable: e }
}

/** 改本机选择(null = 回 Forsion 模型)。写不进 localStorage 就抛(调用方报给用户),写成了才通知。 */
export function setChosenEngine(key: string | null): void {
  if (key) localStorage.setItem(TRANSLATE_ENGINE_PREF, key)
  else localStorage.removeItem(TRANSLATE_ENGINE_PREF)
  notify()
}

/** 选择或登记变了(本窗;别的窗经 storage 事件)。模型槽在本窗改了也请调 notifyTranslationChoice。 */
export function subscribeTranslationChoice(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export const notifyTranslationChoice = notify

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === TRANSLATE_ENGINE_PREF || e.key === null) notify() })
}

/** 只给测试:清空登记。 */
export function __resetTranslationEnginesForTest(): void { engines.clear(); listeners.clear() }
