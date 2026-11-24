// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { engineTranslate } from './engineTranslate'
import {
  __resetTranslationEnginesForTest, activeTranslationEngine, chosenEngineKey, listTranslationEngines, registerTranslationEngine,
  setChosenEngine, subscribeTranslationChoice, TRANSLATE_ENGINE_PREF,
} from '../amadeus/plugins/translationEngines'

const reg = (impl: (req: { text: string; to: string; before?: string }) => string | Promise<string>, opts: { id?: string; ready?: () => boolean } = {}) => {
  const calls: Array<{ text: string; to: string; before?: string }> = []
  const off = registerTranslationEngine('translation', {
    id: opts.id ?? 'deepl', name: { zh: 'DeepL', en: 'DeepL' }, ready: opts.ready,
    translate: async (req) => { calls.push({ text: req.text, to: req.to, before: req.before }); return impl(req) },
  })
  return { calls, off }
}

beforeEach(() => { localStorage.clear(); __resetTranslationEnginesForTest() })
afterEach(() => { localStorage.clear(); __resetTranslationEnginesForTest() })

describe('translation engine registry', () => {
  it('routes only when the chosen engine is registered and ready', () => {
    expect(activeTranslationEngine()).toEqual({})
    setChosenEngine('translation:deepl')
    expect(activeTranslationEngine()).toEqual({}) // 选了但没登记(插件停用 / 手机)= 当没选
    let ready = false
    const { off } = reg(() => 'x', { ready: () => ready })
    expect(activeTranslationEngine().unavailable?.key).toBe('translation:deepl')
    expect(listTranslationEngines({ readyOnly: true })).toHaveLength(0)
    ready = true
    expect(activeTranslationEngine().engine?.key).toBe('translation:deepl')
    off()
    expect(activeTranslationEngine()).toEqual({})
    expect(chosenEngineKey()).toBe('translation:deepl') // 撤销登记不改用户的选择
  })

  it('notifies subscribers on register, unregister and choice changes', () => {
    let n = 0
    const unsub = subscribeTranslationChoice(() => { n++ })
    const { off } = reg(() => 'x')
    setChosenEngine('translation:deepl')
    setChosenEngine(null)
    off()
    unsub()
    setChosenEngine('translation:deepl')
    expect(n).toBe(4)
    expect(localStorage.getItem(TRANSLATE_ENGINE_PREF)).toBe('translation:deepl')
  })

  it('a replaced registration is not removed by the old disposer', () => {
    const a = reg(() => 'a')
    reg(() => 'b')
    a.off()
    expect(listTranslationEngines()).toHaveLength(1)
  })
})

describe('engineTranslate', () => {
  it('protects formulas and code, restores them, and names the engine', async () => {
    const { calls } = reg((req) => req.text.replace('The value', '取值').replace('is', '是'))
    const engine = listTranslationEngines()[0]
    let streamed = ''
    const r = await engineTranslate(engine, { action: 'translate', selection: 'The value $x^2$ is `code`', language: 'Chinese (Simplified)', before: 'Prev.' }, { onDelta: (d) => { streamed += d } })
    expect(calls[0].text).not.toContain('$x^2$')
    expect(calls[0].text).toMatch(/ZXQ[0-9a-f]{8}_0QXZ/)
    expect(calls[0].before).toBe('Prev.')
    expect(calls[0].to).toBe('Chinese (Simplified)')
    expect(r.text).toBe('取值 $x^2$ 是 `code`')
    expect(streamed).toBe(r.text)
    expect(r.model).toEqual({ id: 'engine:translation:deepl', name: 'DeepL', mt: true, engine: true })
  })

  it('retries once when markers are lost, then reports translation_format_lost', async () => {
    const { calls } = reg(() => 'lost everything')
    await expect(engineTranslate(listTranslationEngines()[0], { action: 'translate', selection: 'a $b$ c', language: 'English' }, {}))
      .rejects.toMatchObject({ code: 'translation_format_lost' })
    expect(calls).toHaveLength(2)
  })

  it('an empty answer for text with formulas takes the format-retry path', async () => {
    const { calls } = reg(() => '')
    await expect(engineTranslate(listTranslationEngines()[0], { action: 'translate', selection: 'a $b$ c', language: 'English' }, {}))
      .rejects.toMatchObject({ code: 'translation_format_lost' })
    expect(calls).toHaveLength(2)
  })

  it('passes the engine message through with a code', async () => {
    reg(() => { throw new Error('DeepL 没有翻：密钥无效（HTTP 403）') })
    await expect(engineTranslate(listTranslationEngines()[0], { action: 'translate', selection: 'hello', language: 'English' }, {}))
      .rejects.toMatchObject({ code: 'translation_engine_failed', message: 'DeepL 没有翻：密钥无效（HTTP 403）', engine: 'DeepL' })
  })

  it('treats an empty answer as a failure, and an abort as an abort', async () => {
    reg(() => '  ')
    await expect(engineTranslate(listTranslationEngines()[0], { action: 'translate', selection: 'hello', language: 'English' }, {}))
      .rejects.toMatchObject({ code: 'translation_engine_failed' })
    __resetTranslationEnginesForTest()
    const ac = new AbortController()
    reg(() => { ac.abort(); throw new Error('aborted by fetch') })
    await expect(engineTranslate(listTranslationEngines()[0], { action: 'translate', selection: 'hello', language: 'English' }, { signal: ac.signal }))
      .rejects.not.toMatchObject({ code: 'translation_engine_failed' })
  })
})
