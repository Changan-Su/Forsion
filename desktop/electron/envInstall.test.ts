import { describe, expect, it } from 'vitest'
import { downloadUrlFor, installCommandFor, requiredProgram } from './envInstall'
import { KNOWN_APPS } from '../shared/knownApps'

const NON_INTERACTIVE = ['--source winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']

describe('引导安装命令表', () => {
  it('Windows 的每条 winget 命令都带非交互参数(缺了新机器会卡在 msstore 协议提示上)', () => {
    const cmds = [
      ...['node', 'python3', 'git', 'docker'].map((tool) => installCommandFor(tool, 'win32', 'default')),
      ...Object.values(KNOWN_APPS).map((app) => app.install.win32).filter((c): c is string => !!c?.startsWith('winget')),
    ]
    expect(cmds.length).toBeGreaterThanOrEqual(5)
    for (const cmd of cmds) for (const flag of NON_INTERACTIVE) expect(cmd, cmd!).toContain(flag)
  })

  it('按命令找出它依赖的程序:不在就不给安装按钮', () => {
    expect(requiredProgram(installCommandFor('git', 'win32', 'default')!)).toBe('winget')
    expect(requiredProgram(installCommandFor('git', 'darwin', 'default')!)).toBe('brew')
    expect(requiredProgram(installCommandFor('git', 'linux', 'default')!)).toBe('apt-get')
    expect(requiredProgram(installCommandFor('docker', 'linux', 'china')!)).toBe('curl')
  })

  it('下载页:大陆镜像开着时 Windows 的 Git 走 npmmirror;未知工具没有下载页', () => {
    expect(downloadUrlFor('git', 'win32', 'china')).toContain('npmmirror.com')
    expect(downloadUrlFor('git', 'win32', 'default')).toBe('https://git-scm.com/downloads')
    expect(downloadUrlFor('tangu', 'win32', 'default')).toBeNull()
    expect(installCommandFor('tangu', 'win32', 'default')).toBeNull()
  })
})
