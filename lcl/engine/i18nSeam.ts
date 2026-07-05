/** 引擎的 i18n 接缝:LCL 不依赖宿主的 i18n 实现,宿主装配期注入自己的 hook(desktop=useI18n)。
 *  缺省恒等 t(key→key),引擎无宿主也可渲染(测试/独立复用)。注入的必须是稳定的 React hook。 */
export interface EngineI18n { t: (key: string, vars?: Record<string, unknown>) => string }

let hook: () => EngineI18n = () => ({ t: (k) => k })

/** 宿主在任何渲染发生前调用一次(如 installEngine 开头)。 */
export function setEngineI18n(h: () => EngineI18n): void { hook = h }

/** 引擎组件内部用;转发到宿主注入的 hook。 */
export function useEngineI18n(): EngineI18n { return hook() }
