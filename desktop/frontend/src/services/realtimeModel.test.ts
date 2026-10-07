import { describe, expect, it } from 'vitest'
import { defaultVoiceFor, effectiveRealtimeModel, isAudioFamily, resolveRealtimeCall } from './realtimeModel'

const cloudModel = { id: 'pr-0a1b', name: 'Forsion Voice', apiModelId: 'qwen3.5-omni-flash-realtime' }
const signedIn = { model: cloudModel, signedIn: true }

describe('语音通话用哪个模型', () => {
  it('从没动过 + 已登录 Forsion + 云端有通话模型 → 默认开,用云端那个', () => {
    expect(effectiveRealtimeModel({ realtimeModelId: '', realtimeModelUnset: true }, signedIn)).toBe('pr-0a1b')
  })
  it('没登录 / 没装 Extend / 云端没开通话 → 不替他开', () => {
    expect(effectiveRealtimeModel({ realtimeModelId: '', realtimeModelUnset: true }, { model: cloudModel, signedIn: false })).toBe('')
    expect(effectiveRealtimeModel({ realtimeModelId: '', realtimeModelUnset: true }, { model: null, signedIn: true })).toBe('')
    expect(effectiveRealtimeModel({ realtimeModelId: '', realtimeModelUnset: true }, { signedIn: true })).toBe('')
  })
  it('用户关掉过(存了空串)→ 登录着也不自己开回来', () => {
    expect(effectiveRealtimeModel({ realtimeModelId: '', realtimeModelUnset: false }, signedIn)).toBe('')
  })
  it('用户选过自己的百炼模型 → 不被云端缺省盖掉', () => {
    expect(effectiveRealtimeModel({ realtimeModelId: 'bailian/qwen3.8-omni-flash-realtime', realtimeModelUnset: false }, signedIn)).toBe('bailian/qwen3.8-omni-flash-realtime')
    // 老引擎 / 老主进程不给 realtimeModelUnset:当作动过,行为和以前一样
    expect(effectiveRealtimeModel({ realtimeModelId: '' }, signedIn)).toBe('')
  })
})

describe('拨出去时的音色', () => {
  it('云端模型没选音色:按上游模型名的家族把缺省音色明说出来(id 是 pr-<hash>,引擎看不出家族)', () => {
    expect(resolveRealtimeCall({ realtimeModelId: '', realtimeModelUnset: true, realtimeVoice: '' }, signedIn)).toEqual({ model: 'pr-0a1b', voice: 'Tina' })
    const audio = { model: { id: 'pr-9z', name: 'Audio', apiModelId: 'qwen-audio-3.1-realtime-plus' }, signedIn: true }
    expect(resolveRealtimeCall({ realtimeModelId: 'pr-9z', realtimeModelUnset: false, realtimeVoice: '' }, audio)).toEqual({ model: 'pr-9z', voice: 'longanqian' })
  })
  it('选了音色就用选的;自带百炼的模型没选音色时留空,交给引擎按 id 定', () => {
    expect(resolveRealtimeCall({ realtimeModelId: 'pr-0a1b', realtimeModelUnset: false, realtimeVoice: 'Cindy' }, signedIn).voice).toBe('Cindy')
    expect(resolveRealtimeCall({ realtimeModelId: 'bailian/qwen-audio-3.1-realtime-plus', realtimeModelUnset: false, realtimeVoice: '' }, signedIn)).toEqual({ model: 'bailian/qwen-audio-3.1-realtime-plus', voice: '' })
    expect(resolveRealtimeCall({ realtimeModelId: '', realtimeModelUnset: false, realtimeVoice: 'Cindy' }, signedIn)).toEqual({ model: '', voice: 'Cindy' })
  })
  it('家族判断:云端看 apiModelId(缺了退回 id),自带的看 id', () => {
    expect(isAudioFamily('pr-9z', { id: 'pr-9z', name: 'x', apiModelId: 'qwen-audio-3.1-realtime-plus' })).toBe(true)
    expect(isAudioFamily('qwen-audio-3.1-realtime-plus', { id: 'qwen-audio-3.1-realtime-plus', name: 'x' })).toBe(true)
    expect(isAudioFamily('bailian/qwen-audio-3.1-realtime-plus', cloudModel)).toBe(true)
    expect(defaultVoiceFor('bailian/qwen3.8-omni-flash-realtime', cloudModel)).toBe('Tina')
  })
})
