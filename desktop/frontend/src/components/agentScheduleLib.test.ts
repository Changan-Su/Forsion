import { describe, expect, it } from 'vitest'
import { nextOccurrence, triggerWakes } from './agentScheduleLib'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

describe('nextOccurrence', () => {
  it('未来的锚点就是下一次(含带结束时间的区间写法)', () => {
    expect(nextOccurrence({ date: '2026-09-20T09:00/2026-09-20T10:00', repeat: '' }, at(2026, 9, 19))?.getTime()).toBe(at(2026, 9, 20, 9))
  })
  it('重复项从锚点滚到当前时刻之后的第一格;刚好压线算这一格', () => {
    expect(nextOccurrence({ date: '2026-09-01T09:00', repeat: '1d' }, at(2026, 9, 19, 9, 1))?.getTime()).toBe(at(2026, 9, 20, 9))
    expect(nextOccurrence({ date: '2026-09-01T09:00', repeat: '3h' }, at(2026, 9, 1, 15))?.getTime()).toBe(at(2026, 9, 1, 15))
  })
  it('一次性且已过 / 无日期 / 重复写法不合法 → null', () => {
    expect(nextOccurrence({ date: '2026-09-01', repeat: '' }, at(2026, 9, 19))).toBeNull()
    expect(nextOccurrence({ date: '', repeat: '1d' }, at(2026, 9, 19))).toBeNull()
    expect(nextOccurrence({ date: '2026-09-01', repeat: 'weekly' }, at(2026, 9, 19))).toBeNull()
  })
})

describe('triggerWakes', () => {
  it('动作链看 agent_run;旧式规则看 agentSlug,缺省是 Muse', () => {
    expect(triggerWakes({ actions: [{ type: 'notify', title: 'x' }, { type: 'agent_run', agentSlug: 'research', prompt: 'p' }] }, 'research')).toBe(true)
    expect(triggerWakes({ actions: [{ type: 'notify', title: 'x' }], agentSlug: 'research' }, 'research')).toBe(false)
    expect(triggerWakes({ agentSlug: 'research' }, 'research')).toBe(true)
    expect(triggerWakes({}, 'muse')).toBe(true)
    expect(triggerWakes({}, 'research')).toBe(false)
  })
})
