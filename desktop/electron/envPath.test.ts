/**
 * 钉 2026-09-06 的真事故:安装版里 agent 的 run_bash 拿不到 /opt/homebrew/bin,
 * yt-dlp 报 `ffprobe and ffmpeg not found`(青鸟收藏夹转录整条挂掉),而设置页的环境探测显示 ffmpeg 已装
 * —— 探测补了 PATH,托管引擎 spawn 没补。dev 从终端起继承完整 PATH,复现不出来。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { appendUserBinDirs, composeEnginePath, userBinDirs } from './envPath'

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
