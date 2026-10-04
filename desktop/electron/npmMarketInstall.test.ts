import { it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { npmDownloadCandidates, npmTarballToZip } from './npmMarketInstall'
import { detectMarketType, extractZipToDir, readInstalledVersion } from './marketInstall'

function tar(files: Record<string, string>, type = '0'): Buffer {
  const blocks: Buffer[] = []
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value), h = Buffer.alloc(512)
    h.write(name); h.write('0000644\0', 100); h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.fill(32, 148, 156); h.write(type, 156)
    h.write([...h].reduce((sum, n) => sum + n, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const files = () => ({
  'package/package.json': JSON.stringify({ name: '@demo/notes', version: '1.2.0', scripts: { install: 'touch should-never-run' } }),
  'package/manifest.json': JSON.stringify({ id: 'demo-notes', version: '1.2.0' }),
  'package/main.js': 'module.exports = {}',
})
const snapshot = (buf: Buffer) => ({ npmPackage: '@demo/notes', version: '1.2.0', integrity: `sha512-${createHash('sha512').update(buf).digest('base64')}` })

it('installs a scoped npm archive through the existing market path and reads its installed version', async () => {
  const archive = tar(files()), info = snapshot(archive), root = await mkdtemp(join(tmpdir(), 'npm-market-'))
  try {
    const zip = await npmTarballToZip(archive, info, 'plugin')
    expect(await detectMarketType(zip, 'plugin')).toBe('amadeus-plugin')
    await extractZipToDir(zip, root, ['manifest.json'])
    expect(await readInstalledVersion('amadeus-plugin', root)).toBe('1.2.0')
    expect(await readFile(join(root, 'main.js'), 'utf8')).toBe('module.exports = {}')
    await expect(readFile(join(root, 'should-never-run'))).rejects.toThrow()
    expect(npmDownloadCandidates(info, 'china')).toEqual(['https://registry.npmmirror.com/@demo/notes/-/notes-1.2.0.tgz', 'https://registry.npmjs.org/@demo/notes/-/notes-1.2.0.tgz'])
    expect(npmDownloadCandidates(info, '')).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects modified bytes, changed package identity and manifest version drift', async () => {
  const clean = tar(files())
  await expect(npmTarballToZip(tar({ ...files(), 'package/main.js': 'changed' }), snapshot(clean), 'plugin')).rejects.toThrow('integrity')
  for (const [name, value] of [
    ['package/package.json', JSON.stringify({ name: '@demo/other', version: '1.2.0' })],
    ['package/manifest.json', JSON.stringify({ id: 'demo-notes', version: '1.0.0' })],
  ]) {
    const buf = tar({ ...files(), [name]: value })
    await expect(npmTarballToZip(buf, snapshot(buf), 'plugin')).rejects.toThrow(/identity|versions/)
  }
})

it('rejects traversal, absolute paths and links before extraction', async () => {
  for (const path of ['package/../escape', '/package/root', 'package/a/../../escape', 'package/C:/bad', 'package/a\\bad']) {
    const buf = tar({ ...files(), [path]: 'x' })
    await expect(npmTarballToZip(buf, snapshot(buf), 'plugin')).rejects.toThrow()
  }
  const link = tar({ 'package/link': 'x' }, '2')
  await expect(npmTarballToZip(link, snapshot(link), 'plugin')).rejects.toThrow()
})

it('rejects ordinary libraries without a Forsion manifest and script-like version specs', async () => {
  const f = files(); delete (f as any)['package/manifest.json']
  const buf = tar(f)
  await expect(npmTarballToZip(buf, snapshot(buf), 'plugin')).rejects.toThrow('no Forsion manifest')
  expect(() => npmDownloadCandidates({ ...snapshot(buf), npmPackage: 'https://evil.test/pkg' }, '')).toThrow()
  expect(() => npmDownloadCandidates({ ...snapshot(buf), version: '../../x' }, '')).toThrow()
})
