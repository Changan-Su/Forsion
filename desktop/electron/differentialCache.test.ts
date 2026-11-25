import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { blockmapCoveredSize, differentialOldFile, dropStaleCurrentBlockmap } from './differentialCache'

const blockmap = (...sizes: number[]) => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: sizes.map(String), sizes }] }))
const exists = (p: string) => stat(p).then(() => true, () => false)
let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'forsion-diffcache-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('reads the size an electron-builder blockmap covers', () => {
  expect(blockmapCoveredSize(blockmap(10, 20, 5))).toBe(35)
  expect(blockmapCoveredSize(Buffer.from('nope'))).toBeNull()
  expect(blockmapCoveredSize(gzipSync('{"files":[]}'))).toBeNull()
  expect(blockmapCoveredSize(gzipSync('{"files":[{"sizes":[1,-2]}]}'))).toBeNull()
})

it('keeps a cached blockmap that matches the old file, drops one left over from an earlier version', async () => {
  await writeFile(join(dir, 'installer.exe'), Buffer.alloc(35))
  await writeFile(join(dir, 'current.blockmap'), blockmap(10, 20, 5))
  expect(await dropStaleCurrentBlockmap(dir, 'installer.exe')).toBe(false)
  expect(await exists(join(dir, 'current.blockmap'))).toBe(true)
  // 之后装了一个整包下载 / 手动装的新版:installer.exe 换了,blockmap 还是旧的
  await writeFile(join(dir, 'installer.exe'), Buffer.alloc(40))
  expect(await dropStaleCurrentBlockmap(dir, 'installer.exe')).toBe(true)
  expect(await exists(join(dir, 'current.blockmap'))).toBe(false)
})

it('drops an unreadable cached blockmap, and leaves the cache alone when there is no old file or no blockmap', async () => {
  await writeFile(join(dir, 'current.blockmap'), 'garbage')
  expect(await dropStaleCurrentBlockmap(dir, 'update.zip')).toBe(false) // 没有 update.zip:electron-updater 本来就整包
  expect(await exists(join(dir, 'current.blockmap'))).toBe(true)
  await writeFile(join(dir, 'update.zip'), Buffer.alloc(3))
  expect(await dropStaleCurrentBlockmap(dir, 'update.zip')).toBe(true)
  expect(await dropStaleCurrentBlockmap(dir, 'update.zip')).toBe(false) // 已经没有了
})

it('knows which old file each platform diffs against', () => {
  expect(differentialOldFile('win32')).toBe('installer.exe')
  expect(differentialOldFile('darwin')).toBe('update.zip')
  expect(differentialOldFile('linux')).toBeNull()
})
