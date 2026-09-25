/** 引擎的 i18n 接缝:LCL 不依赖宿主的 i18n 实现,宿主装配期注入自己的 hook(desktop=useI18n)
 *  与非 hook 的翻译函数(desktop=translate)。
 *
 *  - 组件内一律 `useEngineI18n().t(...)`:走宿主 hook = 订阅宿主语言,切语言当场重渲。
 *    (旧写法 `document.documentElement.lang.startsWith('zh') ? … : …` 不订阅语言,切完要等下次
 *    偶然重渲才变,而且双语字面量散在各处,i18nCoverage 管不到。)
 *  - 非组件处(命令 title 的懒求值、class 组件、事件回调)用 `engineTr(...)`。
 *  - 引擎自己的 `lcl.*` 文案住 engineMessages.ts;宿主把它 registerMessages 进自己的字典。
 *    没注入宿主(测试 / vite 台架 / 未装配的独立窗口)或宿主字典里缺键时,按 `<html lang>` 从那份表兜底,
 *    不会渲染出裸键。注入的 hook 必须是稳定的 React hook。 */
import { LCL_MESSAGES } from './engineMessages'

export interface EngineI18n { t: (key: string, vars?: Record<string, unknown>) => string }
type Tr = (key: string, vars?: Record<string, unknown>) => string

function interpolate(s: string, vars?: Record<string, unknown>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

/** 引擎自带表的兜底翻译(按 `<html lang>` 选语言);表里没有就原样返回 key。 */
function builtin(key: string, vars?: Record<string, unknown>): string {
  const m = LCL_MESSAGES[key]
  if (!m) return interpolate(key, vars)
  let zh = false
  try { zh = document.documentElement.lang.startsWith('zh') } catch { /* 无 DOM(node 测试):按英文 */ }
  return interpolate(zh ? m.zh : m.en, vars)
}

/** 宿主翻译回了裸键(= 宿主字典没这条)且引擎表里有 → 用引擎表兜底。 */
const withFallback = (tr: Tr): Tr => (key, vars) => {
  const out = tr(key, vars)
  return out === key && key in LCL_MESSAGES ? builtin(key, vars) : out
}

let hook: () => EngineI18n = () => ({ t: builtin })
let plain: Tr = builtin

/** 宿主在任何渲染发生前调用一次(如 installEngine 开头)。tr = 非 hook 的翻译(供 engineTr)。 */
export function setEngineI18n(h: () => EngineI18n, tr?: Tr): void {
  hook = () => {
    const { t } = h()
    return { t: withFallback(t) }
  }
  if (tr) plain = withFallback(tr)
}

/** 引擎组件内部用;转发到宿主注入的 hook(订阅宿主语言)。 */
export function useEngineI18n(): EngineI18n { return hook() }

/** 非 hook 翻译:命令 title 懒求值、class 组件、事件回调里用。读宿主的模块级语言快照。 */
export function engineTr(key: string, vars?: Record<string, unknown>): string { return plain(key, vars) }
