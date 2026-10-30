import { describe, expect, it } from 'vitest'
import { agentName, agentNames } from './agentName'
import { recordToUi, groupSpeakerResolver } from './tangu/store/tanguSlice'
import { soloSessionTitle } from './sessionTitle'
import type { NormalAgentDef } from './types'

const def = (o: Partial<NormalAgentDef>): NormalAgentDef => ({ slug: 'aria', name: 'Aria', nameZh: '浣溪沙', nameEn: 'Aria', description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: '', createdBy: 'system', ...o } as NormalAgentDef)

describe('agentName', () => {
  it('跟随界面:当前语言的名字优先,没有就用另一个', () => {
    expect(agentName(def({}), 'zh')).toBe('浣溪沙')
    expect(agentName(def({}), 'en')).toBe('Aria')
    expect(agentName(def({ nameEn: '' }), 'en')).toBe('浣溪沙')
    expect(agentName(def({ nameZh: '' }), 'zh')).toBe('Aria')
  })
  it('选了固定名字:两种界面都用它', () => {
    expect(agentName(def({ namePref: 'zh' }), 'en')).toBe('浣溪沙')
    expect(agentName(def({ namePref: 'en' }), 'zh')).toBe('Aria')
  })
  it('临时 Agent / 老引擎只有 name;没有定义回空串', () => {
    expect(agentName({ name: 'Temp' }, 'en')).toBe('Temp')
    expect(agentName(undefined)).toBe('')
  })
  it('全部名字去重', () => {
    expect(agentNames(def({ nameZh: 'Coding', nameEn: 'Coding', name: 'Coding' }))).toEqual(['Coding'])
    expect(agentNames(def({ name: '老名字' }))).toEqual(['浣溪沙', 'Aria', '老名字'])
  })
})

// 群聊记录存的是发言当时的显示名,切语言 / 改名之后要靠 slug 回认,否则发言人头像和颜色全丢
describe('群聊发言人回认', () => {
  const speak = (who: string, slug?: string) => ({ id: 'm', role: 'model', content: `**🗣 ${who}**\n\n大家好`, agent_slug: slug })
  const defs = [def({}), def({ slug: 'recita', name: 'Recita', nameZh: '临江仙', nameEn: 'Recita' })]
  const resolve = groupSpeakerResolver(defs, '主持人')
  it('新记录按 agent_slug 认,哪怕前缀里的名字已经对不上', () => {
    expect(recordToUi(speak('早就改掉的名字', 'recita'), resolve)).toMatchObject({ agentId: 'recita', agentName: '临江仙', content: '大家好' })
  })
  it('老记录没有 slug:任一名字或 slug 都认,显示成现在的名字', () => {
    for (const who of ['Aria', '浣溪沙', 'aria']) expect(recordToUi(speak(who), resolve)).toMatchObject({ agentId: 'aria', agentName: '浣溪沙' })
  })
  it('主持人先判:它的记录 agent_slug 是会话 agent;另一种语言写的也认', () => {
    expect(recordToUi(speak('Host', 'aria'), resolve)).toMatchObject({ agentId: '__host__' })
    expect(recordToUi(speak('主持人', 'aria'), groupSpeakerResolver(defs, 'Host'))).toMatchObject({ agentId: '__host__' })
  })
  it('不在册的发言人:名字原样,slug 留着', () => {
    expect(recordToUi(speak('临时工', 'gone'), resolve)).toMatchObject({ agentId: 'gone', agentName: '临时工' })
    expect(recordToUi(speak('临时工'), resolve)).toMatchObject({ agentId: undefined, agentName: '临时工' })
  })
})

describe('私聊标题', () => {
  const t = (k: string) => k
  it('没起过题 / 老会话存的是任一名字:现取显示名', () => {
    for (const title of ['New Chat', '', 'Aria', '浣溪沙']) expect(soloSessionTitle(title, def({}), t)).toBe('浣溪沙')
  })
  it('起过题的原样;没有 Agent 定义时走普通口径', () => {
    expect(soloSessionTitle('讨论周报', def({}), t)).toBe('讨论周报')
    expect(soloSessionTitle('New Chat', undefined, t)).toBe('session.untitled')
  })
})
