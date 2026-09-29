// writeTextFile 的比对交换写 + 跨窗回灌(G1-01,2026-09-27 评审波次 0a)。
// 同篇多开时陈旧实例拿旧全文盲写,把别处刚写的内容整篇盖掉 —— 主进程这一半的契约:
//  ① 带 base 且盘上指纹不符 → 不写,把现文交回;文件不在 → 不写、current:null(不重建被删的旧路径,Codex 复核 inst P0-2);
//     不带 base = 与从前逐字一致(返回 undefined,可新建)。
//  ② 两个窗口的 CAS 写同时进来,「读→比对→写」不许交错(否则两边都比对通过、先写的被静默盖掉)。
//  ③ 写成功后给**除发起窗口以外**的窗口发 externalChange(自写账本是整个进程一本,watcher 回声被压掉了);
//     Unit RPC 起源(event=null)不在这里发;非笔记文件不发。
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { setFmExtraOnSource } from '@amadeus-shared/db/pageFrontmatter'

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
  return { root, write, disk, peers, vault, handlers }
}

describe('writeTextFile CAS(G1-01)', () => {
  it('不带 base:照旧无条件写,返回 undefined(老调用方与不支持 CAS 的宿主语义不变)', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'a.md'), 'disk')
    expect(await h.write(null, 'a.md', 'blind')).toBeUndefined()
    expect(await h.disk('a.md')).toBe('blind')
  })

  // Codex 复核返修 P1-1 / P0-2:create = 原子的仅新建(优先于 base)。新建笔记(birthNoteFile 带空串基线)此前被
  // 「带 base + ENOENT 拒写」拦下;冲突副本「查空位 → 写」跨窗口会互相盖掉。负对照(实跑过):删掉 create 分支 → 本组红。
  it('create:不存在 → 建、回 ok:true(带 base 也照建);已存在 → 不写、交回现文;两发同名并发只有一个建成', async () => {
    const h = await setup()
    expect(await h.write(null, 'sub/new.md', '', { create: true, base: textFingerprint('') })).toEqual({ ok: true })
    expect(await h.disk('sub/new.md')).toBe('')
    await fs.writeFile(path.join(h.root, 'a.md'), 'mine')
    expect(await h.write(null, 'a.md', 'again', { create: true })).toEqual({ ok: false, current: 'mine' })
    expect(await h.disk('a.md')).toBe('mine')
    const [r1, r2] = await Promise.all([
      h.write({ sender: 'w1' }, 'copy.md', 'from-w1', { create: true }),
      h.write({ sender: 'w2' }, 'copy.md', 'from-w2', { create: true }),
    ])
    const won = (r1 as { ok: boolean }).ok ? 'from-w1' : 'from-w2'
    expect([r1, r2].filter((r) => (r as { ok: boolean }).ok)).toHaveLength(1)
    expect([r1, r2]).toContainEqual({ ok: false, current: won })
    expect(await h.disk('copy.md')).toBe(won)
    // 跨进程(两个 VaultManager 同一库根,不共享路径锁):只剩 `wx` 在守,仍只有一个建成
    const other = new VaultManager()
    other.setRoot(h.root)
    const both = await Promise.allSettled([h.vault.createTextFile('x.md', 'p1'), other.createTextFile('x.md', 'p2')])
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('EEXIST')
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

  // Codex 复核 inst P0-2:A 的 CAS 写已发往主进程、B 随后把文件删了 —— 旧口径「不在 = 无冲突」把旧路径重建出来。
  // 负对照(实跑过):换回 `cur = null` 放行 → 本条红。
  it('带 base 而文件已不在 → 拒写、current:null,绝不重建被删的旧路径;不带 base 的新建照旧', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'gone.md'), 'v1')
    await fs.rm(path.join(h.root, 'gone.md')) // 别处删了
    expect(await h.write({ sender: 'w1' }, 'gone.md', 'reborn', { base: textFingerprint('v1') })).toEqual({ ok: false, current: null })
    await expect(h.disk('gone.md')).rejects.toThrow(/ENOENT/)
    expect(h.peers).toEqual([]) // 没写就不通知
    expect(await h.write(null, 'fresh.md', 'new note')).toBeUndefined() // 真新建:不带 base
    expect(await h.disk('fresh.md')).toBe('new note')
  })

  // Codex g3#4:只有 ENOENT 才算「文件不在」。文件本身读不了(权限 / I/O 错误)而目录仍可写时,原子 rename
  // 照样能把它盖掉 —— 基线没验证就丢了盘上版本。其余读错一律拒写(抛给渲染层,走写失败提示 + 退避重试)。
  // 负对照(实跑过):改回 `catch { cur = null }` → 本条红。
  it('读盘失败但不是 ENOENT(EACCES / EIO)→ 拒写抛错,盘上原文一个字节不动;不带 base 的盲写不读盘、照旧写', async () => {
    const h = await setup()
    const abs = path.join(h.root, 'locked.md')
    await fs.writeFile(abs, 'precious')
    const realRead = fs.readFile.bind(fs)
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      if (String(p) === abs) return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      return (realRead as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as typeof fs.readFile)
    try {
      await expect(h.write({ sender: 'w1' }, 'locked.md', 'clobber', { base: textFingerprint('precious') })).rejects.toThrow(/EACCES/)
      expect(await realRead(abs, 'utf8')).toBe('precious')
      expect(h.peers).toEqual([]) // 没写就不通知
      await h.write(null, 'locked.md', 'blind') // 不带 base = 从前的盲写语义,不读盘
      expect(await realRead(abs, 'utf8')).toBe('blind')
    } finally {
      spy.mockRestore()
    }
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

// Codex 复核返修 P0-3:物理改名 / 移动 / 移入回收站不在路径锁里 —— CAS 保存读完基线、正要原子写的那一刻文件被挪走,
// 写照样落到旧路径 = 旧名复活成幽灵笔记(新路径还是保存前的旧内容)。时序做法:拦住保存那一发写(按内容认)到改名排上之后。
// 负对照(实跑过):改名 / 回收站的锁摘掉 → 对应条红。
describe('改名 / 移入回收站与在途 CAS 保存互斥(Codex 复核返修 P0-3)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const holdSave = (h: Awaited<ReturnType<typeof setup>>, text: string) => {
    const real = h.vault.writeTextFile.bind(h.vault)
    vi.spyOn(h.vault, 'writeTextFile').mockImplementation(async (rel: string, t: string) => {
      if (t === text) await sleep(120) // 保存已过比对、卡在写之前:改名在这段里发起
      return real(rel, t)
    })
  }
  const exists = (h: Awaited<ReturnType<typeof setup>>, rel: string) => fs.access(path.join(h.root, rel)).then(() => true, () => false)

  it('renamePageFile:等在途保存落盘再搬 —— 旧名不复活,新名是保存后的内容', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 'n.md'), 'v1')
    holdSave(h, 'v2')
    const saving = h.write({ sender: 'w1' }, 'n.md', 'v2', { base: textFingerprint('v1') })
    await sleep(20)
    const renaming = h.handlers.get(IPC.renamePageFile)!(null, 'n.md', 'm')
    const [saved, renamed] = await Promise.all([saving, renaming])
    expect(saved).toEqual({ ok: true })
    expect(renamed).toBe('m.md')
    expect(await exists(h, 'n.md')).toBe(false)
    expect(await h.disk('m.md')).toBe('v2')
  })

  it('trashEntry:等在途保存落盘再移入回收站 —— 旧名不复活', async () => {
    const h = await setup()
    await fs.writeFile(path.join(h.root, 't.md'), 'v1')
    holdSave(h, 'v2')
    const saving = h.write({ sender: 'w1' }, 't.md', 'v2', { base: textFingerprint('v1') })
    await sleep(20)
    await Promise.all([saving, h.handlers.get(IPC.trashEntry)!(null, 't.md')])
    expect(await exists(h, 't.md')).toBe(false)
  })
})

// Codex g3#2:CAS 的路径锁起初只包住 writeTextFile。Bases 属性写(setPageFrontmatter)、待办就地勾(patchMark)是同一篇
// .md 的「读→改→写」:它读到旧全文,编辑器随即 CAS 写入新正文(比对通过、回 ok:true),它再把旧正文连同补丁写回 →
// 新正文静默丢失,编辑器毫不知情。修法:同篇的读改写通道都进同一把路径锁,并且在锁内读。
// 时序做法:拦住读改写通道的那一发写(按内容认),直到 CAS 那发落定或 150ms 超时 —— 未修时这正好把旧全文压在 CAS 之后。
// 负对照(实跑过):摘掉 setPageFrontmatter / patchMark 的路径锁 → 对应两条红。
describe('同篇读改写通道与 CAS 共用路径锁(Codex g3#2)', () => {
  const V1 = '---\nstatus: todo\n---\n正文 v1\n- [ ] 任务 @2026-10-01\n'
  const V2 = '---\nstatus: todo\n---\n正文 v2 编辑器刚写的\n- [ ] 任务 @2026-10-01\n'
  type H = Awaited<ReturnType<typeof setup>>
  const channels = [
    {
      name: 'setPageFrontmatter',
      run: (h: H) => h.handlers.get(IPC.setPageFrontmatter)!(null, 'n.md', { status: 'done' }),
      isPatchWrite: (t: string) => t.includes('status: done'),
      applied: (t: string) => setFmExtraOnSource(t, { status: 'done' }),
    },
    {
      name: 'patchMark',
      run: (h: H) => h.handlers.get(IPC.patchMark)!(null, 'n.md', '- [ ] 任务 @2026-10-01', 0, '- [x] 任务 @2026-10-01'),
      isPatchWrite: (t: string) => t.includes('- [x] 任务'),
      applied: (t: string) => t.replace('- [ ] 任务', '- [x] 任务'),
    },
  ]

  /** 拦住读改写通道的写:等 CAS 那发落定(或 150ms,修好后 CAS 在锁外排队、永远等不到)再放行。 */
  const holdPatchWrite = (h: H, isPatchWrite: (t: string) => boolean, casSettled: () => Promise<unknown>) => {
    const real = h.vault.writeTextFile.bind(h.vault)
    vi.spyOn(h.vault, 'writeTextFile').mockImplementation(async (rel: string, text: string) => {
      if (isPatchWrite(text)) await Promise.race([casSettled(), new Promise((r) => setTimeout(r, 150))])
      return real(rel, text)
    })
  }

  for (const ch of channels) {
    it(`${ch.name} 先进、编辑器 CAS 后到:CAS 必须看见补丁后的盘面并拒写(不许回 ok 却被旧正文盖掉)`, async () => {
      const h = await setup()
      await fs.writeFile(path.join(h.root, 'n.md'), V1)
      let cas: Promise<unknown> = Promise.resolve()
      holdPatchWrite(h, ch.isPatchWrite, () => cas)
      const patching = ch.run(h)
      cas = h.write({ sender: 'w1' }, 'n.md', V2, { base: textFingerprint(V1) }) as Promise<unknown>
      const [, res] = await Promise.all([patching, cas])
      const disk = await h.disk('n.md')
      expect(disk).toBe(ch.applied(V1)) // 补丁在
      expect(res).toEqual({ ok: false, current: disk }) // 编辑器被告知盘上已变,回灌 / 冲突副本由渲染层接
    })

    it(`编辑器 CAS 先进、${ch.name} 后到:它必须在锁内读到新正文再打补丁(两边都在)`, async () => {
      const h = await setup()
      await fs.writeFile(path.join(h.root, 'n.md'), V1)
      let cas: Promise<unknown> = Promise.resolve()
      holdPatchWrite(h, ch.isPatchWrite, () => cas)
      cas = h.write({ sender: 'w1' }, 'n.md', V2, { base: textFingerprint(V1) }) as Promise<unknown>
      const patching = ch.run(h)
      const [res] = await Promise.all([cas, patching])
      expect(res).toEqual({ ok: true })
      expect(await h.disk('n.md')).toBe(ch.applied(V2))
    })
  }
})
