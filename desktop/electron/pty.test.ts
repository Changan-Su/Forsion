import { describe, it, expect } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { defaultShell, resolveCwd, saneSize } from './pty'

describe('pty 纯函数', () => {
  it('defaultShell 尊重 $SHELL 且走登录 shell(GUI 进程 PATH 残缺)', () => {
    expect(defaultShell('darwin', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'] })
    expect(defaultShell('linux', {})).toEqual({ file: '/bin/bash', args: ['-l'] })
    expect(defaultShell('win32', { COMSPEC: 'C:\\cmd.exe' })).toEqual({ file: 'C:\\cmd.exe', args: [] })
  })

  it('resolveCwd:不存在/非目录/缺省一律回家目录', () => {
    expect(resolveCwd(tmpdir())).toBe(tmpdir())
    expect(resolveCwd('/definitely/not/a/dir/xyz')).toBe(homedir())
    expect(resolveCwd(undefined)).toBe(homedir())
  })

  it('saneSize:NaN/0/负数/超大一律消毒(脏尺寸会让 pty 直接抛)', () => {
    expect(saneSize(120, 40)).toEqual({ cols: 120, rows: 40 })
    expect(saneSize(0, -3)).toEqual({ cols: 80, rows: 24 })
    expect(saneSize(NaN, undefined)).toEqual({ cols: 80, rows: 24 })
    expect(saneSize(99999, 1e9)).toEqual({ cols: 1000, rows: 1000 })
    expect(saneSize(80.7, 24.9)).toEqual({ cols: 80, rows: 24 })
  })
})
