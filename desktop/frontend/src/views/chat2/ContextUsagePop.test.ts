import { describe, expect, it } from 'vitest'
import { ctxSegments, msToDailyReset, weeklyResetTime } from './ContextUsagePop'
import type { CtxInfo } from '../../types'

const t = (k: string) => k
const info = (over: Partial<CtxInfo> = {}): CtxInfo => ({
  ctxWindow: 272000, ctxWindowSource: 'model', files: [], filesTruncated: false,
  sections: [{ k: 'persona', tokens: 3000 }, { k: 'memory', tokens: 2000 }, { k: 'brandNew', tokens: 1000 }],
  historyCount: 10, historyTokens: 20000, ...over,
})
const byId = (segs: ReturnType<typeof ctxSegments>) => Object.fromEntries(segs.map((s) => [s.id, s.tokens]))

describe('ctxSegments', () => {
  it('系统段 → 历史 → 余数记「工具与本轮」,总和等于真实占用', () => {
    const segs = ctxSegments(40000, info(), t)
    expect(byId(segs)).toEqual({ messages: 20000, tools: 14000, system: 4000, memory: 2000 })
    expect(segs.reduce((n, s) => n + s.tokens, 0)).toBe(40000)
  })
  it('未知段归进系统提示并显示 key 本身', () => {
    const system = ctxSegments(40000, info(), t).find((s) => s.id === 'system')!
    expect(system.parts!.map((p) => p.label)).toEqual(['ctx.sec.persona', 'brandNew'])
  })
  it('压缩后占用回落到分项估算以下:依次截断,不出负数、不超占用', () => {
    const segs = ctxSegments(8000, info(), t)
    expect(byId(segs)).toEqual({ system: 4000, memory: 2000, messages: 2000 })
    expect(segs.every((s) => s.tokens > 0)).toBe(true)
  })
  it('没有 context_info:只给一段「已用」;占用 0 不画段', () => {
    expect(byId(ctxSegments(5000, null, t))).toEqual({ used: 5000 })
    expect(ctxSegments(0, null, t)).toEqual([])
  })
})

describe('额度重置时间(北京时间 0 点)', () => {
  it('每日:北京 23:30 → 还剩 30 分钟', () => {
    expect(msToDailyReset(Date.UTC(2026, 8, 26, 15, 30))).toBe(30 * 60e3)
  })
  it('每周:YYYY-MM-DD 按北京 0 点落到 UTC 前一天 16:00,不按 UTC 解析', () => {
    expect(weeklyResetTime('2026-10-02')!.toISOString()).toBe('2026-10-01T16:00:00.000Z')
    expect(weeklyResetTime('garbage')).toBeNull()
  })
})

describe('ctxSegments 截断时不列子项', () => {
  it('压缩后系统段被截断:父项只剩占用,子项(旧估算)不再列出', () => {
    const system = ctxSegments(1000, info(), t).find((s) => s.id === 'system')!
    expect(system.tokens).toBe(1000)
    expect(system.parts).toBeUndefined()
  })
})
