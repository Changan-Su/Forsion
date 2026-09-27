import { describe, expect, it } from 'vitest'
import { __dictSnapshot } from '../i18n'
import './computerHistoryMessages'
import type { ComputerHistorySession, ComputerHistoryStatus } from '../../../shared/computerHistory'
import {
  CLEAR_CHOICES, PAUSE_CHOICES, STATUS_KEYS, clearArg, clockLabel, hoursSinceLocalMidnight, needsHelperSetup, normalizeBundleId,
  normalizeDomain, pauseArg, startOfLocalDay, statusTone, todaySessions, urlHost,
} from './computerHistoryModel'

const MIN = 60_000
const at = (h: number, m = 0, dayOffset = 0): number => new Date(2026, 8, 27 + dayOffset, h, m).getTime()

describe('computerHistoryModel', () => {
  it('pause 传时长(ms)或 tomorrow,不是绝对时刻', () => {
    expect(pauseArg('30m')).toBe(30 * MIN)
    expect(pauseArg('1h')).toBe(60 * MIN)
    expect(pauseArg('tomorrow')).toBe('tomorrow')
    expect(PAUSE_CHOICES.map((c) => c.id)).toEqual(['30m', '1h', 'tomorrow'])
  })

  it('clear 传绝对起点 now - 时长;全部 = all', () => {
    const now = at(15, 30)
    expect(clearArg('10m', now)).toEqual({ sinceMs: now - 10 * MIN })
    expect(clearArg('1h', now)).toEqual({ sinceMs: now - 60 * MIN })
    expect(clearArg('1d', now)).toEqual({ sinceMs: now - 24 * 60 * MIN })
    expect(clearArg('all', now)).toEqual({ all: true })
    expect(CLEAR_CHOICES.map((c) => c.id)).toEqual(['10m', '1h', '1d', 'all'])
  })

  it('规范化域名:剥协议 / 路径 / 端口 / www / 通配 / 尾点,转小写', () => {
    expect(normalizeDomain('example.com')).toBe('example.com')
    expect(normalizeDomain('  Example.COM.  ')).toBe('example.com')
    expect(normalizeDomain('https://www.example.com/a/b?q=1#x')).toBe('example.com')
    expect(normalizeDomain('*.mail.example.co.uk')).toBe('mail.example.co.uk')
    expect(normalizeDomain('example.com:8443/path')).toBe('example.com')
    expect(normalizeDomain('例子.中国')).toBe('xn--fsqu00a.xn--fiqs8s')
  })

  it('不合法的域名给 null', () => {
    for (const bad of ['', '   ', 'localhost', 'exa mple.com', 'example', '1.2.3.4', 'a..b', '-bad.com', 'http://', 'foo_bar.com']) {
      expect(normalizeDomain(bad), bad).toBeNull()
    }
  })

  it('手填 Bundle ID:至少一个点、不收通配与空白,大小写原样', () => {
    expect(normalizeBundleId('  com.apple.Health ')).toBe('com.apple.Health')
    expect(normalizeBundleId('com.microsoft.VSCode')).toBe('com.microsoft.VSCode')
    expect(normalizeBundleId('org.some_app.Foo-Bar')).toBe('org.some_app.Foo-Bar')
    for (const bad of ['', 'Health', 'com.apple.*', 'com..apple', '.com.apple', 'com.apple.', 'com apple.x', '-com.apple', 'com/apple.x', `a.${'b'.repeat(260)}`]) {
      expect(normalizeBundleId(bad), bad).toBeNull()
    }
  })

  it('预览只要今天:recent() 的小时数 = 零点到现在,下限 1 分钟', () => {
    expect(hoursSinceLocalMidnight(at(15, 30))).toBeCloseTo(15.5)
    expect(hoursSinceLocalMidnight(at(0, 0))).toBeCloseTo(1 / 60)
  })

  it('今天的会话:按本地日界过滤,新的在前', () => {
    const s = (start: number, end: number, app: string): ComputerHistorySession => ({ start, end, app, typed: [] })
    const now = at(12)
    const list = [
      s(at(9), at(9, 20), 'A'),
      s(at(23, 50, -1), at(0, 10), 'B'), // 跨午夜:结束在今天,留
      s(at(22, 0, -1), at(23, 0, -1), 'C'), // 昨天,丢
      s(at(11), at(11, 30), 'D'),
    ]
    expect(todaySessions(list, now).map((x) => x.app)).toEqual(['D', 'A', 'B'])
    expect(startOfLocalDay(now)).toBe(at(0))
  })

  it('时刻标签:同一天只写 HH:mm,跨天带日期', () => {
    const now = at(15, 5)
    expect(clockLabel(at(15, 35), now)).toBe('15:35')
    const tomorrow = clockLabel(at(0, 0, 1), now)
    expect(tomorrow).toContain('00:00')
    expect(tomorrow).not.toBe('00:00')
  })

  it('状态:色调与需要装 / 授权 helper 的三种', () => {
    const all: ComputerHistoryStatus[] = ['off', 'recording', 'paused', 'no_permission', 'helper_missing', 'helper_outdated', 'disconnected', 'unsupported']
    expect(all.filter(needsHelperSetup)).toEqual(['no_permission', 'helper_missing', 'helper_outdated'])
    expect(statusTone('recording')).toBe('ok')
    expect(statusTone('disconnected')).toBe('warn')
    expect(statusTone('no_permission')).toBe('warn')
    expect(statusTone('off')).toBe('idle')
    expect(Object.keys(STATUS_KEYS).sort()).toEqual([...all].sort())
  })

  it('主机名:解析失败给空串', () => {
    expect(urlHost('https://docs.example.com/a/b')).toBe('docs.example.com')
    expect(urlHost(undefined)).toBe('')
    expect(urlHost('not a url')).toBe('')
  })

  it('表里存的文案 key 中英都有(动态 t(key) 不在 i18nCoverage 的 C 断言扫描范围内)', () => {
    const { zh, en } = __dictSnapshot()
    const keys = [
      ...Object.values(STATUS_KEYS).flatMap((k) => [k.label, k.hint]),
      ...PAUSE_CHOICES.map((c) => c.labelKey),
      ...CLEAR_CHOICES.flatMap((c) => [c.labelKey, c.confirmKey]),
      'computerHistory.sites.invalid', 'computerHistory.sites.duplicate', 'computerHistory.apps.invalid', 'computerHistory.apps.duplicate',
    ]
    for (const k of keys) {
      expect(zh[k], `${k} zh`).toBeTruthy()
      expect(en[k], `${k} en`).toBeTruthy()
    }
  })
})
