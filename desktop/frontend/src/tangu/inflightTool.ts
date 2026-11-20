import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'

/**
 * 断在半截的工具调用(中断任务续跑方案 B 6.2 / 6.3)。
 *
 * 引擎边跑边落库:工具执行前先落一条占位结果 `{ tool_call_id, inflight: { state: 'pending' | 'started', sideEffect } }`,
 * 做完再换成真结果。引擎在这中间没了,重开对话时历史里留下的就是这条占位:它**不是**成功,也不是报错 ——
 * 是「没开始 / 结果未知」。在线时被非用户原因打断、没等到结果的调用同样按「结果未知」画。
 *
 * 渲染层把它规整成 `done: true, result: undefined, isError: false` 再挂一个 `inflight`:和老历史里「没有结果的调用」同一种形状
 * (各处卡片 / 产物统计本来就认 result === undefined 不画),通用过程行据 `inflight`(行上 data-inflight)整行退成淡色,
 * 行尾写「没执行 / 被打断 / 结果未知」;展开先说结局,打算做的改动收进折叠(样式在 base.css `.tool-row[data-inflight]`)。
 * `inflight` 的形状与判定在 tangu-agent/src/contracts/inflightTool.ts(ToolEvent 本身这一轮不加这个字段)。
 */
// 占位的形状与判定在契约里(宿主也要用,如 Studio 的改动统计):这里转出给 Tangu 界面各处,下面是界面自己的两件
export { inflightFromResult, inflightOf, isInflightTool, type InflightInfo, type InflightState, type ToolEventWithInflight } from '../../../../tangu-agent/src/contracts/inflightTool'
import { type InflightInfo, type ToolEventWithInflight } from '../../../../tangu-agent/src/contracts/inflightTool'

/** 只读不改的副作用等级(引擎 capabilities.sideEffect):断了也不会留下半截改动。 */
const READ_ONLY = new Set(['none', 'read'])

/** 这一步对人怎么说(i18n key;文案在 ToolGroup)。三分法照方案 6.3:没开始 / 只读断了 / 结果未知。 */
export function inflightTextKey(info: InflightInfo): 'tool.inflight.notRun' | 'tool.inflight.readCut' | 'tool.inflight.unknown' {
  if (info.state === 'pending') return 'tool.inflight.notRun'
  return info.sideEffect && READ_ONLY.has(info.sideEffect) ? 'tool.inflight.readCut' : 'tool.inflight.unknown'
}

/** 在线时被非用户原因打断:还没等到结果的调用改成「结果未知」(和重开对话后的占位同一种画法;历史合并是本地优先,不改就一直挂着没收口)。 */
export function markUnfinishedInflight(events: ToolEvent[] | undefined): ToolEvent[] | undefined {
  if (!events?.some((e) => !e.done)) return events
  return events.map((e) => (e.done ? e : { ...e, done: true, result: undefined, isError: false, inflight: { state: 'started' } } as ToolEventWithInflight))
}
