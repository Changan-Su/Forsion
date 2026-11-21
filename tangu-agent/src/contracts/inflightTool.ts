import type { ToolEvent } from './clientTypes.js'

/**
 * 断在半截的工具调用的形状(中断任务续跑方案 B 6.2 / 6.3),引擎、Tangu 界面、宿主三方共用。
 *
 * 引擎边跑边落库:工具执行前先在 tool_results 落一条占位 `{ tool_call_id, name, inflight: { state: 'pending' | 'started', sideEffect } }`,
 * 做完再换成真结果(引擎侧见 services/runProgress.ts)。引擎在这中间没了,重开对话时历史里留下的就是这条占位:
 * 它**不是**成功,也不是报错 —— 是「没开始 / 结果未知」。渲染层把它规整成 `done: true, result: undefined, isError: false`
 * 再挂一个 `inflight`(ToolEvent 契约本身这一轮不动),宿主(如 Studio 的改动统计)据此把它当成没写成的一步。
 */
export type InflightState = 'pending' | 'started'
export interface InflightInfo { state: InflightState; sideEffect?: string }
export type ToolEventWithInflight = ToolEvent & { inflight?: InflightInfo }

/** 落库的工具结果是不是占位:形状还可能微调,只认「带一个 inflight 对象」,其余字段尽量读。 */
export function inflightFromResult(res: unknown): InflightInfo | undefined {
  const raw = res && typeof res === 'object' ? (res as { inflight?: unknown }).inflight : undefined
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { state?: unknown; sideEffect?: unknown }
  return {
    state: r.state === 'pending' ? 'pending' : 'started', // 认不出的按「开始了、结果未知」—— 最保守的那种说法
    ...(typeof r.sideEffect === 'string' && r.sideEffect ? { sideEffect: r.sideEffect } : {}),
  }
}

export function inflightOf(ev: ToolEvent): InflightInfo | undefined {
  const v = (ev as ToolEventWithInflight).inflight
  return v && typeof v === 'object' ? v : undefined
}

export const isInflightTool = (ev: ToolEvent): boolean => !!inflightOf(ev)
