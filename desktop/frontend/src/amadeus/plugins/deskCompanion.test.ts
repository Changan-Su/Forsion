// deskCompanion 注册表的 handle 身份(09-19):同 key 再注册 = 替换,**被替换的旧 handle 变哑**。
// 跨 ctx 世代的变哑在 deskCtx.test.ts(pluginStore 的 ctxAlive 包装);这里钉同一世代内、注册表自己那层。
// 负对照(已实跑红):update / dispose 退回按 key 认领(`e.key === key`)→「旧 handle 撤不掉新条目 / 翻不动新条目的模式」红;
// update 换出新对象却不跟着换 handle 名下的条目 →「连续 update 都生效」红。
import { describe, expect, it, beforeEach } from 'vitest'
import { registerDeskCompanion, activeDeskCompanion, __resetDeskCompanions } from './deskCompanion'

const def = (mode: 'idle' | 'always' = 'idle') => ({ id: 'avatar', mode, mount: () => {} })

beforeEach(() => __resetDeskCompanions())

describe('registerDeskCompanion 的 handle 身份', () => {
  it('同 key 再注册只留一份,新条目生效', () => {
    registerDeskCompanion('p', def('idle'))
    registerDeskCompanion('p', def('always'))
    expect(activeDeskCompanion()).toMatchObject({ key: 'plugin:p:avatar', mode: 'always' })
  })

  it('先注册新的再 dispose 旧的:旧 handle 撤不掉新条目', () => {
    const h1 = registerDeskCompanion('p', def('idle'))
    registerDeskCompanion('p', def('always'))
    h1.dispose()
    expect(activeDeskCompanion()).toMatchObject({ key: 'plugin:p:avatar', mode: 'always' })
  })

  it('旧 handle 迟到的 update 翻不动新条目的模式', () => {
    const h1 = registerDeskCompanion('p', def('idle'))
    registerDeskCompanion('p', def('idle'))
    h1.update({ mode: 'always' })
    expect(activeDeskCompanion()?.mode).toBe('idle')
  })

  it('当前 handle:连续 update 都生效(条目换对象后仍认得自己),dispose 后退回前一个', () => {
    registerDeskCompanion('other', { ...def('idle'), id: 'base' })
    const h = registerDeskCompanion('p', def('idle'))
    h.update({ mode: 'always' })
    const after1 = activeDeskCompanion()
    expect(after1).toMatchObject({ key: 'plugin:p:avatar', mode: 'always' })
    h.update({ mode: 'idle' })
    expect(activeDeskCompanion()).toMatchObject({ key: 'plugin:p:avatar', mode: 'idle' })
    expect(activeDeskCompanion()).not.toBe(after1) // 换新对象 → useDeskCompanion 订阅者重渲染
    h.dispose()
    expect(activeDeskCompanion()?.key).toBe('plugin:other:base')
    h.update({ mode: 'always' }) // dispose 之后不复活
    expect(activeDeskCompanion()).toMatchObject({ key: 'plugin:other:base', mode: 'idle' })
  })
})
