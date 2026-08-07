import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CLOUD_VAULT_MARKER } from '@amadeus-shared/entrySync'
import { mirrorVaultNames } from './mirrorVaults'

const root = path.join(tmpdir(), `mirror-vaults-${process.pid}`)
afterAll(() => fs.rm(root, { recursive: true, force: true }))

describe('mirrorVaultNames', () => {
  it('只认根级带标记的文件夹(换设备后分区名的唯一来源)', async () => {
    const mk = async (rel: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await fs.writeFile(path.join(root, rel), '')
    }
    await mk(`工作/${CLOUD_VAULT_MARKER}`)
    await mk(`Alpha/${CLOUD_VAULT_MARKER}`)
    await mk(`深/嵌套/${CLOUD_VAULT_MARKER}`) // 非根级:不算
    await mk(`与我共享/某页/note.md`) // 无标记:不算
    await mk(CLOUD_VAULT_MARKER) // 镜像根自身:不算(不是某个文件夹的标记)
    await fs.mkdir(path.join(root, '.trash'), { recursive: true })

    expect(await mirrorVaultNames(root)).toEqual(['Alpha', '工作'])
  })

  it('镜像目录还不存在(未登录/首启)→ 空数组,不抛', async () => {
    expect(await mirrorVaultNames(path.join(root, 'nope'))).toEqual([])
  })
})
