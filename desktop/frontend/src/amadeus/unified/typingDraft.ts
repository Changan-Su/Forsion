/**
 * 连续打字期间的本机草稿节拍(max-wait)。
 *
 * 存盘是两级「停手才触发」的防抖(编辑器监听 200ms + 保存 800ms):字与字间隔一直短于 200ms 时两级都被不断重置,
 * 期间既不序列化也不写盘 —— 这时进程崩溃,整段连打的字全丢。这里不动写盘节奏,只在**第一次改动后**起一个计时,
 * 到点就把编辑器此刻的全文存进本机草稿(与失焦 / 隐藏时同一份草稿),计时**不随后续按键重置**,所以连打时每隔
 * 一个间隔至少存一次。写盘成功后草稿按原规则清掉;重开时的「恢复草稿」判断照旧。
 *
 * - 输入法组字中不存(组到一半的拼音不是用户要的字):改成短轮询,组字结束后的下一跳再存 —— 不在 compositionend
 *   里同步存,ProseMirror 要在那之后才提交组字事务。
 * - 大笔记一次存草稿要整篇序列化(外加和盘上基线比对),按上一次的耗时自适应放宽间隔,把开销压在一小比例以内;
 *   间隔有上限,上限就是最坏情况下会丢的时长。
 */

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

/** 连续打字时最迟多久存一次草稿。 */
export const TYPING_DRAFT_MS = 2000
/** 自适应放宽的上限(大笔记一次存草稿很慢时)。 */
export const TYPING_DRAFT_MAX_MS = 10_000
/** 放宽系数:间隔 ≥ 上一次耗时 × 它,即草稿开销不超过打字时间的约 4%。 */
export const TYPING_DRAFT_COST_FACTOR = 25
/** 组字中到点时的复查间隔。 */
export const TYPING_DRAFT_COMPOSE_POLL_MS = 150

export interface TypingDraftDeps {
  /** 存一次草稿(同步)。返回值不影响节拍。 */
  stash: () => void
  /** 此刻是否在输入法组字中。 */
  composing: () => boolean
  /** 此刻不宜存(例如笔记正在挪动、旧路径随时会没):跳过这一跳,下一次改动再起计时。 */
  blocked?: () => boolean
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export interface TypingDraftPacer {
  /** 文档变了(每个改文档的事务都调)。已在计时就什么都不做 —— max-wait 语义。 */
  edit: () => void
  /** 卸载:停掉计时。 */
  dispose: () => void
  /** 当前间隔(测试 / 探针用)。 */
  interval: () => number
}

export function createTypingDraftPacer(deps: TypingDraftDeps): TypingDraftPacer {
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let timer: unknown = null
  let gap = TYPING_DRAFT_MS
  let disposed = false

  const fire = (): void => {
    timer = null
    if (disposed) return
    if (deps.composing()) {
      timer = setTimer(fire, TYPING_DRAFT_COMPOSE_POLL_MS)
      return
    }
    if (deps.blocked?.()) return
    const t0 = now()
    try {
      deps.stash()
    } catch (error) {
      console.warn('[amadeus] typing draft stash failed', error)
    }
    const cost = Math.max(0, now() - t0)
    gap = Math.min(TYPING_DRAFT_MAX_MS, Math.max(TYPING_DRAFT_MS, cost * TYPING_DRAFT_COST_FACTOR))
  }

  return {
    edit: () => {
      if (disposed || timer != null) return
      timer = setTimer(fire, gap)
    },
    dispose: () => {
      disposed = true
      if (timer != null) clearTimer(timer)
      timer = null
    },
    interval: () => gap,
  }
}

/** 每个改了文档的事务都报一声(选区变化不算)。回调经 ref 现读,插件引用保持稳定。 */
export function typingDraftPlugin(onEdit: () => void) {
  return $prose(() => new Plugin({
    view: () => ({
      update: (view, prev) => {
        if (view.state.doc !== prev.doc) onEdit()
      },
    }),
  }))
}
