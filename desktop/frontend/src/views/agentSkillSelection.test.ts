import { describe, it, expect } from 'vitest'
import { nextExtraSelection } from './agentSkillSelection'

describe('nextExtraSelection', () => {
  it('「自动」(未配置)与「关闭」(空清单)下勾选不生效:不许一次点击就把技能固化成清单', () => {
    expect(nextExtraSelection(undefined, 'local:@coding/review', false)).toBeNull()
    expect(nextExtraSelection(null, 'skill_1', true)).toBeNull()
    expect(nextExtraSelection([], 'skill_1', true)).toBeNull()
  })
  it('「自选」下照常增删,不重复', () => {
    expect(nextExtraSelection(['local:a'], 'local:@coding/review', true)).toEqual(['local:a', 'local:@coding/review'])
    expect(nextExtraSelection(['local:a', 'x'], 'x', true)).toEqual(['local:a', 'x'])
    expect(nextExtraSelection(['local:a', 'x'], 'x', false)).toEqual(['local:a'])
  })
})
