// 「添加」菜单的原生半屏(Android):会话多到装不下时不递截断的名单(原生搜索只在递过去的那份里找,
// 第 301 条以后的会话就永远搜不到),而是整页回落到搜全量的 Web 二级面板。评审 2026-10-02。
import { describe, expect, it } from 'vitest'
import { NATIVE_ALL_SESSIONS_CAP, nativeSessionPage } from './AddContentMenu'

const sessions = (n: number): Array<{ id: string }> => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }))

describe('nativeSessionPage', () => {
  it('fits: recent first, the rest without duplicates, nothing dropped', () => {
    const all = sessions(10)
    const page = nativeSessionPage([all[7], all[2]], all)
    expect(page?.recent.map((s) => s.id)).toEqual(['s7', 's2'])
    expect(page?.rest.map((s) => s.id)).toEqual(['s0', 's1', 's3', 's4', 's5', 's6', 's8', 's9'])
  })
  it('exactly at the cap still goes native; one more ⇒ null (web pane), never a truncated list', () => {
    const recent = sessions(6)
    const atCap = [...recent, ...Array.from({ length: NATIVE_ALL_SESSIONS_CAP }, (_, i) => ({ id: `x${i}` }))]
    const page = nativeSessionPage(recent, atCap)
    expect(page?.rest).toHaveLength(NATIVE_ALL_SESSIONS_CAP)
    expect(page?.rest.at(-1)?.id).toBe(`x${NATIVE_ALL_SESSIONS_CAP - 1}`)
    expect(nativeSessionPage(recent, [...atCap, { id: 'one-too-many' }])).toBeNull()
    expect(nativeSessionPage([], sessions(5), 4)).toBeNull()
  })
})
