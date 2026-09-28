/** 外置后端注册点:注册 / 查 / 列 / 单文件上限夹紧(penzor 搬进 Extend 后宿主只剩这条接缝)。 */
import { afterEach, describe, expect, it } from 'vitest'
import { clampMaxFile, clearRemoteSyncBackends, extraBackend, extraBackendKinds, registerRemoteSyncBackend } from './backends'
import type { RemoteFs } from './types'

const fakeRemote: RemoteFs = {
  kind: 'x',
  walk: async () => [],
  readFile: async () => Buffer.alloc(0),
  writeFile: async (key) => ({ key, size: 0, mtimeMs: 0, id: '1' }),
  rm: async () => {},
  check: async () => ({ ok: true }),
}

afterEach(() => clearRemoteSyncBackends())

describe('remotesync/backends', () => {
  it('注册后按 kind 可查、可列;未注册 = undefined', async () => {
    expect(extraBackend('penzor')).toBeUndefined()
    expect(extraBackendKinds()).toEqual([])
    registerRemoteSyncBackend('penzor', async (section) => ({ remote: fakeRemote, fingerprint: `penzor:${JSON.stringify(section)}`, maxFileBytes: 7 }))
    expect(extraBackendKinds()).toEqual(['penzor'])
    const built = await extraBackend('penzor')!({ vault: 'v' })
    expect(built).toEqual({ remote: fakeRemote, fingerprint: 'penzor:{"vault":"v"}', maxFileBytes: 7 })
  })

  it('clampMaxFile:无硬上限原样;用户不限 → 硬上限;否则取较小', () => {
    expect(clampMaxFile(100, undefined)).toBe(100)
    expect(clampMaxFile(0, undefined)).toBe(0)
    expect(clampMaxFile(0, 50)).toBe(50)
    expect(clampMaxFile(100, 50)).toBe(50)
    expect(clampMaxFile(30, 50)).toBe(30)
  })
})
