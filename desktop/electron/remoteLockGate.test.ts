/** P1 · K2 §3.9:锁定时 unitWeb 放行表(纯函数,表驱动)。 */
import { describe, it, expect } from 'vitest'
import { IPC } from '../shared/amadeus/ipc'
import { lockedEngineAllowed, lockedRequestAllowed, REMOTE_LOCKED_BODY, VAULT_RPC_READ } from './remoteLockGate'
import { VAULT_RPC_ALLOW, VAULT_RPC_LOCAL_ONLY } from './unitWeb'

describe('remoteLockGate', () => {
  it.each([
    ['GET', '/unit/config', true], ['HEAD', '/unit/plugins', true], ['OPTIONS', '/unit/pair/request', true], ['GET', '/', true],
    ['GET', '/unit/remote-access', true], ['POST', '/vault/asset-token', true],
    ['PUT', '/unit/config', false], ['POST', '/unit/pair/request', false], ['POST', '/unit/p2p/offer', false],
    ['POST', '/unit/remote-access/request', false], ['POST', '/unit/mcp', false], ['POST', '/unit/mcp/call', false],
    ['POST', '/vault/asset-token/', false], ['POST', '/VAULT/asset-token', false], ['DELETE', '/unit/config', false], ['post', '/unit/config', false],
  ])('顶层 %s %s → %s', (m, p, want) => {
    expect(lockedRequestAllowed(m, p)).toBe(want)
  })

  it.each([
    ['GET', '/agent/sessions', true], ['HEAD', '/agent/runs/r1/events', true], ['OPTIONS', '/agent/runs', true],
    ['POST', '/agent/runs/r1/abort', true], ['POST', '/Agent/Runs/R1/ABORT', true],
    ['POST', '/agent/runs', false], ['POST', '/agent/runs/r1/approvals/a1', false], ['POST', '/agent/runs/r1/inquiries/i1', false],
    ['POST', '/agent/runs/r1/steer', false], ['DELETE', '/agent/runs/r1/steer/m1', false], ['PATCH', '/agent/sessions/s1', false],
    ['POST', '/agent/runs/r1/abort/x', false], ['POST', '/agent/runs//abort', false], ['POST', '/agent/special/muse/todos/t/approve', false],
  ])('/engine %s %s → %s', (m, p, want) => {
    expect(lockedEngineAllowed(m, p)).toBe(want)
  })

  it('只读通道 ⊆ 远程白名单,且不含写 / 删 / 出网 / 改本机状态的通道', () => {
    for (const ch of VAULT_RPC_READ) expect(VAULT_RPC_ALLOW.has(ch), ch).toBe(true)
    for (const ch of VAULT_RPC_LOCAL_ONLY) expect(VAULT_RPC_READ.has(ch), ch).toBe(false)
    for (const ch of [IPC.savePage, IPC.newPage, IPC.deletePage, IPC.movePage, IPC.renamePage, IPC.saveAsset, IPC.saveVaultBytes, IPC.saveAttachment,
      IPC.dbWrite, IPC.dbWriteCas, IPC.drawingWrite, IPC.writeTextFile, IPC.pluginDataWrite, IPC.trashEntry, IPC.restoreTrash,
      IPC.createFolder, IPC.renameFolder, IPC.deleteFolder, IPC.moveFolder, IPC.reindex, IPC.reconcilePage, IPC.setPageFrontmatter,
      IPC.renamePageFile, IPC.renameDbFile, IPC.patchMark, IPC.restoreVault, IPC.loadPage, IPC.fetchLinkMeta, IPC.searchImages]) {
      expect(VAULT_RPC_READ.has(ch), ch).toBe(false)
    }
    expect(VAULT_RPC_READ.has(IPC.readPage)).toBe(true)
    expect(VAULT_RPC_READ.has(IPC.listPages)).toBe(true)
  })

  it('423 回包码 = REMOTE_LOCKED(与引擎中间件、渲染层 localOnly.ts 同码)', () => {
    expect(REMOTE_LOCKED_BODY.code).toBe('REMOTE_LOCKED')
  })
})
