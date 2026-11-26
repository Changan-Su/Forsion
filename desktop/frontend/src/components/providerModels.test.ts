// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { DirectProviderConfig } from '../types'
import { addModels, bareModelId, canDropLlm, changeModelKind, isCommonModel, listKindOf, mutateProvider, scrubKey, providerModelCount, readProviderStatus, removeModel, setTextOnly, writeProviderStatus } from './providerModels'

const base: DirectProviderConfig = {
  providerId: 'or', baseUrl: 'https://x/v1', apiKey: 'k',
  modelIds: ['a/one', 'b/two', 'omni'], asrModelIds: ['omni'], noVisionModelIds: ['b/two'],
}

describe('providerModels', () => {
  it('bare id keeps slashes inside the model name', () => {
    expect(bareModelId('or', 'or/anthropic/claude-opus-5.5')).toBe('anthropic/claude-opus-5.5')
    expect(bareModelId('or', 'other/x')).toBe('other/x')
  })

  it('maps library tabs to the four on-disk lists', () => {
    expect(listKindOf('llm')).toBe('llm')
    expect(listKindOf('image_gen')).toBe('image')
    expect(listKindOf('realtime')).toBeNull()
  })

  it('removing a chat model only touches the chat list and its vision flag', () => {
    const next = removeModel(base, 'llm', 'b/two')
    expect(next.modelIds).toEqual(['a/one', 'omni'])
    expect(next.noVisionModelIds).toBeUndefined()
    expect(next.asrModelIds).toEqual(['omni'])
    expect(base.modelIds).toHaveLength(3) // 不改原对象
  })

  it('never empties the chat list (empty = any model allowed)', () => {
    const one: DirectProviderConfig = { providerId: 'p', baseUrl: 'u', modelIds: ['only'] }
    expect(canDropLlm(one, 'only')).toBe(false)
    expect(() => removeModel(one, 'llm', 'only')).toThrow('last-llm')
    // 重复写了两遍的同名也只算一个
    expect(canDropLlm({ providerId: 'p', baseUrl: 'u', modelIds: ['only', 'only'] }, 'only')).toBe(false)
    // 改类型不拦:只有朗读的连接是正当配置
    expect(changeModelKind(one, 'only', 'llm', 'tts')).toMatchObject({ ttsModelIds: ['only'] })
    expect(changeModelKind(one, 'only', 'llm', 'tts').modelIds).toBeUndefined()
    // 已经不在 from 下(连点两次):拒绝,不挂进第二类
    expect(() => changeModelKind(changeModelKind(one, 'only', 'llm', 'tts'), 'only', 'llm', 'asr')).toThrow('stale')
    // 空名单下随叫随用的模型不在名单里,也不能「移除」
    expect(canDropLlm({ providerId: 'p', baseUrl: 'u' }, 'x')).toBe(false)
  })

  it('removing the last non-chat model drops the field', () => {
    const next = removeModel(base, 'asr', 'omni')
    expect(next.asrModelIds).toBeUndefined()
    expect(next.modelIds).toContain('omni')
  })

  it('changing kind moves between lists and keeps other memberships', () => {
    const next = changeModelKind(base, 'b/two', 'llm', 'tts')
    expect(next.modelIds).toEqual(['a/one', 'omni'])
    expect(next.ttsModelIds).toEqual(['b/two'])
    expect(next.noVisionModelIds).toBeUndefined()
  })

  it('vision flag toggles the deny list', () => {
    expect(setTextOnly(base, 'a/one', true).noVisionModelIds).toEqual(['b/two', 'a/one'])
    expect(setTextOnly(base, 'b/two', false).noVisionModelIds).toBeUndefined()
  })

  it('adds picks by guessed kind, skips known and unsupported ones', () => {
    const next = addModels(base, [{ id: 'openai/gpt-6.1' }, { id: 'qwen3-tts-flash' }, { id: 'a/one' }, { id: 'text-embedding-4' }, { id: 'x/y-realtime' }])
    expect(next.modelIds).toEqual(['a/one', 'b/two', 'omni', 'openai/gpt-6.1'])
    expect(next.ttsModelIds).toEqual(['qwen3-tts-flash'])
    expect(providerModelCount(next)).toBe(5)
  })

  it('picks out mainstream recent models as common', () => {
    expect(isCommonModel('anthropic/claude-opus-5.5')).toBe(true)
    expect(isCommonModel('openai/gpt-6.1')).toBe(true)
    expect(isCommonModel('deepseek/deepseek-v4-pro')).toBe(true)
    expect(isCommonModel('nousresearch/hermes-5-70b')).toBe(false)
    expect(isCommonModel('google/gemini-3-pro-preview')).toBe(false)
  })
})

it('scrubs an echoed key from probe messages', () => {
  expect(scrubKey('401 bad key sk-abcdef123456 rejected', 'sk-abcdef123456')).toBe('401 bad key …3456 rejected')
  expect(scrubKey('timeout', 'sk-abcdef123456')).toBe('timeout')
})

describe('provider status store', () => {
  beforeEach(() => localStorage.clear())
  it('round-trips and treats garbage as unknown', () => {
    writeProviderStatus('or', { ok: false, at: 5, message: '401' })
    expect(readProviderStatus()).toEqual({ or: { ok: false, at: 5, message: '401' } })
    localStorage.setItem('forsion.providerStatus.v1', '{bad')
    expect(readProviderStatus()).toEqual({})
    localStorage.setItem('forsion.providerStatus.v1', JSON.stringify({ x: { ok: 'yes' } }))
    expect(readProviderStatus()).toEqual({})
  })
})

describe('mutateProvider', () => {
  // 假宿主:盘上一份 providers,list / save 都异步(save 慢一点,模拟连点两下时第一笔还没写完)
  const fake = (initial: DirectProviderConfig[]) => {
    let disk = structuredClone(initial)
    const saves: DirectProviderConfig[] = []
    ;(window as unknown as { tangu: unknown }).tangu = {
      listProviders: async () => structuredClone(disk),
      saveProvider: async (cp: DirectProviderConfig) => {
        await new Promise((r) => setTimeout(r, 10))
        saves.push(cp)
        disk = [...disk.filter((x) => x.providerId !== cp.providerId), cp]
        return structuredClone(disk)
      },
    }
    return { saves, disk: () => disk }
  }

  it('two quick edits both land (each reads the latest record)', async () => {
    const f = fake([base])
    await Promise.all([
      mutateProvider('or', (cur) => removeModel(cur, 'llm', 'a/one')),
      mutateProvider('or', (cur) => setTextOnly(cur, 'omni', true)),
    ])
    const cur = f.disk().find((x) => x.providerId === 'or')!
    expect(cur.modelIds).toEqual(['b/two', 'omni'])
    expect(cur.noVisionModelIds).toEqual(['b/two', 'omni'])
    expect(cur.apiKey).toBe('k')
  })

  it('writes nothing when the provider is gone, and uses fallback only for a new one', async () => {
    const f = fake([])
    await expect(mutateProvider('or', (cur) => cur)).rejects.toThrow('provider-gone')
    expect(f.saves).toHaveLength(0)
    await mutateProvider('new', (cur) => addModels(cur, [{ id: 'gpt-6.1' }]), { providerId: 'new', baseUrl: 'u', apiKey: 'k2' })
    expect(f.disk()).toEqual([{ providerId: 'new', baseUrl: 'u', apiKey: 'k2', modelIds: ['gpt-6.1'] }])
    // 新建时同名已存在:不并进去
    await expect(mutateProvider('new', (cur) => addModels(cur, [{ id: 'x' }]), { providerId: 'new', baseUrl: 'other', apiKey: 'k3' })).rejects.toThrow('provider-exists')
    expect(f.saves).toHaveLength(1)
  })

  it('a refused edit does not jam the queue', async () => {
    const f = fake([{ providerId: 'p', baseUrl: 'u', modelIds: ['only'] }])
    await expect(mutateProvider('p', (cur) => removeModel(cur, 'llm', 'only'))).rejects.toThrow('last-llm')
    await mutateProvider('p', (cur) => addModels(cur, [{ id: 'second' }]))
    expect(f.disk()[0].modelIds).toEqual(['only', 'second'])
    expect(f.saves).toHaveLength(1)
  })
})
