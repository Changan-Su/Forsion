import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  applyExclude, buildPolicy, ComputerHistory, ComputerHistoryStore, DEFAULT_TITLE_ONLY_BUNDLE_IDS, eventT, foldSessions,
  localDay, nextLocalMidnight, normalizeExclude, sanitizeEvent, stopComputerHistoryForWipe, tightenExclude,
  type ComputerHistoryDeps, type ComputerHistoryPersistPatch,
} from './computerHistory'
import { createSerialQueue } from './configWrite'
import type { ComputerHistoryEvent, ComputerHistoryState } from '../shared/computerHistory'

const DAY = 86_400_000
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ch-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'computer-history')
}
const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const lines = (file: string): ComputerHistoryEvent[] =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const readState = (root: string): ComputerHistoryState => JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))
const mode = (p: string): number => statSync(p).mode & 0o777

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ComputerHistoryStore', () => {
  it('按事件本地日期分文件追加;目录 0700 / 文件 0600;只在首次建根目录时打 Time Machine 排除', async () => {
    const root = tmpRoot()
    const tm = vi.fn(async () => {})
    const store = new ComputerHistoryStore(root, tm)
    const a = { t: at(2026, 9, 26, 23, 59), kind: 'app', app: { name: 'Safari', bundleId: 'com.apple.Safari' }, title: 'A' } as ComputerHistoryEvent
    const b = { t: at(2026, 9, 27, 0, 1), kind: 'text', app: { name: 'Safari', bundleId: 'com.apple.Safari' }, text: 'hi' } as ComputerHistoryEvent
    await store.append([a, b])
    await store.append([{ ...b, t: b.t + 1000 }])
    expect(readdirSync(store.eventsDir).sort()).toEqual(['2026-09-26.jsonl', '2026-09-27.jsonl'])
    expect(lines(path.join(store.eventsDir, '2026-09-26.jsonl'))).toEqual([a])
    expect(lines(path.join(store.eventsDir, '2026-09-27.jsonl')).map((e) => e.t)).toEqual([b.t, b.t + 1000])
    expect(mode(root)).toBe(0o700)
    expect(mode(store.eventsDir)).toBe(0o700)
    expect(mode(path.join(store.eventsDir, '2026-09-27.jsonl'))).toBe(0o600)
    expect(tm).toHaveBeenCalledTimes(1)
    expect(tm).toHaveBeenCalledWith(root)
  })

  const evLine = (t: number): string => `${JSON.stringify({ t, kind: 'app', app: { name: 'X', bundleId: 'x' } })}\n`

  it('有记录的日子:只算非空的日文件(清除后留下的空文件不算),临时文件不算', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    await store.ensureRoot()
    writeFileSync(path.join(store.eventsDir, '2026-09-26.jsonl'), evLine(at(2026, 9, 26, 10)))
    writeFileSync(path.join(store.eventsDir, '2026-09-25.jsonl'), '')
    writeFileSync(path.join(store.eventsDir, '2026-09-27.jsonl.1-x.tmp'), 'half')
    expect(await store.days()).toEqual(['2026-09-26'])
  })

  it('保留期:整天早于 now-7d 的日文件与残留 .tmp 删掉;截止那天按事件时间重写,只留 t >= now-7d(creview F)', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    await store.ensureRoot()
    const now = at(2026, 9, 27, 12)
    const cutoffT = now - 7 * DAY // 9/20 12:00
    const names = [0, 6, 7, 8, 30].map((d) => `${localDay(now - d * DAY)}.jsonl`)
    for (const d of [0, 6, 8, 30]) writeFileSync(path.join(store.eventsDir, `${localDay(now - d * DAY)}.jsonl`), evLine(now - d * DAY))
    // 截止那天:凌晨的已超过 7 天(旧实现要等到次日才删),下午的还在期内
    writeFileSync(path.join(store.eventsDir, names[2]), evLine(cutoffT - 9 * 3_600_000) + evLine(cutoffT + 3_600_000))
    writeFileSync(path.join(store.eventsDir, '2026-09-27.jsonl.123-x.tmp'), 'half')
    const removed = await store.prune(now)
    expect(removed.sort()).toEqual([names[3], names[4], '2026-09-27.jsonl.123-x.tmp'].sort())
    expect(readdirSync(store.eventsDir).sort()).toEqual([names[0], names[1], names[2]].sort())
    expect(lines(path.join(store.eventsDir, names[2])).map((e) => e.t)).toEqual([cutoffT + 3_600_000])
  })

  it('保留期精确边界(creview F):t = now-7d 留、早 1ms 删;残行删;原子重写 0600 不留 .tmp;一行不剩就删文件', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    await store.ensureRoot()
    const now = at(2026, 9, 27, 12)
    const cutoffT = now - 7 * DAY
    const file = path.join(store.eventsDir, `${localDay(cutoffT)}.jsonl`)
    writeFileSync(file, evLine(cutoffT - 1) + evLine(cutoffT) + '{"t":17\n' + evLine(cutoffT + 1), { mode: 0o600 })
    expect(await store.prune(now)).toEqual([])
    expect(lines(file).map((e) => e.t)).toEqual([cutoffT, cutoffT + 1])
    expect(mode(file)).toBe(0o600)
    expect(readdirSync(store.eventsDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    // 再往后 2ms:剩下两条也都过期 → 整个文件删掉
    expect(await store.prune(now + 2)).toEqual([path.basename(file)])
    expect(existsSync(file)).toBe(false)
  })

  it('保留期每小时(creview4 P1):日文件 t 不严格递增 —— 首行在期内也要逐行剪掉乱序的过期行;不逐行 JSON.parse', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    await store.ensureRoot()
    const now = at(2026, 9, 27, 12)
    const cutoffT = now - 7 * DAY
    const file = path.join(store.eventsDir, `${localDay(cutoffT)}.jsonl`)
    // 首行已在期内;后面一条更早的(去抖后才写入的文本事件就是这样乱序的)+ 一行残行
    const body = evLine(cutoffT + 60_000) + evLine(cutoffT + 120_000) + evLine(cutoffT - 1) + '{"t":17\n'
    writeFileSync(file, body, { mode: 0o600 })
    const parse = vi.spyOn(JSON, 'parse')
    cleanups.push(() => parse.mockRestore())
    const parsedLines = (): number => parse.mock.calls.filter(([s]) => typeof s === 'string' && s.startsWith('{"t":')).length
    expect(await store.prune(now)).toEqual([])
    expect(parsedLines()).toBe(1) // 只有残行那一次退回完整解析(先断言:下面的 lines() 自己也要 JSON.parse)
    expect(lines(file).map((e) => e.t)).toEqual([cutoffT + 60_000, cutoffT + 120_000]) // 乱序的过期行与残行都没了
    // 已剪干净:再跑一遍一行没丢 → 文件原样不动
    const after = readFileSync(file, 'utf8')
    expect(await store.prune(now)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(after)
  })

  it('保留期流式重写(creview3 #3):> 64KB、行跨块、多字节字符跨块、键序不同的行、残行 —— 留下的与逐行完整解析的结果逐字节一致', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    await store.ensureRoot()
    const now = at(2026, 9, 27, 12)
    const cutoffT = now - 7 * DAY
    const file = path.join(store.eventsDir, `${localDay(cutoffT)}.jsonl`)
    const rows: string[] = []
    for (let i = 0; i < 1500; i++) {
      const t = cutoffT - 750_000 + i * 1000
      const title = `标题${'电脑历史'.repeat(1 + (i % 7))}-${i}`
      rows.push(i % 97 === 5
        ? JSON.stringify({ kind: 'window', t, app: { name: 'Chrome', bundleId: 'c' }, title }) // t 不在最前:退回完整解析
        : JSON.stringify({ t, kind: 'window', app: { name: 'Chrome', bundleId: 'c' }, title }))
      if (i === 900) rows.push(`{"t":${t},"kind":"window","title":"半截`) // 残行
    }
    writeFileSync(file, rows.join('\n') + '\n', { mode: 0o600 })
    expect(statSync(file).size).toBeGreaterThan(3 * 64 * 1024)
    const expected = rows.filter((l) => { try { return JSON.parse(l).t >= cutoffT } catch { return false } })
    expect(expected.length).toBeGreaterThan(0)
    expect(expected.length).toBeLessThan(rows.length - 1)
    expect(await store.prune(now)).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(expected.join('\n') + '\n')
    expect(readdirSync(store.eventsDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('eventT:前缀正则取 t;键序不同 / 截断的行退回完整解析', () => {
    expect(eventT('{"t":1759000000123,"kind":"app"}')).toBe(1759000000123)
    expect(eventT('{"kind":"app","t":5}')).toBe(5)
    expect(eventT('{"t":17')).toBeNull()
    expect(eventT('{"t":17,"kind":"app","title":"半截')).toBeNull()
    expect(eventT('')).toBeNull()
    expect(eventT(null)).toBeNull()
  })

  it('clear(since):跨界那天原子重写只留 t < since(残行一并删),之后的整天删,之前的不动', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    const ev = (t: number): ComputerHistoryEvent => ({ t, kind: 'app', app: { name: 'X', bundleId: 'x' } })
    await store.append([ev(at(2026, 9, 25, 10)), ev(at(2026, 9, 26, 10)), ev(at(2026, 9, 26, 11)), ev(at(2026, 9, 26, 12)), ev(at(2026, 9, 27, 9))])
    const mid = path.join(store.eventsDir, '2026-09-26.jsonl')
    writeFileSync(mid, readFileSync(mid, 'utf8') + '{"t":17590\n', { flag: 'w' }) // 半截残行
    const before = readFileSync(path.join(store.eventsDir, '2026-09-25.jsonl'), 'utf8')
    await store.clear({ sinceMs: at(2026, 9, 26, 11, 30) })
    expect(readdirSync(store.eventsDir).sort()).toEqual(['2026-09-25.jsonl', '2026-09-26.jsonl'])
    expect(lines(mid).map((e) => e.t)).toEqual([at(2026, 9, 26, 10), at(2026, 9, 26, 11)])
    expect(mode(mid)).toBe(0o600)
    expect(readFileSync(path.join(store.eventsDir, '2026-09-25.jsonl'), 'utf8')).toBe(before)
    expect(readdirSync(store.eventsDir).some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('clear(all) 删光日文件;recentApps 新的在前、去重、跳过被排除的', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    const t0 = at(2026, 9, 26, 10)
    await store.append([
      { t: t0, kind: 'app', app: { name: 'Safari', bundleId: 'com.apple.Safari' } },
      { t: t0 + 1, kind: 'app', app: { name: '1Password', bundleId: 'com.1password.1password', excluded: true } },
      { t: t0 + 2, kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'x' },
      { t: at(2026, 9, 27, 9), kind: 'app', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' } },
      { t: at(2026, 9, 27, 9, 5), kind: 'app', app: { name: 'Safari', bundleId: 'com.apple.Safari' } },
    ])
    expect(await store.recentApps(10)).toEqual([
      { name: 'Safari', bundleId: 'com.apple.Safari' },
      { name: 'Code', bundleId: 'com.microsoft.VSCode' },
    ])
    await store.clear({ all: true })
    expect(readdirSync(store.eventsDir)).toEqual([])
  })

  it('recentApps 有界:每个日文件只读尾部,总量封顶;截断的首行不误读', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    const t0 = at(2026, 9, 27, 9)
    const filler = Array.from({ length: 200 }, (_, i) => ({ t: t0 + 1 + i, kind: 'text' as const, app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'x'.repeat(40) }))
    await store.append([{ t: t0 - DAY, kind: 'app', app: { name: 'Old', bundleId: 'com.old' } }])
    await store.append([{ t: t0, kind: 'app', app: { name: 'Early', bundleId: 'com.early' } }, ...filler, { t: t0 + 999, kind: 'app', app: { name: 'Late', bundleId: 'com.late' } }])
    expect((await store.recentApps(10)).map((a) => a.bundleId)).toEqual(['com.late', 'com.early', 'com.old'])
    expect((await store.recentApps(10, 1024 * 1024, 2_000)).map((a) => a.bundleId)).toEqual(['com.late', 'com.old']) // 今天那份只读了尾部
    expect((await store.recentApps(10, 2_000, 2_000)).map((a) => a.bundleId)).toEqual(['com.late']) // 总预算用完就不再读更早的日文件
  })

  it('writeState:commit 否决时不落盘、不留临时文件', async () => {
    const root = tmpRoot()
    const store = new ComputerHistoryStore(root)
    const s = (status: ComputerHistoryState['status']): ComputerHistoryState => ({ v: 1, enabled: true, pausedUntil: null, status, since: 0, updatedAt: 0, platform: 'darwin', dataGen: 0 })
    await store.writeState(s('disconnected'))
    await store.writeState(s('recording'), () => false)
    expect(readState(root).status).toBe('disconnected')
    expect(readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('输入收敛 / 策略', () => {
  it('sanitizeEvent:白名单字段 + 封顶;时间离谱丢;被排除 App 只留切换事实', () => {
    const now = Date.now()
    const ev = sanitizeEvent({ t: now, kind: 'text', app: { name: 'A', bundleId: 'a' }, text: 'x'.repeat(900), extra: 1, el: { role: 'AXTextArea', label: 'L' } }, now)!
    expect(ev.text).toHaveLength(500)
    expect(ev).not.toHaveProperty('extra')
    expect(ev.el).toEqual({ role: 'AXTextArea', label: 'L' })
    expect(sanitizeEvent({ t: now - 2 * DAY, kind: 'app' }, now)).toBeNull()
    expect(sanitizeEvent({ t: now + 3_600_000, kind: 'app' }, now)).toBeNull()
    expect(sanitizeEvent({ t: now, kind: 'screenshot' }, now)).toBeNull()
    expect(sanitizeEvent({ t: now, kind: 'app', app: { name: 'P', excluded: true }, title: 'secret' }, now)).toEqual({ t: now, kind: 'app', app: { name: 'P', excluded: true } })
  })

  it('排除表 → 下发策略:收敛输入、默认 titleOnly(Forsion / 终端 / 本 App)合并,排除优先', () => {
    const ex = normalizeExclude({
      apps: [' com.x.App ', 'bad/id', 'com.x.App', 'com.apple.Terminal', 42],
      domains: ['https://Mail.Example.com/inbox?x=1', '*.bank.cn', '.corp.local', 'not a domain', 'mail.example.com'],
    })
    expect(ex).toEqual({ apps: ['com.x.App', 'com.apple.Terminal'], domains: ['mail.example.com', 'bank.cn', 'corp.local'] })
    const policy = buildPolicy(ex, 'com.github.Electron')
    expect(policy.excludeBundleIds).toEqual(['com.x.App', 'com.apple.Terminal'])
    expect(policy.excludeDomains).toEqual(['mail.example.com', 'bank.cn', 'corp.local'])
    expect(policy.titleOnlyBundleIds).toContain('com.forsion.*')
    expect(policy.titleOnlyBundleIds).toContain('com.googlecode.iterm2')
    expect(policy.titleOnlyBundleIds).toContain('com.github.Electron')
    expect(policy.titleOnlyBundleIds).not.toContain('com.apple.Terminal') // 被用户排除 → 不再只记标题,而是什么都不记
    expect(policy).toMatchObject({ text: true, clicks: true, keys: true })
    expect(buildPolicy({ apps: [], domains: [] }).titleOnlyBundleIds).toEqual([...DEFAULT_TITLE_ONLY_BUNDLE_IDS])
    // Windows 的 exe 名常带空格、+、括号(notepad++.exe / Code - Insiders.exe)
    expect(normalizeExclude({ apps: ['notepad++.exe', 'Code - Insiders.exe', 'Acme, Inc.exe', '微信.exe', 'a\\b.exe', 'a:b.exe'], domains: [] }).apps)
      .toEqual(['notepad++.exe', 'Code - Insiders.exe', 'Acme, Inc.exe', '微信.exe'])
  })

  it('applyExclude:排除 App 只留不带标题的 app 切换(它的 window 事件整条丢);排除站点留一条不带内容的标记、同 App 连续不重复', () => {
    const ex = { apps: ['com.bank'], domains: ['bank.cn'] }
    const t = 1
    const bank = { name: 'Bank', bundleId: 'com.bank' }
    const chrome = { name: 'Chrome', bundleId: 'c' }
    expect(applyExclude({ t, kind: 'app', app: bank, title: 'acct' }, ex))
      .toEqual({ t, kind: 'app', app: { ...bank, excluded: true } })
    // 排除 App 里换窗口 / 改标题:去掉标题也不留(落盘的时间与次数本身就在泄露)
    expect(applyExclude({ t, kind: 'window', app: bank, title: 'Transfer' }, ex)).toBeNull()
    expect(applyExclude({ t, kind: 'window', app: { name: 'Bank', bundleId: 'COM.BANK' } }, ex)).toBeNull()
    expect(applyExclude({ t, kind: 'text', app: bank, text: 'pw' }, ex)).toBeNull()
    // 排除站点:切进去那一下留一条标记(否则折叠把这段时间记到上一个页面头上)
    expect(applyExclude({ t, kind: 'window', app: chrome, title: 'x', url: 'https://www.bank.cn/a' }, ex))
      .toEqual({ t, kind: 'window', app: { ...chrome, excluded: true } })
    expect(applyExclude({ t, kind: 'window', app: chrome, title: 'x', url: 'https://www.bank.cn/a' }, ex, { context: { bundleId: 'c', url: 'https://ok.example/', excluded: false } }))
      .toEqual({ t, kind: 'window', app: { ...chrome, excluded: true } })
    // 已在同一 App 的排除情境里:站内的标题 / 网址变化不再记
    const onBank = { bundleId: 'c', url: 'https://www.bank.cn/a', excluded: true }
    expect(applyExclude({ t, kind: 'window', app: chrome, title: 'y', url: 'https://www.bank.cn/b' }, ex, { context: onBank })).toBeNull()
    expect(applyExclude({ t, kind: 'window', app: { ...chrome, excluded: true } }, ex, { context: onBank })).toBeNull() // helper 标的同理
    // 切回这个 App 本身(app 事件)照留一条切换事实
    expect(applyExclude({ t, kind: 'app', app: chrome, url: 'https://www.bank.cn/b' }, ex, { context: onBank }))
      .toEqual({ t, kind: 'app', app: { ...chrome, excluded: true } })
    expect(applyExclude({ t, kind: 'window', app: chrome, url: 'https://notbank.cn/' }, ex)).not.toBeNull()
    expect(applyExclude({ t, kind: 'window', app: chrome, url: 'https://notbank.cn/' }, ex, { context: onBank })).not.toBeNull()
  })

  it('applyExclude:与 helper 同口径(不分大小写、`.*` 前缀通配);只记标题的 App 丢输入;不带 url 的输入按当前情境补判', () => {
    const t = 1
    const bank = { name: 'Bank', bundleId: 'com.bank.app' }
    const chrome = { name: 'Chrome', bundleId: 'com.google.Chrome' }
    const iterm = { name: 'iTerm', bundleId: 'com.googlecode.iterm2' }
    // 用户规则 `com.Bank.*`:helper 那边命中,这里也得命中
    expect(applyExclude({ t, kind: 'text', app: bank, text: 'pw' }, { apps: ['com.Bank.*'], domains: [] })).toBeNull()
    expect(applyExclude({ t, kind: 'app', app: bank, title: 'acct' }, { apps: ['com.Bank.*'], domains: [] })?.app?.excluded).toBe(true)
    expect(applyExclude({ t, kind: 'text', app: { name: 'X', bundleId: 'com.bankx.app' }, text: 'ok' }, { apps: ['com.bank.*'], domains: [] })).not.toBeNull()
    // 只记标题:窗口事件照收,text / click / key 丢(包括 com.forsion.* 通配)
    const titleOnly = buildPolicy({ apps: [], domains: [] }).titleOnlyBundleIds
    const none = { apps: [], domains: [] }
    expect(applyExclude({ t, kind: 'text', app: { ...iterm, bundleId: 'com.googlecode.ITERM2' }, text: 'export KEY=…' }, none, { titleOnly })).toBeNull()
    expect(applyExclude({ t, kind: 'key', app: { name: 'Forsion', bundleId: 'com.forsion.desktop' }, keys: '⌘K' }, none, { titleOnly })).toBeNull()
    expect(applyExclude({ t, kind: 'window', app: iterm, title: 'zsh' }, none, { titleOnly })).not.toBeNull()
    // 情境在排除站点上:不带 url 的输入 / 点击丢;带了别的 App 的输入不受这个情境影响
    const ex = { apps: [], domains: ['bank.cn'] }
    const onBank = { bundleId: chrome.bundleId, url: 'https://www.bank.cn/login', excluded: false }
    expect(applyExclude({ t, kind: 'text', app: chrome, text: 'pw' }, ex, { context: onBank })).toBeNull()
    expect(applyExclude({ t, kind: 'click', app: chrome, el: { role: 'AXButton', label: 'Pay' } }, ex, { context: onBank })).toBeNull()
    expect(applyExclude({ t, kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'x' }, ex, { context: onBank })).not.toBeNull()
    // 情境本身被排除(helper 标了 excluded):同 App 的输入丢
    expect(applyExclude({ t, kind: 'text', app: chrome, text: 'x' }, none, { context: { bundleId: chrome.bundleId, excluded: true } })).toBeNull()
    expect(applyExclude({ t, kind: 'text', app: chrome, text: 'x', url: 'https://ok.example/' }, ex, { context: onBank })).not.toBeNull() // 自己带 url 的按自己判
  })

  it('断点标 resumed(creview3 #4):只认 app / window、排除 App 的切换上也留;排除标记带着它;「排除站点 → 无痕 → 同一排除站点」那条标记不丢', () => {
    const now = Date.now()
    const chrome = { name: 'Chrome', bundleId: 'com.google.Chrome' }
    expect(sanitizeEvent({ t: now, kind: 'window', app: chrome, title: 'B', resumed: true }, now)?.resumed).toBe(true)
    expect(sanitizeEvent({ t: now, kind: 'app', app: { name: 'P', excluded: true }, title: 'secret', resumed: true }, now))
      .toEqual({ t: now, kind: 'app', app: { name: 'P', excluded: true }, resumed: true })
    expect(sanitizeEvent({ t: now, kind: 'text', app: chrome, text: 'x', resumed: true }, now)).not.toHaveProperty('resumed')
    expect(sanitizeEvent({ t: now, kind: 'window', app: chrome, resumed: 'yes' }, now)).not.toHaveProperty('resumed')

    const t = 1
    const ex = { apps: ['com.bank'], domains: ['bank.cn'] }
    const onBank = { bundleId: chrome.bundleId, url: 'https://www.bank.cn/a', excluded: true }
    const back = { t, kind: 'window' as const, app: chrome, title: 'x', url: 'https://www.bank.cn/a' }
    // 老 helper 没有断点标:同 App 的排除情境里不重复标
    expect(applyExclude(back, ex, { context: onBank })).toBeNull()
    // 新 helper:无痕之后回到同一排除站点 → 留一条带断点标、不带内容的标记
    expect(applyExclude({ ...back, resumed: true }, ex, { context: onBank }))
      .toEqual({ t, kind: 'window', app: { ...chrome, excluded: true }, resumed: true })
    expect(applyExclude({ ...back, app: { ...chrome, excluded: true }, title: undefined, url: undefined, resumed: true }, ex, { context: onBank }))
      .toEqual({ t, kind: 'window', app: { ...chrome, excluded: true }, resumed: true })
    // 普通情境 → 无痕 → 排除站点 / 排除 App:标记带着断点标
    expect(applyExclude({ ...back, resumed: true }, ex, { context: { bundleId: chrome.bundleId, url: 'https://ok.example/', excluded: false } }))
      .toEqual({ t, kind: 'window', app: { ...chrome, excluded: true }, resumed: true })
    expect(applyExclude({ t, kind: 'app', app: { name: 'Bank', bundleId: 'com.bank' }, title: 'acct', resumed: true }, ex))
      .toEqual({ t, kind: 'app', app: { name: 'Bank', bundleId: 'com.bank', excluded: true }, resumed: true })
    // 普通事件原样过
    expect(applyExclude({ t, kind: 'window', app: chrome, title: 'B', url: 'https://ok.example/b', resumed: true }, ex)?.resumed).toBe(true)
  })
})

describe('foldSessions', () => {
  const base = at(2026, 9, 27, 9)
  const chrome = { name: 'Chrome', bundleId: 'com.google.Chrome' }
  const e = (s: number, x: Partial<ComputerHistoryEvent>): ComputerHistoryEvent => ({ t: base + s * 1000, kind: 'app', ...x })
  it('同 App+标题合段;打字归当前段;瞄一眼的短段吞掉并回;锁屏收尾;无字短段丢', () => {
    const sessions = foldSessions([
      e(0, { kind: 'app', app: chrome, title: 'Docs', url: 'https://docs.example.com/d/1' }),
      e(5, { kind: 'text', app: chrome, text: 'hello   world' }),
      e(6, { kind: 'text', app: chrome, text: 'by agent', origin: 'agent' }),
      e(60, { kind: 'window', app: chrome, title: 'Mail' }),
      e(62, { kind: 'app', app: { name: 'Finder', bundleId: 'com.apple.finder' }, title: 'Downloads' }),
      e(65, { kind: 'app', app: chrome, title: 'Mail' }),
      e(300, { kind: 'system', state: 'locked' }),
      e(900, { kind: 'system', state: 'unlocked' }),
      e(905, { kind: 'app', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' }, title: 'main.ts' }),
      e(1000, { kind: 'key', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' }, keys: '⌘S' }),
      e(1003, { kind: 'app', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, title: 'n' }),
      e(1004, { kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'quick' }),
    ])
    expect(sessions.map((s) => [s.app, s.title, (s.start - base) / 1000, (s.end - base) / 1000, s.typed])).toEqual([
      ['Chrome', 'Docs', 0, 60, ['hello world']],
      ['Chrome', 'Mail', 60, 300, []],
      ['Code', 'main.ts', 905, 1003, []],
      ['Notes', 'n', 1003, 1004, ['quick']], // 短但打了字 → 保留
    ])
    expect(sessions[0].url).toBe('https://docs.example.com/d/1')
    expect(sessions[0].bundleId).toBe('com.google.Chrome')
  })

  it('排除段遇断点收到断点那一刻(排除标记就是起点,那段时间确实在被排除处,不是 0 秒)', () => {
    const code = { name: 'Code', bundleId: 'com.microsoft.VSCode' }
    const pw = { name: '1Password', bundleId: 'com.1password.1password', excluded: true as const }
    const s = foldSessions([e(0, { app: code, title: 'x' }), e(600, { app: pw }), e(1200, { app: code, title: 'x', resumed: true }), e(1800, { app: chrome, title: 'y' })])
    expect(s.map((x) => [x.app, (x.start - base) / 1000, (x.end - base) / 1000])).toEqual([['Code', 0, 600], ['1Password', 600, 1200], ['Code', 1200, 1800]])
    // 在排除 App 里待了 45 分钟(超过 30 分钟空档规则)再回来:仍报真实时长,不被空档规则收在起点(creview4 P2)
    const long = foldSessions([e(0, { app: code, title: 'x' }), e(600, { app: pw }), e(600 + 45 * 60, { app: code, title: 'x', resumed: true }), e(600 + 50 * 60, { app: chrome, title: 'y' })])
    expect(long.map((x) => [x.app, (x.start - base) / 1000, (x.end - base) / 1000])[1]).toEqual(['1Password', 600, 600 + 45 * 60])
  })

  it('长时间没事件(Forsion 没开)不把空白算给上一个窗口', () => {
    const s = foldSessions([e(0, { app: chrome, title: 'A' }), e(40, { kind: 'click', app: chrome }), e(5 * 3600, { app: chrome, title: 'B' }), e(5 * 3600 + 30, { kind: 'key', app: chrome, keys: '⌘T' })])
    expect(s.map((x) => [x.title, (x.end - x.start) / 1000])).toEqual([['A', 40], ['B', 30]])
  })

  it('排除标记自成一段(creview I):无标题页面与无标题排除标记不同键;不足 10s 的标记也挡住往回并段;排除段不收网址与打字', () => {
    const marker = { ...chrome, excluded: true as const }
    // (a) 无标题的正常页面 → 排除站点待了 4 分钟 → 别的页面:排除期间不能算到前一页(及其网址)头上
    const a = foldSessions([
      e(0, { kind: 'app', app: chrome, url: 'https://ok.example/' }),
      e(30, { kind: 'click', app: chrome }),
      e(60, { kind: 'window', app: marker }),
      e(100, { kind: 'text', app: chrome, text: 'leak' }),
      e(300, { kind: 'window', app: chrome, title: 'News', url: 'https://news.example.com/' }),
      e(400, { kind: 'key', app: chrome, keys: '⌘R' }),
    ])
    expect(a.map((s) => [s.title, (s.start - base) / 1000, (s.end - base) / 1000, s.url, s.typed])).toEqual([
      [undefined, 0, 60, 'https://ok.example/', []],
      [undefined, 60, 300, undefined, []],
      ['News', 300, 400, 'https://news.example.com/', []],
    ])
    // (b) 瞄了 5 秒排除站点又回到同一个无标题页面:标记太短被丢,但两边仍是两段,不并成一段把那 5 秒吞进去
    const b = foldSessions([
      e(0, { kind: 'app', app: chrome, url: 'https://ok.example/' }),
      e(60, { kind: 'window', app: marker }),
      e(65, { kind: 'window', app: chrome, url: 'https://ok.example/' }),
      e(200, { kind: 'key', app: chrome, keys: '⌘S' }),
    ])
    expect(b.map((s) => [(s.start - base) / 1000, (s.end - base) / 1000])).toEqual([[0, 60], [65, 200]])
  })

  // helper 不发无痕窗口的任何事件、并对连着的同键情境事件去重:「A → 无痕 → 回到 A」落盘就是两条同键的 A
  const pageA = { app: chrome, title: 'Docs', url: 'https://docs.example.com/a' }
  const finder = { name: 'Finder', bundleId: 'com.apple.finder' }
  const code = { name: 'Code', bundleId: 'com.microsoft.VSCode' }
  const cols = (ss: ReturnType<typeof foldSessions>) => ss.map((s) => [s.app, s.title, (s.start - base) / 1000, (s.end - base) / 1000])

  it('重复的相同情境事件 = 边界(无痕窗口):A 收在自己最后一条事件,不延到重复那条;不看 kind;同标题换网址不算重复', () => {
    const s = foldSessions([
      e(0, { kind: 'app', ...pageA }), // 激活 Chrome(普通窗口 A)
      e(20, { kind: 'window', app: chrome, title: 'Docs', url: 'https://docs.example.com/b' }), // 同标题换网址:键变了,照常续段
      e(25, { kind: 'window', ...pageA }), // 回到 a:与上一条不同键,不是重复
      e(40, { kind: 'key', app: chrome, keys: '⌘F' }), // A 的最后一条事件 —— 之后进了无痕窗口 6 分钟,一条事件都没有
      e(400, { kind: 'window', ...pageA }), // 从无痕回到 A:与上一条情境同键(kind 不同也算)
      e(500, { kind: 'click', app: chrome }),
      e(600, { kind: 'app', app: finder, title: 'Downloads' }),
      e(700, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(s)).toEqual([
      ['Chrome', 'Docs', 0, 40], // 此前:0 → 600,把无痕那 6 分钟算给了 A
      ['Chrome', 'Docs', 400, 600],
      ['Finder', 'Downloads', 600, 700],
    ])
  })

  it('重复边界挡住往回并段:缝隙 ≤ 60s 也不把两段 A 并回去;短的边界段也不让别的段跨过它往回并', () => {
    // (a) 无痕只待了 30 秒:两段 A 之间只隔 30s,老的「≤ 60s 并回」会把这 30 秒算回 A
    const a = foldSessions([
      e(0, { kind: 'window', ...pageA }),
      e(20, { kind: 'click', app: chrome }),
      e(50, { kind: 'window', ...pageA }),
      e(100, { kind: 'key', app: chrome, keys: '⌘S' }),
      e(120, { kind: 'app', app: finder, title: 'Downloads' }),
      e(200, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(a)).toEqual([['Chrome', 'Docs', 0, 20], ['Chrome', 'Docs', 50, 120], ['Finder', 'Downloads', 120, 200]])
    // (b) 编辑器 → 切到 A(0 秒)→ 无痕 25 秒 → 回 A 5 秒 → 回编辑器:两段 A 都短被丢,但编辑器两段不能跨过边界并成一段
    const b = foldSessions([
      e(0, { kind: 'app', app: code, title: 'main.ts' }),
      e(30, { kind: 'app', ...pageA }),
      e(55, { kind: 'window', ...pageA }),
      e(60, { kind: 'app', app: code, title: 'main.ts' }),
      e(200, { kind: 'key', app: code, keys: '⌘S' }),
      e(210, { kind: 'app', app: finder, title: 'Downloads' }),
    ])
    expect(cols(b)).toEqual([['Code', 'main.ts', 0, 30], ['Code', 'main.ts', 60, 210]])
  })

  it('锁屏后 helper 重拍的同一情境不另算边界(锁屏本身已收尾,沿用 ≤ 60s 并回口径);dropped 不清「上一条情境」', () => {
    const locked = foldSessions([
      e(0, { kind: 'app', ...pageA }),
      e(100, { kind: 'key', app: chrome, keys: '⌘S' }),
      e(120, { kind: 'system', state: 'locked' }),
      e(150, { kind: 'system', state: 'unlocked' }),
      e(151, { kind: 'app', ...pageA }), // helper 解锁后清掉去重键并重拍前台
      e(300, { kind: 'app', app: finder, title: 'Downloads' }),
      e(400, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(locked)).toEqual([['Chrome', 'Docs', 0, 300], ['Finder', 'Downloads', 300, 400]])
    // helper 丢了事件(背压)之后又来一条同键的 A:中间可能切走过,照样当边界
    const dropped = foldSessions([
      e(0, { kind: 'app', ...pageA }),
      e(40, { kind: 'click', app: chrome }),
      e(90, { kind: 'system', state: 'dropped', count: 3 }),
      e(95, { kind: 'window', ...pageA }),
      e(200, { kind: 'app', app: finder, title: 'Downloads' }),
      e(300, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(dropped)).toEqual([['Chrome', 'Docs', 0, 40], ['Chrome', 'Docs', 95, 200], ['Finder', 'Downloads', 200, 300]])
  })

  it('断点标 resumed = 边界(creview3 #4):A → 无痕 → 同标题换网址的 B,无痕时段不算给 A、B 不并回 A、A 的网址不被改写', () => {
    const pageB = { app: chrome, title: 'Docs', url: 'https://docs.example.com/b' }
    const s = foldSessions([
      e(0, { kind: 'app', ...pageA }),
      e(40, { kind: 'click', app: chrome }), // A 的最后一条事件,之后进了无痕窗口
      e(400, { kind: 'window', ...pageB, resumed: true }), // 与 A 不同键(网址不同),老判法认不出
      e(500, { kind: 'key', app: chrome, keys: '⌘S' }),
      e(600, { kind: 'app', app: finder, title: 'Downloads' }),
      e(700, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(s)).toEqual([['Chrome', 'Docs', 0, 40], ['Chrome', 'Docs', 400, 600], ['Finder', 'Downloads', 600, 700]])
    expect(s.map((x) => x.url)).toEqual(['https://docs.example.com/a', 'https://docs.example.com/b', undefined])
    // 无痕只待了 20 秒(≤ 60s 并回口径之内)也不并回
    const short = foldSessions([
      e(0, { kind: 'app', ...pageA }),
      e(30, { kind: 'click', app: chrome }),
      e(50, { kind: 'window', ...pageB, resumed: true }),
      e(100, { kind: 'app', app: finder, title: 'Downloads' }),
      e(200, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(short)).toEqual([['Chrome', 'Docs', 0, 30], ['Chrome', 'Docs', 50, 100], ['Finder', 'Downloads', 100, 200]])
    // 排除站点 → 无痕 → 同一排除站点(标记带断点标)→ 普通页面:同 App 内的断点结束时刻不明,排除段不延长,
    // 无痕时段不算进排除段(creview4 P2);延长只给「别的 App 的断点」,见下一条
    const marker = { ...chrome, excluded: true as const }
    const ex = foldSessions([
      e(0, { kind: 'app', ...pageA }),
      e(60, { kind: 'window', app: marker }),
      e(400, { kind: 'window', app: marker, resumed: true }),
      e(450, { kind: 'window', app: chrome, title: 'News', url: 'https://news.example.com/' }),
      e(600, { kind: 'app', app: code, title: 'main.ts' }),
    ])
    expect(cols(ex)).toEqual([['Chrome', 'Docs', 0, 60], ['Chrome', undefined, 400, 450], ['Chrome', 'News', 450, 600]])
  })
})

// ── 控制器 × 假 helper(unix socket) ────────────────────────────────────────

type HelperMode = 'ok' | 'denied' | 'unknown' | 'old' | 'untrusted'
let sockSeq = 0
function fakeHelper() {
  const sockPath = path.join(os.tmpdir(), `chs-${process.pid}-${++sockSeq}.sock`)
  const conns = new Set<net.Socket>()
  const requests: Array<Record<string, any>> = []
  let accepted = 0
  let helperMode: HelperMode = 'ok'
  const server = net.createServer((sock) => {
    accepted++
    conns.add(sock)
    sock.on('close', () => conns.delete(sock))
    sock.on('error', () => {})
    sock.setEncoding('utf8')
    let buf = ''
    sock.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const req = JSON.parse(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      requests.push(req)
      const reply = helperMode === 'ok' ? { ok: true, result: { subscribed: true, protocolVersion: 13, axTrusted: true } }
        : helperMode === 'old' ? { ok: true, result: { subscribed: true, protocolVersion: 12, axTrusted: true } }
        : helperMode === 'untrusted' ? { ok: true, result: { subscribed: true, protocolVersion: 13, axTrusted: false } }
        : helperMode === 'denied' ? { ok: false, error: { code: 'accessibility_denied', message: 'Accessibility not granted' } }
        : { ok: false, error: { code: 'unknown_command', message: "Unknown command 'recordSubscribe'" } }
      sock.write(`${JSON.stringify({ id: req.id, ...reply })}\n`)
    })
  })
  const h = {
    sockPath,
    requests,
    get accepted() { return accepted },
    get open() { return conns.size },
    setMode: (m: HelperMode) => { helperMode = m },
    listen: () => new Promise<void>((r) => server.listen(sockPath, () => r())),
    push: (ev: unknown) => { for (const c of conns) c.write(`${JSON.stringify({ ev })}\n`) },
    kick: () => { for (const c of conns) c.destroy() },
    close: () => new Promise<void>((r) => { for (const c of conns) c.destroy(); server.close(() => r()) }),
  }
  cleanups.push(() => h.close().catch(() => {}))
  cleanups.push(() => rmSync(sockPath, { force: true }))
  return h
}

function makeController(sockPath: string, over: Partial<ComputerHistoryDeps> = {}) {
  const root = over.root ?? tmpRoot()
  const helperApp = path.join(path.dirname(root), 'tangu-computer-use.app')
  const persist = vi.fn(async (_patch: ComputerHistoryPersistPatch): Promise<void> => {})
  const onChanged = vi.fn()
  const launchHelper = vi.fn(async () => {})
  const ch = new ComputerHistory({
    root, platform: 'darwin', socketPath: sockPath, externalSocket: false, helperAppPath: () => helperApp,
    // 函数形态的补丁(后台补落)在「写盘」这一刻求值 —— 这里就是调用那一刻;mock 记下的永远是对象
    persist: (p) => persist(typeof p === 'function' ? p() : p), onChanged, launchHelper, tmExclude: async () => {}, ...over,
  })
  cleanups.push(async () => { ch.dispose(); await ch.flush().catch(() => {}) }) // 等队列里的写落完再删临时目录
  const installHelper = () => {
    mkdirSync(path.join(helperApp, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(helperApp, 'Contents', 'MacOS', 'bridge'), '')
    chmodSync(path.join(helperApp, 'Contents', 'MacOS', 'bridge'), 0o755)
  }
  return { ch, root, persist, onChanged, launchHelper, installHelper }
}

describe('ComputerHistory × helper 订阅', () => {
  it('开着:订阅(带策略)→ 事件流按 1s 批量落盘;state.json 跟着状态走', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath, { selfBundleId: 'com.github.Electron' })
    await ch.start({ computerHistoryEnabled: true, computerHistoryExclude: { apps: ['com.bank'], domains: ['bank.cn'] } })
    await waitFor(() => ch.view().state.status === 'recording')
    expect(helper.requests[0]).toMatchObject({ cmd: 'recordSubscribe', policy: { excludeBundleIds: ['com.bank'], excludeDomains: ['bank.cn'] } })
    expect(helper.requests[0].policy.titleOnlyBundleIds).toEqual(expect.arrayContaining(['com.forsion.*', 'com.github.Electron']))
    const t = Date.now()
    const safari = { name: 'Safari', bundleId: 'com.apple.Safari' }
    helper.push({ t, kind: 'app', app: safari, title: 'Docs', url: 'https://example.com/a', junk: 1 })
    helper.push({ t: t + 1, kind: 'text', app: safari, text: 'hello', el: { role: 'AXTextField' } })
    helper.push({ t: t + 2, kind: 'text', app: { name: 'Bank', bundleId: 'com.bank' }, text: 'leak' }) // 防御纵深:主进程再滤一次
    helper.push({ t: 5, kind: 'app', app: safari }) // 离谱时间戳
    const file = path.join(root, 'events', `${localDay(t)}.jsonl`)
    await waitFor(() => existsSync(file) && lines(file).length >= 2, 3_000) // 不手动 flush:1s 批量计时器自己落
    await ch.flush()
    expect(lines(file)).toEqual([
      { t, kind: 'app', app: safari, title: 'Docs', url: 'https://example.com/a' },
      { t: t + 1, kind: 'text', app: safari, text: 'hello', el: { role: 'AXTextField' } },
    ])
    expect(readState(root)).toMatchObject({ v: 1, enabled: true, pausedUntil: null, status: 'recording', platform: 'darwin' })
    expect(mode(path.join(root, 'state.json'))).toBe(0o600)
    expect((await ch.recent(1)).map((s) => s.title)).toEqual(['Docs'])
    expect(await ch.recent(1, t - 60_000)).toEqual([]) // 按天回看:end 在事件之前 → 读不到
    expect(await ch.days()).toEqual([localDay(t)])
    expect((await ch.recent(1, t + 3_600_000)).map((s) => s.title)).toEqual(['Docs']) // end 超过现在按现在算
    expect(await ch.recentApps()).toEqual([safari])
  })

  it('断线 → disconnected → 退避后重连回到 recording', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    helper.kick()
    await waitFor(() => ch.view().state.status === 'disconnected')
    await ch.flush()
    expect(readState(root).status).toBe('disconnected')
    await waitFor(() => ch.view().state.status === 'recording', 4_000)
    expect(helper.requests.filter((r) => r.cmd === 'recordSubscribe')).toHaveLength(2)
  })

  it('老 helper:unknown_command / 协议 < 13 → helper_outdated', async () => {
    for (const m of ['unknown', 'old'] as const) {
      const helper = fakeHelper()
      helper.setMode(m)
      await helper.listen()
      const { ch, root } = makeController(helper.sockPath)
      await ch.start({ computerHistoryEnabled: true })
      await waitFor(() => ch.view().state.status === 'helper_outdated')
      await ch.flush()
      expect(readState(root).status).toBe('helper_outdated')
      await waitFor(() => helper.open === 0) // 我们关掉了连接,不留半开的订阅
    }
  })

  it('accessibility_denied → no_permission;授权后重试自动转 recording', async () => {
    const helper = fakeHelper()
    helper.setMode('denied')
    await helper.listen()
    const { ch } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'no_permission')
    helper.setMode('ok')
    await waitFor(() => ch.view().state.status === 'recording', 4_000)
  })

  it('关着:绝不连 socket、不拉起 helper、不建目录', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root, launchHelper } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: false })
    await new Promise((r) => setTimeout(r, 300))
    expect(helper.accepted).toBe(0)
    expect(launchHelper).not.toHaveBeenCalled()
    expect(existsSync(root)).toBe(false)
    expect(ch.view().state.status).toBe('off')
  })

  it('非 darwin / win32(linux):恒 unsupported,开关拨不动,不碰 socket', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const windowsRecorder = vi.fn(async () => ({ exe: 'x', pipe: helper.sockPath, protocol: 13 }))
    const { ch, launchHelper } = makeController(helper.sockPath, { platform: 'linux', windowsRecorder })
    await ch.start({ computerHistoryEnabled: true })
    const v = await ch.setEnabled(true)
    expect(v.state).toMatchObject({ status: 'unsupported', enabled: false })
    await new Promise((r) => setTimeout(r, 200))
    expect(helper.accepted).toBe(0)
    expect(windowsRecorder).not.toHaveBeenCalled()
    expect(launchHelper).not.toHaveBeenCalled()
  })

  // win32:端点由 windowsRecorder 每次连接现给(真机是命名管道;控制器不关心,这里用同一个 unix socket 假 helper)
  const winExe = (root: string): string => {
    const exe = path.join(path.dirname(root), 'bin', 'windows-bridge-0123456789ab.exe')
    mkdirSync(path.dirname(exe), { recursive: true })
    writeFileSync(exe, '')
    return exe
  }

  it('win32:开着 → 按 windowsRecorder 给的管道订阅并落盘;管道没人听就拉起私有副本(target 带 exe + 管道)再订阅;不碰 darwin 的 socket / helper.app', async () => {
    const helper = fakeHelper() // 先不听:第一次连接 ENOENT → 走拉起
    const root = tmpRoot()
    const exe = winExe(root)
    const windowsRecorder = vi.fn(async () => ({ exe, pipe: helper.sockPath, protocol: 13 }))
    const launchHelper = vi.fn(async () => { await helper.listen() })
    const helperAppPath = vi.fn(() => '/nonexistent/tangu-computer-use.app')
    const { ch } = makeController('/nonexistent/darwin.sock', {
      root, platform: 'win32', windowsRecorder, launchHelper, helperAppPath, selfBundleId: 'electron.exe', externalSocket: true,
    })
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    expect(launchHelper).toHaveBeenCalledTimes(1)
    expect(launchHelper).toHaveBeenCalledWith({ socketPath: helper.sockPath, exe })
    expect(helperAppPath).not.toHaveBeenCalled()
    expect(windowsRecorder).toHaveBeenCalled()
    expect(helper.requests[0]).toMatchObject({ cmd: 'recordSubscribe' })
    expect(helper.requests[0].policy.titleOnlyBundleIds).toEqual(expect.arrayContaining(['electron.exe', 'forsion.exe', 'windowsterminal.exe', 'powershell.exe']))
    const t = Date.now()
    const chrome = { name: 'Google Chrome', bundleId: 'chrome.exe' }
    helper.push({ t, kind: 'app', app: chrome, title: 'Docs', url: 'https://example.com/a' })
    helper.push({ t: t + 1, kind: 'text', app: { name: 'Windows PowerShell', bundleId: 'powershell.exe' }, text: 'secret' }) // 终端只记标题
    helper.push({ t: t + 2, kind: 'text', app: chrome, text: 'hello' })
    await waitFor(() => existsSync(path.join(root, 'events', `${localDay(t)}.jsonl`)) && lines(path.join(root, 'events', `${localDay(t)}.jsonl`)).length >= 2, 3_000)
    await ch.flush()
    expect(lines(path.join(root, 'events', `${localDay(t)}.jsonl`))).toEqual([
      { t, kind: 'app', app: chrome, title: 'Docs', url: 'https://example.com/a' },
      { t: t + 2, kind: 'text', app: chrome, text: 'hello' },
    ])
    expect(readState(root)).toMatchObject({ enabled: true, status: 'recording', platform: 'win32' })
    expect(ch.requiredHelperProtocol()).toBeUndefined() // 权限页那条「更新并重启助手」只管 mac
    expect(await ch.recentApps()).toEqual([chrome])
  })

  it('win32:axTrusted 不作数(Windows 没有这项授权),照样 recording;同一回包在 darwin 上是 no_permission(负对照)', async () => {
    const helper = fakeHelper()
    helper.setMode('untrusted')
    await helper.listen()
    const root = tmpRoot()
    const exe = winExe(root)
    const win = makeController(helper.sockPath, { root, platform: 'win32', windowsRecorder: async () => ({ exe, pipe: helper.sockPath, protocol: 13 }) })
    await win.ch.start({ computerHistoryEnabled: true })
    await waitFor(() => win.ch.view().state.status === 'recording')
    const mac = makeController(helper.sockPath)
    await mac.ch.start({ computerHistoryEnabled: true })
    await waitFor(() => mac.ch.view().state.status === 'no_permission')
  })

  it('win32:没有 helper 源(windowsRecorder 回 null / 缺省)→ helper_missing,不拉起、不连', async () => {
    for (const windowsRecorder of [async () => null, undefined]) {
      const helper = fakeHelper()
      await helper.listen()
      const { ch, root, launchHelper } = makeController(helper.sockPath, { platform: 'win32', windowsRecorder })
      await ch.start({ computerHistoryEnabled: true })
      await waitFor(() => ch.view().state.status === 'helper_missing')
      await ch.flush()
      expect(readState(root)).toMatchObject({ enabled: true, status: 'helper_missing', platform: 'win32' })
      expect(launchHelper).not.toHaveBeenCalled()
      expect(helper.accepted).toBe(0)
      ch.dispose()
    }
  })

  it('win32:私有副本协议 < 13 或探不出版本(老 helper)→ helper_outdated,不拉起、不连;拉起前就判掉', async () => {
    for (const protocol of [12, null]) {
      const helper = fakeHelper()
      await helper.listen()
      const root = tmpRoot()
      const exe = winExe(root)
      const { ch, launchHelper } = makeController(helper.sockPath, { root, platform: 'win32', windowsRecorder: async () => ({ exe, pipe: helper.sockPath, protocol }) })
      await ch.start({ computerHistoryEnabled: true })
      await waitFor(() => ch.view().state.status === 'helper_outdated')
      expect(launchHelper).not.toHaveBeenCalled()
      expect(helper.accepted).toBe(0)
      ch.dispose()
    }
  })

  it('win32:现取录制服务一时失败(拷贝 / 探测起不来)→ disconnected + 退避重试,恢复后 recording', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const root = tmpRoot()
    const exe = winExe(root)
    let fail = true
    const windowsRecorder = vi.fn(async () => {
      if (fail) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return { exe, pipe: helper.sockPath, protocol: 13 }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const { ch } = makeController(helper.sockPath, { root, platform: 'win32', windowsRecorder })
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'disconnected' && windowsRecorder.mock.calls.length >= 1)
    fail = false
    await waitFor(() => ch.view().state.status === 'recording', 4_000)
  })

  it('socket 不在:装了 helper 就拉起再订阅;没装 → helper_missing 且不拉起', async () => {
    const helper = fakeHelper()
    const missing = makeController(helper.sockPath)
    await missing.ch.start({ computerHistoryEnabled: true })
    await waitFor(() => missing.ch.view().state.status === 'helper_missing')
    expect(missing.launchHelper).not.toHaveBeenCalled()
    missing.ch.dispose()

    const launchHelper = vi.fn(async () => { await helper.listen() })
    const { ch, installHelper } = makeController(helper.sockPath, { launchHelper })
    installHelper()
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    expect(launchHelper).toHaveBeenCalledTimes(1)
  })

  it('权限页关停 / 重装 helper 期间绝不拉起(拉起的会是旧包),也不占节流窗口;忙完立刻重连并拉起一次', async () => {
    const helper = fakeHelper() // socket 不在:连接失败 → 走拉起
    let busy = true
    let idle: (() => void) | undefined
    const onHelperIdle = vi.fn((cb: () => void) => { idle = cb; return () => { idle = undefined } })
    const launchHelper = vi.fn(async () => { await helper.listen() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const { ch, installHelper } = makeController(helper.sockPath, { launchHelper, helperBusy: () => busy, onHelperIdle })
    installHelper()
    await ch.start({ computerHistoryEnabled: true })
    expect(onHelperIdle).toHaveBeenCalledTimes(1)
    const busyAttempts = (): number => warn.mock.calls.filter((c) => c[1] === 'helper_busy').length
    await waitFor(() => busyAttempts() >= 2, 3_000) // 首次 + 1s 退避后那次:重试计时器照常跑,只是不拉起
    expect(launchHelper).not.toHaveBeenCalled()
    expect(ch.view().state.status).toBe('disconnected')
    // 忙完的回调要让它立刻连上,而不是等退避
    busy = false
    idle!()
    await waitFor(() => ch.view().state.status === 'recording', 1_500) // 下一次退避重试在 idle 后 ~2s:此界内连上 = 是回调连的
    expect(launchHelper).toHaveBeenCalledTimes(1)
    expect(helper.requests.filter((r) => r.cmd === 'recordSubscribe')).toHaveLength(1)
    await ch.dispose()
    expect(idle).toBeUndefined() // dispose 取消订阅
  })

  it('requiredHelperProtocol:只在 darwin 且开着时要求 13(没开电脑历史的 CU 用户不会被提示重启)', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const off = makeController(helper.sockPath)
    await off.ch.start({ computerHistoryEnabled: false })
    expect(off.ch.requiredHelperProtocol()).toBeUndefined()
    const on = makeController(helper.sockPath)
    await on.ch.start({ computerHistoryEnabled: true })
    expect(on.ch.requiredHelperProtocol()).toBe(13)
    await on.ch.setEnabled(false)
    expect(on.ch.requiredHelperProtocol()).toBeUndefined()
    const win = makeController(helper.sockPath, { platform: 'win32' })
    await win.ch.start({ computerHistoryEnabled: true })
    expect(win.ch.requiredHelperProtocol()).toBeUndefined()
  })

  it('暂停:断订阅 + state.json 带 pausedUntil + 写回配置;恢复重连', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root, persist, onChanged } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    const before = Date.now()
    const v = await ch.pause(3_600_000)
    expect(v.state.status).toBe('paused')
    expect(v.state.pausedUntil).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(persist).toHaveBeenCalledWith({ computerHistoryPausedUntil: v.state.pausedUntil })
    await waitFor(() => helper.open === 0)
    await ch.flush()
    expect(readState(root)).toMatchObject({ enabled: true, status: 'paused', pausedUntil: v.state.pausedUntil })
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ state: expect.objectContaining({ status: 'paused' }) }))

    await ch.resume()
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryPausedUntil: null })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    expect(readState(root)).toMatchObject({ status: 'recording', pausedUntil: null })
  })

  it('暂停到点自动恢复(时钟推进 + recheck);「到明天」= 下一个本地 0 点', async () => {
    let clock = at(2026, 9, 27, 15)
    const { ch, persist } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`), { now: () => clock })
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: clock + 30 * 60_000 })
    expect(ch.view().state.status).toBe('paused')
    clock += 31 * 60_000
    ch.recheck()
    expect(ch.view().state.pausedUntil).toBeNull()
    expect(ch.view().state.status).not.toBe('paused')
    await waitFor(() => persist.mock.calls.some((c) => JSON.stringify(c) === JSON.stringify([{ computerHistoryPausedUntil: null }]))) // 落配置排在意愿队列里
    const v = await ch.pause('tomorrow')
    expect(v.state.pausedUntil).toBe(nextLocalMidnight(clock))
    expect(v.state.pausedUntil).toBe(at(2026, 9, 28, 0))
  })

  it('clear(since):删盘上与缓冲里的新事件,并重开订阅(helper 丢差分基线)', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    const t = Date.now()
    const app = { name: 'Notes', bundleId: 'com.apple.Notes' }
    helper.push({ t: t - 60_000, kind: 'app', app, title: 'old' })
    helper.push({ t, kind: 'text', app, text: 'secret' })
    await waitFor(async () => (await ch.recent(1)).length > 0)
    await ch.clear({ sinceMs: t - 1_000 })
    await waitFor(() => helper.requests.length === 2)
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    const file = path.join(root, 'events', `${localDay(t)}.jsonl`)
    // 跨天边界跑这条时旧事件可能落在前一天的文件里;只断言「secret 不在任何文件里」+「old 还在」
    const all = readdirSync(path.join(root, 'events')).flatMap((f) => lines(path.join(root, 'events', f)))
    expect(all.map((e) => e.title ?? e.text)).toEqual(['old'])
    expect(existsSync(file) || localDay(t - 60_000) !== localDay(t)).toBe(true)

    await ch.clear({ all: true })
    expect(readdirSync(path.join(root, 'events'))).toEqual([])
  })

  it('改排除表:写回配置 + 用新策略重订阅', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, persist } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    const v = await ch.setExclude({ apps: ['com.bank'], domains: ['https://bank.cn/x'] })
    expect(v.exclude).toEqual({ apps: ['com.bank'], domains: ['bank.cn'] })
    expect(persist).toHaveBeenCalledWith({ computerHistoryExclude: { apps: ['com.bank'], domains: ['bank.cn'] } })
    await waitFor(() => helper.requests.length === 2 && ch.view().state.status === 'recording')
    expect(helper.requests[1].policy).toMatchObject({ excludeBundleIds: ['com.bank'], excludeDomains: ['bank.cn'] })
  })

  it('清空数据(dispose discard):缓冲丢弃、计时器停,删掉目录后不会被 1s 批量落盘建回来', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const tmExclude = vi.fn(async () => {})
    const { ch, root } = makeController(helper.sockPath, { tmExclude })
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    expect(tmExclude).toHaveBeenCalledTimes(1)
    helper.push({ t: Date.now(), kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'secret' })
    await waitFor(async () => (await ch.recent(1)).length > 0) // 事件进了缓冲、1s 计时器已挂上
    // 队列里有一笔在途的写:dispose 返回的 promise 要等它落定(main 等完才删目录)
    let release: (() => void) | undefined
    vi.spyOn(ch.store, 'ensureRoot').mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    void ch.reveal()
    await waitFor(() => release !== undefined) // 那笔写已开跑(还没开跑的,dispose 之后轮到就直接跳过)
    let drained = false
    const done = ch.dispose({ discard: true }).then(() => { drained = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(drained).toBe(false)
    release!()
    await done
    // discard:缓冲不落盘、state 不改写(目录马上整删)
    expect(readdirSync(path.join(root, 'events'))).toEqual([])
    expect(readState(root).status).toBe('recording')
    rmSync(root, { recursive: true, force: true })
    helper.push({ t: Date.now(), kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'late' })
    await new Promise((r) => setTimeout(r, 1_500))
    expect(existsSync(root)).toBe(false)
    expect(tmExclude).toHaveBeenCalledTimes(1)
    await waitFor(() => helper.open === 0)
  })

  it('退出(dispose 缺省):排队中的写不挡同步兜底,也盖不回「记录中」', async () => {
    const helper = fakeHelper()
    helper.setMode('denied')
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'no_permission')
    await ch.flush()
    // 用一笔卡住的写把队列堵住:之后的 state 写(recording)只能排队
    let release!: () => void
    vi.spyOn(ch.store, 'ensureRoot').mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    void ch.reveal()
    helper.setMode('ok')
    await waitFor(() => ch.view().state.status === 'recording', 4_000) // 退避重试连上 → writeState(recording) 排在卡住那笔后面
    const t = Date.now()
    const safari = { name: 'Safari', bundleId: 'com.apple.Safari' }
    helper.push({ t, kind: 'app', app: safari, title: 'Docs' })
    helper.push({ t: t + 1, kind: 'text', app: safari, text: 'hi' }) // 无字的 0 秒段会被折叠丢掉,带一条输入好让 recent() 看得见
    await waitFor(async () => (await ch.recent(1)).length > 0)
    const drained = ch.dispose()
    release()
    await drained
    await ch.flush()
    expect(readState(root).status).toBe('disconnected')
    const all = readdirSync(path.join(root, 'events')).flatMap((f) => lines(path.join(root, 'events', f)))
    expect(all.map((e) => e.title ?? e.text)).toEqual(['Docs', 'hi'])
  })

  it('清除时重写失败:错误照抛给设置页,但订阅照样重开(不会断着还显示「记录中」)', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    const now = Date.now()
    const file = path.join(root, 'events', `${localDay(now)}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ t: now - 5, kind: 'app', app: { name: 'X', bundleId: 'x' } })}\n`, { mode: 0o600 })
    chmodSync(file, 0o000)
    cleanups.push(() => chmodSync(file, 0o600))
    await expect(ch.clear({ sinceMs: now })).rejects.toThrow(/EACCES/)
    await waitFor(() => helper.requests.length === 2 && ch.view().state.status === 'recording')
    await waitFor(() => helper.open === 1)
  })

  it('写盘失败:整批退回缓冲重试;连续失败状态降级,恢复后补写且不重复', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    const events = path.join(root, 'events')
    chmodSync(events, 0o500) // 建不了日文件
    cleanups.push(() => chmodSync(events, 0o700))
    const t = Date.now()
    const safari = { name: 'Safari', bundleId: 'com.apple.Safari' }
    helper.push({ t, kind: 'app', app: safari, title: 'Docs' })
    helper.push({ t: t + 1, kind: 'text', app: safari, text: 'hi' })
    await waitFor(async () => (await ch.recent(1)).length > 0)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await ch.flush()
    expect(ch.view().state.status).toBe('recording') // 一次失败先不报
    await ch.flush()
    expect(ch.view().state.status).toBe('disconnected')
    await ch.flush()
    expect(readState(root).status).toBe('disconnected')
    expect((await ch.recent(1)).map((s) => s.title)).toEqual(['Docs']) // 还在缓冲里
    warn.mockRestore()
    chmodSync(events, 0o700)
    await ch.flush()
    await ch.flush()
    expect(ch.view().state.status).toBe('recording')
    expect(readState(root).status).toBe('recording')
    expect(lines(path.join(events, `${localDay(t)}.jsonl`)).map((e) => e.title ?? e.text)).toEqual(['Docs', 'hi'])
  })

  it('开 / 关落配置失败:开 = 什么都没变;关 = 立刻停录(断订阅、state 写 off),错误照抛', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const persist = vi.fn(async () => { throw new Error('EROFS') })
    const off = makeController(helper.sockPath, { persist })
    await off.ch.start({ computerHistoryEnabled: false })
    await expect(off.ch.setEnabled(true)).rejects.toThrow('EROFS')
    expect(off.ch.view().state).toMatchObject({ enabled: false, status: 'off' })
    await expect(off.ch.resume()).rejects.toThrow('EROFS')
    await new Promise((r) => setTimeout(r, 200))
    expect(helper.accepted).toBe(0)

    const on = makeController(helper.sockPath, { persist })
    await on.ch.start({ computerHistoryEnabled: true })
    await waitFor(() => on.ch.view().state.status === 'recording')
    await expect(on.ch.setEnabled(false)).rejects.toThrow('EROFS')
    expect(on.ch.view().state).toMatchObject({ enabled: false, status: 'off' })
    await waitFor(() => helper.open === 0)
    await on.ch.flush()
    expect(readState(on.root)).toMatchObject({ enabled: false, status: 'off' })
  })

  it('最近 App:事件流喂内存表;清除后不再列出被清掉的', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    const t = Date.now()
    helper.push({ t: t - 2_000, kind: 'app', app: { name: 'Safari', bundleId: 'com.apple.Safari' }, title: 'a' })
    helper.push({ t: t - 1_000, kind: 'app', app: { name: 'Code', bundleId: 'com.microsoft.VSCode' }, title: 'b' })
    helper.push({ t, kind: 'app', app: { name: '1Password', bundleId: 'com.1password.1password', excluded: true } })
    await waitFor(async () => (await ch.recentApps()).length === 2)
    expect((await ch.recentApps()).map((a) => a.bundleId)).toEqual(['com.microsoft.VSCode', 'com.apple.Safari'])
    await ch.clear({ sinceMs: t - 1_500 })
    expect((await ch.recentApps()).map((a) => a.bundleId)).toEqual(['com.apple.Safari'])
  })

  it('排除落盘(creview #5):排除 App 只留一条不带标题的切换;排除站点只留切进去那条标记,站内变化与输入都不落', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true, computerHistoryExclude: { apps: ['com.bank'], domains: ['bank.cn'] } })
    await waitFor(() => ch.view().state.status === 'recording')
    const t = Date.now()
    const bank = { name: 'Bank', bundleId: 'com.bank' }
    const chrome = { name: 'Chrome', bundleId: 'com.google.Chrome' }
    for (const ev of [
      { t, kind: 'app', app: bank, title: 'Accounts' },
      { t: t + 1, kind: 'window', app: bank, title: 'Transfer' },
      { t: t + 2, kind: 'text', app: bank, text: '1000' },
      { t: t + 3, kind: 'app', app: chrome, title: 'Docs', url: 'https://docs.example.com/' },
      { t: t + 4, kind: 'window', app: chrome, title: 'Login', url: 'https://www.bank.cn/login' },
      { t: t + 5, kind: 'window', app: chrome, title: 'Balance', url: 'https://www.bank.cn/balance' },
      { t: t + 6, kind: 'text', app: chrome, text: 'pw' },
      { t: t + 7, kind: 'window', app: chrome, title: 'News', url: 'https://news.example.com/' },
    ]) helper.push(ev)
    const all = (): ComputerHistoryEvent[] => readdirSync(path.join(root, 'events')).flatMap((f) => lines(path.join(root, 'events', f)))
    await waitFor(async () => { await ch.flush(); return all().some((e) => e.title === 'News') })
    expect(all()).toEqual([
      { t, kind: 'app', app: { ...bank, excluded: true } },
      { t: t + 3, kind: 'app', app: chrome, title: 'Docs', url: 'https://docs.example.com/' },
      { t: t + 4, kind: 'window', app: { ...chrome, excluded: true } },
      { t: t + 7, kind: 'window', app: chrome, title: 'News', url: 'https://news.example.com/' },
    ])
  })

  it('断点标落盘(creview3 #4):「排除站点 → 无痕 → 同一排除站点」的第二条标记带 resumed 落盘;普通事件上的 resumed 原样落盘', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true, computerHistoryExclude: { apps: [], domains: ['bank.cn'] } })
    await waitFor(() => ch.view().state.status === 'recording')
    const t = Date.now()
    const chrome = { name: 'Chrome', bundleId: 'com.google.Chrome' }
    for (const ev of [
      { t, kind: 'app', app: chrome, title: 'Docs', url: 'https://docs.example.com/a' },
      { t: t + 1, kind: 'window', app: chrome, title: 'Login', url: 'https://www.bank.cn/login' },
      { t: t + 2, kind: 'window', app: chrome, title: 'Login', url: 'https://www.bank.cn/login', resumed: true }, // 中间进过无痕窗口
      { t: t + 3, kind: 'window', app: chrome, title: 'Docs', url: 'https://docs.example.com/b', resumed: true },
    ]) helper.push(ev)
    const all = (): ComputerHistoryEvent[] => readdirSync(path.join(root, 'events')).flatMap((f) => lines(path.join(root, 'events', f)))
    await waitFor(async () => { await ch.flush(); return all().length >= 4 })
    expect(all()).toEqual([
      { t, kind: 'app', app: chrome, title: 'Docs', url: 'https://docs.example.com/a' },
      { t: t + 1, kind: 'window', app: { ...chrome, excluded: true } },
      { t: t + 2, kind: 'window', app: { ...chrome, excluded: true }, resumed: true },
      { t: t + 3, kind: 'window', app: chrome, title: 'Docs', url: 'https://docs.example.com/b', resumed: true },
    ])
  })

  it('意愿按发出顺序生效(creview #1):落配置途中的旧「开 / 恢复」盖不掉之后的「关 / 暂停」', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const holdNextPersist = (persist: ReturnType<typeof makeController>['persist']): (() => void) => {
      let release: (() => void) | undefined
      persist.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
      return () => release!()
    }
    // 开 → 关:在途的「开」回来时作废,盘上最后留下的是「关」
    {
      const { ch, persist } = makeController(helper.sockPath)
      await ch.start({ computerHistoryEnabled: false })
      const release = holdNextPersist(persist)
      const enabling = ch.setEnabled(true)
      await waitFor(() => persist.mock.calls.length === 1)
      const disabling = ch.setEnabled(false)
      release()
      await Promise.all([enabling, disabling])
      expect(ch.view().state).toMatchObject({ enabled: false, status: 'off' })
      expect(persist.mock.calls.map((c) => c[0].computerHistoryEnabled)).toEqual([true, false])
    }
    // 恢复 → 暂停(设置页恢复途中,托盘点了暂停):恢复作废
    {
      const { ch, persist } = makeController(helper.sockPath)
      await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
      const release = holdNextPersist(persist)
      const resuming = ch.resume()
      await waitFor(() => persist.mock.calls.length === 1)
      const pausing = ch.pause(30 * 60_000)
      release()
      await Promise.all([resuming, pausing])
      expect(ch.view().state.status).toBe('paused')
      expect(persist.mock.calls.map((c) => c[0].computerHistoryPausedUntil)).toEqual([null, ch.view().state.pausedUntil])
    }
    // 开 → 暂停:只作废「开」里清暂停的那半,开本身照生效(内存与盘一致:开着 + 暂停中)
    {
      const { ch, persist } = makeController(helper.sockPath)
      await ch.start({ computerHistoryEnabled: false })
      const release = holdNextPersist(persist)
      const enabling = ch.setEnabled(true)
      await waitFor(() => persist.mock.calls.length === 1)
      const pausing = ch.pause(30 * 60_000)
      release()
      await Promise.all([enabling, pausing])
      expect(ch.view().state).toMatchObject({ enabled: true, status: 'paused' })
    }
    // 开 → config:set 直接关(渲染层另一条写配置的路):同样作废在途的「开」;关闭让数据代次 +1
    {
      const { ch, persist } = makeController(helper.sockPath)
      await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
      const gen = ch.view().state.dataGen
      const release = holdNextPersist(persist)
      const enabling = ch.setEnabled(true) // 暂停中再拨「开」= 清暂停
      await waitFor(() => persist.mock.calls.length === 1)
      ch.applyConfig({ computerHistoryEnabled: false })
      release()
      await enabling
      expect(ch.view().state).toMatchObject({ enabled: false, status: 'off' })
      expect(ch.view().state.dataGen).toBe(gen + 1)
    }
    await new Promise((r) => setTimeout(r, 200))
    expect(helper.accepted).toBe(0) // 四种交错都没开录过
  })

  it('改排除表(creview #2):新增的排除当场生效,落配置卡着也不再按旧策略记;移除的等落配置成功才放开', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root, persist } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    let release: (() => void) | undefined
    persist.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const adding = ch.setExclude({ apps: ['com.bank'], domains: [] })
    // 落配置还没回来:已按收紧后的策略重订,内存过滤已收紧
    await waitFor(() => helper.requests.length === 2 && ch.view().state.status === 'recording' && release !== undefined)
    expect(helper.requests[1].policy.excludeBundleIds).toEqual(['com.bank'])
    expect(ch.view().exclude.apps).toEqual(['com.bank'])
    const t = Date.now()
    const bank = { name: 'Bank', bundleId: 'com.bank' }
    helper.push({ t, kind: 'app', app: bank, title: 'Accounts' })
    helper.push({ t: t + 1, kind: 'text', app: bank, text: 'secret' })
    await new Promise((r) => setTimeout(r, 150))
    await ch.flush()
    const all = (): ComputerHistoryEvent[] => readdirSync(path.join(root, 'events')).flatMap((f) => lines(path.join(root, 'events', f)))
    expect(all()).toEqual([{ t, kind: 'app', app: { ...bank, excluded: true } }])
    release!()
    await adding
    expect(helper.requests).toHaveLength(2) // 落配置回来与收紧后的一致,不再重订

    // 移除 = 放宽:落配置卡着时照旧排除
    release = undefined
    persist.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    const removing = ch.setExclude({ apps: [], domains: [] })
    await waitFor(() => release !== undefined)
    await new Promise((r) => setTimeout(r, 100))
    expect(helper.requests).toHaveLength(2)
    expect(ch.view().exclude.apps).toEqual(['com.bank'])
    release!()
    await removing
    await waitFor(() => helper.requests.length === 3)
    expect(helper.requests[2].policy.excludeBundleIds).toEqual([])
    expect(tightenExclude({ apps: ['com.X.App'], domains: ['a.com'] }, { apps: ['com.x.app'], domains: ['a.com'] })).toBeNull() // 只是大小写不同不算新增
  })

  it('清空数据(creview #3):dispose discard 后,在途那笔写的后续步骤不再建日文件', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    helper.push({ t: Date.now(), kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'secret' })
    await waitFor(async () => (await ch.recent(1)).length > 0)
    let release: (() => void) | undefined
    vi.spyOn(ch.store, 'ensureRoot').mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
    void ch.flush() // 追加卡在 ensureRoot
    await waitFor(() => release !== undefined)
    const drained = ch.dispose({ discard: true })
    release!()
    await drained
    expect(readdirSync(path.join(root, 'events'))).toEqual([])
  })

  it('清空数据(creview #3):在途写超过封顶仍未落定 → 删完目录后等它落定再删一次,慢写建回的目录不留', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, root } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    helper.push({ t: Date.now(), kind: 'text', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, text: 'secret' })
    await waitFor(async () => (await ch.recent(1)).length > 0)
    // 已经派发出去、取消不了的慢写:300ms 后才落定,落定时把 events/ 与日文件建回来
    let started = false
    vi.spyOn(ch.store, 'append').mockImplementationOnce(async () => {
      started = true
      await new Promise((r) => setTimeout(r, 300))
      mkdirSync(path.join(root, 'events'), { recursive: true })
      writeFileSync(path.join(root, 'events', `${localDay(Date.now())}.jsonl`), '{"t":1,"kind":"text","text":"secret"}\n')
    })
    void ch.flush()
    await waitFor(() => started)
    const wipe = await stopComputerHistoryForWipe(ch, 200)
    expect(wipe.drained).toBe(false) // 封顶到了还没落定
    rmSync(root, { recursive: true, force: true }) // 调用方整删
    await wipe.afterWipe()
    expect(existsSync(root)).toBe(false)
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(root)).toBe(false)
  })

  it('「关」落配置失败(creview #4):本次保持已停并在后台按退避补落,设置页看得到错误;补成即停;之后「开」落成则欠账作废', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    cleanups.push(() => vi.useRealTimers())
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
    const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await settle() }
    // 开着但暂停中:不碰 socket,计时器全是假的
    const { ch, persist, onChanged } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`))
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
    persist.mockRejectedValueOnce(new Error('EROFS')).mockRejectedValueOnce(new Error('EROFS again'))
    await expect(ch.setEnabled(false)).rejects.toThrow('EROFS')
    expect(ch.view().state).toMatchObject({ enabled: false, status: 'off' })
    expect(ch.view().persistError).toBe('EROFS')
    expect(onChanged.mock.lastCall?.[0]).toMatchObject({ persistError: 'EROFS' })
    expect(persist).toHaveBeenCalledTimes(1)
    await advance(4_999)
    expect(persist).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(persist).toHaveBeenCalledTimes(2) // 第一次补:又失败 → 错误原文更新、退避翻倍
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryEnabled: false, computerHistoryPausedUntil: null })
    expect(ch.view().persistError).toBe('EROFS again')
    await advance(9_999)
    expect(persist).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(persist).toHaveBeenCalledTimes(3) // 补成
    expect(ch.view().persistError).toBeUndefined()
    expect(onChanged.mock.lastCall?.[0]).not.toHaveProperty('persistError')
    await advance(120_000)
    expect(persist).toHaveBeenCalledTimes(3) // 补成就停

    // 再关一次失败 → 欠账;随后「开」落成 → 欠账作废,补落不会把刚开的盖成关
    persist.mockRejectedValueOnce(new Error('EROFS'))
    await expect(ch.setEnabled(false)).rejects.toThrow('EROFS')
    expect(ch.view().persistError).toBe('EROFS')
    await ch.setEnabled(true)
    expect(ch.view().persistError).toBeUndefined()
    await advance(120_000)
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryEnabled: true, computerHistoryPausedUntil: null })
    expect(ch.view().state.enabled).toBe(true)
  })

  it('state.json dataGen:接着盘上的往下数(老文件没有 = 0);清除前后各 +1 且夹住删除,改排除表 / 关闭各 +1', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const seed = (dataGen?: number): string => {
      const root = tmpRoot()
      mkdirSync(root, { recursive: true })
      writeFileSync(path.join(root, 'state.json'), JSON.stringify({ v: 1, enabled: true, pausedUntil: null, status: 'recording', since: 0, updatedAt: 0, platform: 'darwin', ...(dataGen === undefined ? {} : { dataGen }) }))
      return root
    }
    expect(makeController(helper.sockPath, { root: seed() }).ch.view().state.dataGen).toBe(0)
    const { ch, root } = makeController(helper.sockPath, { root: seed(7) })
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    await ch.flush()
    expect(readState(root).dataGen).toBe(7)
    // 清除:删除执行那一刻盘上已是 +1,删完再 +1
    const seen: number[] = []
    const realClear = ch.store.clear.bind(ch.store)
    vi.spyOn(ch.store, 'clear').mockImplementationOnce(async (o) => { seen.push(readState(root).dataGen); await realClear(o) })
    await ch.clear({ all: true })
    await ch.flush()
    expect(seen).toEqual([8])
    expect(readState(root).dataGen).toBe(9)
    await ch.setExclude({ apps: ['com.bank'], domains: [] })
    await ch.flush()
    expect(readState(root).dataGen).toBe(10)
    await ch.setExclude({ apps: ['com.bank'], domains: [] }) // 没变不加
    await ch.setEnabled(false)
    await ch.flush()
    expect(readState(root)).toMatchObject({ enabled: false, status: 'off', dataGen: 11 })
  })

  it('View.rev:每份快照单调递增;写操作的回包比途中推送的都新', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const { ch, onChanged } = makeController(helper.sockPath)
    await ch.start({ computerHistoryEnabled: true })
    await waitFor(() => ch.view().state.status === 'recording')
    const a = ch.view().rev
    expect(ch.get().rev).toBeGreaterThan(a)
    const before = onChanged.mock.calls.length
    const v = await ch.pause(3_600_000)
    const pushed = onChanged.mock.calls.slice(before).map((c) => c[0].rev as number)
    expect(pushed.length).toBeGreaterThan(0)
    expect(Math.max(...pushed)).toBeLessThan(v.rev)
    const revs = onChanged.mock.calls.map((c) => c[0].rev as number)
    expect(revs).toEqual([...revs].sort((x, y) => x - y))
  })

  it('助手更新中(creview ui #2):清除 / 改排除表的重订阅同样走 helperBusy 闸,不拉起 helper;忙完只拉起一次', async () => {
    const helper = fakeHelper() // socket 不在:连接失败 → 走拉起
    let busy = true
    let idle: (() => void) | undefined
    const onHelperIdle = vi.fn((cb: () => void) => { idle = cb; return () => { idle = undefined } })
    const launchHelper = vi.fn(async () => { await helper.listen() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const { ch, installHelper } = makeController(helper.sockPath, { launchHelper, helperBusy: () => busy, onHelperIdle })
    installHelper()
    await ch.start({ computerHistoryEnabled: true })
    const busyAttempts = (): number => warn.mock.calls.filter((c) => c[1] === 'helper_busy').length
    await waitFor(() => busyAttempts() >= 1)
    const n = busyAttempts()
    await ch.clear({ all: true })
    await ch.setExclude({ apps: ['com.bank'], domains: [] })
    await ch.clear({ sinceMs: Date.now() - 60_000 })
    await waitFor(() => busyAttempts() > n) // 清除后的重订阅确实去连了,且撞在闸上
    expect(launchHelper).not.toHaveBeenCalled()
    busy = false
    idle!()
    await waitFor(() => ch.view().state.status === 'recording', 3_000)
    expect(launchHelper).toHaveBeenCalledTimes(1)
  })

  it('暂停 / 收紧排除表落配置失败(creview C):同「关」一样后台按退避补落最新意愿、设置页看得到;之后的意愿取代;放宽失败不欠', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    cleanups.push(() => vi.useRealTimers())
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
    const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await settle() }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    // 开着但暂停中:不碰 socket
    const { ch, persist, onChanged } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`))
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })

    // 暂停落失败(托盘那条路还把错误吞了):本次保持暂停,后台补落这次的暂停值,补成提示消失、不再重试
    persist.mockRejectedValueOnce(new Error('EROFS'))
    await expect(ch.pause(30 * 60_000)).rejects.toThrow('EROFS')
    const until = ch.view().state.pausedUntil
    expect(ch.view().state.status).toBe('paused')
    expect(ch.view().persistError).toBe('EROFS')
    expect(onChanged.mock.lastCall?.[0]).toMatchObject({ persistError: 'EROFS' })
    await advance(4_999)
    expect(persist).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryPausedUntil: until })
    expect(ch.view().persistError).toBeUndefined()
    expect(onChanged.mock.lastCall?.[0]).not.toHaveProperty('persistError')
    await advance(120_000)
    expect(persist).toHaveBeenCalledTimes(2)

    // 收紧排除表落失败:收紧的部分本次保留,后台补落内存里的排除表
    persist.mockRejectedValueOnce(new Error('EROFS'))
    await expect(ch.setExclude({ apps: ['com.bank'], domains: [] })).rejects.toThrow('EROFS')
    expect(ch.view().exclude.apps).toEqual(['com.bank'])
    expect(ch.view().persistError).toBe('EROFS')
    await advance(5_000)
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryExclude: { apps: ['com.bank'], domains: [] } })
    expect(ch.view().persistError).toBeUndefined()

    // 放宽落失败 = 什么都没变,不欠、不补
    persist.mockRejectedValueOnce(new Error('EROFS'))
    await expect(ch.setExclude({ apps: [], domains: [] })).rejects.toThrow('EROFS')
    expect(ch.view().exclude.apps).toEqual(['com.bank'])
    expect(ch.view().persistError).toBeUndefined()
    const afterRelax = persist.mock.calls.length
    await advance(120_000)
    expect(persist).toHaveBeenCalledTimes(afterRelax)

    // 连着两次暂停都落失败:补落的是最后那次
    persist.mockRejectedValueOnce(new Error('EROFS')).mockRejectedValueOnce(new Error('EROFS'))
    await expect(ch.pause(30 * 60_000)).rejects.toThrow('EROFS')
    await expect(ch.pause('tomorrow')).rejects.toThrow('EROFS')
    const last = ch.view().state.pausedUntil
    expect(last).toBe(nextLocalMidnight(Date.now()))
    await advance(5_000)
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryPausedUntil: last })
    expect(ch.view().persistError).toBeUndefined()

    // 暂停落失败后又恢复成功:欠账还清,补落不会把已恢复的盖回暂停
    persist.mockRejectedValueOnce(new Error('EROFS'))
    await expect(ch.pause(30 * 60_000)).rejects.toThrow('EROFS')
    expect(ch.view().persistError).toBe('EROFS')
    await ch.resume()
    expect(ch.view().persistError).toBeUndefined()
    const afterResume = persist.mock.calls.length
    await advance(120_000)
    expect(persist).toHaveBeenCalledTimes(afterResume)
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryPausedUntil: null })
  })

  /** 仿 main:桌面配置文件 + configQueue(saveConfig:函数形态的补丁在队内、写盘前才求值);blockQueue 卡住队头(慢盘 / 锁)。 */
  function fakeConfigStore() {
    const disk: Record<string, unknown> = {}
    const configQueue = createSerialQueue()
    let writes = 0
    const failAt = new Map<number, string>()
    const saveConfig = (p: ComputerHistoryPersistPatch | (() => ComputerHistoryPersistPatch)): Promise<void> => configQueue(async () => {
      const patch = typeof p === 'function' ? p() : p
      const m = failAt.get(++writes)
      if (m) throw new Error(m)
      Object.assign(disk, JSON.parse(JSON.stringify(patch)))
    })
    const blockQueue = (): (() => void) => {
      let open!: () => void
      const gate = new Promise<void>((r) => { open = r })
      void configQueue(() => gate)
      return open
    }
    /** 从现在起第 n 笔执行的写失败(1 = 下一笔)。 */
    const failWrite = (n: number, m: string): void => { failAt.set(writes + n, m) }
    return { disk, saveConfig, blockQueue, failWrite, failNextWith: (m: string) => failWrite(1, m) }
  }

  it('config:set × 排除表补落(creview3 #1):新增排除 A 落失败 → config:set 落 A+B → 排着的补落不许把盘改回只有 A', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    cleanups.push(() => vi.useRealTimers())
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
    const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await settle() }
    const cfg = fakeConfigStore()
    // 开着但暂停中:不碰 socket
    const { ch } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`), { persist: cfg.saveConfig })
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
    const A = { apps: ['com.a'], domains: [] }
    const AB = { apps: ['com.a', 'com.b'], domains: [] }
    cfg.failNextWith('EROFS')
    await expect(ch.setExclude(A)).rejects.toThrow('EROFS')
    expect(ch.view().persistError).toBe('EROFS')
    // 配置写队列卡着;这时渲染层经 config:set 存 A+B(main 的 config:set 走 configSet),随后补落的计时器到点
    const open = cfg.blockQueue()
    const configSet = ch.configSet({ computerHistoryExclude: AB }, () => cfg.saveConfig({ computerHistoryExclude: AB }))
    await advance(5_000)
    open()
    await configSet
    await advance(0)
    expect(cfg.disk.computerHistoryExclude).toEqual(AB)
    expect(ch.view().exclude).toEqual(AB)
    expect(ch.view().persistError).toBeUndefined()
    await advance(120_000)
    expect(cfg.disk.computerHistoryExclude).toEqual(AB) // 之后也没有补落再去改它
  })

  it('config:set 发出即作废在途的「开」(creview3 #1):开的落盘排在前面、config:set 关排在后面,开回来也不许开录(哪怕一瞬)', async () => {
    const helper = fakeHelper()
    await helper.listen()
    const cfg = fakeConfigStore()
    const { ch } = makeController(helper.sockPath, { persist: cfg.saveConfig })
    await ch.start({ computerHistoryEnabled: false })
    const open = cfg.blockQueue()
    const enabling = ch.setEnabled(true)
    const disabling = ch.configSet({ computerHistoryEnabled: false }, () => cfg.saveConfig({ computerHistoryEnabled: false }))
    open()
    await Promise.all([enabling, disabling])
    await new Promise((r) => setTimeout(r, 200))
    expect(cfg.disk.computerHistoryEnabled).toBe(false)
    expect(ch.view().state).toMatchObject({ enabled: false, status: 'off' })
    expect(helper.accepted).toBe(0)
  })

  it('config:set 作废了已落盘的「开」、自己却没落成(creview3 #1 边角):盘上不许留着「开」—— 挂提示并补落成内存里的「关」', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    cleanups.push(() => vi.useRealTimers())
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
    const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await settle() }
    const cfg = fakeConfigStore()
    const { ch } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`), { persist: cfg.saveConfig })
    await ch.start({ computerHistoryEnabled: false })
    const open = cfg.blockQueue()
    const enabling = ch.setEnabled(true)
    const disabling = ch.configSet({ computerHistoryEnabled: false }, () => Promise.reject(new Error('EROFS')))
    open()
    await enabling
    await expect(disabling).rejects.toThrow('EROFS')
    expect(cfg.disk.computerHistoryEnabled).toBe(true) // 「开」那笔已落盘
    expect(ch.view().state.enabled).toBe(false) // 被 config:set 作废,没开录
    expect(ch.view().persistError).toBe('EROFS') // 盘上与内存不一致:提示重启可能恢复记录
    await advance(5_000)
    expect(cfg.disk.computerHistoryEnabled).toBe(false)
    expect(ch.view().persistError).toBeUndefined()
    // 连点两次「开」、第二次没落成:第一次已落盘却被第二次作废(内存没开)—— 同样挂提示、补成内存里的「关」
    const open2 = cfg.blockQueue()
    cfg.failWrite(2, 'EIO') // 第 1 笔 = 第一次「开」,第 2 笔 = 第二次「开」(卡队头的那笔不经 saveConfig,不计)
    const first = ch.setEnabled(true)
    const second = ch.setEnabled(true)
    open2()
    await first
    await expect(second).rejects.toThrow('EIO')
    expect(cfg.disk.computerHistoryEnabled).toBe(true)
    expect(ch.view().state.enabled).toBe(false)
    expect(ch.view().persistError).toBe('EIO')
    await advance(5_000)
    expect(cfg.disk.computerHistoryEnabled).toBe(false)
    expect(ch.view().persistError).toBeUndefined()
  })

  it('main 的 config:set 走 configSet(creview3 #1):不许退回「先落盘、后 applyConfig」', () => {
    const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    const handler = source.slice(source.indexOf("ipcMain.handle('config:set'"), source.indexOf("ipcMain.handle('config:set'") + 2_000)
    expect(handler).toContain('computerHistory.configSet(chPatch, save)')
    expect(handler).not.toContain('computerHistory?.applyConfig(')
  })

  it('补落在写盘那一刻才定补丁(creview3 #1):排在它前面的另一份写(绕过意愿队列的老路径)落成并同步内存后,补落不拿旧值盖回', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    cleanups.push(() => vi.useRealTimers())
    const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
    const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await settle() }
    const cfg = fakeConfigStore()
    const { ch } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`), { persist: cfg.saveConfig })
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
    const A = { apps: ['com.a'], domains: [] }
    const AB = { apps: ['com.a', 'com.b'], domains: [] }
    cfg.failNextWith('EROFS')
    await expect(ch.setExclude(A)).rejects.toThrow('EROFS')
    const open = cfg.blockQueue()
    // 老的 config:set 次序:先落盘(排在补落前面),落成才同步内存
    const legacy = cfg.saveConfig({ computerHistoryExclude: AB }).then(() => ch.applyConfig({ computerHistoryExclude: AB }))
    await advance(5_000) // 补落到点:它的写排在 A+B 后面
    open()
    await legacy
    await advance(0)
    expect(cfg.disk.computerHistoryExclude).toEqual(AB)
    expect(ch.view().exclude).toEqual(AB)
    expect(ch.view().persistError).toBeUndefined()
  })

  it('state.json 写失败(creview G):写成才算数、按退避重写;关闭那份写不进去就删掉 state.json 失败关门', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const eio = (): Error => Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })
    // 开着但暂停中:不碰 socket
    const { ch, root } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`))
    const statePath = path.join(root, 'state.json')
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
    await ch.flush()
    expect(readState(root)).toMatchObject({ enabled: true, status: 'paused' })
    const writeState = vi.spyOn(ch.store, 'writeState')

    // 非关门的一份(换暂停时长)写失败:文件不删(引擎照常读),但不算已写 —— 重试把新的 pausedUntil 补上
    writeState.mockRejectedValueOnce(eio())
    const v = await ch.pause(30 * 60_000)
    await ch.flush()
    expect(existsSync(statePath)).toBe(true)
    expect(readState(root).pausedUntil).not.toBe(v.state.pausedUntil)
    await waitFor(() => readState(root).pausedUntil === v.state.pausedUntil)

    // 关闭那份写失败:当场删掉 state.json(引擎把没有 state.json 当关),之后重试写上 enabled:false
    writeState.mockRejectedValueOnce(eio())
    await ch.setEnabled(false)
    expect(existsSync(statePath)).toBe(false)
    await waitFor(() => existsSync(statePath))
    expect(readState(root)).toMatchObject({ enabled: false, status: 'off' })
  })

  it('state.json 写不进也删不掉(creview3 #2):历史目录只读时关闭 —— 「关」照样落进桌面配置(引擎第二道闸),设置页看得到错误;恢复可写后补上并消失', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const { ch, root, persist, onChanged } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`))
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
    await ch.flush()
    expect(readState(root)).toMatchObject({ enabled: true })
    chmodSync(root, 0o500) // 目录只读:建不了临时文件,也删不掉 state.json
    cleanups.push(() => chmodSync(root, 0o700))
    await ch.setEnabled(false)
    await ch.flush()
    expect(readState(root)).toMatchObject({ enabled: true }) // 盘上还是旧的「开」—— 只剩桌面配置这道闸
    expect(persist).toHaveBeenLastCalledWith({ computerHistoryEnabled: false, computerHistoryPausedUntil: null })
    const err = ch.view().stateError
    expect(err).toMatch(/EACCES/)
    expect(err!.split(';')).toHaveLength(2) // 写失败 + 删失败都在
    expect(onChanged.mock.lastCall?.[0].stateError).toBe(err)
    chmodSync(root, 0o700)
    await waitFor(() => ch.view().stateError === undefined, 6_000)
    expect(readState(root)).toMatchObject({ enabled: false, status: 'off' })
    expect(onChanged.mock.lastCall?.[0]).not.toHaveProperty('stateError')
  })

  it('state.json 写失败 × 清除(creview G):dataGen+1 那份写不进去 → 删除执行时 state.json 已不在;删完那份写上后恢复', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    const { ch, root } = makeController(path.join(os.tmpdir(), `chs-none-${process.pid}.sock`))
    const statePath = path.join(root, 'state.json')
    await ch.start({ computerHistoryEnabled: true, computerHistoryPausedUntil: Date.now() + 3_600_000 })
    await ch.flush()
    const gen = readState(root).dataGen
    vi.spyOn(ch.store, 'writeState').mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }))
    const seen: boolean[] = []
    const realClear = ch.store.clear.bind(ch.store)
    vi.spyOn(ch.store, 'clear').mockImplementationOnce(async (o) => { seen.push(existsSync(statePath)); await realClear(o) })
    await ch.clear({ all: true })
    await ch.flush()
    expect(seen).toEqual([false]) // 读到一半的读者复核时拿不到 state → 整份作废;新来的读者当关
    expect(readState(root)).toMatchObject({ enabled: true, status: 'paused', dataGen: gen + 2 })
  })
})
