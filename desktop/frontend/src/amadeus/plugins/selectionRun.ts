/**
 * 划线动作一次 run 的宿主侧上下文(2026-11-22,翻译改随包核心插件后 Codex 评审补):按 run 拿到的 `cx.signal` 认。
 *
 * 宿主自己的「翻译」请求一直带着两样插件 run 拿不到的东西:笔记里选区前后的文字与页面说明(术语表之类),以及
 * 结果卡头「谁译的」署名。翻译改由插件 `translation` 接管后,插件只交回字符串,这两样就丢了。这里补一条宿主内部的
 * 侧路:宿主跑插件动作前按那次的 signal 登记一份上下文;插件在 run 里把 `cx.signal` 原样交给 `ctx.tangu.translate` /
 * `complete` 时,宿主把上下文补进**自己的**模型请求,并把真正出结果的模型记回来给卡署名。
 *
 * 插件本身拿不到这些字段(只进宿主发出的请求),也只认登记时的那个插件 —— 别的插件拿到同一个 signal 也对不上。
 * WeakMap:signal 随卡 / 请求结束被回收,不用手动清。
 */
export interface SelectionRunModel { id?: string; name: string; mt?: boolean }

export interface SelectionRunContext {
  /** 这次 run 属于哪个插件;只有它自己的 ctx.tangu 调用会用上这份上下文。 */
  readonly pluginId: string
  readonly before?: string
  readonly after?: string
  readonly title?: string
  readonly pagePath?: string
  readonly pageInstructions?: string
  /** 结果卡「用 Forsion 模型重试」:这次 run 里插件调的 ctx.tangu.translate 跳过本机选的翻译引擎(2026-11-24)。 */
  readonly noEngine?: boolean
  /** 宿主在请求返回后写回:这次真正出结果的模型(给卡头署名)。 */
  model?: SelectionRunModel
}

const runs = new WeakMap<AbortSignal, SelectionRunContext>()

/** 跑插件动作前登记。返回同一个对象,run 结束后读它的 `model`。 */
export function bindSelectionRun(signal: AbortSignal, cx: SelectionRunContext): SelectionRunContext {
  runs.set(signal, cx)
  return cx
}

/** run 结束(出结果 / 出错)就撤掉:插件把旧 signal 存起来、下一次 run 里再交回来,也对不上那次的周边内容。 */
export function unbindSelectionRun(signal: AbortSignal): void {
  runs.delete(signal)
}

/** ctx.tangu 的请求里带的 signal 是不是这个插件某次划线 run 的那个;是就给它的上下文。 */
export function selectionRunOf(signal: unknown, pluginId: string): SelectionRunContext | undefined {
  if (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal)) return undefined
  const r = runs.get(signal)
  return r && r.pluginId === pluginId ? r : undefined
}
