import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearDataPaths, verifyClearTarget, type ClearDataInput, type ClearTarget } from './clearDataPaths'
import { dirIdentity } from './dirIdentity'

const files = ['tangu-desktop-config.json', 'amadeus-config.json', 'remote-sessions.json']

let T = ''
let H = ''
beforeEach(() => {
  T = realpathSync(mkdtempSync(join(tmpdir(), 'forsion-cleardata-')))
  H = join(T, 'home')
  mkdirSync(H)
})
afterEach(() => { rmSync(T, { recursive: true, force: true }) })

const mkUnit = (dir: string): string => { for (const s of ['home', 'app-data', 'Forsion']) mkdirSync(join(dir, s), { recursive: true }); return dir }
const folder = (dir: string, extra: Partial<ClearDataInput> = {}): ClearDataInput => ({
  role: 'folder', tangu: true, desktop: true, home: H, desktopFiles: files, folderDir: dir, folderIdentity: dirIdentity(dir),
  envTanguHome: join(H, '.forsion'), forsionHome: join(H, '.forsion'), workspace: join(H, 'Forsion'), userData: join(dir, 'app-data'),
  unitDirs: [], protectedRoots: [join(T, 'Application Support', 'Forsion')], ...extra,
})

describe('app:clearData 要删的路径', () => {
  it('默认那台:引擎 home + 工作区 + ~/.tangu、~/Tangu 软链 + 三份壳层文件', () => {
    expect(clearDataPaths({ home: H, desktopFiles: files, tangu: true, desktop: true, role: 'owner', forsionHome: `${H}/.forsion`, workspace: `${H}/Forsion`, userData: '/ud', unitDirs: [] })).toMatchObject({
      remove: [`${H}/.forsion`, `${H}/Forsion`, `${H}/.tangu`, `${H}/Tangu`, '/ud/tangu-desktop-config.json', '/ud/amadeus-config.json', '/ud/remote-sessions.json'],
      refused: [],
    })
    // 显式 TANGU_HOME=…/tangu:只删它本身,不删推导出的父目录
    expect(clearDataPaths({ home: H, desktopFiles: files, tangu: true, role: 'owner', envTanguHome: '/data/tangu', forsionHome: '/data', workspace: `${H}/Forsion`, userData: '/ud', unitDirs: [] }).remove[0]).toBe('/data/tangu')
  })

  it('默认那台:名册里的 Unit 在要删的路径里(旧的开发版位置 ~/.forsion-dev/units)→ 一条都不删;名册读不出 → 也不删', () => {
    const legacy = mkUnit(join(H, '.forsion-dev', 'units', 'Old'))
    const owner: ClearDataInput = { home: H, desktopFiles: files, tangu: true, desktop: true, role: 'owner', forsionHome: join(H, '.forsion-dev'), workspace: join(H, 'Forsion-Dev'), userData: '/ud', unitDirs: [legacy] }
    const r = clearDataPaths(owner)
    expect(r.remove).toEqual([]) // 连桌面那半也不删
    expect(r.refused).toEqual([{ path: join(H, '.forsion-dev'), reason: 'unit_inside', with: legacy }])
    // 软链别名:Unit 文件夹登记的是软链,真身在要删的工作区里
    const elsewhere = mkUnit(join(H, 'Forsion-Dev', 'Hidden'))
    symlinkSync(elsewhere, join(T, 'alias'))
    expect(clearDataPaths({ ...owner, unitDirs: [join(T, 'alias')] }).refused[0]).toMatchObject({ path: join(H, 'Forsion-Dev'), reason: 'unit_inside' })
    expect(clearDataPaths({ ...owner, unitDirs: null })).toMatchObject({ remove: [], refused: [{ path: join(H, '.forsion-dev'), reason: 'registry_unreadable' }] })
    // 新的缺省位置 ~/.forsion-dev-units 不在里面:照常删
    const fresh = mkUnit(join(H, '.forsion-dev-units', 'New'))
    expect(clearDataPaths({ ...owner, unitDirs: [fresh] }).refused).toEqual([])
  })

  it('插件沙箱:只删自己的 home 与工作区,不碰整机的兼容软链', () => {
    const r = clearDataPaths({ home: H, desktopFiles: files, tangu: true, role: 'sandbox', envTanguHome: '/sbx/home', forsionHome: '/sbx/home', workspace: '/sbx/workspace', userData: '/sbx/ud' })
    expect(r.remove).toEqual(['/sbx/home', '/sbx/workspace'])
  })

  it('文件夹 Unit:只删本文件夹下的 home/ 与 Forsion/(不看环境变量),桌面那半删本文件夹 app-data 里的壳层文件', () => {
    const dir = mkUnit(join(H, 'Forsion Units', 'A'))
    const r = clearDataPaths(folder(dir))
    expect(r).toMatchObject({
      remove: [`${dir}/home`, `${dir}/Forsion`, `${dir}/app-data/tangu-desktop-config.json`, `${dir}/app-data/amadeus-config.json`, `${dir}/app-data/remote-sessions.json`],
      refused: [],
    })
    expect(verifyClearTarget(r.targets[0], folder(dir))).toBe('rmdir')
    expect(verifyClearTarget(r.targets[2], folder(dir))).toBe('gone') // 壳层文件本来就没有
  })

  it('软链别名:~/Forsion 指进 Unit 文件夹里,清这台 Unit 不能顺手删掉默认那台的工作区', () => {
    const dir = mkUnit(join(T, 'data', 'U'))
    symlinkSync(join(dir, 'Forsion'), join(H, 'Forsion')) // 默认工作区就是这台 Unit 的 Forsion/
    const r = clearDataPaths(folder(dir))
    expect(r.remove).toEqual([])
    expect(r.refused).toEqual([{ path: join(dir, 'Forsion'), reason: 'overlap', with: join(H, 'Forsion') }])
  })

  it('子目录是软链 / 文件夹被换掉(换成软链或另一个目录)→ 不删', () => {
    const dir = mkUnit(join(H, 'Forsion Units', 'B'))
    const input = folder(dir)
    rmSync(join(dir, 'home'), { recursive: true })
    mkdirSync(join(H, '.forsion'))
    symlinkSync(join(H, '.forsion'), join(dir, 'home'))
    expect(clearDataPaths(input).refused).toEqual([{ path: join(dir, 'home'), reason: 'link' }])
    // 核对之后文件夹被挪走、原地换成指向别处的软链:删之前再核一次就拦下
    const dir2 = mkUnit(join(H, 'Forsion Units', 'C'))
    const in2 = folder(dir2)
    const t2 = clearDataPaths(in2).targets.find((t) => t.path === join(dir2, 'Forsion'))!
    expect(verifyClearTarget(t2, in2)).toBe('rmdir')
    renameSync(dir2, join(T, 'C-moved'))
    symlinkSync(mkUnit(join(T, 'victim')), dir2)
    expect(verifyClearTarget(t2, in2)).toBe('changed') // 跟着软链进去的是另一个目录(身份不对)
    expect(clearDataPaths(in2).refused[0]).toMatchObject({ path: dir2, reason: 'link' })
    // 换成另一个真目录(身份不对)
    rmSync(dir2)
    mkUnit(dir2)
    expect(clearDataPaths(in2).refused[0]).toMatchObject({ path: dir2, reason: 'moved' })
  })

  it('文件夹在默认那台的数据目录里 / 就是家目录的上级 / 碰到别的 Unit / 名册读不出 → 一条都不删', () => {
    const inside = mkUnit(join(H, '.forsion', 'units', 'A'))
    expect(clearDataPaths(folder(inside)).refused.map((r) => r.reason)).toEqual(['overlap', 'overlap'])
    // 文件夹 = 家目录的父目录(home/ 子目录正好就是家目录)
    mkdirSync(join(T, 'Forsion'))
    mkdirSync(join(T, 'app-data'))
    const top = clearDataPaths(folder(T))
    expect(top.remove).toEqual([])
    expect(top.refused).toContainEqual(expect.objectContaining({ path: H, reason: 'overlap' }))
    // 别的 Unit 的文件夹在本 Unit 的 Forsion/ 里
    const host = mkUnit(join(H, 'Forsion Units', 'Host'))
    const nested = mkUnit(join(host, 'Forsion', 'Nested'))
    expect(clearDataPaths(folder(host, { unitDirs: [nested] })).refused).toEqual([{ path: join(host, 'Forsion'), reason: 'overlap', with: nested }])
    expect(clearDataPaths(folder(host, { unitDirs: null })).refused[0].reason).toBe('registry_unreadable')
    expect(clearDataPaths({ ...folder(host), folderDir: undefined }).remove).toEqual([])
  })

  it('旧的开发版位置 ~/.forsion-dev/units 里的老 Unit:照样能清自己的数据', () => {
    const legacy = mkUnit(join(H, '.forsion-dev', 'units', 'Old'))
    expect(clearDataPaths(folder(legacy)).refused).toEqual([])
  })

  it('默认那台照常清:先删 ~/.forsion,兼容软链 ~/.tangu 跟着悬空 —— 照样只删链接、往下删完,不算清理不完整', () => {
    mkdirSync(join(H, '.forsion', 'tangu'), { recursive: true })
    mkdirSync(join(H, 'Forsion', 'Amadeus'), { recursive: true })
    symlinkSync(join(H, '.forsion', 'tangu'), join(H, '.tangu'))
    const outside = join(T, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'x')
    symlinkSync(outside, join(H, 'Tangu')) // 兼容软链指到别处:只删链接,不跟进去
    const ud = join(T, 'ud')
    mkdirSync(ud)
    writeFileSync(join(ud, files[0]), '{}')
    const unit = mkUnit(join(H, 'Forsion Units', 'A')) // 名册里一台不沾边的 Unit
    const input: ClearDataInput = { home: H, desktopFiles: files, tangu: true, desktop: true, role: 'owner', forsionHome: join(H, '.forsion'), workspace: join(H, 'Forsion'), userData: ud, unitDirs: [unit] }
    const plan = clearDataPaths(input)
    expect(plan.refused).toEqual([])
    expect(plan.targets.map((t) => t.kind)).toEqual(['dir', 'dir', 'link', 'link', 'file', 'absent', 'absent'])
    const results: string[] = []
    for (const t of plan.targets) { // main.ts 的删法:一条一条,删前只核这一条
      const v = verifyClearTarget(t, input)
      results.push(v)
      if (v === 'rmdir') rmSync(t.path, { recursive: true, force: true })
      else if (v === 'unlink') rmSync(t.path, { force: true })
    }
    expect(results).toEqual(['rmdir', 'rmdir', 'unlink', 'unlink', 'unlink', 'gone', 'gone'])
    for (const p of [join(H, '.forsion'), join(H, 'Forsion'), join(ud, files[0])]) expect(existsSync(p)).toBe(false)
    for (const p of [join(H, '.tangu'), join(H, 'Tangu')]) expect(() => lstatSync(p)).toThrow() // 链接本身没了
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true) // 链接指向的东西原样在
    expect(existsSync(unit)).toBe(true)
    // 一开始就悬空的兼容软链(用户手动删过 ~/.forsion)也不挡清理
    symlinkSync(join(H, '.forsion', 'tangu'), join(H, '.tangu'))
    expect(clearDataPaths(input).refused).toEqual([])
  })

  it('删之前目录被换掉(另一个目录 / 换成软链)、或名册变得读不出 → changed(不删,算清理不完整)', () => {
    mkdirSync(join(H, '.forsion'))
    const input: ClearDataInput = { home: H, desktopFiles: files, tangu: true, role: 'owner', forsionHome: join(H, '.forsion'), workspace: join(H, 'Forsion'), userData: '/ud', unitDirs: [] }
    const t = clearDataPaths(input).targets[0] as ClearTarget
    expect(verifyClearTarget(t, { ...input, unitDirs: null })).toBe('changed')
    // 换成另一个目录:先挪走原目录再在原地新建,两者同时存在,inode 必然不同(Linux 上删完立刻新建常复用同一个 inode 号)
    renameSync(join(H, '.forsion'), join(H, '.forsion-old'))
    mkdirSync(join(H, '.forsion'))
    expect(verifyClearTarget(t, input)).toBe('changed')
    rmSync(join(H, '.forsion'), { recursive: true })
    symlinkSync(join(T), join(H, '.forsion'))
    expect(verifyClearTarget(t, input)).toBe('changed')
    // 计划时还没有、删之前建出来了(工作区):按身份再核一次沾边,不沾边才删
    const w = clearDataPaths(input).targets.find((x) => x.path === join(H, 'Forsion'))!
    expect(w.kind).toBe('absent')
    const inside = mkUnit(join(H, 'Forsion', 'U'))
    expect(verifyClearTarget(w, input)).toBe('rmdir')
    expect(verifyClearTarget(w, { ...input, unitDirs: [inside] })).toBe('changed')
  })

  it('什么都不勾 = 什么都不删', () => {
    expect(clearDataPaths({ home: H, desktopFiles: files, tangu: false, desktop: false, role: 'owner', forsionHome: '/a', workspace: '/b', userData: '/c', unitDirs: [] })).toEqual({ remove: [], targets: [], refused: [] })
  })
})
