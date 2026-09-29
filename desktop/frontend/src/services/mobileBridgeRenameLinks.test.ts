/**
 * 评审 G2-04 的移动端那半:本地库桥改名 / 移动笔记之后重写全库 `[[链接]]`(此前纯移动,引用全断)。
 * 本机跑不了 mobile 的 Capacitor 文件系统:VaultManager 换成内存实现(方法签名照 mobile/src/amadeus/vaultManager.ts),
 * path-browserify 用 node:path 的 posix 版顶替;索引(VaultIndex)与桥本体是真的。
 *  - renamePageFile / movePage / renameFolder:引用跟到新名 / 新路径,改写过的笔记经 onExternalChange 通知(原来是空实现)
 *  - 写前盘上已不是读到的那版 → 按现文重算,不盲盖
 *  - (复核 P0)重写正写着时编辑器存盘:同一把按路径的锁,编辑器那发排在后面、基线不符拿回 ok:false,
 *    不会「报成功、字却被重写的旧快照盖掉」。负对照(实跑过):withPathLock 改成直接调用 → 这条红。
 *  - (复核 P1)连续改名 B→C→D 不等前一次:库级有序队列,引用最终指向 D。负对照(实跑过):去掉 queueStructureOps → 红。
 * 负对照(实跑过):摘掉 renamePageFile 里的 propagateRenames → 第 1 条红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AmadeusApi } from '@amadeus-shared/ipc'
import { textFingerprint } from '@amadeus-shared/writeConflict'

const disk = new Map<string, string>()
let afterRead: (rel: string) => void = () => {}
let writeGate: ((rel: string) => Promise<void>) | null = null
let readDelay: (rel: string) => number = () => 0

vi.mock('path-browserify', async () => {
  const p = await import('node:path')
  return { default: p.posix }
})
vi.mock('../../../../mobile/src/amadeus/vaultManager', () => {
  const ROOT = '/vault/'
  const rel = (abs: string): string => abs.replace(ROOT, '')
  class VaultManager {
    private root: string | null = null
    getRoot(): string | null { return this.root }
    setRoot(p: string): void { this.root = p }
    async makeDir(): Promise<void> { /* 内存库不需要目录 */ }
    async listPages(): Promise<string[]> { return [...disk.keys()].filter((k) => k.endsWith('.md')).sort() }
    async listFolders(): Promise<string[]> { return [] }
    absPath(p: string): string { return ROOT + p }
    async readTextAbs(abs: string): Promise<string> {
      const d = readDelay(rel(abs))
      if (d) await new Promise((r) => setTimeout(r, d))
      const t = disk.get(rel(abs))
      if (t == null) throw new Error(`ENOENT ${abs}`)
      afterRead(rel(abs))
      return t
    }
    async writeTextFile(p: string, text: string): Promise<void> { if (writeGate) await writeGate(p); disk.set(p, text) }
    async pathExists(p: string): Promise<boolean> { return disk.has(p) || [...disk.keys()].some((k) => k.startsWith(`${p}/`)) }
    async moveEntry(src: string, dst: string): Promise<void> {
      for (const [k, v] of [...disk]) {
        if (k === src) { disk.delete(k); disk.set(dst, v) }
        else if (k.startsWith(`${src}/`)) { disk.delete(k); disk.set(dst + k.slice(src.length), v) }
      }
    }
  }
  return { VaultManager }
})

// 非字面量路径:只让 vitest 在运行时解析。字面量会把 mobile 源码拉进 desktop 的 tsc(那边的 path-browserify /
// Capacitor 类型 desktop 没装,typecheck 当场红);类型用契约 AmadeusApi 兜住。
const MOBILE_BRIDGE = '../../../../mobile/src/amadeus/mobileAmadeusBridge'
const { createMobileAmadeusBridge } = (await import(/* @vite-ignore */ MOBILE_BRIDGE)) as { createMobileAmadeusBridge: () => AmadeusApi }

beforeEach(() => {
  disk.clear()
  afterRead = () => {}
  writeGate = null
  readDelay = () => 0
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('window', { dispatchEvent: () => true })
})

const boot = async (files: Record<string, string>) => {
  for (const [p, t] of Object.entries(files)) disk.set(p, t)
  const bridge = createMobileAmadeusBridge()
  await bridge.openVault()
  const external: string[] = []
  bridge.onExternalChange((p) => external.push(p))
  return { bridge, external }
}

describe('mobile bridge: rename / move rewrites [[links]] (G2-04)', () => {
  it('renamePageFile B → C:引用跟到新名,改写过的笔记经 onExternalChange 通知', async () => {
    const { bridge, external } = await boot({ 'A.md': 'see [[B]] and [[B#H]] and ![[B|300]]\n', 'B.md': 'b\n', 'Other.md': '[[Z]]\n' })
    expect(await bridge.renamePageFile('B.md', 'C')).toBe('C.md')
    expect(disk.get('A.md')).toBe('see [[C]] and [[C#H]] and ![[C|300]]\n')
    expect(disk.get('Other.md')).toBe('[[Z]]\n')
    expect(external).toEqual(['A.md'])
  })
  it('movePage / renameFolder:路径限定引用跟到新路径', async () => {
    const { bridge } = await boot({ 'sub/D.md': 'see [[sub/E]]\n', 'sub/E.md': 'e\n', 'X.md': '[[sub/D]]\n' })
    expect(await bridge.movePage('sub/E.md', '')).toBe('E.md')
    expect(disk.get('sub/D.md')).toBe('see [[E]]\n')
    expect(await bridge.renameFolder('sub', 'lib')).toBe('lib')
    expect(disk.get('X.md')).toBe('[[lib/D]]\n')
  })
  it('写前盘上已不是读到的那版 → 按现文重算,不盲盖', async () => {
    const { bridge } = await boot({ 'A.md': 'x [[B]]\n', 'B.md': 'b\n' })
    // 模拟编辑器在「读 → 写」之间落了一次盘:重写那一读之后立刻改盘
    let bumped = false
    afterRead = (p) => { if (p === 'A.md' && !bumped) { bumped = true; disk.set('A.md', `${disk.get('A.md')}编辑器刚存的一行\n`) } }
    await bridge.renamePageFile('B.md', 'C')
    expect(bumped).toBe(true)
    expect(disk.get('A.md')).toBe('x [[C]]\n编辑器刚存的一行\n')
  })
  it('复核 P0:重写正写着时编辑器存盘 → 排在同一把路径锁后面,基线不符拿回 ok:false,绝不报成功却被盖掉', async () => {
    const orig = 'x [[B]]\n'
    const { bridge } = await boot({ 'A.md': orig, 'B.md': 'b\n' })
    let release: () => void = () => {}
    let parked = false
    writeGate = async (p) => {
      if (p !== 'A.md' || parked) return
      parked = true // 重写已比对完、正卡在落盘这一步
      await new Promise<void>((r) => { release = r })
    }
    const renaming = bridge.renamePageFile('B.md', 'C')
    await vi.waitFor(() => expect(parked).toBe(true))
    const saving = bridge.writeTextFile('A.md', `${orig}编辑器新打的一行\n`, { base: textFingerprint(orig) })
    await new Promise((r) => setTimeout(r, 20))
    release()
    await renaming
    expect(await saving).toEqual({ ok: false, current: 'x [[C]]\n' })
    expect(disk.get('A.md')).toBe('x [[C]]\n')
  })
  it('复核 P1:连续改名 B→C→D(不等前一次跑完)→ 引用最终指向 D,不留 [[C]] 断链', async () => {
    const { bridge } = await boot({ 'A.md': 'x [[B]]\n', 'B.md': 'b\n' })
    let slowed = false
    readDelay = (p) => (p === 'A.md' && !slowed ? ((slowed = true), 30) : 0)
    await Promise.all([bridge.renamePageFile('B.md', 'C'), bridge.renamePageFile('C.md', 'D')])
    expect(disk.has('D.md')).toBe(true)
    expect(disk.get('A.md')).toBe('x [[D]]\n')
  })
})
