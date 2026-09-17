/** 「有些明明有图标的笔记,树里不显示图标」(2026-09-16 用户实报,改名/删除/改动文件后出现)。
 *  watcher 的结构回调是 `void index.build()` + 立刻广播 structureChange,而 build 先 clear 再分片重读 ——
 *  渲染端被广播叫醒去拉 pageIcons() 时撞上半截索引,拿到残表整表覆盖,没读到的那些页图标就没了。
 *  钉两条:① build 在途时读者看到的是上一版**完整**表;② 在途期间的增量 update 不被换表吞掉。 */
import { promises as fs, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultIndex } from './vaultIndex'
import type { VaultManager } from './vaultManager'

const withIcon = (icon: string): string => `---\nicon: ${icon}\n---\n正文\n`

let dir = ''
afterEach(async () => {
  vi.restoreAllMocks()
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function setup(files: Record<string, string>) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-race-'))
  for (const [p, text] of Object.entries(files)) await fs.writeFile(path.join(dir, p), text)
  let gate: Promise<void> | null = null
  const vault = {
    // 目录快照取在**调用时**(真 listPages 就是这个语义):卡住的那发只认得卡住前的盘面。
    listPages: async () => {
      const snap = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
      if (gate) await gate
      return snap
    },
    absPath: (p: string) => path.join(dir, p),
    getRoot: () => dir,
  } as unknown as VaultManager
  const index = new VaultIndex(vault)
  await index.build()
  /** 让下一发 build 卡在 listPages 上,返回放行函数。 */
  const hold = (): (() => void) => {
    let open = (): void => {}
    gate = new Promise((r) => { open = () => { gate = null; r() } })
    return () => open()
  }
  return { index, hold }
}

describe('VaultIndex.build 换表原子性', () => {
  it('build 在途时 pageIcons 仍是上一版完整表(不是空表 / 残表)', async () => {
    const { index, hold } = await setup({ 'a.md': withIcon('🅰️'), 'b.md': withIcon('🅱️') })
    expect(index.pageIcons()).toEqual({ 'a.md': '🅰️', 'b.md': '🅱️' })
    const release = hold()
    const pending = index.build()
    expect(index.pageIcons()).toEqual({ 'a.md': '🅰️', 'b.md': '🅱️' })
    release()
    await pending
    expect(index.pageIcons()).toEqual({ 'a.md': '🅰️', 'b.md': '🅱️' })
  })

  it('build 在途期间的增量 update 以增量为准,不被换表吞掉', async () => {
    const { index, hold } = await setup({ 'a.md': withIcon('🅰️') })
    // build 先把 a.md 的**旧**内容读走(模拟:它读盘早于这次写),读完之前另一路 update 写进新图标
    const release = hold()
    const realRead = fs.readFile.bind(fs)
    let buildRead: (() => void) | null = null
    vi.spyOn(fs, 'readFile').mockImplementation(((p: string, enc: BufferEncoding) => {
      if (buildRead === null && String(p).endsWith('a.md')) {
        const stale = realRead(p, enc)
        return new Promise((r) => { buildRead = () => r(stale) })
      }
      return realRead(p, enc)
    }) as typeof fs.readFile)
    const pending = index.build()
    release()
    await vi.waitFor(() => expect(buildRead).not.toBeNull())
    await fs.writeFile(path.join(dir, 'a.md'), withIcon('🆎'))
    await index.update('a.md')
    buildRead!()
    await pending
    expect(index.pageIcons()).toEqual({ 'a.md': '🆎' })
  })

  it('update 读盘在途时文件被删:迟到的 update 不许把条目塞回去(无论有没有 build 在途)', async () => {
    for (const withBuild of [false, true]) {
      const { index, hold } = await setup({ 'a.md': withIcon('🅰️'), 'b.md': withIcon('🅱️') })
      const realRead = fs.readFile.bind(fs)
      let late: (() => void) | null = null
      const spy = vi.spyOn(fs, 'readFile').mockImplementation(((p: string, enc: BufferEncoding) => {
        if (late === null && String(p).endsWith('a.md')) {
          const stale = realRead(p, enc) // 删之前读到的旧内容
          return new Promise((r) => { late = () => r(stale) })
        }
        return realRead(p, enc)
      }) as typeof fs.readFile)
      const release = withBuild ? hold() : () => {}
      const updating = index.update('a.md')
      await vi.waitFor(() => expect(late).not.toBeNull())
      const building = withBuild ? index.build() : Promise.resolve()
      await fs.rm(path.join(dir, 'a.md'))
      index.remove('a.md')
      release()
      late!()
      await updating
      await building
      spy.mockRestore()
      expect(index.pageIcons(), withBuild ? 'build 在途' : '无 build').toEqual({ 'b.md': '🅱️' })
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('换根期间旧根迟到的 update 不许串进新根索引', async () => {
    const r1 = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-r1-'))
    const r2 = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-r2-'))
    try {
      await fs.writeFile(path.join(r1, 'x.md'), withIcon('🅰️'))
      await fs.writeFile(path.join(r2, 'x.md'), withIcon('🅱️'))
      let root = r1
      const vault = {
        listPages: async () => readdirSync(root).filter((f) => f.endsWith('.md')).sort(),
        absPath: (p: string) => path.join(root, p),
        getRoot: () => root,
      } as unknown as VaultManager
      const index = new VaultIndex(vault)
      await index.build()
      const realRead = fs.readFile.bind(fs)
      let late: (() => void) | null = null
      vi.spyOn(fs, 'readFile').mockImplementation(((p: string, enc: BufferEncoding) => {
        if (late === null && String(p).startsWith(r1)) {
          const old = realRead(p, enc)
          return new Promise((r) => { late = () => r(old) })
        }
        return realRead(p, enc)
      }) as typeof fs.readFile)
      const updating = index.update('x.md') // R1 的 watcher 发起,读盘卡住
      await vi.waitFor(() => expect(late).not.toBeNull())
      root = r2 // activateRoot:setRoot → build
      await index.build()
      late!()
      await updating
      expect(index.pageIcons()).toEqual({ 'x.md': '🅱️' })
    } finally {
      await fs.rm(r1, { recursive: true, force: true })
      await fs.rm(r2, { recursive: true, force: true })
    }
  })

  it('并发 build 合并:await 返回时索引已反映调用之后的盘面', async () => {
    const { index, hold } = await setup({ 'a.md': withIcon('🅰️') })
    const release = hold()
    const first = index.build()
    await fs.writeFile(path.join(dir, 'c.md'), withIcon('🌊'))
    const second = index.build()
    release()
    await second
    expect(index.pageIcons()).toEqual({ 'a.md': '🅰️', 'c.md': '🌊' })
    await first
  })
})
