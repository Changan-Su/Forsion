/**
 * 委托管理员的单一问法与审批档换算(services/delegatedAdmin.ts)。
 * 跑:cd desktop && npx vitest run frontend/src/services/delegatedAdmin.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest'
import { approvalModeSelectable, delegatedAdminName, delegatedApprovalField, isDelegatedAdmin, noteApprovalCap, useDelegatedApprovalCap } from './delegatedAdmin'

const OPTIONS = ['', 'readonly', 'auto-edit', 'full-auto', 'custom'].map((value) => ({ value, label: value || 'follow' }))
const setTangu = (t: Record<string, unknown> | undefined): void => { (globalThis as any).window = t === undefined ? {} : { tangu: t } }
afterEach(() => { delete (globalThis as any).window; useDelegatedApprovalCap.setState({ cap: null }) })

describe('isDelegatedAdmin', () => {
  it('缺省 false:桌面 / 手机 / 普通网页 / 别的 Unit 来路都不设这个键', () => {
    setTangu(undefined)
    expect(isDelegatedAdmin()).toBe(false)
    setTangu({ platform: 'darwin' })
    expect(isDelegatedAdmin()).toBe(false)
    setTangu({ mobile: true, delegatedAdmin: { name: 'x' } }) // 没有 unitPage:不算(这个角色只存在于 Unit 网页)
    expect(isDelegatedAdmin()).toBe(false)
    setTangu({ unitPage: true, remoteCaller: true })
    expect(isDelegatedAdmin()).toBe(false)
  })
  it('Unit 网页 + 角色键:true,显示名照给', () => {
    setTangu({ unitPage: true, delegatedAdmin: { name: 'Alex' } })
    expect(isDelegatedAdmin()).toBe(true)
    expect(delegatedAdminName()).toBe('Alex')
  })
})

describe('审批档上限', () => {
  it('noteApprovalCap 只在这个角色下记,只收三档', () => {
    setTangu({ unitPage: true })
    noteApprovalCap('auto-edit')
    expect(useDelegatedApprovalCap.getState().cap).toBeNull()
    setTangu({ unitPage: true, delegatedAdmin: { name: '' } })
    noteApprovalCap('custom')
    expect(useDelegatedApprovalCap.getState().cap).toBeNull()
    noteApprovalCap('auto-edit')
    expect(useDelegatedApprovalCap.getState().cap).toBe('auto-edit')
  })
  it('approvalModeSelectable:不超过上限;空与 custom 恒不可选;上限未知只放 readonly', () => {
    expect(['readonly', 'auto-edit', 'full-auto'].map((m) => approvalModeSelectable(m, 'auto-edit'))).toEqual([true, true, false])
    expect(approvalModeSelectable('', 'full-auto')).toBe(false)
    expect(approvalModeSelectable('custom', 'full-auto')).toBe(false)
    expect(['readonly', 'auto-edit'].map((m) => approvalModeSelectable(m, null))).toEqual([true, false])
  })
  it('delegatedApprovalField:不给「跟随会话」;存值为空显示成上限那档;custom 只读', () => {
    const empty = delegatedApprovalField('', 'auto-edit', OPTIONS)
    expect(empty.value).toBe('auto-edit')
    expect(empty.options.map((o) => o.value)).toEqual(['readonly', 'auto-edit'])
    expect(empty.disabled).toBe(false)
    expect(delegatedApprovalField(undefined, null, OPTIONS)).toMatchObject({ value: 'readonly' })
    const custom = delegatedApprovalField('custom', 'auto-edit', OPTIONS)
    expect(custom).toMatchObject({ value: 'custom', disabled: true })
    expect(custom.options.map((o) => o.value)).toEqual(['readonly', 'auto-edit', 'custom'])
    expect(custom.options.find((o) => o.value === 'custom')?.disabled).toBe(true)
    expect(delegatedApprovalField('full-auto', 'full-auto', OPTIONS).options.map((o) => o.value)).toEqual(['readonly', 'auto-edit', 'full-auto'])
  })
  it('超出上限的当前值只作不可选的展示(上限没读到 / 上限后来降了)', () => {
    const unknownCap = delegatedApprovalField('auto-edit', null, OPTIONS)
    expect(unknownCap.value).toBe('auto-edit')
    expect(unknownCap.options.map((o) => [o.value, !!o.disabled])).toEqual([['readonly', false], ['auto-edit', true]])
    const lowered = delegatedApprovalField('full-auto', 'auto-edit', OPTIONS)
    expect(lowered.value).toBe('full-auto')
    expect(lowered.options.map((o) => [o.value, !!o.disabled])).toEqual([['readonly', false], ['auto-edit', false], ['full-auto', true]])
    expect(lowered.disabled).toBe(false)
    // 在上限内的当前值照常可选
    expect(delegatedApprovalField('readonly', 'auto-edit', OPTIONS).options.every((o) => !o.disabled)).toBe(true)
  })
})
