// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { DirectProviderConfig } from '../types'
import { addModels, bareModelId, canDropLlm, changeModelKind, isCommonModel, listKindOf, providerModelCount, readProviderStatus, removeModel, setTextOnly, writeProviderStatus } from './providerModels'

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
