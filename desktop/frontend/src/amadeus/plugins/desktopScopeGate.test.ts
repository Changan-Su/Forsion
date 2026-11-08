// @vitest-environment happy-dom
// LCL 表面规范第四期:桌面作用域(浮在别的应用上)与跨应用写字只给首方。钉两件事:
//  ① 插件的 ctx.ui.float 没有桌面档 —— 传 'desktop' 同步抛错,不悄悄退成窗口作用域;ctx 上也没有任何听写 / 写字的口子。
//  ② 代码内注册的内置插件标了 defaultOff(全局语音输入):这台设备第一次见到时记成关,之后用户怎么拨算怎么,
//     「见过」清单读不出来时这次按关算、但不写回。
// 负对照(已实跑红):seedDefaultOff 不记「见过」→ ②「用户打开后不会被关回去」红;读失败分支改成 return disabled → ②「读不出来」红。
import { beforeEach, describe, expect, it } from 'vitest'

const { usePluginStore, seedDefaultOff } = await import('./pluginStore')
type Ctx = import('./types').PluginContext
type Plugin = import('./types').AmadeusPlugin

function ctxOf(id: string, over: Partial<Plugin> = {}): Ctx {
  let ref: Ctx | null = null
  usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  usePluginStore.getState().init([{ id, name: id, version: '0', setup: (c) => { ref = c }, ...over }])
  return ref!
}

beforeEach(() => { localStorage.clear() })

describe('desktop scope stays first-party', () => {
  it('ctx.ui.float rejects the desktop scope', () => {
    const ctx = ctxOf('third-party')
    expect(() => ctx.ui!.float!({ scope: 'desktop' as never })).toThrow(/view, space, window/)
    expect(document.querySelector('.lcl-float')).toBeNull()
  })
  it('the plugin context has no dictation / typing seam', () => {
    const ctx = ctxOf('third-party') as unknown as Record<string, unknown>
    expect(ctx.dictation).toBeUndefined()
    expect((ctx.app as Record<string, unknown>).dictation).toBeUndefined()
    expect((ctx.ui as Record<string, unknown>).desktopFloat).toBeUndefined()
  })
})

describe('defaultOff built-ins', () => {
  const builtin = (id: string, defaultOff = true): Plugin => ({ id, name: id, version: '1', builtin: true, defaultOff, setup: () => {} })

  it('first sight: switched off and remembered', () => {
    const next = seedDefaultOff([builtin('voice-input'), builtin('other', false)], ['x'])
    expect(next).toEqual(['x', 'voice-input'])
    expect(JSON.parse(localStorage.getItem('amadeus.plugins.disabled')!)).toEqual(['x', 'voice-input'])
    expect(JSON.parse(localStorage.getItem('amadeus.plugins.defaultOffSeen')!)).toEqual(['voice-input'])
  })
  it('after the user turns it on, the next start keeps it on', () => {
    seedDefaultOff([builtin('voice-input')], [])
    expect(seedDefaultOff([builtin('voice-input')], [])).toEqual([])
  })
  it('only in-code built-ins can be default-off', () => {
    expect(seedDefaultOff([{ ...builtin('ext'), builtin: false }], [])).toEqual([])
  })
  it('an unreadable seen-list counts as off for now and writes nothing back', () => {
    localStorage.setItem('amadeus.plugins.defaultOffSeen', '{broken')
    expect(seedDefaultOff([builtin('voice-input')], ['a'])).toEqual(['a', 'voice-input'])
    expect(localStorage.getItem('amadeus.plugins.disabled')).toBeNull()
    expect(localStorage.getItem('amadeus.plugins.defaultOffSeen')).toBe('{broken')
  })
  it('init() applies it: a default-off built-in does not run', () => {
    let ran = false
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ ...builtin('voice-input'), setup: () => { ran = true } }])
    expect(ran).toBe(false)
    expect(usePluginStore.getState().disabledIds).toContain('voice-input')
  })
})
