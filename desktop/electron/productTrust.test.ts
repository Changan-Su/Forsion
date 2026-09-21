import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allowExternalLaunch, gitOwners, isExternalLaunchAllowed, revokeExternalLaunch } from './productTrust'

let home: string
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'product-trust-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

const A = { id: 'p_aaaaaaaaaaaa', root: '/projects/a' }
const NONCE = 'ab'.repeat(16)

describe('productTrust', () => {
  it('git nonce 登记后才认;形态不对的一律不认也不收', () => {
    const owners = gitOwners(home)
    expect(owners.has(NONCE)).toBe(false)
    owners.add(NONCE)
    expect(gitOwners(home).has(NONCE)).toBe(true) // 落盘了:换一个实例也读得到
    expect(owners.has('Forsion Coding Studio version history')).toBe(false)
    expect(() => owners.add('not-a-nonce')).toThrow(/invalid nonce/)
    if (process.platform !== 'win32') expect(statSync(path.join(home, 'product-trust.json')).mode & 0o777).toBe(0o600)
  })

  it('外部拉起:登记 / 撤销往返,id 与真实根双钥匙', () => {
    expect(isExternalLaunchAllowed(home, A)).toBe(false)
    allowExternalLaunch(home, A)
    expect(isExternalLaunchAllowed(home, A)).toBe(true)
    expect(isExternalLaunchAllowed(home, { ...A, root: '/projects/impostor' })).toBe(false) // 同 id 的 sidecar 被搬进别的目录
    expect(isExternalLaunchAllowed(home, { ...A, id: 'p_bbbbbbbbbbbb' })).toBe(false)
    revokeExternalLaunch(home, A.id)
    expect(isExternalLaunchAllowed(home, A)).toBe(false)
  })

  it('两类凭据互不覆盖', () => {
    gitOwners(home).add(NONCE)
    allowExternalLaunch(home, A)
    gitOwners(home).add('cd'.repeat(16))
    expect(gitOwners(home).has(NONCE)).toBe(true)
    expect(isExternalLaunchAllowed(home, A)).toBe(true)
  })

  it('⚠️坏文件 / 怪形状一律当空(fail closed):不认任何仓、不放行任何外部拉起', () => {
    for (const raw of ['{ broken', '[]', '{"gitNonces":"x","externalLaunch":[]}', `{"gitNonces":[42,"zz"],"externalLaunch":{"__proto__":"/x","p_aaaaaaaaaaaa":"relative"}}`]) {
      writeFileSync(path.join(home, 'product-trust.json'), raw)
      expect(gitOwners(home).has(NONCE)).toBe(false)
      expect(isExternalLaunchAllowed(home, A)).toBe(false)
    }
  })
})
