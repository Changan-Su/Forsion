// 页面版本历史(评审 C-20):库外快照存储 + 写盘路径接入 + 恢复。全部用临时目录,不碰真家目录。
//  ① 时间窗:同一篇窗内最多一份;与最近一份相同不存;force(恢复前补快照)只跳过时间窗。
//  ② 淘汰:每篇最多 N 份(最旧的先走,文件一并删);全局容量超了跨库按最旧先走。
//  ③ 写盘接入:CAS 写用手里的盘上旧文做快照(存的是旧文,不是新文);不带 base 的写 / 非笔记不存;快照卡住也不拖住保存;
//     智库里不多出任何文件。
//  ④ 恢复:base 对不上不写;成功 = 盘上换成该版本、恢复前的现文进历史(窗内也进)→ 可再恢复回去;路径 / id 校验。
//  ⑤ 改名 / 移动:历史跟着走;目标已有历史 = 合并。
// 负对照(实跑过):删掉 vaultHandlers 里 writeTextFile 那一行 snapshot → ③ 组红。
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
const { createPageHistory } = await import('./pageHistory')
type PageHistoryT = import('./pageHistory').PageHistory

const tmp = (p: string): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), p))
const MIN = 60_000

function store(root: string, extra: Partial<Parameters<typeof createPageHistory>[0]> = {}) {
  const clock = { t: 1_800_000_000_000 }
  const logs: string[] = []
  const h = createPageHistory({ root: () => root, now: () => clock.t, log: (m) => logs.push(m), ...extra })
  return { h, clock, logs }
}

describe('存储:时间窗 / 去重 / force', () => {
  it('窗内最多一份;过窗再存;与最近一份相同不存(过窗也不存);force 跳过时间窗但不存重复', async () => {
    const root = await tmp('amx-hist-')
    const { h, clock } = store(root)
    const V = '/vault/A'
    expect(await h.snapshot(V, 'a.md', 'v1')).toBe(true)
    clock.t += 2 * MIN
    expect(await h.snapshot(V, 'a.md', 'v2')).toBe(false) // 窗内
    clock.t += 4 * MIN
    expect(await h.snapshot(V, 'a.md', 'v1')).toBe(false) // 与最近一份相同
    expect(await h.snapshot(V, 'a.md', 'v2')).toBe(true)
    clock.t += 1000
    expect(await h.snapshot(V, 'a.md', 'v3', { force: true })).toBe(true) // 窗内,force
    expect(await h.snapshot(V, 'a.md', 'v3', { force: true })).toBe(false) // 相同,force 也不存
    const list = await h.list(V, 'a.md')
    expect(list.map((e) => e.size)).toEqual([2, 2, 2])
    expect(await Promise.all(list.map((e) => h.read(V, 'a.md', e.id)))).toEqual(['v3', 'v2', 'v1']) // 新 → 旧
    expect(list[0].at).toBe(clock.t)
    // 不同库、不同路径各算各的
    expect(await h.snapshot('/vault/B', 'a.md', 'b1')).toBe(true)
    expect(await h.snapshot(V, 'sub/a.md', 's1')).toBe(true)
    expect((await h.list('/vault/B', 'a.md')).length).toBe(1)
    expect((await h.list(V, 'a.md')).length).toBe(3)
    // 反斜杠路径与正斜杠同一篇(Windows 的 listPages 是反斜杠)
    expect((await h.list(V, 'sub\\a.md')).length).toBe(1)
  })

  it('id 只认索引里登记过的:伪造 / 穿越 id 一律 null', async () => {
    const root = await tmp('amx-hist-')
    const { h } = store(root)
    await h.snapshot('/v', 'a.md', 'x')
    expect(await h.read('/v', 'a.md', '../../index')).toBeNull()
    expect(await h.read('/v', 'a.md', 'zzzz-00000000')).toBeNull()
  })

  it('index 损坏按空处理、不抛;存储根写不了:普通快照回 false 记日志,force 照抛', async () => {
    const root = await tmp('amx-hist-')
    const { h, logs } = store(root)
    await h.snapshot('/v', 'a.md', 'x')
    const dir = path.join(root, (await fs.readdir(root))[0])
    const fdir = path.join(dir, (await fs.readdir(dir))[0])
    await fs.writeFile(path.join(fdir, 'index.json'), '{oops')
    expect(await h.list('/v', 'a.md')).toEqual([])
    expect(await h.snapshot('/v', 'a.md', 'y')).toBe(true)
    expect(logs.some((m) => m.includes('损坏'))).toBe(true)

    const blocker = path.join(await tmp('amx-hist-'), 'file')
    await fs.writeFile(blocker, '')
    const bad = store(blocker) // 根是个文件:mkdir 必失败
    expect(await bad.h.snapshot('/v', 'a.md', 'x')).toBe(false)
    expect(bad.logs.some((m) => m.includes('没存成'))).toBe(true)
    await expect(bad.h.snapshot('/v', 'a.md', 'x', { force: true })).rejects.toThrow()
  })
})

describe('存储:淘汰', () => {
  it('每篇最多 N 份:最旧的先走,快照文件一并删', async () => {
    const root = await tmp('amx-hist-')
    const { h, clock } = store(root, { maxPerFile: 3 })
    for (let i = 1; i <= 5; i++) {
      await h.snapshot('/v', 'a.md', `v${i}`)
      clock.t += 6 * MIN
    }
    const list = await h.list('/v', 'a.md')
    expect(await Promise.all(list.map((e) => h.read('/v', 'a.md', e.id)))).toEqual(['v5', 'v4', 'v3'])
    const dir = path.join(root, (await fs.readdir(root))[0])
    const files = await fs.readdir(path.join(dir, (await fs.readdir(dir))[0]))
    expect(files.filter((f) => f.endsWith('.md')).length).toBe(3)
  })

  it('全局容量:跨库、跨篇按快照时刻最旧先走,回到上限以内', async () => {
    const root = await tmp('amx-hist-')
    const { h, clock } = store(root, { maxBytes: 250 })
    const body = (c: string): string => c.repeat(100)
    await h.snapshot('/v1', 'a.md', body('a')) // 最旧
    clock.t += MIN
    await h.snapshot('/v2', 'b.md', body('b'))
    clock.t += MIN
    await h.snapshot('/v1', 'c.md', body('c')) // 300 > 250 → a 走
    expect(await h.list('/v1', 'a.md')).toEqual([])
    expect((await h.list('/v2', 'b.md')).length).toBe(1)
    expect((await h.list('/v1', 'c.md')).length).toBe(1)
    clock.t += MIN
    // 新进程(计数从盘上重扫)照样守得住
    const again = createPageHistory({ root: () => root, now: () => clock.t, maxBytes: 250, log: () => {} })
    await again.snapshot('/v2', 'd.md', body('d'))
    expect(await again.list('/v2', 'b.md')).toEqual([])
    expect((await again.list('/v1', 'c.md')).length).toBe(1)
    expect((await again.list('/v2', 'd.md')).length).toBe(1)
  })
})

describe('存储:改名 / 移动', () => {
  it('历史跟着走;目标已有历史 = 合并(按时间排、按上限截),源目录清掉', async () => {
    const root = await tmp('amx-hist-')
    const { h, clock } = store(root, { maxPerFile: 3 })
    await h.snapshot('/v', 'a.md', 'a1')
    clock.t += 6 * MIN
    await h.snapshot('/v', 'a.md', 'a2')
    await h.move('/v', { 'a.md': 'dir/b.md' })
    expect(await h.list('/v', 'a.md')).toEqual([])
    const moved = await h.list('/v', 'dir/b.md')
    expect(await Promise.all(moved.map((e) => h.read('/v', 'dir/b.md', e.id)))).toEqual(['a2', 'a1'])
    // 合并:c 有两份,挪到 dir/b.md(已有两份)上,上限 3 → 留最新三份
    clock.t += 6 * MIN
    await h.snapshot('/v', 'c.md', 'c1')
    clock.t += 6 * MIN
    await h.snapshot('/v', 'c.md', 'c2')
    await h.move('/v', { 'c.md': 'dir/b.md' })
    const merged = await h.list('/v', 'dir/b.md')
    expect(await Promise.all(merged.map((e) => h.read('/v', 'dir/b.md', e.id)))).toEqual(['c2', 'c1', 'a2'])
    expect(await h.list('/v', 'c.md')).toEqual([])
    const vdir = path.join(root, (await fs.readdir(root))[0])
    expect((await fs.readdir(vdir)).length).toBe(1)
  })
})

type Handler = (event: unknown, ...args: unknown[]) => unknown
async function setup(history?: PageHistoryT) {
  const root = await tmp('amx-hist-vault-')
  const histRoot = await tmp('amx-hist-store-')
  const s = store(histRoot)
  const h = history ?? s.h
  const vault = new VaultManager()
  vault.setRoot(root)
  const index = new VaultIndex(vault)
  await index.build()
  const handlers = new Map<string, Handler>()
  const peers: Array<{ channel: string; payload: unknown }> = []
  registerVaultHandlers({
    vault, index,
    handle: (channel, fn) => { handlers.set(channel, fn as Handler) },
    rememberPage: async () => {},
    notifyAll: () => {},
    notifyPeers: (_o, channel, payload) => { peers.push({ channel, payload }) },
    pageHistory: h,
  })
  const call = (ch: string, e: unknown, ...a: unknown[]) => handlers.get(ch)!(e, ...a)
  const disk = (rel: string) => fs.readFile(path.join(root, rel), 'utf8')
  const put = (rel: string, text: string) => fs.writeFile(path.join(root, rel), text)
  const versions = async (rel: string) => {
    const list = (await call(IPC.listPageHistory, null, rel)) as Array<{ id: string }>
    return Promise.all(list.map((e) => call(IPC.readPageHistory, null, rel, e.id)))
  }
  return { root, histRoot, h, clock: s.clock, call, disk, put, versions, peers, handlers }
}

describe('写盘接入(writeTextFile 的 CAS 支)', () => {
  it('CAS 写用盘上旧文做快照(不是新文);窗内第二发不存;不带 base / 非笔记 / 内容没变都不存;智库里不多文件', async () => {
    const t = await setup()
    await t.put('a.md', 'old')
    await t.call(IPC.writeTextFile, null, 'a.md', 'new1', { base: textFingerprint('old') })
    await t.call(IPC.writeTextFile, null, 'a.md', 'new2', { base: textFingerprint('new1') })
    await t.h.settle()
    expect(await t.versions('a.md')).toEqual(['old'])
    t.clock.t += 6 * MIN
    await t.call(IPC.writeTextFile, null, 'a.md', 'new3', { base: textFingerprint('new2') })
    await t.call(IPC.writeTextFile, null, 'a.md', 'blind') // 不带 base:手里没有旧文,不存
    await t.h.settle()
    expect(await t.versions('a.md')).toEqual(['new2', 'old'])
    t.clock.t += 6 * MIN
    await t.call(IPC.writeTextFile, null, 'a.md', 'blind', { base: textFingerprint('blind') }) // 内容没变
    await t.put('pic.excalidraw.md', 'd0')
    await t.call(IPC.writeTextFile, null, 'pic.excalidraw.md', 'd1', { base: textFingerprint('d0') }) // 画板不是笔记
    await t.h.settle()
    expect(await t.versions('a.md')).toEqual(['new2', 'old'])
    await expect(t.call(IPC.listPageHistory, null, 'pic.excalidraw.md')).rejects.toThrow()
    expect((await fs.readdir(t.root)).sort()).toEqual(['a.md', 'pic.excalidraw.md'])
  })

  it('快照卡住 / 出错也不拖住保存', async () => {
    const stuck: PageHistoryT = {
      snapshot: () => new Promise(() => {}),
      list: async () => [], read: async () => null, move: async () => {}, settle: async () => {},
    }
    const t = await setup(stuck)
    await t.put('a.md', 'old')
    const r = await Promise.race([
      t.call(IPC.writeTextFile, null, 'a.md', 'new', { base: textFingerprint('old') }),
      new Promise((res) => setTimeout(() => res('timeout'), 1000)),
    ])
    expect(r).toEqual({ ok: true })
    expect(await t.disk('a.md')).toBe('new')
  })
})

describe('恢复(restorePageHistory)', () => {
  it('base 对不上 / 文件不在 → 不写;成功 → 盘上换成该版本、恢复前的现文进历史(窗内也进)、可再恢复回去、通知别的窗口', async () => {
    const t = await setup()
    await t.put('a.md', 'v1')
    await t.call(IPC.writeTextFile, null, 'a.md', 'v2', { base: textFingerprint('v1') })
    await t.h.settle()
    const [v1] = (await t.call(IPC.listPageHistory, null, 'a.md')) as Array<{ id: string }>
    expect(await t.call(IPC.restorePageHistory, { sender: 'w1' }, 'a.md', v1.id, textFingerprint('stale'))).toEqual({ ok: false, current: 'v2' })
    expect(await t.disk('a.md')).toBe('v2')
    const r = await t.call(IPC.restorePageHistory, { sender: 'w1' }, 'a.md', v1.id, textFingerprint('v2'))
    expect(r).toEqual({ ok: true })
    expect(await t.disk('a.md')).toBe('v1')
    expect(await t.versions('a.md')).toEqual(['v2', 'v1']) // 恢复前的 v2 进了历史(距上一份才几毫秒,窗内照进)
    expect(t.peers).toEqual([{ channel: IPC.externalChange, payload: 'a.md' }])
    const [v2] = (await t.call(IPC.listPageHistory, null, 'a.md')) as Array<{ id: string }>
    expect(await t.call(IPC.restorePageHistory, null, 'a.md', v2.id, textFingerprint('v1'))).toEqual({ ok: true })
    expect(await t.disk('a.md')).toBe('v2')
    await fs.unlink(path.join(t.root, 'a.md'))
    expect(await t.call(IPC.restorePageHistory, null, 'a.md', v1.id, textFingerprint('v2'))).toEqual({ ok: false, current: null })
    await expect(fs.access(path.join(t.root, 'a.md'))).rejects.toThrow() // 不按旧路径重建
  })

  it('补快照失败就不恢复;版本不在 → 抛;路径 / id 校验', async () => {
    const failing: PageHistoryT = {
      snapshot: async (_v, _r, _t, o) => { if (o?.force) throw new Error('disk full'); return false },
      list: async () => [], read: async () => 'old version', move: async () => {}, settle: async () => {},
    }
    const t = await setup(failing)
    await t.put('a.md', 'cur')
    await expect(t.call(IPC.restorePageHistory, null, 'a.md', 'abc-0123abcd', textFingerprint('cur'))).rejects.toThrow('disk full')
    expect(await t.disk('a.md')).toBe('cur')
    const t2 = await setup()
    await t2.put('a.md', 'cur')
    await expect(t2.call(IPC.restorePageHistory, null, 'a.md', 'abc-0123abcd', textFingerprint('cur'))).rejects.toThrow()
    for (const bad of ['../x.md', 'a/../a.md', '/etc/x.md', './a.md', 'a.txt', 'C:/x.md']) {
      await expect(t2.call(IPC.listPageHistory, null, bad)).rejects.toThrow()
    }
    await expect(t2.call(IPC.readPageHistory, null, 'a.md', '../index')).rejects.toThrow()
    await expect(t2.call(IPC.restorePageHistory, null, 'a.md', 'a/b', textFingerprint('cur'))).rejects.toThrow()
  })
})

describe('改名接入(propagateRenames)', () => {
  it('renamePageFile / movePage 之后历史在新路径下', async () => {
    const t = await setup()
    await t.put('a.md', 'v1')
    await t.call(IPC.writeTextFile, null, 'a.md', 'v2', { base: textFingerprint('v1') })
    await t.call(IPC.renamePageFile, null, 'a.md', 'b')
    await t.h.settle()
    expect(await t.versions('b.md')).toEqual(['v1'])
    expect(await t.versions('a.md')).toEqual([])
    await fs.mkdir(path.join(t.root, 'sub'))
    await t.call(IPC.movePage, null, 'b.md', 'sub')
    await t.h.settle()
    expect(await t.versions('sub/b.md')).toEqual(['v1'])
  })
})
