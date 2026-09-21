import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDevLoaded, readDevLoads, setDevLoad } from './devLoadStore'

let home: string
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'devload-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

let A: { id: string; root: string }
beforeEach(() => { A = { id: 'p_aaaaaaaaaaaa', root: path.join(home, 'projects', 'a') }; mkdirSync(A.root, { recursive: true }) })

describe('devLoadStore', () => {
  it('登记 / 撤销往返;id 与真实根都对上才算授权', () => {
    expect(isDevLoaded(readDevLoads(home), A)).toBe(false)
    setDevLoad(home, A, true)
    const loads = readDevLoads(home)
    expect(isDevLoaded(loads, A)).toBe(true)
    const elsewhere = path.join(home, 'projects', 'elsewhere'); mkdirSync(elsewhere)
    expect(isDevLoaded(loads, { ...A, root: elsewhere })).toBe(false) // 同 id 的 sidecar 被搬进另一个文件夹(另一个 inode)
    expect(isDevLoaded(loads, { ...A, id: 'p_bbbbbbbbbbbb' })).toBe(false) // 同目录换了 id(复制后重铸)
    setDevLoad(home, A, false)
    expect(isDevLoaded(readDevLoads(home), A)).toBe(false)
  })

  it('两条授权互不覆盖;文件 0600', () => {
    setDevLoad(home, A, true)
    const b = path.join(home, 'projects', 'b'); mkdirSync(b)
    setDevLoad(home, { id: 'p_bbbbbbbbbbbb', root: b }, true)
    expect(Object.keys(readDevLoads(home)).sort()).toEqual(['p_aaaaaaaaaaaa', 'p_bbbbbbbbbbbb'])
    if (process.platform !== 'win32') expect(statSync(path.join(home, 'dev-plugins.json')).mode & 0o777).toBe(0o600)
  })

  it('⚠️坏文件 / 怪形状一律当空名单(fail closed),且原型污染键进不来', () => {
    const file = path.join(home, 'dev-plugins.json')
    for (const raw of ['{ broken', '[]', '{"products":[]}', '{"products":{"__proto__":"/x","nope":"/y","p_aaaaaaaaaaaa":"relative/path","p_bbbbbbbbbbbb":42}}']) {
      writeFileSync(file, raw)
      expect(Object.keys(readDevLoads(home))).toEqual([])
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('⚠️授权绑的是目录身份不是路径:项目文件夹改了名,授权照旧(否则一改名开发副本就静默掉线)', () => {
    setDevLoad(home, A, true)
    const renamed = path.join(home, 'projects', 'a-renamed')
    renameSync(A.root, renamed)
    expect(isDevLoaded(readDevLoads(home), { id: A.id, root: renamed })).toBe(true)
    expect(isDevLoaded(readDevLoads(home), A)).toBe(false) // 旧路径上已经没有目录了
  })

  it('非法 id / 相对路径直接抛,不落盘', () => {
    expect(() => setDevLoad(home, { id: 'evil', root: A.root }, true)).toThrow(/invalid product/)
    expect(() => setDevLoad(home, { id: 'p_aaaaaaaaaaaa', root: 'relative' }, true)).toThrow(/invalid product/)
    expect(() => readFileSync(path.join(home, 'dev-plugins.json'))).toThrow()
  })
})
