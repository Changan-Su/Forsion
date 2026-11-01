import { describe, expect, it } from 'vitest'
import { STEP_SINCE, permissionTabList, permissionsNewHere, stepOrder, updateOrder } from './onboardingFlow'

const desktop = stepOrder({ agentBackend: true, envCheck: true, config: true, permissions: true })

describe('stepOrder', () => {
  it('桌面:后台 Agent 紧挨在权限前一步(Muse 说明里的「下一步」靠这个相邻关系)', () => {
    expect(desktop).toEqual(['welcome', 'connect', 'model', 'theme', 'workspace', 'env', 'background', 'permissions', 'done'])
    expect(desktop.indexOf('permissions') - desktop.indexOf('background')).toBe(1)
  })
  it('按宿主能力收缩', () => {
    expect(stepOrder({ agentBackend: true, envCheck: false, config: true, permissions: false })).toEqual(['welcome', 'background', 'theme', 'done'])
    expect(stepOrder({ agentBackend: false, envCheck: false, config: false, permissions: true })).toEqual(['welcome', 'theme', 'permissions', 'done'])
    expect(stepOrder({ agentBackend: false, envCheck: false, config: false, permissions: false })).toEqual(['welcome', 'theme', 'done'])
  })
})

describe('updateOrder', () => {
  const all = (): boolean => true
  it('从没有电脑历史的版本升上来:更新内容 + 那一步,没有完成页', () => {
    expect(updateOrder(desktop, '2.13.3', all)).toEqual(['welcome', 'permissions'])
    expect(updateOrder(desktop, null, all)).toEqual(['welcome', 'permissions'])
  })
  it('已经看过那一步的版本再升级:只有更新内容一屏', () => {
    expect(updateOrder(desktop, '2.13.8', all)).toEqual(['welcome'])
    expect(updateOrder(desktop, '2.14.0', all)).toEqual(['welcome'])
  })
  it('2.13.8 起「帮助改进」也在这一步:看过电脑历史(2.13.4–2.13.7)的老用户升上来会再看到第 7 步', () => {
    expect(STEP_SINCE.permissions).toBe('2.13.8')
    expect(updateOrder(desktop, '2.13.4', all)).toEqual(['welcome', 'permissions'])
    expect(updateOrder(desktop, '2.13.7', all)).toEqual(['welcome', 'permissions'])
  })
  it('本机没有那项新设置(不支持的系统):那一步不算新', () => {
    expect(updateOrder(desktop, '2.13.3', (step) => step !== 'permissions')).toEqual(['welcome'])
  })
  it('宿主本来就没有那一步:不凭空加出来', () => {
    expect(updateOrder(['welcome', 'theme', 'done'], '2.13.3', all)).toEqual(['welcome'])
  })
})

describe('「权限与数据」的分页与「有没有新内容」', () => {
  it('帮助改进排在语音与媒体之后;没有就不出现', () => {
    expect(permissionTabList({ computer: true, history: true, improve: true })).toEqual(['computer', 'history', 'media', 'improve'])
    expect(permissionTabList({ computer: true, history: true, improve: false })).toEqual(['computer', 'history', 'media'])
    expect(permissionTabList({ computer: false, history: false, improve: true })).toEqual(['media', 'improve'])
  })
  it('升级短引导:有电脑历史或有帮助改进,这一步就算新;两样都没有(Linux 且没有带遥测的 Extend)才不算', () => {
    const order = (o: { history: boolean; improve: boolean }) => updateOrder(desktop, '2.13.4', (s) => s !== 'permissions' || permissionsNewHere(o))
    expect(order({ history: true, improve: false })).toEqual(['welcome', 'permissions'])
    expect(order({ history: false, improve: true })).toEqual(['welcome', 'permissions'])
    expect(order({ history: false, improve: false })).toEqual(['welcome'])
  })
})
