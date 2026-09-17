/** 删笔记 / 删引用块时「只被它引用的附件」只认普通文件:引用解析到目录(`[子](Project.fd)`)时,
 *  整棵连带移进回收站是误删,底下的笔记编辑器与多维表待写也收不了尾(Codex 评审 09-17)。 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { VaultIndex } from './vaultIndex'
import type { VaultManager } from './vaultManager'

let dir = ''
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

it('exclusiveAssets 跳过解析到目录的引用,普通文件照列', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-index-exclusive-'))
  await fs.mkdir(path.join(dir, 'Project.fd'))
  await fs.writeFile(path.join(dir, 'Project.fd', '表.db'), '{}')
  await fs.writeFile(path.join(dir, '图.png'), 'x')
  await fs.writeFile(path.join(dir, '笔记.md'), '# 笔记\n\n![](图.png)\n\n[子](Project.fd)\n')
  const vault = {
    listPages: async () => ['笔记.md'],
    absPath: (p: string) => path.join(dir, p),
    getRoot: () => dir,
    resolveAttachment: async (_page: string, ref: string) => {
      const abs = path.join(dir, ref)
      return (await fs.stat(abs).then(() => true, () => false)) ? abs : null
    },
  } as unknown as VaultManager
  const index = new VaultIndex(vault)
  await index.build()
  expect(await index.exclusiveAssets('笔记.md')).toEqual(['图.png'])
})
