// 官方商店安装的第二级审核兜底(2026-11-16):声明了 internals-raw 的包,这一版过了审核才装。
// 负对照(已实跑红):assertInternalsRawApproved 里把「读失败 ≠ 放行」那行改成 catch 后 return → 「条目详情拿不到按没过审处理」红。
import { describe, expect, it } from 'vitest'
import { RAW_UNAPPROVED, assertInternalsRawApproved, declaresInternalsRaw } from './marketInternals'

const raw = (version = '1.2.0') => ({ id: 'x', version, capabilities: ['internals', 'internals-raw'] })

describe('assertInternalsRawApproved', () => {
  it('没声明 internals-raw:不问服务端,直接放行', async () => {
    let asked = false
    await assertInternalsRawApproved({ version: '1', capabilities: ['internals'] }, async () => { asked = true; return null })
    expect(asked).toBe(false)
    expect(declaresInternalsRaw(null)).toBe(false)
  })
  it('过审的版本和包里的一致:放行', async () => {
    await expect(assertInternalsRawApproved(raw('1.2.0'), async () => '1.2.0')).resolves.toBeUndefined()
  })
  it('没过审 / 过审的是别的版本:拒', async () => {
    await expect(assertInternalsRawApproved(raw('1.2.0'), async () => null)).rejects.toThrow(RAW_UNAPPROVED)
    await expect(assertInternalsRawApproved(raw('1.2.1'), async () => '1.2.0')).rejects.toThrow(RAW_UNAPPROVED)
  })
  it('条目详情拿不到按没过审处理', async () => {
    await expect(assertInternalsRawApproved(raw(), async () => { throw new Error('offline') })).rejects.toThrow(RAW_UNAPPROVED)
  })
  it('包里没写版本:拒', async () => {
    await expect(assertInternalsRawApproved({ capabilities: ['internals-raw'] }, async () => '')).rejects.toThrow(RAW_UNAPPROVED)
  })
})
