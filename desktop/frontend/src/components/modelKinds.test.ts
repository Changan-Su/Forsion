import { describe, expect, it } from 'vitest'
import { catalogByKind, guessProviderModelKind, mergeFetched, originOf, providerFieldsFromRows, rowsFromProvider, FETCH_ENABLE_LIMIT } from './modelKinds'

describe('guessProviderModelKind', () => {
  it.each([
    ['qwen3.8-max', 'llm'], ['deepseek-flash', 'llm'], ['openai/gpt-6-luna', 'llm'],
    ['qwen3-tts-flash', 'tts'], ['FunAudioLLM/CosyVoice2-0.5B', 'tts'], ['gpt-4o-mini-tts', 'tts'], ['gemini-3.8-flash-tts', 'tts'],
    ['qwen3-asr-flash', 'asr'], ['whisper-1', 'asr'], ['gpt-transcribe', 'asr'], ['paraformer-v2', 'asr'],
    ['wan2.5-t2i-preview', 'image'], ['gpt-image-2', 'image'], ['black-forest-labs/FLUX.1-dev', 'image'], ['nano-banana-2', 'image'],
    ['qwen3.5-omni-flash-realtime', 'off'], ['gemini-3.8-live', 'off'], ['qwen-mt-plus', 'off'], ['text-embedding-3-large', 'off'], ['bge-reranker-v2', 'off'],
  ])('%s → %s', (id, kind) => expect(guessProviderModelKind(id)).toBe(kind))
})

describe('provider rows', () => {
  it('round-trips the on-disk fields', () => {
    const p = { modelIds: ['a', 'b'], imageModelIds: ['img'], ttsModelIds: ['t'], asrModelIds: ['s'], noVisionModelIds: ['b'] }
    expect(providerFieldsFromRows(rowsFromProvider(p))).toEqual(p)
  })
  it('writes undefined for empty kinds so an empty whitelist still means any model', () => {
    expect(providerFieldsFromRows([{ id: 'x', kind: 'off', textOnly: true }])).toEqual({ modelIds: undefined, imageModelIds: undefined, ttsModelIds: undefined, asrModelIds: undefined, noVisionModelIds: undefined })
  })
  it('text-only only counts for chat rows', () => {
    expect(providerFieldsFromRows([{ id: 't', kind: 'tts', textOnly: true }]).noVisionModelIds).toBeUndefined()
  })
  it('keeps a text-only list that has no rows (empty whitelist) on a plain save', () => {
    const p = { noVisionModelIds: ['deepseek-chat'] }
    expect(providerFieldsFromRows(rowsFromProvider(p), p).noVisionModelIds).toEqual(['deepseek-chat'])
    expect(mergeFetched([], ['deepseek-chat'], p.noVisionModelIds)[0].textOnly).toBe(true)
  })
  it('keeps the other kinds of an untouched model, drops them once its kind changes', () => {
    const p = { modelIds: ['omni'], asrModelIds: ['omni'] }
    const rows = rowsFromProvider(p)
    expect(providerFieldsFromRows(rows, p)).toMatchObject({ modelIds: ['omni'], asrModelIds: ['omni'] })
    expect(providerFieldsFromRows(rows.map((r) => ({ ...r, kind: 'tts' as const })), p)).toMatchObject({ modelIds: undefined, asrModelIds: undefined, ttsModelIds: ['omni'] })
    expect(providerFieldsFromRows(rows.map((r) => ({ ...r, kind: 'off' as const })), p)).toMatchObject({ modelIds: undefined, asrModelIds: undefined })
  })
  it('keeps existing rows and guesses new ones', () => {
    const rows = mergeFetched([{ id: 'qwen3-tts-flash', kind: 'llm', textOnly: false, orig: 'llm' }], ['qwen3-tts-flash', 'qwen3-asr-flash', 'qwen3.8-max'])
    expect(rows.map((r) => [r.id, r.kind])).toEqual([['qwen3-tts-flash', 'llm'], ['qwen3-asr-flash', 'asr'], ['qwen3.8-max', 'llm']])
  })
  it('leaves new chat models off when a fetch returns a lot', () => {
    const ids = Array.from({ length: FETCH_ENABLE_LIMIT + 1 }, (_, i) => `m${i}`)
    const rows = mergeFetched([], [...ids, 'some-tts'])
    expect(rows.filter((r) => r.kind === 'llm')).toHaveLength(0)
    expect(rows.find((r) => r.id === 'some-tts')?.kind).toBe('tts')
  })
})

describe('catalogByKind', () => {
  it('folds the side lists into seven kinds', () => {
    const c = catalogByKind({
      models: [{ id: 'a', name: 'A', provider: 'forsion', source: 'forsion' }, { id: 'i', name: 'I', provider: 'forsion', source: 'forsion', modelType: 'image_gen' }, { id: 's', name: 'S', provider: 'p', source: 'direct', modelType: 'asr' }],
      directProviders: [{ providerId: 'bailian', ttsModelIds: ['qwen3-tts-flash'] }],
      defaultModelId: null,
      ttsModels: [{ id: 'tts1', name: 'TTS' }], translateModels: [{ id: 'mt1', name: 'MT' }], realtimeModel: { id: 'rt', name: 'RT' }, fimModels: [{ id: 'fim1', name: 'FIM' }],
    }, [{ id: 'bailian/omni', name: 'omni', provider: 'bailian' }])
    expect(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.map((x) => x.id)]))).toEqual({
      llm: ['a'], image_gen: ['i'], asr: ['s'], tts: ['tts1', 'bailian/qwen3-tts-flash'], realtime: ['rt', 'bailian/omni'], mt: ['mt1'], fim: ['fim1'],
    })
  })
})

describe('originOf', () => {
  it('tells cloud, own key and subscription apart', () => {
    expect(originOf({ source: 'forsion', provider: 'x' }, [])).toBe('cloud')
    expect(originOf({ source: 'direct', provider: 'deepseek' }, ['codex'])).toBe('key')
    expect(originOf({ source: 'direct', provider: 'codex' }, ['codex'])).toBe('sub')
  })
})
