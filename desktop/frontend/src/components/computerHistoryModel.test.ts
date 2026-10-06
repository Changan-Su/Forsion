import { describe, expect, it } from 'vitest'
import { __dictSnapshot } from '../i18n'
import './computerHistoryMessages'
import type { ComputerHistorySession, ComputerHistoryStatus } from '../../../shared/computerHistory'
import {
  CLEAR_CHOICES, PAUSE_CHOICES, STATUS_KEYS, WINDOWS_STATUS_KEYS, clearArg, clockLabel, isSupportedPlatform, needsHelperSetup, normalizeBundleId, normalizeExeName,
  normalizeDomain, statusKeys, pauseArg, startOfLocalDay, statusTone, historyBlocks, urlHost, dayOptions, dayRange, dayStartAgo, localDayKey,
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

  it('按天回看:今天读零点到现在,往前的读整天到次日零点;下限 1 分钟', () => {
    expect(dayRange(at(15, 30), 0)).toEqual({ hours: expect.closeTo(15.5), end: at(15, 30) })
    expect(dayRange(at(0, 0), 0).hours).toBeCloseTo(1 / 60)
    expect(dayStartAgo(at(15, 30), 2)).toBe(at(0, 0, -2))
    expect(dayRange(at(15, 30), 2)).toEqual({ hours: 24, end: at(0, 0, -1) })
  })

  it('日期下拉只列有记录的日子:今天恒在,正选着的也留着', () => {
    const now = at(15)
    expect(localDayKey(now)).toBe('2026-09-27')
    const days = ['2026-09-27', '2026-09-25', '2026-09-10'] // 9/10 超出 7 天,不列
    expect(dayOptions(now, 7, days, 0)).toEqual([0, 2])
    expect(dayOptions(now, 7, [], 0)).toEqual([0]) // 今天还没记录也列
    expect(dayOptions(now, 7, days, 4)).toEqual([0, 2, 4]) // 选着的那天清空了,选项还在
  })

  it('时间线:按本地钟点 20 分钟分段,跨段按重叠拆,排除的只进图标行,新的在前', () => {
    const s = (start: number, end: number, app: string, title?: string, url?: string): ComputerHistorySession =>
      ({ start, end, app, bundleId: `id.${app}`, title, url, typed: [] })
    const now = at(12)
    const blocks = historyBlocks([
      s(at(23, 50, -1), at(0, 10), 'Mail', 'Inbox'), // 跨午夜:只算今天那 10 分钟
      s(at(22, 0, -1), at(23, 0, -1), 'Old', 'yesterday'), // 昨天,丢
      s(at(11, 10), at(11, 30), 'Chrome', 'Docs', 'https://docs.example.com/a'), // 11:00 段 10 分钟 + 11:20 段 10 分钟
      s(at(11, 25), at(11, 40), 'Code', 'main.ts'), // 恰好收在 11:40,不溢进下一段
      s(at(11, 5), at(11, 8), 'Secret'), // 排除:无标题
      s(at(11, 9), at(11, 9), 'Finder', 'Downloads'), // 零时长也露面
      s(at(23, 50), at(0, 30, 1), 'Late', 'tomorrow'), // 跨到明天:只算今天 23:40 段那 10 分钟
    ], startOfLocalDay(now))
    expect(blocks.map((b) => b.start)).toEqual([at(23, 40), at(11, 20), at(11), at(0)])
    blocks.shift()
    expect(blocks[0].items.map((i) => i.title)).toEqual(['main.ts', 'Docs'])
    expect(blocks[1].items).toEqual([
      { app: 'Chrome', bundleId: 'id.Chrome', title: 'Docs', host: 'docs.example.com' },
      { app: 'Finder', bundleId: 'id.Finder', title: 'Downloads', host: '' },
    ])
    expect(blocks[1].apps.map((a) => a.name)).toEqual(['Chrome', 'Secret', 'Finder'])
    expect(blocks[2].apps).toEqual([{ name: 'Mail', bundleId: 'id.Mail' }])
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

  it('平台:darwin / win32 支持,其余不支持;Windows 的「缺 / 旧」换成组件说法,其余状态与 mac 同键', () => {
    expect(['darwin', 'win32', 'linux', undefined].map(isSupportedPlatform)).toEqual([true, true, false, false])
    expect(statusKeys('helper_missing', 'win32').label).toBe('computerHistory.win.helperMissing')
    expect(statusKeys('helper_outdated', 'win32').hint).toBe('computerHistory.win.helperOutdatedHint')
    expect(statusKeys('helper_missing', 'darwin')).toBe(STATUS_KEYS.helper_missing)
    expect(statusKeys('recording', 'win32')).toBe(STATUS_KEYS.recording)
    expect(normalizeBundleId('chrome.exe')).toBe('chrome.exe') // Windows 的 App 标识 = exe 文件名,照样过校验
    expect(normalizeExeName(' Notepad++.EXE ')).toBe('notepad++.exe')
    expect(normalizeExeName('Code - Insiders.exe')).toBe('code - insiders.exe')
    expect(normalizeExeName('Acme, Inc.exe')).toBe('acme, inc.exe')
    expect(normalizeExeName('微信.exe')).toBe('微信.exe')
    for (const bad of ['chrome', 'C:\\Windows\\notepad.exe', '../x.exe', ' .exe', '*.exe']) expect(normalizeExeName(bad), bad).toBeNull()
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
      ...Object.values(WINDOWS_STATUS_KEYS).flatMap((k) => [k!.label, k!.hint]),
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
