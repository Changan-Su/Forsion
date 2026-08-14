// ctx.getLocale / ctx.subscribeLocale(2026-08-14 起,codex 评审定的纪律)。
// 这里钉的是**生命周期**那半:插件订了语言变更,禁用之后必须收干净 —— 宿主是最终责任人,
// 不能指望第三方插件的 disposer 写对(块表面同款设计)。
import { describe, expect, it, beforeEach } from 'vitest'
import { usePluginStore } from './pluginStore'
import { setLocaleGlobal, currentLocale } from '../../i18n'
import type { AmadeusPlugin, PluginContext } from './types'

function fakePlugin(id: string, onLocale: (l: string) => void, keepOwnDisposer = false): AmadeusPlugin {
  return {
    id,
    name: id,
    version: '0',
    setup: (ctx: PluginContext) => {
      const off = ctx.subscribeLocale?.((l) => onLocale(l))
      return keepOwnDisposer ? () => off?.() : undefined
    },
  }
}

describe('插件语言接缝', () => {
  beforeEach(() => {
    setLocaleGlobal('zh')
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
  })

  it('getLocale 与宿主同步;subscribeLocale 只报变化', () => {
    const seen: string[] = []
    let ctxRef: PluginContext | null = null
    usePluginStore.getState().init([
      { id: 'p1', name: 'p1', version: '0', setup: (ctx) => { ctxRef = ctx; ctx.subscribeLocale?.((l) => seen.push(l)) } },
    ])
    expect(ctxRef!.getLocale?.()).toBe('zh')
    setLocaleGlobal('en')
    expect(ctxRef!.getLocale?.()).toBe('en')
    expect(currentLocale()).toBe('en')
    setLocaleGlobal('en') // 同值不重播
    expect(seen).toEqual(['en'])
  })

  it('⚠️插件禁用后宿主统一收订阅(插件自己没写 disposer 也要收)', () => {
    const seen: string[] = []
    usePluginStore.getState().init([fakePlugin('p2', (l) => seen.push(l))])
    setLocaleGlobal('en')
    expect(seen).toEqual(['en'])
    usePluginStore.getState().disable('p2')
    setLocaleGlobal('zh')
    expect(seen).toEqual(['en']) // 禁用后不再收到
  })

  it('setup 抛错的插件也不留订阅', () => {
    const seen: string[] = []
    usePluginStore.getState().init([
      {
        id: 'p3', name: 'p3', version: '0',
        setup: (ctx) => { ctx.subscribeLocale?.((l) => seen.push(l)); throw new Error('boom') },
      },
    ])
    setLocaleGlobal('en')
    expect(seen).toEqual([])
  })

  it('插件自己退订是幂等的(退订后再 disable 不炸)', () => {
    const seen: string[] = []
    usePluginStore.getState().init([fakePlugin('p4', (l) => seen.push(l), true)])
    usePluginStore.getState().disable('p4') // 自己的 disposer 先 off,宿主再收一遍
    setLocaleGlobal('en')
    expect(seen).toEqual([])
  })
})
