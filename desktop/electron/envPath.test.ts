/**
 * 钉 2026-09-06 的真事故:安装版里 agent 的 run_bash 拿不到 /opt/homebrew/bin,
 * yt-dlp 报 `ffprobe and ffmpeg not found`(青鸟收藏夹转录整条挂掉),而设置页的环境探测显示 ffmpeg 已装
 * —— 探测补了 PATH,托管引擎 spawn 没补。dev 从终端起继承完整 PATH,复现不出来。
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { appendUserBinDirs, composeEnginePath, darwinPathGitWorks, userBinDirs, withBundledGit } from './envPath'

const GUI_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter) // GUI 启动的 mac app 实拿到的那份

describe('appendUserBinDirs', () => {
  it('把真实存在的用户 bin 目录补进精简 PATH', () => {
    const present = userBinDirs().filter((d) => existsSync(d))
    expect(present.length).toBeGreaterThan(0) // 本机/CI 至少有一个(/usr/local/bin 之类)
    const out = appendUserBinDirs(GUI_PATH).split(delimiter)
    for (const d of present) expect(out).toContain(d)
  })

  it('已在 PATH 上的不重复追加', () => {
    const d = userBinDirs().find((x) => existsSync(x))!
    const out = appendUserBinDirs([GUI_PATH, d].join(delimiter)).split(delimiter)
    expect(out.filter((x) => x === d)).toHaveLength(1)
  })
})

describe('composeEnginePath 顺序即策略', () => {
  it('内置 Python 前置 → 继承 PATH → 用户 bin → 内置 Node 末尾', () => {
    const out = composeEnginePath(GUI_PATH, ['/py/bin'], ['/bundled/node/bin']).split(delimiter)
    expect(out[0]).toBe('/py/bin')                       // 接管 python
    expect(out.slice(1, 5)).toEqual(GUI_PATH.split(delimiter))
    expect(out[out.length - 1]).toBe('/bundled/node/bin') // 兜底,系统有 node 就用系统的
    const present = userBinDirs().filter((d) => existsSync(d))
    expect(out.slice(5, -1)).toEqual(present)             // 用户 bin 夹在中间
  })
})

describe('withBundledGit 只兜底、不抢用户的 git', () => {
  const broken = () => false
  const works = () => true

  it('Windows:追加在末尾,用户装的 Git for Windows 先命中', () => {
    // 分隔符用宿主的 delimiter(函数按它拼);这里钉的是顺序,不是 Windows 路径格式
    expect(withBundledGit(GUI_PATH, ['/res/git/cmd'], 'win32', works)).toBe([GUI_PATH, '/res/git/cmd'].join(delimiter))
  })

  it('mac PATH 查到的 git 不能用:前置,压过 /usr/bin/git 那个会弹「安装开发者工具」的 shim', () => {
    expect(withBundledGit(GUI_PATH, ['/res/git/bin'], 'darwin', broken).split(delimiter)[0]).toBe('/res/git/bin')
  })

  it('mac PATH 查到的 git 能用:完全不挂,原 PATH 一字不动', () => {
    expect(withBundledGit(GUI_PATH, ['/res/git/bin'], 'darwin', works)).toBe(GUI_PATH)
  })

  it('没有内置 git(Linux / 降级):原样返回', () => {
    expect(withBundledGit(GUI_PATH, [], 'darwin', broken)).toBe(GUI_PATH)
  })
})

describe('darwinPathGitWorks 看 PATH 实际命中的那份', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'path-git-'))
    writeFileSync(join(dir, 'git'), '#!/bin/sh\n'); chmodSync(join(dir, 'git'), 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('排在 /usr/bin 前面的真 git → 能用', () => {
    expect(darwinPathGitWorks([dir, GUI_PATH].join(delimiter), [])).toBe(true)
  })

  it('PATH 上一份 git 都没有 → 不能用', () => {
    const empty = mkdtempSync(join(tmpdir(), 'path-nogit-'))
    try { expect(darwinPathGitWorks(empty, [])).toBe(false) } finally { rmSync(empty, { recursive: true, force: true }) }
  })

  // Homebrew 有 git、没装 CLT:PATH 先命中 /usr/bin/git shim。旧判定「机器上有真 git 就不挂」在这里会弹框(Codex 评审 P1)。
  it.runIf(existsSync('/usr/bin/git'))('先命中 /usr/bin/git 时只看 CLT / Xcode,排在后面的真 git 不算', () => {
    expect(darwinPathGitWorks(['/usr/bin', dir].join(delimiter), [])).toBe(false)
    expect(darwinPathGitWorks(['/usr/bin', dir].join(delimiter), [join(dir, 'git')])).toBe(true)
  })
})
