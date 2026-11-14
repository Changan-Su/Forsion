import { describe, expect, it } from 'vitest'
import { clearDataPaths } from './clearDataPaths'

const H = '/Users/x'
const files = ['tangu-desktop-config.json', 'amadeus-config.json', 'remote-sessions.json']
const base = { home: H, desktopFiles: files, tangu: true, desktop: true }

describe('app:clearData 要删的路径', () => {
  it('默认那台:引擎 home + 工作区 + ~/.tangu、~/Tangu 软链 + 三份壳层文件', () => {
    expect(clearDataPaths({ ...base, role: 'owner', forsionHome: `${H}/.forsion`, workspace: `${H}/Forsion`, userData: '/ud' })).toEqual({
      remove: [`${H}/.forsion`, `${H}/Forsion`, `${H}/.tangu`, `${H}/Tangu`, '/ud/tangu-desktop-config.json', '/ud/amadeus-config.json', '/ud/remote-sessions.json'],
      refused: [],
    })
    // 显式 TANGU_HOME=…/tangu:只删它本身,不删推导出的父目录
    expect(clearDataPaths({ ...base, desktop: false, role: 'owner', envTanguHome: '/data/tangu', forsionHome: '/data', workspace: `${H}/Forsion`, userData: '/ud' }).remove[0]).toBe('/data/tangu')
  })

  it('插件沙箱:只删自己的 home 与工作区,不碰整机的兼容软链', () => {
    const r = clearDataPaths({ ...base, desktop: false, role: 'sandbox', envTanguHome: '/sbx/home', forsionHome: '/sbx/home', workspace: '/sbx/workspace', userData: '/sbx/ud' })
    expect(r.remove).toEqual(['/sbx/home', '/sbx/workspace'])
  })

  it('文件夹 Unit:只删本文件夹下的 home/ 与 Forsion/(不看环境变量),桌面那半删本文件夹 app-data 里的壳层文件', () => {
    const dir = `${H}/Forsion Units/A`
    const r = clearDataPaths({ ...base, role: 'folder', folderDir: dir, envTanguHome: `${H}/.forsion`, forsionHome: `${H}/.forsion`, workspace: `${H}/Forsion`, userData: `${dir}/app-data` })
    expect(r).toEqual({
      remove: [`${dir}/home`, `${dir}/Forsion`, `${dir}/app-data/tangu-desktop-config.json`, `${dir}/app-data/amadeus-config.json`, `${dir}/app-data/remote-sessions.json`],
      refused: [],
    })
    for (const p of r.remove) for (const bad of ['.forsion', '.forsion-dev', 'Forsion/', '.tangu', 'Tangu']) expect(p.startsWith(`${H}/${bad}`)).toBe(false)
  })

  it('文件夹放在默认那台的数据目录里 / 盖住家目录 → 不删,记进 refused', () => {
    const inside = clearDataPaths({ ...base, desktop: false, role: 'folder', folderDir: `${H}/.forsion/units/A`, forsionHome: '', workspace: '', userData: '' })
    expect(inside.remove).toEqual([])
    expect(inside.refused).toEqual([`${H}/.forsion/units/A/home`, `${H}/.forsion/units/A/Forsion`])
    // 文件夹 = 家目录的父目录(home/ 子目录正好就是家目录):那一条绝不删
    expect(clearDataPaths({ ...base, desktop: false, role: 'folder', folderDir: '/', forsionHome: '', workspace: '', userData: '', home: '/home' }).refused).toContain('/home')
    expect(clearDataPaths({ ...base, desktop: false, role: 'folder', forsionHome: '', workspace: '', userData: '' }).remove).toEqual([])
  })

  it('什么都不勾 = 什么都不删', () => {
    expect(clearDataPaths({ ...base, tangu: false, desktop: false, role: 'owner', forsionHome: '/a', workspace: '/b', userData: '/c' })).toEqual({ remove: [], refused: [] })
  })
})
