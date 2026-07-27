/**
 * 命令目录的防漂移仪器。
 *
 * catalog 是引擎侧 `tangu-agent/src/core/commandCatalog.ts` 的同步拷贝(sync:commands + --check 守着
 * 逐字节一致)。这里守的是另一半:**声明了 desktop 却没人实现**——那种命令会在 `/` 菜单里静默消失,
 * typecheck 和 --check 都发现不了。
 */
import { describe, it, expect } from 'vitest'
import { COMMAND_CATALOG, commandsFor, canonicalCommandName } from '../../commandCatalog'
import { DESKTOP_IMPLEMENTED } from './slashImplemented'

describe('命令目录', () => {
  it('每条命令都以 / 开头、名字不重复', () => {
    const names = COMMAND_CATALOG.map((c) => c.name)
    expect(names.every((n) => n.startsWith('/'))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it('每条命令至少落在一个界面上（否则就是死条目）', () => {
    for (const c of COMMAND_CATALOG) expect(c.surfaces.length).toBeGreaterThan(0)
  })

  it('别名归一到正名', () => {
    expect(canonicalCommandName('/effort')).toBe('/think')
    expect(canonicalCommandName('/fork')).toBe('/branch')
    expect(canonicalCommandName('/think')).toBe('/think')
    expect(canonicalCommandName('/不存在')).toBe('/不存在')
  })

  it('别名不与任何正名冲突', () => {
    const names = new Set(COMMAND_CATALOG.map((c) => c.name))
    for (const c of COMMAND_CATALOG) for (const a of c.aliases || []) expect(names.has(a)).toBe(false)
  })

  it('声明 desktop 的命令都在 Composer2 里有实现（漏了会在 / 菜单静默消失）', () => {
    const declared = commandsFor('desktop').map((c) => c.name)
    const missing = declared.filter((n) => !DESKTOP_IMPLEMENTED.includes(n))
    expect(missing).toEqual([])
  })

  it('实现清单里没有 catalog 之外的孤儿', () => {
    const declared = new Set(commandsFor('desktop').map((c) => c.name))
    expect(DESKTOP_IMPLEMENTED.filter((n) => !declared.has(n))).toEqual([])
  })

  it('中英描述都不为空（Desktop 直接渲染 catalog 文案，空了就是白条）', () => {
    for (const c of COMMAND_CATALOG) {
      expect(c.zh.trim().length).toBeGreaterThan(0)
      expect(c.en.trim().length).toBeGreaterThan(0)
    }
  })
})
