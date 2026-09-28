import { describe, expect, it } from 'vitest'
import { secretNoticeView } from './SecretStorageNotice'
import type { SecretStorageStatus } from '../../../shared/secretStorage'

const st = (o: Partial<SecretStorageStatus>): SecretStorageStatus => ({ level: 'os', backend: 'keychain', locked: [], restartRequired: false, lastError: null, ...o })

describe('SecretStorageNotice 判定', () => {
  it('一切正常不渲染', () => {
    expect(secretNoticeView(st({}))).toBeNull()
    expect(secretNoticeView(st({}), 'externalToken')).toBeNull()
  })

  it('macOS 钥匙串被拒绝(unavailable):只给「重启」,不给「重试」也不给「重新登记」(新配对存不下)', () => {
    const v = secretNoticeView(st({ level: 'unavailable', locked: ['unitPairing'], restartRequired: true }))
    expect(v).toEqual({ kind: 'restart', lockedHere: true, canReset: false })
    // 还没有配对(刚打开互联)也要出现:入册存不下
    expect(secretNoticeView(st({ level: 'unavailable', restartRequired: true }))).toMatchObject({ kind: 'restart', lockedHere: false })
  })

  it('解密失败(level=os):重试 + 重新登记', () => {
    expect(secretNoticeView(st({ locked: ['unitPairing'], lastError: 'decrypt-failed' }))).toEqual({ kind: 'locked', lockedHere: true, canReset: true })
  })

  it('Linux 这次没起钥匙串而盘上有加密条目:重启 + 重新登记(Linux 允许明文兼容回落,不会困死)', () => {
    expect(secretNoticeView(st({ level: 'plaintext', backend: 'basic_text', locked: ['unitPairing'], restartRequired: true })))
      .toEqual({ kind: 'restart', lockedHere: true, canReset: true })
  })

  it('Linux 无钥匙串:明文降级提示,无按钮', () => {
    expect(secretNoticeView(st({ level: 'plaintext', backend: 'basic_text' }))).toEqual({ kind: 'plaintext', lockedHere: false, canReset: false })
  })

  it('外部连接面板(slot=externalToken):只在 token 锁定 / 加密不可用时出现;配对锁定、Linux 降级不在这里重复;永不给重新登记', () => {
    expect(secretNoticeView(st({ locked: ['unitPairing'] }), 'externalToken')).toBeNull()
    expect(secretNoticeView(st({ level: 'plaintext', backend: 'basic_text' }), 'externalToken')).toBeNull()
    expect(secretNoticeView(st({ locked: ['externalToken', 'unitPairing'] }), 'externalToken')).toEqual({ kind: 'locked', lockedHere: true, canReset: false })
    expect(secretNoticeView(st({ level: 'unavailable', restartRequired: true }), 'externalToken')).toMatchObject({ kind: 'restart', canReset: false })
  })
})
