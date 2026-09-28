/**
 * 主进程 i18n 地基(P1-K5):主进程自己撰写的原生界面文案(对话框、系统通知、选择框标题、托盘)的唯一出口。
 *
 * 语言来源与渲染层同一结论,不在主进程另写一份判定(CLAUDE.md「界面语言自适应」):
 *   ① 渲染层落在 localStorage `tangu_locale` 的值(① 手选 / ③ IP 校正都写它)—— main 在主窗载入后读一次、
 *      之后经 ui:sync 转进来(setMainLocale);
 *   ② 没有这个键 = 界面跟随系统:系统首选语言 zh* → 中文,其余英文(与 tray 原规则、渲染层 ②④ 同口径)。
 * 系统语言由调用方注入(initMainLocale),本模块不依赖 electron,vitest 直测。
 *
 * 文案规矩(与渲染层 registerMessages 同):
 *   - 键一律 `main.<模块>.*`,片段用 defineMainMessages 就近放在使用方旁边;zh / en 成对。
 *   - 调用时求值(mt() 在弹框 / 通知那一刻取),不在模块作用域定格 —— 否则切语言纹丝不动。
 *   - i18nCoverage.test.ts 的 M 段把这些片段并入 A/B/E/F/G 断言,并对 mt('字面量键') 核对键存在。
 */

export type MainLocale = 'zh' | 'en'
export type MainMessage = { zh: string; en: string }

/** 渲染层界面语言的 localStorage 键(= frontend/src/types.ts 的 LOCALE_KEY;主进程不 import 渲染层)。 */
export const UI_LOCALE_PREF_KEY = 'tangu_locale'

let systemLanguages: () => readonly string[] = () => []
/** 渲染层报来的界面语言;null = 渲染层没存(跟随系统)或还没读到。 */
let override: MainLocale | null = null
const messages = new Map<string, MainMessage>()
const listeners = new Set<(l: MainLocale) => void>()

function fromSystem(): MainLocale {
  let langs: readonly string[] = []
  try { langs = systemLanguages() } catch { /* 取不到系统语言 = 按英文 */ }
  return /^zh\b/i.test(langs[0] ?? '') ? 'zh' : 'en'
}

/** 注入系统首选语言的来源(main.ts:app.getPreferredSystemLanguages)。惰性调用,模块装载即可注入。 */
export function initMainLocale(o: { systemLanguages(): readonly string[] }): void {
  const before = mainLocale()
  systemLanguages = () => o.systemLanguages()
  notifyIfChanged(before)
}

/** 当前生效语言:界面覆盖 > 系统 zh* → zh > en。 */
export function mainLocale(): MainLocale {
  return override ?? fromSystem()
}

/** 渲染层的覆盖值(tray 的 trayLang 用它作缺省覆盖来源);null = 跟随系统。 */
export function mainLocaleOverride(): MainLocale | null {
  return override
}

/** main 转进来的界面语言(主窗载入时读 localStorage、ui:sync 的 prefs)。'zh' | 'en' 之外的值(含 null)= 跟随系统。 */
export function setMainLocale(v: unknown): void {
  const next = v === 'zh' || v === 'en' ? v : null
  if (next === override) return
  const before = mainLocale()
  override = next
  notifyIfChanged(before)
}

function notifyIfChanged(before: MainLocale): void {
  const now = mainLocale()
  if (now === before) return
  for (const cb of [...listeners]) {
    try { cb(now) } catch (e) { console.error('[mainI18n] 语言变更回调抛错:', e) }
  }
}

/** 生效语言变化时回调(同值重复设置不回调);返回退订函数。 */
export function onMainLocaleChange(cb: (l: MainLocale) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 登记一段主进程文案并原样返回(便于 `typeof` 取键)。键必须以 `main.` 开头(i18nCoverage M1 钉住)。
 *  同键重复登记以后者为准 —— 与渲染层 registerMessages 同语义,冲突由 M1 在测试里抓。 */
export function defineMainMessages<const T extends Record<string, MainMessage>>(frag: T): T {
  for (const [k, v] of Object.entries(frag)) messages.set(k, v)
  return frag
}

/** 单趟替换:一次正则扫模板,回调里查 vars。**不能**按变量逐个 .replace —— 配对框把对端自报的设备名插进文案,
 *  名字里写 `{code}` 就会被下一轮替换成真配对码(对端借本机的弹框伪造配对码)。缺的变量原样留着 `{x}`。 */
function fill(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m))
}

/** 指定语言取文案:该语言缺 → 回落 zh → 再回落 key 本身(与渲染层 translateIn 的 en ?? zh ?? key 同)。 */
export function mtFor(l: MainLocale, key: string, vars?: Record<string, string | number>): string {
  const m = messages.get(key)
  return fill(m?.[l] ?? m?.zh ?? key, vars)
}

/** 按当前生效语言取文案。 */
export function mt(key: string, vars?: Record<string, string | number>): string {
  return mtFor(mainLocale(), key, vars)
}
