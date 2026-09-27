import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyBundleSignature, SIGNATURE_FILE, canonicalFiles } from './bundleSignature'
import { signDir, testKeyPair } from './bundleSignature.testutil'

let dir: string
const key = testKeyPair()
const write = async (rel: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  await fs.writeFile(path.join(dir, rel), body)
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bundle-sig-'))
  await write('manifest.json', '{"id":"forsion-extend","version":"0.1.0"}')
  await write('dist/desktop.mjs', 'export const registerCloud = () => {}')
  await write('dist/main.js', '// renderer')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('verifyBundleSignature', () => {
  it('签过的目录:验过,files 列全;点名的入口在 files 里', async () => {
    await signDir(dir, key.privateKey)
    const v = await verifyBundleSignature(dir, key.publicKeyPem, ['dist/desktop.mjs'])
    expect(v).toMatchObject({ ok: true, files: ['dist/desktop.mjs', 'dist/main.js', 'manifest.json'] })
    if (v.ok) expect(v.digests['dist/desktop.mjs']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('canonical 形式与键的写入顺序无关(签名侧乱序写也能验过)', () => {
    expect(canonicalFiles({ b: '1', a: '2' })).toBe('{"a":"2","b":"1"}')
  })

  it('目录里多出来的文件不算错(宿主以后可能往插件目录写东西;入口是单文件不会 require 邻居)', async () => {
    await signDir(dir, key.privateKey)
    await write('data.json', '{}')
    expect((await verifyBundleSignature(dir, key.publicKeyPem)).ok).toBe(true)
  })

  it('负对照:改一个字节 / 删一个签过的文件 / 换公钥 / 点名未签文件 / 符号链接冒充 → 一律拒,原因可读', async () => {
    await signDir(dir, key.privateKey)
    const fail = async (name: string, mutate: () => Promise<void>, reason: string, require: string[] = []) => {
      await mutate()
      const v = await verifyBundleSignature(dir, key.publicKeyPem, require)
      expect(v.ok, name).toBe(false)
      if (!v.ok) expect(v.reason, name).toContain(reason)
    }
    const entry = await fs.readFile(path.join(dir, 'dist/desktop.mjs'), 'utf8')
    await fail('tamper', () => write('dist/desktop.mjs', entry + '//x'), 'does not match its signed hash')
    await write('dist/desktop.mjs', entry)
    expect((await verifyBundleSignature(dir, key.publicKeyPem)).ok).toBe(true) // 复原后再过,证明上面拒的是改动本身
    await fail('require', async () => {}, 'not covered', ['dist/other.mjs'])
    const other = await verifyBundleSignature(dir, testKeyPair().publicKeyPem)
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.reason).toContain('pinned public key')
    await fail('missing', () => fs.rm(path.join(dir, 'dist/main.js')), 'is missing')
    await write('dist/main.js', '// renderer')
    if (process.platform !== 'win32') {
      await fail('symlink', async () => {
        await fs.rm(path.join(dir, 'dist/main.js'))
        await fs.symlink(path.join(dir, 'manifest.json'), path.join(dir, 'dist/main.js'))
      }, 'not a regular file')
    }
  }, 20_000)

  it('负对照:没有 SIGNATURE / 格式坏 / 路径穿越条目 → 拒', async () => {
    expect((await verifyBundleSignature(dir, key.publicKeyPem)).ok).toBe(false)
    await write(SIGNATURE_FILE, '{"alg":"rsa","files":{},"sig":""}')
    expect((await verifyBundleSignature(dir, key.publicKeyPem)).ok).toBe(false)
    await write(SIGNATURE_FILE, JSON.stringify({ alg: 'ed25519', files: { '../escape': 'a'.repeat(64) }, sig: 'AA==' }))
    const v = await verifyBundleSignature(dir, key.publicKeyPem)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('bad entry')
  })
})

// 公钥换成另一对时上面的「换公钥」用例才有意义:这里确认两对不同
describe('testKeyPair', () => {
  it('每次生成不同的密钥', () => {
    expect(testKeyPair().publicKeyPem).not.toBe(key.publicKeyPem)
  })
})
