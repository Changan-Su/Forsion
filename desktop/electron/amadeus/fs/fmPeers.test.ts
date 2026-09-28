// 外科写 frontmatter 的跨窗回灌(评审 G1-05,2026-09-27 评审波次 0b)。
// setPageFrontmatter 走原子写 + 自写账本 → watcher 的回声被压掉,别的窗口开着这篇的 v4 实例停在旧 fm,
// 下一次击键把刚改的属性整篇写回旧值。主进程这一半:写成功后与 writeTextFile 同口径,给**发起窗口以外**的
// 窗口发 externalChange;Unit RPC 起源(event=null)、没改动(补丁后与原文相同)、非笔记文件都不发。
// 负对照(实跑过):摘掉 setPageFrontmatter 里的 notifyPeers → 两条都红。
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '@amadeus-shared/ipc'

vi.mock('electron', () => ({ dialog: {} }))

const { VaultManager } = await import('./vaultManager')
const { VaultIndex } = await import('./vaultIndex')
const { registerVaultHandlers } = await import('./vaultHandlers')

type Handler = (event: unknown, ...args: unknown[]) => unknown
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-fmpeers-'))
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
  const setFm = (event: unknown, rel: string, patch: Record<string, unknown>) => handlers.get(IPC.setPageFrontmatter)!(event, rel, patch)
  const disk = (rel: string) => fs.readFile(path.join(root, rel), 'utf8')
  return { root, setFm, disk, peers }
}

describe('setPageFrontmatter 的跨窗回灌(G1-05)', () => {
  it('渲染层起源写成功 → 给别的窗口发 externalChange(发起者身份原样交给 notifyPeers 排除)', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'n.md'), '---\nstatus: todo\n---\n\n正文\n')
    const sender = { sender: 'window-1' }
    await h.setFm(sender, 'n.md', { status: 'done' })
    expect(await h.disk('n.md')).toContain('status: done')
    expect(h.peers).toEqual([{ origin: sender, channel: IPC.externalChange, payload: 'n.md' }])
  })

  it('RPC 起源 / 补丁后原文不变 / 笔记不在 / 非笔记文件都不发', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'n.md'), '---\nstatus: done\n---\n\n正文\n')
    await fs.writeFile(path.join(h.root, 'board.excalidraw.md'), '---\nx: 1\n---\n')
    const sender = { sender: 'window-1' }
    await h.setFm(null, 'n.md', { status: 'todo' }) // Unit RPC:本机广播归 vaultFace.call 的映射
    await h.setFm(sender, 'n.md', { status: 'wip' }) // 这发真写了 → 发一次
    await h.setFm(sender, 'n.md', { status: 'wip' }) // 没改动:不写、不发
    await h.setFm(sender, 'gone.md', { status: 'x' }) // 笔记不在:静默跳过
    await h.setFm(sender, 'board.excalidraw.md', { x: 2 }) // 画板不是笔记
    expect(h.peers).toEqual([{ origin: sender, channel: IPC.externalChange, payload: 'n.md' }])
  })
})
