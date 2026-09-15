import { beforeEach, describe, expect, it } from 'vitest'
import { useApp } from './appStore'

// C-5:后台 LLM 调用(压缩/子代理/脑暴/判官)发的 usage 事件带 phase,其 prompt 是那次后台调用
// 自己的一小段上下文。没有这道闸,上下文进度条会在每次 delegate/脑暴/压缩时塌成子代理的体量。
const initial = useApp.getState()
const emit = (payload: Record<string, unknown>) =>
  useApp.getState().reduceEvent('s1', 'r1', { current: 'a1' }, { seq: 1, type: 'usage', payload } as never)

beforeEach(() => {
  useApp.setState(initial, true)
  useApp.setState({
    tr: (key) => key,
    messagesBySession: { s1: [] },
    runningBySession: { s1: 'r1' }, // reduceEvent 开头按 runningBySession 认领事件,不种就整条静默丢弃
    // 起点刻意落在成本闸阈值**下方**(80% × 20_000 = 16_000):起点就超阈值的话,即便 phase 闸
    // 整个缺失,预警也不会因为这条事件触发 —— 标题声称的两件事就都没被钉住(评审 #10)。
    usageBySession: { s1: { ctx: 120_000, base: 0, live: 300, runCost: 1_000, costLimit: 20_000 } },
  })
})

// 同一份载荷:带 phase = 后台调用,不带 = 主循环。它带齐 total/costTotal/costLimit,
// 且 costTotal 会把 runCost 从阈值下方顶到上方 —— phase 闸缺失时 ctx/live/runCost 全变、
// 还会多出一条成本预警消息,三处都能暴露回归。
const PAYLOAD = { prompt: 900, completion: 40, cached: 0, cacheReported: true, cost: 3, iteration: 2, total: 940, costTotal: 19_000, costLimit: 20_000 }

describe('usage 事件的 phase 闸', () => {
  it('后台用量不刷上下文/累计,也不触发成本闸提示', () => {
    emit({ ...PAYLOAD, phase: 'delegate' })
    // 整份 usage 状态逐字段不变(不用 toMatchObject:它放行 runCost/costLimit 被后台值改写)。
    expect(useApp.getState().usageBySession.s1).toEqual({ ctx: 120_000, base: 0, live: 300, runCost: 1_000, costLimit: 20_000 })
    expect(useApp.getState().messagesBySession.s1).toEqual([])
  })

  it('负对照:同一份载荷去掉 phase → 上下文/累计/成本全刷新,并弹一次成本预警', () => {
    emit({ ...PAYLOAD })
    expect(useApp.getState().usageBySession.s1).toEqual({ ctx: 900, base: 0, live: 940, runCost: 19_000, costLimit: 20_000 })
    const msgs = useApp.getState().messagesBySession.s1
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('cost.nearCap') // tr 是恒等函数
  })
})
