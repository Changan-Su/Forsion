/**
 * 订阅直连(codex / xai)凭证过期的识别。
 *
 * 钉住两条不变式:
 * 1. 上游那句英文必须被翻译(此前它未命中任何规则 → 原样甩给用户看英文);
 * 2. 「重新登录」按钮只在**确实是订阅直连**时出现 —— 导错登录入口比不给按钮更坏,
 *    所以 Forsion 云端 / BYO-key 的鉴权错误一律不给。
 */
import { describe, expect, it } from 'vitest'
import { humanizeRunError, subLoginProvider } from './EditorialMessage'

// 用户实测报的原句(codex 直连;xAI 同样句式)
const UPSTREAM = 'Provided authentication token is expired. Please try signing in again.'
const t = (k: string) => k // 只关心命中了哪个 key,不关心译文本身

describe('订阅登录过期', () => {
  it('上游原句命中 chat.err.subExpired,而不是笼统的 chat.err.auth', () => {
    expect(humanizeRunError(UPSTREAM, t)).toContain('chat.err.subExpired')
  })

  it('原文保留在括号里供排查', () => {
    expect(humanizeRunError(UPSTREAM, t)).toContain(UPSTREAM)
  })

  it('模型 id 前缀 = provider id', () => {
    expect(subLoginProvider(UPSTREAM, 'codex/gpt-5.6-sol')).toBe('codex')
    expect(subLoginProvider(UPSTREAM, 'xai/grok-3')).toBe('xai')
  })

  it('不是订阅直连的模型 → 不给按钮(免得把人导去重登直连账号)', () => {
    expect(subLoginProvider(UPSTREAM, 'forsion/claude-sonnet-5')).toBeNull()
    expect(subLoginProvider(UPSTREAM, 'gpt-4o')).toBeNull() // 无前缀
    expect(subLoginProvider(UPSTREAM, undefined)).toBeNull()
  })

  it('别的鉴权错误不算订阅过期 —— Forsion 自家 token 过期要走 /login,不是重登直连账号', () => {
    expect(subLoginProvider('401 Unauthorized', 'codex/gpt-5.6-sol')).toBeNull()
    expect(subLoginProvider('invalid api key', 'codex/gpt-5.6-sol')).toBeNull()
    expect(humanizeRunError('401 Unauthorized', t)).toContain('chat.err.auth')
  })
})
