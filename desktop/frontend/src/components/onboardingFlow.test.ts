import { describe, expect, it } from 'vitest'
import { stepOrder, updateOrder } from './onboardingFlow'

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
    expect(updateOrder(desktop, '2.13.4', all)).toEqual(['welcome'])
    expect(updateOrder(desktop, '2.14.0', all)).toEqual(['welcome'])
  })
  it('本机没有那项新设置(不支持的系统):那一步不算新', () => {
    expect(updateOrder(desktop, '2.13.3', (step) => step !== 'permissions')).toEqual(['welcome'])
  })
  it('宿主本来就没有那一步:不凭空加出来', () => {
    expect(updateOrder(['welcome', 'theme', 'done'], '2.13.3', all)).toEqual(['welcome'])
  })
})
