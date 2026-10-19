// 库内路径一律 `/`(vaultRel):Windows 上 path.relative 给 `\`,listPages 原样交出去 → 树里的行、开着的标签、索引键和
// 挪动 / 改名回传的 `/` 路径成了同一篇的两种写法(PR #64 Windows 红在「拖回」那步)。
// 下面「真平台」那组在 macOS / Linux 上本来就绿,**咬人的是 Windows**:probe-windows-contracts 跑它。
// 负对照(实跑过):vaultRel 换回原样返回 → Windows 上「真平台」那组红(CI);本机只能红第一条(注入 `\` 分隔)。
import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vaultRel } from './vaultRel'
import { VaultManager } from './vaultManager'
import { VaultWatcher } from './watcher'
import { VaultIndex } from './vaultIndex'

const roots: string[] = []
afterEach(async () => { for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }) })

it('Windows 分隔符换成 `/`;POSIX 上原样(那里 `\\` 是合法文件名字符)', () => {
  expect(vaultRel('夹\\子\\笔记.md', '\\')).toBe('夹/子/笔记.md')
  expect(vaultRel('a\\b.md', '/')).toBe('a\\b.md')
  expect(vaultRel('a/b.md', '/')).toBe('a/b.md')
})

describe('真平台:主进程交出去的库内路径都是 `/`', () => {
  async function vaultWith() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amx-vaultrel-'))
    roots.push(root)
    await fs.mkdir(path.join(root, '夹', '子'), { recursive: true })
    await fs.mkdir(path.join(root, '夹', '空'), { recursive: true })
    await fs.writeFile(path.join(root, '夹', '子', '笔记.md'), '# 笔记\n\n见 [[别篇]]\n')
    await fs.writeFile(path.join(root, '夹', '别篇.md'), '# 别篇\n\n链到 [[笔记]]\n')
    await fs.writeFile(path.join(root, '夹', '图.png'), 'png')
    const vault = new VaultManager()
    vault.setRoot(root)
    return { root, vault }
  }

  it('listPages / listFolders / listFiles', async () => {
    const { vault } = await vaultWith()
    expect(await vault.listPages()).toEqual(['夹/别篇.md', '夹/子/笔记.md'])
    expect(await vault.listFolders()).toEqual(['夹', '夹/子', '夹/空'])
    expect(await vault.listFiles()).toContain('夹/图.png')
  })

  it('外部改动的回灌事件', async () => {
    const { root, vault } = await vaultWith()
    const pages: string[] = []
    const watcher = new VaultWatcher(vault, (p) => pages.push(p), () => {})
    const abs = path.join(root, '夹', '子', '笔记.md')
    await fs.writeFile(abs, '# 笔记\n\n外部改了\n')
    await watcher['handle'](abs, root)
    expect(pages).toEqual(['夹/子/笔记.md'])
  })

  it('索引键:按本机写法(Windows 上是 `\\`)递进来的路径落到同一条,不另起一条', async () => {
    const { vault } = await vaultWith()
    const index = new VaultIndex(vault)
    await index.build()
    const native = path.join('夹', '子', '笔记.md')
    await index.update(native)
    expect([...index['entries'].keys()].sort()).toEqual(['夹/别篇.md', '夹/子/笔记.md'])
    expect(index.backlinks(native).map((b) => b.path)).toEqual(['夹/别篇.md'])
  })
})
