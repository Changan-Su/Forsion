import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { addExternalCreation, allowExternalLaunch, externalCreationRoots, gitOwners, isExternalLaunchAllowed, removeExternalCreation, revokeExternalLaunch } from './productTrust'

let home: string
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'product-trust-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

let A: { id: string; root: string }
beforeEach(() => { A = { id: 'p_aaaaaaaaaaaa', root: path.join(home, 'projects', 'a') }; mkdirSync(A.root, { recursive: true }) })
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
    const impostor = path.join(home, 'projects', 'impostor'); mkdirSync(impostor)
    expect(isExternalLaunchAllowed(home, { ...A, root: impostor })).toBe(false) // 同 id 的 sidecar 被搬进别的文件夹(另一个 inode)
    // ⚠️改名不丢:桌面快捷方式里只有产物 id,用户给项目文件夹改了名它照样得打得开(更新日志里写明的承诺)。
    const renamed = path.join(home, 'projects', 'a-renamed')
    renameSync(A.root, renamed)
    expect(isExternalLaunchAllowed(home, { id: A.id, root: renamed })).toBe(true)
    renameSync(renamed, A.root)
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

  it('⚠️坏文件 / 怪形状一律当空(fail closed):不认任何仓、不放行任何外部拉起、不认任何外部造物', () => {
    for (const raw of ['{ broken', '[]', '{"gitNonces":"x","externalLaunch":[],"externalCreations":{}}', `{"gitNonces":[42,"zz"],"externalLaunch":{"__proto__":"/x","p_aaaaaaaaaaaa":"relative"},"externalCreations":[{"root":"relative","dir":{"dev":1,"ino":2}},{"root":"${A.root.replace(/\\/g, '\\\\')}"}]}`]) {
      writeFileSync(path.join(home, 'product-trust.json'), raw)
      expect(gitOwners(home).has(NONCE)).toBe(false)
      expect(isExternalLaunchAllowed(home, A)).toBe(false)
      expect(externalCreationRoots(home)).toEqual([])
    }
  })

  it('外部造物:登记 / 取消往返;改名后旧路径不再认,重加按目录身份替换旧条目;原路径换成别的文件夹不认', () => {
    const ext = path.join(home, 'elsewhere', 'app'); mkdirSync(ext, { recursive: true })
    expect(externalCreationRoots(home)).toEqual([])
    addExternalCreation(home, ext)
    expect(externalCreationRoots(home)).toEqual([ext])
    const renamed = path.join(home, 'elsewhere', 'app-renamed')
    renameSync(ext, renamed)
    expect(externalCreationRoots(home)).toEqual([]) // 路径没了:不认(要重加一次)
    addExternalCreation(home, renamed)
    expect(externalCreationRoots(home)).toEqual([renamed])
    const stored = JSON.parse(readFileSync(path.join(home, 'product-trust.json'), 'utf8')).externalCreations
    expect(stored).toHaveLength(1) // 按 inode 替换,不留一条死的旧路径
    // 原路径上换了个文件夹:原来那个还在(改了名)占着 inode,新建的这个一定是另一个身份
    const moved = path.join(home, 'elsewhere', 'app-moved')
    renameSync(renamed, moved); mkdirSync(renamed)
    expect(externalCreationRoots(home)).toEqual([])
    addExternalCreation(home, moved)
    expect(externalCreationRoots(home)).toEqual([moved])
    removeExternalCreation(home, moved)
    expect(externalCreationRoots(home)).toEqual([])
    expect(existsSync(moved)).toBe(true) // 取消登记不动文件夹
    // 与另两类凭据互不覆盖
    gitOwners(home).add(NONCE); allowExternalLaunch(home, A); addExternalCreation(home, moved)
    expect(gitOwners(home).has(NONCE) && isExternalLaunchAllowed(home, A)).toBe(true)
    expect(externalCreationRoots(home)).toEqual([moved])
  })
})
