import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineMainMessages, initMainLocale, mainLocale, mainLocaleOverride, mt, mtFor, onMainLocaleChange, setMainLocale } from './mainI18n'

const MSG = defineMainMessages({
  'main.test.hello': { zh: '你好，{name}', en: 'Hello, {name}' },
  'main.test.pair': { zh: '「{name}」配对码：{code}', en: '{name} pairing code: {code}' },
})

afterEach(() => {
  setMainLocale(null)
  initMainLocale({ systemLanguages: () => [] })
})

describe('mainI18n', () => {
  it('解析链:界面覆盖 > 系统 zh* > en;非法值等于跟随系统', () => {
    initMainLocale({ systemLanguages: () => ['zh-Hans-CN', 'en-US'] })
    expect(mainLocale()).toBe('zh')
    setMainLocale('en')
    expect(mainLocale()).toBe('en')
    expect(mainLocaleOverride()).toBe('en')
    setMainLocale('fr') // 非 zh/en = 没设
    expect(mainLocaleOverride()).toBeNull()
    expect(mainLocale()).toBe('zh')
    setMainLocale('zh')
    initMainLocale({ systemLanguages: () => ['en-US'] })
    expect(mainLocale()).toBe('zh') // 覆盖优先于系统
    setMainLocale(null)
    expect(mainLocale()).toBe('en')
    initMainLocale({ systemLanguages: () => ['zh-Hant-TW'] })
    expect(mainLocale()).toBe('zh')
    initMainLocale({ systemLanguages: () => { throw new Error('boom') } })
    expect(mainLocale()).toBe('en') // 取不到系统语言 = en,不抛
  })

  it('变更回调只在生效语言变化时触发,可退订', () => {
    initMainLocale({ systemLanguages: () => ['zh-CN'] })
    const cb = vi.fn()
    const off = onMainLocaleChange(cb)
    setMainLocale('zh') // 覆盖值变了,但生效语言仍是 zh → 不回调
    expect(cb).not.toHaveBeenCalled()
    setMainLocale('en')
    expect(cb).toHaveBeenLastCalledWith('en')
    setMainLocale('en') // 同值
    expect(cb).toHaveBeenCalledTimes(1)
    setMainLocale(null) // 回到跟随系统 = zh
    expect(cb).toHaveBeenLastCalledWith('zh')
    initMainLocale({ systemLanguages: () => ['en-GB'] }) // 系统语言来源变了也算
    expect(cb).toHaveBeenLastCalledWith('en')
    off()
    setMainLocale('zh')
    expect(cb).toHaveBeenCalledTimes(3)
  })

  it('mt 占位符替换;缺的变量原样保留;语言跟随当前生效值', () => {
    initMainLocale({ systemLanguages: () => ['zh-CN'] })
    expect(mt('main.test.hello', { name: 'Ada' })).toBe('你好，Ada')
    setMainLocale('en')
    expect(mt('main.test.hello', { name: 'Ada' })).toBe('Hello, Ada')
    expect(mt('main.test.hello')).toBe('Hello, {name}')
    expect(mtFor('zh', 'main.test.hello', { name: 3 })).toBe('你好，3')
  })

  it('单趟替换:变量值里的 {code} 不会被二次替换成真配对码', () => {
    // 对端自报的设备名是不可信输入;逐变量 .replace 会让名字里的 `{code}` 被下一轮换成真码。
    expect(mtFor('zh', 'main.test.pair', { name: '{code}', code: '123456' })).toBe('「{code}」配对码：123456')
    expect(mtFor('en', 'main.test.pair', { name: '{code}', code: '123456' })).toBe('{code} pairing code: 123456')
  })

  it('缺 en 回落 zh 再回落 key', () => {
    defineMainMessages({ 'main.test.zhOnly': { zh: '仅中文', en: undefined as unknown as string } })
    expect(mtFor('en', 'main.test.zhOnly')).toBe('仅中文')
    expect(mtFor('en', 'main.test.missing')).toBe('main.test.missing')
    expect(mtFor('zh', 'main.test.missing')).toBe('main.test.missing')
  })

  it('defineMainMessages 原样返回传入对象', () => {
    const frag = { 'main.test.same': { zh: '同', en: 'Same' } }
    expect(defineMainMessages(frag)).toBe(frag)
    expect(MSG['main.test.hello'].en).toBe('Hello, {name}')
  })
})
