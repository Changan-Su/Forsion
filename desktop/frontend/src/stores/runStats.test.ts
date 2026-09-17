import { describe, expect, it } from 'vitest'
import { finishRunStats, inRunWindow, stepRunStats, type RunStats } from './runStats'

const base: RunStats = { runId: 'r1', startedAt: 0, tokens: 0, thinkMs: 0, thinkTracked: true }

describe('run stats', () => {
  it('accumulates thinking across segments and freezes on finish', () => {
    let rs = stepRunStats(base, { type: 'reasoning', payload: { delta: 'a' } }, 1000)
    expect(stepRunStats(rs, { type: 'reasoning', payload: { delta: 'b' } }, 1500)).toBe(rs) // 后续 delta 不改起点
    rs = stepRunStats(rs, { type: 'token', payload: { delta: 'x' } }, 4000)
    expect(rs).toMatchObject({ thinkMs: 3000, thinkSince: undefined })
    expect(stepRunStats(rs, { type: 'token', payload: { delta: 'y' } }, 4100)).toBe(rs) // 非思考期的 token 零开销
    rs = stepRunStats(rs, { type: 'reasoning' }, 10_000) // 工具回来后再次思考
    rs = finishRunStats(rs, 12_000) // 思考中被停止:这段也要结算
    expect(rs).toMatchObject({ thinkMs: 5000, thinkSince: undefined, finishedAt: 12_000 })
    expect(finishRunStats(rs, 99_000)).toBe(rs)
  })

  it.each(['tool_stream', 'tool_call', 'turn_boundary', 'done', 'error'])('%s ends a thinking segment at that moment', (type) => {
    const thinking = stepRunStats(base, { type: 'reasoning' }, 1000)
    expect(stepRunStats(thinking, { type, payload: {} }, 2500)).toMatchObject({ thinkMs: 1500, thinkSince: undefined })
  })

  it('takes run-cumulative tokens from usage, ignoring background phases', () => {
    let rs = stepRunStats(base, { type: 'usage', payload: { total: 1200 } }, 1)
    expect(rs.tokens).toBe(1200)
    rs = stepRunStats(rs, { type: 'usage', payload: { phase: 'compaction', prompt: 50, total: 99_999 } }, 2)
    expect(rs.tokens).toBe(1200)
    rs = stepRunStats(rs, { type: 'usage', payload: { total: 5400 } }, 3)
    expect(rs.tokens).toBe(5400)
  })

  it('closes a thinking segment when the model call ends without output', () => {
    let rs = stepRunStats(base, { type: 'reasoning' }, 0)
    rs = stepRunStats(rs, { type: 'status', payload: { phase: 'llm_call' } }, 500)
    expect(rs.thinkSince).toBe(0)
    rs = stepRunStats(rs, { type: 'usage', payload: { total: 10 } }, 2000)
    expect(rs).toMatchObject({ thinkMs: 2000, tokens: 10, thinkSince: undefined })
  })

  it('only claims bubbles created during the run', () => {
    const live = { ...base, startedAt: 10_000 }
    expect(inRunWindow(live, 9_999)).toBe(false) // 回退后剩下的上一轮回复
    expect(inRunWindow(live, 10_000)).toBe(true)
    expect(inRunWindow(live, 10_000_000)).toBe(true)
    const done = finishRunStats(live, 20_000)
    expect(inRunWindow(done, 24_000)).toBe(true) // 远端时钟偏差内
    expect(inRunWindow(done, 60_000)).toBe(false) // 轮询并进来的他端新回复
  })
})
