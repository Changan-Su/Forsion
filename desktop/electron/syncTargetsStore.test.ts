/**
 * 宿主的 sync-targets 存档(智库同步第 2 步 H 包):读失败 ≠ 空、legacy 封口记录形状不对 = 读不了(按持有处理),
 * 报错只带固定的错误码 —— JSON.parse 的原始报错会带一截文件原文(凭据)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSyncTargetsStore } from './syncTargetsStore'
import { createLegacyGate } from './remotesync/legacySeal'

let dir = ''
const file = (): string => join(dir, 'sync-targets.json')
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forsion-sync-targets-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('sync-targets store', () => {
  it('a present but malformed legacy record is unreadable (so the gate holds), never read as "handed back"', async () => {
    for (const legacy of [{ holder: 'v1' }, { holder: 2 }, { holder: 'v2', archived: 'yes' }, { holder: 'v2', archiveDir: 5 }, { holder: 'v2', archivedAt: 'now' }, { holder: 'v2', targetId: 3 }, []]) {
      writeFileSync(file(), JSON.stringify({ version: 1, targets: {}, legacy }))
      const store = createSyncTargetsStore(file)
      await expect(store.readLegacy(), JSON.stringify(legacy)).rejects.toThrow('sync-targets-malformed')
      const g = createLegacyGate({ loadHold: () => store.readLegacy(), saveHold: async () => {} })
      await g.ready()
      g.extendLoaded(true)
      expect(g.state().hold).toBe('unknown')
      expect(g.blocked()).toBe(true)
    }
    // 缺的字段取缺省;holder 显式 null = 交还着
    writeFileSync(file(), JSON.stringify({ version: 1, targets: {}, legacy: { archived: true } }))
    expect(await createSyncTargetsStore(file).readLegacy()).toEqual({ holder: null, archived: true })
    writeFileSync(file(), JSON.stringify({ version: 1, targets: {}, legacy: { holder: null, archived: false, targetId: null } }))
    expect(await createSyncTargetsStore(file).readLegacy()).toEqual({ holder: null, archived: false })
  })

  it('parse and shape errors carry a fixed code, never the file text', async () => {
    writeFileSync(file(), JSON.stringify({ version: 1, targets: { t: { kind: 's3', label: 'x', section: { secretAccessKey: 'QQQ' } } } }).replace('"QQQ"', 'fixture-secret-value'))
    const store = createSyncTargetsStore(file)
    const e1 = await store.read().catch((e: Error) => e)
    expect((e1 as Error).message).toBe('sync-targets-unparseable')
    expect(String((e1 as Error).stack)).not.toContain('fixture-sec')
    expect((e1 as Error & { cause?: unknown }).cause).toBeUndefined()
    writeFileSync(file(), JSON.stringify({ version: 1, targets: { 'fixture-secret-id': { kind: 'nope', label: 'x', section: {} } } }))
    const e2 = await store.read().catch((e: Error) => e)
    expect((e2 as Error).message).toBe('sync-targets-malformed')
  })
})
