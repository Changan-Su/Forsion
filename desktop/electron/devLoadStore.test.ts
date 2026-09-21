import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDevLoaded, readDevLoads, setDevLoad } from './devLoadStore'

let home: string
beforeEach(() => { home = mkdtempSync(path.join(os.tmpdir(), 'devload-')) })
afterEach(() => rmSync(home, { recursive: true, force: true }))

const A = { id: 'p_aaaaaaaaaaaa', root: '/projects/a' }

describe('devLoadStore', () => {
  it('登记 / 撤销往返;id 与真实根都对上才算授权', () => {
    expect(isDevLoaded(readDevLoads(home), A)).toBe(false)
    setDevLoad(home, A, true)
    const loads = readDevLoads(home)
    expect(isDevLoaded(loads, A)).toBe(true)
    expect(isDevLoaded(loads, { ...A, root: '/projects/elsewhere' })).toBe(false) // 同 id 换了目录
    expect(isDevLoaded(loads, { ...A, id: 'p_bbbbbbbbbbbb' })).toBe(false) // 同目录换了 id(复制后重铸)
    setDevLoad(home, A, false)
    expect(isDevLoaded(readDevLoads(home), A)).toBe(false)
  })

  it('两条授权互不覆盖;文件 0600', () => {
    setDevLoad(home, A, true)
    setDevLoad(home, { id: 'p_bbbbbbbbbbbb', root: '/projects/b' }, true)
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

  it('非法 id / 相对路径直接抛,不落盘', () => {
    expect(() => setDevLoad(home, { id: 'evil', root: '/x' }, true)).toThrow(/invalid product/)
    expect(() => setDevLoad(home, { id: 'p_aaaaaaaaaaaa', root: 'relative' }, true)).toThrow(/invalid product/)
    expect(() => readFileSync(path.join(home, 'dev-plugins.json'))).toThrow()
  })
})
