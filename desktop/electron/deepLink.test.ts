import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'
import { filesFromArgv, pushOpenFile, drainOpenFiles } from './deepLink'

describe('filesFromArgv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfile-'))
  const md = join(dir, 'a.md')
  writeFileSync(md, '# a')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.pdf'), '%PDF')

  it('只认存在的普通文件:开关、URL、目录、不存在的路径都跳过', () => {
    const argv = ['--user-data-dir=/x', '-psn_0_123', 'forsion://open?x=1', dir, join(dir, 'nope.md'), md, '']
    expect(filesFromArgv(argv, '/')).toEqual([md])
  })

  it('相对路径按调用方 cwd 解析(win/linux 二启时是那边的工作目录)', () => {
    expect(filesFromArgv(['sub/b.pdf'], dir)).toEqual([join(dir, 'sub', 'b.pdf')])
  })

  it('file:// URL 转成路径(linux .desktop 的 %U);坏 URL 不抛', () => {
    expect(filesFromArgv([pathToFileURL(md).href, 'file://%zz'], '/')).toEqual([md])
  })
})

describe('open-file queue', () => {
  it('拿走即清,超过上限只留最近的', () => {
    for (let i = 0; i < 40; i++) pushOpenFile(`/f${i}.md`)
    const got = drainOpenFiles()
    expect(got.length).toBe(32)
    expect(got[0]).toBe('/f8.md')
    expect(drainOpenFiles()).toEqual([])
  })
})
