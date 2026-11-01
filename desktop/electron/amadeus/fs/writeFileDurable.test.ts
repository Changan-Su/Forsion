// 写临时文件 → fsync → rename(magpie #1505:不刷盘就 rename,断电后文件长度还在、字节全是 0x00)。
// 注入 fsync 失败:原文件一字不动、目录里不留临时文件;笔记写回(writeTextFile / writeVaultBytes)与远端同步(fsLocal.atomicWrite)同一条。
// 负对照(实跑过):去掉 writeFileDurable 里的 handle.sync() → fsync 那三条红;fsLocal 临时名改回拼在目标文件名后面 → 长文件名那条 ENAMETOOLONG。
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fault = vi.hoisted(() => ({ sync: false }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const promises = {
    ...real.promises,
    open: (async (...args: Parameters<typeof real.promises.open>) => {
      const handle = await real.promises.open(...args)
      if (fault.sync) handle.sync = () => Promise.reject(Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }))
      return handle
    }) as typeof real.promises.open,
  }
  return { ...real, promises, default: { ...real, promises } }
})
vi.mock('electron', () => ({ dialog: {} }))

const { writeFileDurable } = await import('./renameAtomic')
const { VaultManager } = await import('./vaultManager')
const { atomicWrite } = await import('../../remotesync/fsLocal')

const fresh = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'durable-write-'))
async function withSyncFailure(fn: () => Promise<unknown>): Promise<void> {
  fault.sync = true
  try { await expect(fn()).rejects.toThrow(/EIO/) } finally { fault.sync = false }
}

describe('writeFileDurable', () => {
  it('写成功:内容落位、不留临时文件;fsync 失败:原文件原样、临时文件删掉', async () => {
    const dir = await fresh()
    const file = path.join(dir, 'note.md')
    await writeFileDurable(file, `${file}.tmp-1`, '旧内容')
    expect(await fs.readFile(file, 'utf8')).toBe('旧内容')
    await withSyncFailure(() => writeFileDurable(file, `${file}.tmp-2`, '新内容'))
    expect(await fs.readFile(file, 'utf8')).toBe('旧内容')
    expect(await fs.readdir(dir)).toEqual(['note.md'])
  })

  it('临时名已被占(残渣)→ 抛 EEXIST,不写进别人的文件、也不删它', async () => {
    const dir = await fresh()
    const file = path.join(dir, 'a.md')
    await fs.writeFile(`${file}.tmp-x`, 'someone else')
    await expect(writeFileDurable(file, `${file}.tmp-x`, 'mine')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(`${file}.tmp-x`, 'utf8')).toBe('someone else')
  })
})

describe('笔记写回与远端同步走同一条', () => {
  it('VaultManager.writeTextFile / writeVaultBytes:fsync 失败时原文件原样,库里不留 .tmp-*', async () => {
    const root = await fresh()
    const vault = new VaultManager()
    vault.setRoot(root)
    await vault.writeTextFile('a.md', '# 原文\n')
    await fs.writeFile(path.join(root, 'b.pdf'), Buffer.from('%PDF-old'))
    await withSyncFailure(() => vault.writeTextFile('a.md', '# 改了\n'))
    await withSyncFailure(() => vault.writeVaultBytes('b.pdf', Buffer.from('%PDF-new')))
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('# 原文\n')
    expect(await fs.readFile(path.join(root, 'b.pdf'), 'utf8')).toBe('%PDF-old')
    expect((await fs.readdir(root)).filter((n) => n.includes('.tmp-'))).toEqual([])
    await vault.writeTextFile('a.md', '# 改了\n')
    expect(await fs.readFile(path.join(root, 'a.md'), 'utf8')).toBe('# 改了\n')
  })

  it('fsLocal.atomicWrite:fsync 失败时原文件原样、不留 .rsync-tmp-*;成功时照旧对齐 mtime', async () => {
    const dir = await fresh()
    const file = path.join(dir, 'sub', 'x.md')
    await atomicWrite(file, Buffer.from('v1'), 1_700_000_000_000)
    expect((await fs.stat(file)).mtimeMs).toBe(1_700_000_000_000)
    await withSyncFailure(() => atomicWrite(file, Buffer.from('v2'), 1_800_000_000_000))
    expect(await fs.readFile(file, 'utf8')).toBe('v1')
    expect(await fs.readdir(path.dirname(file))).toEqual(['x.md'])
  })

  it('fsLocal.atomicWrite:220 字符的文件名照样写得进(临时名不拼目标文件名)', async () => {
    const file = path.join(await fresh(), `长${'n'.repeat(216)}.md`)
    await atomicWrite(file, Buffer.from('long'))
    expect(await fs.readFile(file, 'utf8')).toBe('long')
  })
})
