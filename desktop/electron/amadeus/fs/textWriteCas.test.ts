// writeTextFile 的比对交换写 + 跨窗回灌(G1-01,2026-09-27 评审波次 0a)。
// 同篇多开时陈旧实例拿旧全文盲写,把别处刚写的内容整篇盖掉 —— 主进程这一半的契约:
//  ① 带 base 且盘上指纹不符 → 不写,把现文交回;文件不在 = 无冲突;不带 base = 与从前逐字一致(返回 undefined)。
//  ② 两个窗口的 CAS 写同时进来,「读→比对→写」不许交错(否则两边都比对通过、先写的被静默盖掉)。
//  ③ 写成功后给**除发起窗口以外**的窗口发 externalChange(自写账本是整个进程一本,watcher 回声被压掉了);
//     Unit RPC 起源(event=null)不在这里发;非笔记文件不发。
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'

vi.mock('electron', () => ({ dialog: {} }))

const { VaultManager } = await import('./vaultManager')
const { VaultIndex } = await import('./vaultIndex')
const { registerVaultHandlers } = await import('./vaultHandlers')

type Handler = (event: unknown, ...args: unknown[]) => unknown
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-textcas-'))
  const vault = new VaultManager()
  vault.setRoot(root)
  const index = new VaultIndex(vault)
  await index.build()
  const handlers = new Map<string, Handler>()
  const peers: Array<{ origin: unknown; channel: string; payload: unknown }> = []
  registerVaultHandlers({
    vault, index,
    handle: (channel, fn) => { handlers.set(channel, fn as Handler) },
    rememberPage: async () => {},
    notifyAll: () => {},
    notifyPeers: (origin, channel, payload) => { peers.push({ origin, channel, payload }) },
  })
  const write = (event: unknown, ...args: unknown[]) => handlers.get(IPC.writeTextFile)!(event, ...args)
  const disk = (rel: string) => fs.readFile(path.join(root, rel), 'utf8')
  return { root, write, disk, peers }
}

describe('writeTextFile CAS(G1-01)', () => {
  it('不带 base:照旧无条件写,返回 undefined(老调用方与不支持 CAS 的宿主语义不变)', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'a.md'), 'disk')
    expect(await h.write(null, 'a.md', 'blind')).toBeUndefined()
    expect(await h.disk('a.md')).toBe('blind')
    // create 是云桥的语义:本地写盘忽略它
    expect(await h.write(null, 'a.md', 'again', { create: true })).toBeUndefined()
    expect(await h.disk('a.md')).toBe('again')
  })

  it('base 与盘上一致 → 写,回 ok:true;不一致 → 不写,回盘上现文', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'a.md'), 'v1')
    expect(await h.write(null, 'a.md', 'v2', { base: textFingerprint('v1') })).toEqual({ ok: true })
    expect(await h.disk('a.md')).toBe('v2')
    // 陈旧实例还以为盘上是 v1
    expect(await h.write(null, 'a.md', 'stale', { base: textFingerprint('v1') })).toEqual({ ok: false, current: 'v2' })
    expect(await h.disk('a.md')).toBe('v2')
  })

  it('文件不在 = 无冲突(删了再写 = 重建)', async () => {
    const h = await setup()
    expect(await h.write(null, 'gone.md', 'reborn', { base: textFingerprint('whatever') })).toEqual({ ok: true })
    expect(await h.disk('gone.md')).toBe('reborn')
  })

  it('两个窗口同基线并发 CAS:只有一个写得进去,另一个拿到对方的内容(不许交错成双双成功)', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'race.md'), 'base')
    const b = textFingerprint('base')
    const [r1, r2] = await Promise.all([
      h.write({ sender: 'w1' }, 'race.md', 'from-w1', { base: b }),
      h.write({ sender: 'w2' }, 'race.md', 'from-w2', { base: b }),
    ])
    expect(r1).toEqual({ ok: true })
    expect(r2).toEqual({ ok: false, current: 'from-w1' })
    expect(await h.disk('race.md')).toBe('from-w1')
  })

  it('写成功后只对渲染层起源发 peers 回灌;RPC 起源、被拒的写、非笔记文件都不发', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'n.md'), 'v1')
    const sender = { sender: 'window-1' }
    await h.write(sender, 'n.md', 'v2', { base: textFingerprint('v1') })
    expect(h.peers).toEqual([{ origin: sender, channel: IPC.externalChange, payload: 'n.md' }])
    await h.write(sender, 'n.md', 'stale', { base: textFingerprint('v1') }) // 被拒:没写就不该通知
    await h.write(null, 'n.md', 'rpc') // Unit RPC 起源:本机广播归 vaultFace.call 的映射
    await h.write(sender, 'data.json', '{}') // 非笔记
    await h.write(sender, 'board.excalidraw.md', 'x') // 画板不是笔记
    expect(h.peers).toHaveLength(1)
  })
})
