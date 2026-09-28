/**
 * /unit/config 远端写面(评审 A-desktop#3):lastApprovalMode 是本机新会话的缺省审批档,远端只能看不能改。
 * 走真 unitWeb(局域网配对令牌 = lan 入口)+ main.ts 同一份 unitConfigFace,内存 store 代替配置文件。
 * 跑法:npx vitest run electron/unitConfigFace.test.ts
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startUnitWeb, type UnitWebDeps } from './unitWeb'
import { UNIT_CONFIG_RO, UNIT_CONFIG_RW, unitConfigFace } from './unitConfigFace'
import { UNIT_PREFERENCE_KEYS } from '../shared/unitPreferences'

describe('unitConfigFace:审批档远端只读', () => {
  it('键集:lastApprovalMode 在 RO 不在 RW;其余偏好键照旧可写', () => {
    expect(UNIT_CONFIG_RW).not.toContain('lastApprovalMode')
    expect(UNIT_CONFIG_RO).toContain('lastApprovalMode')
    for (const k of UNIT_PREFERENCE_KEYS) if (k !== 'lastApprovalMode') expect(UNIT_CONFIG_RW, k).toContain(k)
  })

  it('P1-K4:远程会话开关 / 审批档上限 / 信任列表的键不在三张表里;设备页垫片也碰不到 remoteSessions', () => {
    for (const k of ['remoteSessionsEnabled', 'remoteSessions', 'remote', 'maxApprovalMode', 'unitHostEnabled']) {
      expect(UNIT_PREFERENCE_KEYS as readonly string[], k).not.toContain(k)
      expect(UNIT_CONFIG_RW, k).not.toContain(k)
      expect(UNIT_CONFIG_RO, k).not.toContain(k)
    }
    expect(readFileSync(join(__dirname, '../../web/src/unitShim.ts'), 'utf8')).not.toMatch(/remoteSessions|maxApprovalMode/)
  })

  it('远端 PUT /unit/config 改不动 lastApprovalMode(也改不动连接键),普通偏好照常写回;GET 仍能读到审批档', async () => {
    const store: Record<string, unknown> = { lastApprovalMode: 'readonly', modelId: 'm1', token: 'LOCAL', homeDir: '/home/me' }
    const saved: Array<Record<string, unknown>> = []
    const face = unitConfigFace({
      effective: async () => ({ ...store }),
      save: async (p) => { saved.push(p); Object.assign(store, p) },
    })
    const token = 'lan-token'
    const deps: UnitWebDeps = {
      getEngine: () => ({ url: null, token: 'E' }),
      confirmPair: async () => false,
      pairedDevices: { list: () => [{ id: 'd', name: 'lan', tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: 0 }], add: async () => {} },
      readPlugins: async () => [],
      readSpaces: async () => [],
      ...face,
      readProviders: async () => [],
      readHostFile: async () => null,
      readHostDir: async () => null,
      readHostStat: async () => null,
      meta: { instanceId: 'i', name: 'n', version: '0' },
      webDistDir: () => null,
      vault: () => null,
      log: () => {},
    }
    const web = await startUnitWeb(deps, { port: 0, bindHost: '127.0.0.1' })
    try {
      const base = `http://127.0.0.1:${web.port}/unit/config`
      const auth = { Authorization: `Bearer ${token}` }
      const put = await fetch(base, { method: 'PUT', headers: auth, body: JSON.stringify({ lastApprovalMode: 'full-auto', modelId: 'm2', token: 'EVIL' }) })
      expect(put.status).toBe(200)
      const back = ((await put.json()) as { config: Record<string, unknown> }).config
      expect(store.lastApprovalMode).toBe('readonly')
      expect(store.token).toBe('LOCAL')
      expect(store.modelId).toBe('m2')
      expect(saved).toEqual([{ modelId: 'm2' }])
      expect(back.lastApprovalMode).toBe('readonly')
      // 只送审批档:一个字节都不落盘
      saved.length = 0
      await fetch(base, { method: 'PUT', headers: auth, body: JSON.stringify({ lastApprovalMode: 'full-auto' }) })
      expect(saved).toEqual([])
      const got = ((await (await fetch(base, { headers: auth })).json()) as { config: Record<string, unknown> }).config
      expect(got).toMatchObject({ lastApprovalMode: 'readonly', modelId: 'm2', homeDir: '/home/me' })
      expect(got.token).toBeUndefined()
      // P1-K4:远端想借配置面打开远程会话 / 抬高远程审批档上限 —— 一个字节都不落盘
      saved.length = 0
      await fetch(base, { method: 'PUT', headers: auth, body: JSON.stringify({ remoteSessionsEnabled: true, remote: { maxApprovalMode: 'full-auto' }, maxApprovalMode: 'full-auto' }) })
      expect(saved).toEqual([])
    } finally {
      await web.close()
    }
  })
})
