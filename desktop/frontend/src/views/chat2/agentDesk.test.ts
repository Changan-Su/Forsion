import { describe, it, expect } from 'vitest'
import { deskCardGone } from './AgentDesk'

describe('deskCardGone', () => {
  it('新会话空态不上场(病史:空卡把 Agent 选择器挤歪并压住)', () => {
    expect(deskCardGone(undefined, 0, false)).toBe(true)
  })
  it('聊起来之后空态卡照常在场(用户裁决:卡片不可关)', () => {
    expect(deskCardGone(undefined, 0, true)).toBe(false)
  })
  it('侧板在演时卡片隐身', () => {
    expect(deskCardGone('open', 1, true)).toBe(true)
  })
  it('侧板 open 但内容已散 → 卡片兜底,别双双消失', () => {
    expect(deskCardGone('open', 0, true)).toBe(false)
  })
  it('有内容就上场,哪怕消息还没加载出来(切会话瞬间不闪)', () => {
    expect(deskCardGone(undefined, 1, false)).toBe(false)
  })
})
