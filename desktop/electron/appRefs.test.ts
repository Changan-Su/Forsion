import { describe, expect, it } from 'vitest'
import { createAppRefs, parseInstalledApps, type AppRefDeps } from './appRefs'
import { appRefLabel, appRefToken, parseAppRefInner, sameWindowTitle } from '../shared/appRefs'

const MDFIND = [
  '/Applications/Google Chrome.app   kMDItemCFBundleIdentifier = com.google.Chrome   kMDItemDisplayName = Google Chrome',
  '/Applications/WeChat.app   kMDItemCFBundleIdentifier = com.tencent.xinWeChat   kMDItemDisplayName = 微信',
  '/Applications/Xcode.app/Contents/Applications/Instruments.app   kMDItemCFBundleIdentifier = com.apple.Instruments   kMDItemDisplayName = Instruments',
  '/Applications/Keynote.app   kMDItemCFBundleIdentifier = com.apple.iWork.Keynote   kMDItemDisplayName = (null)',
  'garbage',
].join('\n')

function fake(over: Partial<AppRefDeps> & { helper?: Record<string, unknown> | null } = {}) {
  const calls: Array<Record<string, unknown>> = []
  const opened: string[] = []
  const helper = over.helper === undefined ? {
    listApps: [
      { appName: 'Google Chrome', pid: 11, bundleId: 'com.google.Chrome', isFrontmost: true },
      { appName: 'some-agent', pid: 12, bundleId: 'com.example.agent' },
      { appName: 'Keynote', pid: 13, bundleId: 'com.apple.iWork.Keynote' },
    ],
    dockCandidates: { windows: [
      { pid: 11, windowId: 101, app: 'Google Chrome', bundleId: 'com.google.Chrome', title: 'Linear – Pricing', x: 0, y: 0, w: 800, h: 600 },
      { pid: 11, windowId: 102, app: 'Google Chrome', bundleId: 'com.google.Chrome', title: '', x: 0, y: 0, w: 800, h: 600 },
    ] },
    listWindows: [{ title: 'Q4 路演.key', windowId: 301, windowRef: 'w1' }],
    focusWindow: { focused: true },
  } : over.helper
  const deps: AppRefDeps = {
    platform: 'darwin', ownPid: 1, home: '/Users/me',
    ask: async (p) => {
      calls.push(p)
      if (!helper) throw Object.assign(new Error('down'), { code: 'helper_not_installed' })
      return helper[p.cmd as string]
    },
    ensureHelper: async () => { if (!helper) throw Object.assign(new Error('down'), { code: 'helper_not_installed' }) },
    run: async (file, args) => {
      if (file.endsWith('mdfind')) return MDFIND
      if (args[1] === 'com.missing.app') throw new Error('exit 1')
      opened.push(args[1]); return ''
    },
    ...over,
  }
  return { refs: createAppRefs(deps), calls, opened }
}

describe('token', () => {
  it('往返;标题里的 | [ ] 换行不会拆坏双链', () => {
    const tok = appRefToken({ kind: 'window', id: 'com.google.Chrome', name: 'a|b [c]\nd' })
    expect(tok).toBe('[[window://com.google.Chrome|a b c d]]')
    expect(parseAppRefInner(tok.slice(2, -2))).toEqual({ kind: 'window', id: 'com.google.Chrome', name: 'a b c d' })
  })
  it('不是这两种前缀 / 标识不合法 → null(照旧当笔记链接)', () => {
    for (const inner of ['app:com.x|X', 'session:abc|t', 'app://bad id|X', 'window://|t', '笔记/app://x', 'http://a.b|c'])
      expect(parseAppRefInner(inner)).toBeNull()
  })
  it('长标题封顶且幂等,截断后的引用仍对得上原窗口', () => {
    const long = 'x'.repeat(200)
    expect(appRefLabel(appRefLabel(long))).toBe(appRefLabel(long))
    expect(sameWindowTitle(appRefLabel(long), long)).toBe(true)
    expect(sameWindowTitle('', '')).toBe(false)
  })
})

describe('parseInstalledApps', () => {
  it('嵌在别的 .app 里的不算;没有显示名时用文件名', () => {
    const m = parseInstalledApps(MDFIND, '/Users/me')
    expect([...m.keys()].sort()).toEqual(['com.apple.iWork.Keynote', 'com.google.Chrome', 'com.tencent.xinWeChat'])
    expect(m.get('com.apple.iWork.Keynote')!.name).toBe('Keynote')
    expect(m.get('com.tencent.xinWeChat')!.name).toBe('微信')
  })
})

describe('list', () => {
  it('窗口只列带标题的;应用在跑的在前,后台小进程不进候选', async () => {
    const { refs } = fake()
    const r = await refs.list()
    expect(r.windows).toEqual([{ id: 'com.google.Chrome', app: 'Google Chrome', title: 'Linear – Pricing' }])
    expect(r.apps.map((a) => [a.id, a.running])).toEqual([
      ['com.google.Chrome', true], ['com.apple.iWork.Keynote', true], ['com.tencent.xinWeChat', false],
    ])
    expect(r.error).toBeUndefined()
  })
  it('helper 不可用:窗口空、应用照列,带上原因', async () => {
    const r = await fake({ helper: null }).refs.list()
    expect(r.windows).toEqual([])
    expect(r.apps.length).toBe(3)
    expect(r.error).toBe('helper_not_installed')
  })
  it('别的平台:空 + unsupported_platform', async () => {
    expect(await fake({ platform: 'win32' }).refs.list()).toEqual({ windows: [], apps: [], error: 'unsupported_platform' })
  })
})

describe('status', () => {
  it('五种状态', async () => {
    const { refs } = fake()
    const s = await refs.status([
      { kind: 'window', id: 'com.google.Chrome', name: 'Linear – Pricing' },
      { kind: 'window', id: 'com.apple.iWork.Keynote', name: 'Q4 路演.key' }, // 不在屏上,经 AX 找到
      { kind: 'window', id: 'com.google.Chrome', name: '已经关掉的页' },
      { kind: 'app', id: 'com.google.Chrome', name: 'Google Chrome' },
      { kind: 'app', id: 'com.tencent.xinWeChat', name: '微信' },
      { kind: 'app', id: 'com.missing.app', name: 'Gone' },
      { kind: 'bogus' },
    ])
    expect(s.map((x) => x.state)).toEqual(['live', 'live', 'closed', 'running', 'idle', 'missing', 'missing'])
    expect(s[0].appName).toBe('Google Chrome')
  })
  it('helper 不可用时窗口一律按已关、应用按没在跑,不抛', async () => {
    const s = await fake({ helper: null }).refs.status([
      { kind: 'window', id: 'com.google.Chrome', name: 'Linear – Pricing' }, { kind: 'app', id: 'com.google.Chrome', name: 'x' },
    ])
    expect(s.map((x) => x.state)).toEqual(['closed', 'idle'])
  })
})

describe('open', () => {
  it('窗口还在:先提窗口再切应用', async () => {
    const { refs, calls, opened } = fake()
    expect(await refs.open({ kind: 'window', id: 'com.google.Chrome', name: 'Linear – Pricing' })).toEqual({ ok: true, landed: 'window' })
    expect(calls.find((c) => c.cmd === 'focusWindow')).toMatchObject({ pid: 11, windowId: 101 })
    expect(opened).toEqual(['com.google.Chrome'])
  })
  it('窗口关了 / helper 不可用:退到只打开应用', async () => {
    const a = fake()
    expect(await a.refs.open({ kind: 'window', id: 'com.google.Chrome', name: '已经关掉的页' })).toEqual({ ok: true, landed: 'app' })
    expect(a.calls.some((c) => c.cmd === 'focusWindow')).toBe(false)
    const b = fake({ helper: null })
    expect(await b.refs.open({ kind: 'window', id: 'com.google.Chrome', name: 'Linear – Pricing' })).toEqual({ ok: true, landed: 'app' })
    expect(b.opened).toEqual(['com.google.Chrome'])
  })
  it('没装 / 坏引用', async () => {
    const { refs, opened } = fake()
    expect(await refs.open({ kind: 'app', id: 'com.missing.app', name: 'x' })).toEqual({ ok: false, error: 'not_installed' })
    expect(await refs.open({ kind: 'app', id: 'a b; rm -rf', name: 'x' })).toEqual({ ok: false, error: 'bad_ref' })
    expect(opened).toEqual([])
  })
})

describe('frontmost', () => {
  it('取最前那扇;没标题就退成应用', async () => {
    expect(await fake().refs.frontmost()).toEqual({ kind: 'window', id: 'com.google.Chrome', name: 'Linear – Pricing' })
    const untitled = fake({ helper: { dockCandidates: { windows: [{ pid: 5, windowId: 9, app: 'Finder', bundleId: 'com.apple.finder', title: '' }] } } })
    expect(await untitled.refs.frontmost()).toEqual({ kind: 'app', id: 'com.apple.finder', name: 'Finder' })
    expect(await fake({ helper: null }).refs.frontmost()).toBeNull()
  })
})
