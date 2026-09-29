/**
 * 目录身份再绑创建时间:同一路径删掉重建时 Linux 常复用刚释放的 inode,只比 dev/ino 的话新目录会继承旧授权
 * (开发态加载、从应用外拉起、外部造物三份登记都一样)。macOS APFS 不会这么快复用 inode,本机造不出来,
 * 所以这里不靠真的删建:直接改落盘记录,模拟「dev/ino 对得上、创建时间不同」与「2.11.3/2.11.4 写的、没有创建时间的旧记录」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirIdToken, dirIdentity, isDirIdentity, sameDirIdentity } from './dirIdentity'
import { isDevLoaded, isDevLoadStale, readDevLoads, setDevLoad } from './devLoadStore'
import { addExternalCreation, allowExternalLaunch, externalCreationFor, externalCreations, externalLaunchNeedsReauth, isExternalLaunchAllowed } from './productTrust'

let home: string
let A: { id: string; root: string }
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'dir-identity-'))
  A = { id: 'p_aaaaaaaaaaaa', root: path.join(home, 'projects', 'a') }
  mkdirSync(A.root, { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

/** 把某个落盘文件里所有目录身份的 birth 改掉(undefined = 删掉,模拟旧记录)。dev/ino 原样。 */
function rewriteBirth(file: string, birth: number | undefined): void {
  const p = path.join(home, file)
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    if (isDirIdentity(o.dir)) {
      const dir = o.dir as unknown as Record<string, unknown>
      if (birth === undefined) delete dir.birth
      else dir.birth = birth
    }
    for (const x of Object.values(o)) walk(x)
  }
  const data = JSON.parse(readFileSync(p, 'utf8'))
  walk(data)
  writeFileSync(p, JSON.stringify(data))
}

describe('dirIdentity:创建时间', () => {
  it('同一个目录两次取身份相等;dev/ino 相同而创建时间不同、或缺创建时间 → 不是同一个', () => {
    const id = dirIdentity(A.root)!
    expect(typeof id.birth).toBe('number')
    expect(sameDirIdentity(id, dirIdentity(A.root))).toBe(true)
    expect(sameDirIdentity(id, { ...id, birth: id.birth! + 1 })).toBe(false)
    const { birth: _drop, ...legacy } = id
    expect(isDirIdentity(legacy)).toBe(true) // 旧记录照样读得出(才能提示重新授权)
    expect(sameDirIdentity(legacy, id)).toBe(false)
    expect(sameDirIdentity(id, legacy)).toBe(false)
  })

  it('删除确认用的短串也带创建时间:确认框开着时同一路径删了重建(inode 复用)就对不上', () => {
    const id = dirIdentity(A.root)!
    expect(dirIdToken(id)).toBe(dirIdToken(dirIdentity(A.root)!))
    expect(dirIdToken({ ...id, birth: id.birth! + 1 })).not.toBe(dirIdToken(id))
  })

  for (const [label, birth] of [['同 dev/ino、不同创建时间(inode 被复用)', 1] as const, ['没有创建时间的旧记录', undefined] as const]) {
    it(`开发态加载:${label} → 不认,并标记为需要重新加载;再授权一次恢复`, () => {
      setDevLoad(home, A, true)
      expect(isDevLoaded(readDevLoads(home), A)).toBe(true)
      rewriteBirth('dev-plugins.json', birth)
      const loads = readDevLoads(home)
      expect(isDevLoaded(loads, A)).toBe(false)
      expect(isDevLoadStale(loads, A)).toBe(true)
      setDevLoad(home, A, true)
      expect(isDevLoaded(readDevLoads(home), A)).toBe(true)
      expect(isDevLoadStale(readDevLoads(home), A)).toBe(false)
    })

    it(`从应用外拉起:${label} → 不放行,并标记为需要重新添加到桌面;再添加一次恢复`, () => {
      allowExternalLaunch(home, A)
      rewriteBirth('product-trust.json', birth)
      expect(isExternalLaunchAllowed(home, A)).toBe(false)
      expect(externalLaunchNeedsReauth(home, A)).toBe(true)
      allowExternalLaunch(home, A)
      expect(isExternalLaunchAllowed(home, A)).toBe(true)
      expect(externalLaunchNeedsReauth(home, A)).toBe(false)
    })

    it(`外部造物:${label} → 不列出、不认;再「原地加入」一次替换掉旧条目`, () => {
      addExternalCreation(home, A.root)
      rewriteBirth('product-trust.json', birth)
      expect(externalCreations(home)).toEqual([])
      expect(externalCreationFor(home, A.root)).toBeNull()
      addExternalCreation(home, A.root)
      expect(externalCreations(home).map((e) => e.root)).toEqual([A.root])
      expect(JSON.parse(readFileSync(path.join(home, 'product-trust.json'), 'utf8')).externalCreations).toHaveLength(1)
    })
  }

  it('没有任何授权 → 不提示重新授权(深链落在从没建过快捷方式的产物上,照旧报「不可用」)', () => {
    expect(externalLaunchNeedsReauth(home, A)).toBe(false)
    expect(isDevLoadStale(readDevLoads(home), A)).toBe(false)
  })
})
