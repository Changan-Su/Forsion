/**
 * 应用 / 窗口引用 · Windows 半身的可跑检查。PowerShell 不真起:注入的 run 按请求里的 op 回夹具,
 * 夹具就是两段脚本真正输出的形状(`<<FSN:base64(JSON):FSN>>`,字段名见 appRefsWin.ts 的解析器)。
 * 真机那半(脚本本身对不对、能不能抢到前台)在 scripts/app-refs-windows.probe.cjs,由 probe-app-refs-windows.yml 跑。
 */
import { describe, expect, it } from 'vitest'
import {
  PS_NATIVE, PS_SHELL, buildWinIndex, canonWinId, createWinAppRefs, encodeWinId, parseWinFocus, parseWinInstalled, parseWinSnapshot,
  resolveWinView, unframe, winAppIdOf, winIdOfAumid, winIdOfExe, type WinAppRefDeps, type WinInstalledRaw,
} from './appRefsWin'
import { createAppRefs } from './appRefs'
import { appRefToken, isAppRefId, parseAppRefInner } from '../shared/appRefs'

const frame = (o: unknown): string => `<<FSN:${Buffer.from(JSON.stringify(o), 'utf8').toString('base64')}:FSN>>`

const CALC = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'
const NOTEPAD11 = 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'
const SETTINGS = 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel'
const CALC_ID = 'microsoft.windowscalculator_8wekyb3d8bbwe%21app'
const NOTEPAD11_ID = 'microsoft.windowsnotepad_8wekyb3d8bbwe%21app'
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

// 进程表(去重后的 exe + 包身份;desc 只有名下有窗口的进程才带)
const APPS = [
  /* 0 */ { exe: CHROME_EXE, aumid: '', desc: 'Google Chrome' },
  /* 1 */ { exe: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', aumid: '', desc: 'Application Frame Host' },
  /* 2 */ { exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11.2405.2.0_x64__8wekyb3d8bbwe\\CalculatorApp.exe', aumid: CALC, desc: '' },
  /* 3 */ { exe: 'C:\\Windows\\explorer.exe', aumid: '', desc: 'Windows Explorer' },
  /* 4 */ { exe: 'C:\\Program Files\\Notepad++\\notepad++.exe', aumid: '', desc: 'Notepad++' },
  /* 5 */ { exe: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', aumid: '', desc: 'Visual Studio Code' },
  /* 6 */ { exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2410.21.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe', aumid: NOTEPAD11, desc: 'Notepad' },
  /* 7 */ { exe: 'D:\\Tools\\Adobe Premiere Pro.exe', aumid: '', desc: '' },
  /* 8 */ { exe: 'C:\\Windows\\System32\\svchost.exe', aumid: '', desc: '' },
  /* 9 */ { exe: 'C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0.9163\\Discord.exe', aumid: '', desc: '' }, // 只在托盘里,没有窗口
]

type RawWin = { h: number; pid: number; a: number; ha: number; t: string; c: string; x: number; o: number; k: number; m: number; wa: string }
const win = (h: number, pid: number, a: number, t: string, over: Partial<RawWin> = {}): RawWin =>
  ({ h, pid, a, ha: -1, t, c: 'Chrome_WidgetWin_1', x: 0x100, o: 0, k: 0, m: 0, wa: '', ...over })

// 前到后
const WINS = [
  win(0x10a, 11, 0, 'Linear – Pricing - Google Chrome'),
  win(0x20b, 21, 1, '计算器', { c: 'ApplicationFrameWindow', wa: CALC, ha: 2 }), // UWP:外框挂在 ApplicationFrameHost 名下
  win(0x10c, 11, 0, '文档 - Google Chrome'),
  win(0x30d, 31, 6, 'notes.txt - Notepad', { c: 'Notepad' }), // 打包的 Win32(Win11 记事本):自己持有窗口
  win(0x40e, 41, 7, 'Untitled Project', { c: 'Premiere Pro' }), // 便携版:不在开始菜单里,exe 名带空格
  win(0x50f, 51, 4, 'C:\\work\\todo.md - Notepad++', { c: 'Notepad++', m: 1 }), // 最小化
  win(0x610, 61, 5, 'main.ts — forsion', { k: 2 }), // 在别的虚拟桌面
  win(0x711, 71, 3, 'Program Manager', { c: 'Progman' }),
  win(0x712, 71, 3, '', { c: 'Shell_TrayWnd', x: 0x88 }),
  win(0x813, 11, 0, 'Chrome 的小浮层', { x: 0x80 }), // 工具窗口
  win(0x814, 11, 0, '另存为', { o: 1 }), // 有属主的对话框
  win(0x915, 21, 1, '设置', { c: 'ApplicationFrameWindow', k: 2, wa: SETTINGS }), // 挂起的 UWP 留下的空壳
  win(0x916, 21, 1, 'Microsoft Store', { c: 'ApplicationFrameWindow' }), // 认不出里面是谁
  win(0x917, 81, 2, '计算器', { c: 'Windows.UI.Core.CoreWindow' }), // 没挂进外框的内层窗口
]
const SNAPSHOT = { v: 1, fg: 0x10a, apps: APPS, wins: WINS }

const INSTALLED = {
  start: [
    { name: 'Google Chrome', aumid: 'Chrome', target: CHROME_EXE, args: '' },
    { name: 'YouTube', aumid: 'Chrome._crx_agimnk', target: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe', args: '--profile-directory=Default --app-id=agimnkijcaahngcdmfeangaknmldooml' },
    { name: '计算器', aumid: CALC, target: '', args: '' },
    { name: '记事本', aumid: NOTEPAD11, target: '', args: '' },
    { name: 'Notepad++', aumid: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Notepad++\\notepad++.exe', target: 'C:\\Program Files\\Notepad++\\notepad++.exe', args: '' },
    { name: 'Visual Studio Code', aumid: 'Microsoft.VisualStudioCode', target: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', args: '' },
    { name: 'Discord', aumid: 'com.squirrel.Discord.Discord', target: 'C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe', args: '--processStart Discord.exe' },
    { name: '微信', aumid: '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Tencent\\WeChat\\WeChat.exe', target: '', args: '' },
    { name: 'Developer Command Prompt', aumid: 'VisualStudio.DevCmd', target: 'C:\\Windows\\System32\\cmd.exe', args: '/k "C:\\VS\\Common7\\Tools\\VsDevCmd.bat"' },
    { name: '命令提示符', aumid: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe', target: 'C:\\Windows\\System32\\cmd.exe', args: '' },
    { name: 'Uninstall Foo', aumid: 'Foo.Uninstall', target: 'C:\\Program Files\\Foo\\unins000.exe', args: '' },
    { name: '控制面板', aumid: 'Microsoft.Windows.ControlPanel', target: '', args: '' },
  ],
  links: [
    { name: 'Google Chrome', lnk: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk', target: CHROME_EXE, args: '' },
    { name: 'WeChat', lnk: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\WeChat\\WeChat.lnk', target: 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe', args: '' },
    { name: 'Foo Tool', lnk: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Foo Tool.lnk', target: 'C:\\Program Files\\Foo\\Foo Tool.exe', args: '' },
    { name: 'Foo Readme', lnk: 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Foo Readme.lnk', target: 'C:\\Program Files\\Foo\\readme.html', args: '' },
  ],
  paths: [
    { exe: 'mspaint.exe', path: 'C:\\Windows\\System32\\mspaint.exe' },
    { exe: 'chrome.exe', path: `"${CHROME_EXE}"` },
  ],
  errors: [],
}

type Req = Record<string, unknown> & { op: string }

function fake(over: Partial<WinAppRefDeps> = {}) {
  const calls: Array<{ file: string; args: string[]; req: Req; timeoutMs?: number }> = []
  let clock = 1_000_000
  const state = {
    snapshot: SNAPSHOT as unknown,
    installed: INSTALLED as unknown,
    focus: (_req: Req): unknown => ({ gone: false, focused: true, step: 0, min: false }),
    launch: { ok: true, error: '' } as unknown,
    /** 某个 op 直接回这段原文(测坏输出);值是 Error 就 reject(测超时 / 起不来)。 */
    raw: {} as Record<string, string | Error>,
  }
  const deps: WinAppRefDeps = {
    ownPid: 1, now: () => clock, env: { SystemRoot: 'C:\\Windows' },
    run: async (file, args, opts) => {
      const req = JSON.parse(Buffer.from(opts!.env!.FSN_APPREFS_IN, 'base64').toString('utf8')) as Req
      calls.push({ file, args, req, timeoutMs: opts?.timeoutMs })
      const raw = state.raw[req.op]
      if (raw instanceof Error) throw raw
      if (typeof raw === 'string') return raw
      if (req.op === 'snapshot') return frame(state.snapshot)
      if (req.op === 'installed') return frame(state.installed)
      if (req.op === 'focus') return frame(state.focus(req))
      return frame(state.launch)
    },
    ...over,
  }
  const ops = (op: string): Req[] => calls.filter((c) => c.req.op === op).map((c) => c.req)
  return { refs: createWinAppRefs(deps), calls, ops, state, tick: (ms: number) => { clock += ms } }
}

const chromeWin = { kind: 'window' as const, id: 'chrome.exe', name: 'Linear – Pricing - Google Chrome' }

describe('标识', () => {
  it('三类例子:传统应用 / 名字带空格和加号的 / 打包应用,都是合法标识且能在 token 里往返', () => {
    expect(winIdOfExe(CHROME_EXE)).toBe('chrome.exe')
    expect(winIdOfExe('C:\\Program Files\\Notepad++\\notepad++.exe')).toBe('notepad%2B%2B.exe')
    expect(winIdOfExe('D:\\Tools\\Adobe Premiere Pro.exe')).toBe('adobe%20premiere%20pro.exe')
    expect(winIdOfExe('C:\\App\\微信.exe')).toBe('%E5%BE%AE%E4%BF%A1.exe')
    expect(winIdOfExe('C:\\App\\_tool.exe')).toBe('%5Ftool.exe') // 开头不是字母数字的也转义
    expect(winIdOfAumid(CALC)).toBe(CALC_ID)
    for (const id of ['chrome.exe', 'notepad%2B%2B.exe', 'adobe%20premiere%20pro.exe', '%E5%BE%AE%E4%BF%A1.exe', '%5Ftool.exe', CALC_ID]) {
      expect(isAppRefId(id)).toBe(true)
      expect(canonWinId(id)).toBe(id)
      const tok = appRefToken({ kind: 'window', id, name: '报告 [终稿].docx' })
      expect(parseAppRefInner(tok.slice(2, -2))).toEqual({ kind: 'window', id, name: '报告 终稿 .docx' })
    }
  })

  it('同一个应用每次都是同一个标识:大小写、来路(进程路径 / 快捷方式目标 / 手写)不同也一样', () => {
    expect(winIdOfExe('c:\\PROGRA~1\\Google\\Chrome\\Application\\CHROME.EXE')).toBe('chrome.exe')
    expect(canonWinId('Chrome.exe')).toBe('chrome.exe')
    expect(canonWinId('notepad%2B%2B.EXE')).toBe('notepad%2B%2B.exe')
    expect(winIdOfAumid('MICROSOFT.WINDOWSCALCULATOR_8WEKYB3D8BBWE!APP')).toBe(CALC_ID)
    expect(encodeWinId(encodeWinId('a b'))).not.toBe(encodeWinId('a b')) // 编码不幂等是对的:进来的标识一律先解码再编(canonWinId)
    expect(canonWinId(canonWinId('Adobe%20Premiere%20Pro.exe'))).toBe('adobe%20premiere%20pro.exe')
  })

  it('不是 Windows 的标识 / 想夹带路径的 → null', () => {
    for (const id of ['com.google.Chrome', 'com.apple.finder', '..%5C..%5Cevil.exe', 'a%2Fb.exe', 'c%3A%5Cx.exe', '%FF.exe', 'notepad', 'a%7Cb.exe', 'x%0A.exe'])
      expect(canonWinId(id)).toBeNull()
    expect(winIdOfExe('C:\\Windows\\System32\\drivers\\thing.sys')).toBeNull()
    expect(winIdOfExe('')).toBeNull()
    expect(winIdOfAumid('Chrome')).toBeNull() // 传统应用自己设的 AUMID 不是我们的标识
    expect(winIdOfAumid('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe')).toBeNull()
  })

  it('winAppIdOf:窗口属主 → 标识的唯一入口;定不了就是 null,绝不给出 ApplicationFrameHost', () => {
    expect(winAppIdOf(CHROME_EXE)).toBe('chrome.exe')
    expect(winAppIdOf(APPS[6].exe, NOTEPAD11)).toBe(NOTEPAD11_ID)
    expect(winAppIdOf(APPS[6].exe)).toBeNull() // 打包应用没给 AUMID:exe 名对不上开始菜单那侧
    expect(winAppIdOf('C:\\Windows\\System32\\ApplicationFrameHost.exe')).toBeNull()
    expect(winAppIdOf('C:\\Windows\\System32\\ApplicationFrameHost.exe', CALC)).toBeNull()
    // 只注册了稀疏包的传统应用:有包身份,但 exe 在普通目录 → 仍按 exe 名
    expect(winAppIdOf('C:\\Program Files\\Some App\\someapp.exe', 'Vendor.SomeApp_abcdefghjkmnp!App')).toBe('someapp.exe')
  })

  it('ID_RE 只多放了 %XX:bundle id 照旧合法;空白、分隔符、引号、反斜杠、shell 元字符、半截转义都不行', () => {
    for (const ok of ['com.google.Chrome', 'com.apple.iWork.Keynote', 'a', 'x_y-z.1', 'a%20b', '%E5%BE%AE.exe', 'a'.repeat(255)]) expect(isAppRefId(ok)).toBe(true)
    for (const bad of ['', 'a b', 'a|b', 'a[b', 'a]b', 'a\\b', 'a/b', 'a!b', 'a+b', 'a{b}', 'a"b', "a'b", 'a;b', 'a&b', 'a$b', 'a`b', 'a<b', 'a>b', 'a\nb',
      'a%', 'a%2', 'a%2b', 'a%G1', '%', '.a', '-a', '_a', 'a'.repeat(256), 'a' + '%20'.repeat(85), 42, null, undefined]) expect(isAppRefId(bad)).toBe(false)
  })
})

describe('解析:坏输出一律是 null,不抛', () => {
  it('没有结果帧 / 帧里不是 JSON / 缺字段 / 空输出 / PowerShell 的报错文本', () => {
    for (const out of ['', '   ', 'Add-Type : 无法加载类型', '<<FSN::FSN>>', '<<FSN:bm90IGpzb24=:FSN>>', frame({}), frame({ wins: [] }), frame([]), frame(null), null, undefined, 42]) {
      expect(parseWinSnapshot(out)).toBeNull()
      expect(parseWinInstalled(out)).toBeNull()
      expect(parseWinFocus(out)).toBeNull()
    }
  })

  it('帧前后混进别的输出不影响;数组被拆成单个对象 / 给成 null 也认', () => {
    const one = parseWinSnapshot(`WARNING: something\r\n${frame({ v: 1, fg: 0, apps: APPS[0], wins: WINS[0] })}\r\n`)
    expect(one?.apps).toHaveLength(1)
    expect(one?.windows).toEqual([{ hwnd: 0x10a, pid: 11, app: 0, host: -1, title: 'Linear – Pricing - Google Chrome', cls: 'Chrome_WidgetWin_1', ex: 0x100, owned: false, cloaked: 0, min: false, aumid: '' }])
    expect(parseWinSnapshot(frame({ v: 1, fg: 0, apps: null, wins: null }))).toEqual({ fg: 0, apps: [], windows: [] })
    expect(parseWinInstalled(frame({ start: INSTALLED.start[0], links: null, paths: null, errors: 'start: boom' })))
      .toEqual({ start: [INSTALLED.start[0]], links: [], paths: [], errors: ['start: boom'] })
  })

  it('指向不存在的进程的窗口、没有句柄的窗口丢掉;标题里落单的半个表情换掉(不然进了 token 渲染时会抛)', () => {
    const s = parseWinSnapshot(frame({ v: 1, fg: 0, apps: [APPS[0]], wins: [win(0, 11, 0, 'x'), win(5, 11, 3, 'x'), win(6, 0, 0, 'x'), win(7, 11, 0, 'a\ud83db')] }))!
    expect(s.windows.map((w) => w.hwnd)).toEqual([7])
    expect(() => encodeURIComponent(s.windows[0].title)).not.toThrow()
  })

  it('focus 的结果:gone 压过 focused', () => {
    expect(parseWinFocus(frame({ gone: false, focused: true, step: 1, min: true }))).toEqual({ gone: false, focused: true })
    expect(parseWinFocus(frame({ gone: true, focused: true }))).toEqual({ gone: true, focused: false })
    expect(unframe(frame({ ok: true, error: '' }))).toEqual({ ok: true, error: '' })
  })
})

describe('resolveWinView:哪些窗口算数、各是谁的', () => {
  const view = resolveWinView(parseWinSnapshot(frame(SNAPSHOT))!)

  it('只留 Alt-Tab 里会有的窗口,前后顺序不变;UWP 认到里面的应用,打包的 Win32 按 AUMID,便携版按 exe 名', () => {
    expect(view.windows.map((w) => [w.hwnd, w.id])).toEqual([
      [0x10a, 'chrome.exe'], [0x20b, CALC_ID], [0x10c, 'chrome.exe'], [0x30d, NOTEPAD11_ID],
      [0x40e, 'adobe%20premiere%20pro.exe'], [0x50f, 'notepad%2B%2B.exe'], [0x610, 'code.exe'],
    ])
    expect(view.windows.find((w) => w.hwnd === 0x50f)).toMatchObject({ min: true, onScreen: true })
    expect(view.windows.find((w) => w.hwnd === 0x610)).toMatchObject({ onScreen: false })
    expect(view.windows.find((w) => w.hwnd === 0x40e)?.app).toBe('Adobe Premiere Pro') // 没有文件说明时用 exe 名
    expect(view.windows.find((w) => w.hwnd === 0x20b)?.app).toBe('计算器') // UWP 没有别的名字可用时,外框标题就是应用名
  })

  it('没有任何窗口或在跑的应用被记成 ApplicationFrameHost', () => {
    expect(view.windows.some((w) => /applicationframehost/i.test(w.id))).toBe(false)
    expect([...view.running.keys()].some((id) => /applicationframehost/i.test(id))).toBe(false)
  })

  it('外框窗口属性里没有 AUMID 时,退到里面那层 CoreWindow 的进程;两样都没有就丢', () => {
    const raw = { v: 1, fg: 0, apps: APPS, wins: [win(1, 21, 1, '计算器', { c: 'ApplicationFrameWindow', ha: 2 }), win(2, 21, 1, '谁', { c: 'ApplicationFrameWindow' })] }
    expect(resolveWinView(parseWinSnapshot(frame(raw))!).windows.map((w) => [w.hwnd, w.id])).toEqual([[1, CALC_ID]])
  })

  it('在跑的进程:exe 名一条;有包身份的再按 AUMID 一条(开始菜单那侧用哪种都查得到)', () => {
    for (const id of ['chrome.exe', 'discord.exe', 'svchost.exe', CALC_ID, 'calculatorapp.exe', NOTEPAD11_ID]) expect(view.running.has(id)).toBe(true)
    expect(view.running.get(CALC_ID)).toMatchObject({ aumid: CALC })
    expect(view.running.get('chrome.exe')).toEqual({ name: 'Google Chrome', exe: CHROME_EXE })
  })

  it('带 WS_EX_APPWINDOW 的工具窗口 / 有属主的窗口照样算;属主是隐藏窗口的也算(老式程序的主窗口)', () => {
    const raw = { v: 1, fg: 0, apps: APPS, wins: [win(1, 11, 0, 'a', { x: 0x80 | 0x40000 }), win(2, 11, 0, 'b', { o: 1, x: 0x40000 }), win(3, 11, 0, 'c', { x: 0x8000000 }), win(4, 11, 0, 'd', { o: 2 })] }
    expect(resolveWinView(parseWinSnapshot(frame(raw))!).windows.map((w) => w.hwnd)).toEqual([1, 2, 4])
  })
})

describe('buildWinIndex:开始菜单 → 标识', () => {
  const index = buildWinIndex(parseWinInstalled(frame(INSTALLED))!)

  it('传统应用按快捷方式目标的 exe 名,启动用系统给的 AUMID;打包应用按 AUMID', () => {
    expect(index.get('chrome.exe')).toEqual({ id: 'chrome.exe', name: 'Google Chrome', launch: { kind: 'aumid', value: 'Chrome' }, icon: CHROME_EXE, listed: true })
    expect(index.get(CALC_ID)).toEqual({ id: CALC_ID, name: '计算器', launch: { kind: 'aumid', value: CALC }, listed: true })
    expect(index.get('notepad%2B%2B.exe')?.name).toBe('Notepad++')
    expect(index.get('code.exe')?.launch).toEqual({ kind: 'aumid', value: 'Microsoft.VisualStudioCode' })
  })

  it('Squirrel 装的:快捷方式指向 Update.exe --processStart X.exe,按 X.exe 记(窗口属主是它)', () => {
    expect(index.get('discord.exe')).toMatchObject({ name: 'Discord', launch: { kind: 'aumid', value: 'com.squirrel.Discord.Discord' } })
    expect(index.has('update.exe')).toBe(false)
  })

  it('AppsFolder 没给目标时:按路径生成的 AUMID 取文件名,图标路径从 .lnk 那路补;只在 .lnk 里有的用快捷方式启动', () => {
    expect(index.get('wechat.exe')).toMatchObject({ name: '微信', launch: { kind: 'aumid', value: INSTALLED.start[7].aumid }, icon: 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe' })
    expect(index.get('foo%20tool.exe')).toEqual({ id: 'foo%20tool.exe', name: 'Foo Tool', launch: { kind: 'lnk', value: INSTALLED.links[2].lnk }, icon: 'C:\\Program Files\\Foo\\Foo Tool.exe', listed: true })
  })

  it('同一个 exe 的几条:不带参数的赢;带参数指向宿主程序的(开发者命令行、网页应用)、卸载程序、不是 exe 的都不进', () => {
    expect(index.get('cmd.exe')).toMatchObject({ name: '命令提示符', launch: { kind: 'aumid', value: INSTALLED.start[9].aumid } })
    for (const id of ['chrome_proxy.exe', 'unins000.exe', 'readme.html', 'applicationframehost.exe']) expect(index.has(id)).toBe(false)
    expect([...index.values()].some((a) => a.name === 'YouTube' || a.name === '控制面板')).toBe(false)
  })

  it('App Paths 只补「装没装 / 怎么启动」,不进选择器;值带引号也认;已有的不覆盖', () => {
    expect(index.get('mspaint.exe')).toEqual({ id: 'mspaint.exe', name: 'mspaint', launch: { kind: 'exe', value: 'C:\\Windows\\System32\\mspaint.exe' }, icon: 'C:\\Windows\\System32\\mspaint.exe', listed: false })
    expect(index.get('chrome.exe')?.launch.kind).toBe('aumid')
  })

  it('带参数的快捷方式指向 ApplicationFrameHost 也不进', () => {
    const raw: WinInstalledRaw = { start: [{ name: 'x', aumid: 'x', target: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', args: '' }], links: [], paths: [{ exe: 'ApplicationFrameHost.exe', path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe' }], errors: [] }
    expect(buildWinIndex(raw).size).toBe(0)
  })
})

describe('list', () => {
  it('当前桌面上带标题的窗口(前到后,含最小化的);应用在跑的在前,名字用开始菜单里的', async () => {
    const { refs, ops } = fake()
    const r = await refs.list()
    expect(r.windows).toEqual([
      { id: 'chrome.exe', app: 'Google Chrome', title: 'Linear – Pricing - Google Chrome' },
      { id: CALC_ID, app: '计算器', title: '计算器' },
      { id: 'chrome.exe', app: 'Google Chrome', title: '文档 - Google Chrome' },
      { id: NOTEPAD11_ID, app: '记事本', title: 'notes.txt - Notepad' },
      { id: 'adobe%20premiere%20pro.exe', app: 'Adobe Premiere Pro', title: 'Untitled Project' },
      { id: 'notepad%2B%2B.exe', app: 'Notepad++', title: 'C:\\work\\todo.md - Notepad++' },
    ])
    expect(r.error).toBeUndefined()
    const running = r.apps.filter((a) => a.running).map((a) => a.id).sort()
    // VS Code 的窗口在别的桌面(不列窗口),但应用在跑;Discord 只在托盘里,也在跑
    expect(running).toEqual(['adobe%20premiere%20pro.exe', 'chrome.exe', 'code.exe', 'discord.exe', CALC_ID, NOTEPAD11_ID, 'notepad%2B%2B.exe'].sort())
    expect(r.apps.filter((a) => !a.running).map((a) => a.name)).toEqual(['Foo Tool', '命令提示符', '微信'].sort((a, b) => a.localeCompare(b)))
    expect(r.apps.some((a) => a.id === 'mspaint.exe' || /applicationframehost/i.test(a.id))).toBe(false)
    expect(r.apps.findIndex((a) => !a.running)).toBe(running.length) // 在跑的全在前面
    expect(ops('snapshot')).toHaveLength(1)
    expect(ops('installed')).toHaveLength(1)
  })

  it('窗口列不出来(PowerShell 起不来 / 超时 / 输出坏了):窗口空、应用照列,带上原因,不抛', async () => {
    for (const bad of [new Error('spawn ENOENT'), Object.assign(new Error('timeout'), { killed: true }), 'Add-Type : (0) : Warning as Error', '']) {
      const f = fake()
      f.state.raw.snapshot = bad
      const r = await f.refs.list()
      expect(r.windows).toEqual([])
      expect(r.apps.map((a) => a.running)).not.toContain(true)
      expect(r.apps.length).toBeGreaterThan(5)
      expect(r.error).toBe('unavailable')
    }
  })

  it('两段脚本都起不来:空 + 原因', async () => {
    const f = fake()
    f.state.raw.snapshot = new Error('x'); f.state.raw.installed = new Error('x')
    expect(await f.refs.list()).toEqual({ windows: [], apps: [], error: 'unavailable' })
  })
})

describe('status', () => {
  it('五种状态,外加最小化 / 别的桌面 / UWP / 托盘里 / 便携版 / macOS 来的标识', async () => {
    const { refs } = fake()
    const s = await refs.status([
      chromeWin,
      { kind: 'window', id: 'notepad%2B%2B.exe', name: 'C:\\work\\todo.md - Notepad++' }, // 最小化的还开着
      { kind: 'window', id: 'code.exe', name: 'main.ts — forsion' }, // 在别的虚拟桌面的也开着
      { kind: 'window', id: CALC_ID, name: '计算器' }, // UWP
      { kind: 'window', id: 'chrome.exe', name: '已经关掉的页' },
      { kind: 'app', id: 'chrome.exe', name: 'Google Chrome' },
      { kind: 'app', id: 'discord.exe', name: 'Discord' }, // 只在托盘里
      { kind: 'app', id: 'adobe%20premiere%20pro.exe', name: 'Premiere' }, // 不在开始菜单里,但在跑
      { kind: 'app', id: CALC_ID, name: '计算器' },
      { kind: 'app', id: 'wechat.exe', name: '微信' }, // 装了没开
      { kind: 'app', id: 'mspaint.exe', name: '画图' }, // 只在 App Paths 里
      { kind: 'app', id: 'nothere.exe', name: 'Gone' },
      { kind: 'window', id: 'nothere.exe', name: 'x' },
      { kind: 'app', id: 'com.google.Chrome', name: 'Google Chrome' }, // 别的设备(macOS)写下的引用
      { kind: 'bogus' },
    ])
    expect(s.map((x) => x.state)).toEqual(['live', 'live', 'live', 'live', 'closed', 'running', 'running', 'running', 'running', 'idle', 'idle', 'missing', 'missing', 'missing', 'missing'])
    expect(s[0].appName).toBe('Google Chrome')
    expect(s[3].appName).toBe('计算器')
    expect(s[9].appName).toBe('微信')
    expect(s[11].appName).toBe('Gone')
    expect(s[12].appName).toBe('nothere.exe')
  })

  it('手写的大小写不同的标识也认', async () => {
    const s = await fake().refs.status([{ kind: 'app', id: 'Chrome.exe', name: 'x' }, { kind: 'window', id: 'CHROME.EXE', name: '文档 - Google Chrome' }])
    expect(s.map((x) => x.state)).toEqual(['running', 'live'])
  })

  it('只看不动:只起快照和扫描,不提窗口、不启动;同一阵的几批合成一次', async () => {
    const { refs, ops, calls } = fake()
    await Promise.all([refs.status([chromeWin]), refs.status([{ kind: 'app', id: 'wechat.exe', name: 'x' }]), refs.status([chromeWin])])
    await refs.status([chromeWin]) // 刚列过:直接用
    expect(calls.map((c) => c.req.op).sort()).toEqual(['installed', 'snapshot'])
    expect(ops('focus').length + ops('launch').length).toBe(0)
  })

  it('没有一条合法引用时根本不起 PowerShell', async () => {
    const { refs, calls } = fake()
    expect(await refs.status([{ kind: 'bogus' }, null])).toEqual([{ state: 'missing', appName: '' }, { state: 'missing', appName: '' }])
    expect(await refs.status('nope')).toEqual([])
    expect(calls).toEqual([])
  })

  it('快照拿不到(坏输出 / 空输出 / 超时):窗口按已关、应用按没在跑,不抛;之后一段时间内不再白起进程', async () => {
    for (const bad of ['garbage', '', new Error('timeout')]) {
      const f = fake()
      f.state.raw.snapshot = bad
      const ask = [chromeWin, { kind: 'app', id: 'chrome.exe', name: 'x' }, { kind: 'app', id: 'nothere.exe', name: 'y' }]
      expect((await f.refs.status(ask)).map((x) => x.state)).toEqual(['closed', 'idle', 'missing'])
      f.tick(5_000)
      await f.refs.status(ask)
      expect(f.ops('snapshot')).toHaveLength(1)
      f.tick(20_000)
      delete f.state.raw.snapshot
      expect((await f.refs.status(ask)).map((x) => x.state)).toEqual(['live', 'running', 'missing'])
    }
  })

  it('扫描拿不到:在跑的照样认得,没在跑的才是 missing', async () => {
    const f = fake()
    f.state.raw.installed = new Error('COM blocked')
    const s = await f.refs.status([chromeWin, { kind: 'app', id: 'wechat.exe', name: '微信' }])
    expect(s.map((x) => x.state)).toEqual(['live', 'missing'])
  })

  it('便携版关掉之后:这次运行里见过它,算没在跑而不是「这台设备上没有」', async () => {
    const f = fake()
    const premiere = { kind: 'app' as const, id: 'adobe%20premiere%20pro.exe', name: 'Premiere' }
    expect((await f.refs.status([premiere]))[0].state).toBe('running')
    f.state.snapshot = { ...SNAPSHOT, apps: APPS.map((a, i) => (i === 7 ? { ...a, exe: 'C:\\Windows\\System32\\svchost.exe' } : a)), wins: WINS.filter((w) => w.a !== 7) }
    f.tick(2_000)
    expect((await f.refs.status([premiere]))[0]).toEqual({ state: 'idle', appName: 'Adobe Premiere Pro' })
  })
})

describe('标题变了也认得出那扇窗口', () => {
  const retitled = (title: string) => ({ ...SNAPSHOT, wins: WINS.map((w) => (w.h === 0x10a ? { ...w, t: title } : w)) })

  it('这次运行里列过的:浏览器换了标签页(标题全变、还有别的窗口)仍是开着的,点击提的是原来那扇,不用先列窗口', async () => {
    const f = fake()
    await f.refs.list() // 列候选时记下 0x10a
    f.state.snapshot = retitled('GitHub - Google Chrome')
    f.tick(2_000)
    expect((await f.refs.status([chromeWin]))[0].state).toBe('live')
    const before = f.ops('snapshot').length
    expect(await f.refs.open(chromeWin)).toEqual({ ok: true, landed: 'window' })
    expect(f.ops('focus')).toEqual([{ op: 'focus', hwnd: 0x10a, wpid: 11 }])
    expect(f.ops('snapshot')).toHaveLength(before)
    expect(f.ops('launch')).toEqual([])
  })

  it('没记过的(重启后 / 别的设备来的):标题多了前后缀 → 认唯一相近的那扇;全变了 → 找不到', async () => {
    const f = fake()
    const short = { kind: 'window' as const, id: 'chrome.exe', name: 'Linear – Pricing' }
    expect((await f.refs.status([short]))[0].state).toBe('live')
    f.state.snapshot = retitled('GitHub - Google Chrome')
    f.tick(2_000)
    expect((await f.refs.status([chromeWin]))[0].state).toBe('closed')
  })

  it('记着的那扇关了(句柄失效):退回按标题找', async () => {
    const f = fake()
    f.refs.remember('chrome.exe', chromeWin.name, 11, 0xdead)
    f.state.focus = (req) => (req.hwnd === 0xdead ? { gone: true, focused: false } : { gone: false, focused: true })
    expect(await f.refs.open(chromeWin)).toEqual({ ok: true, landed: 'window' })
    expect(f.ops('focus').map((r) => r.hwnd)).toEqual([0xdead, 0x10a])
  })
})

describe('open', () => {
  it('窗口还在:只提那扇窗口(带上 pid 让脚本核对句柄没被别人占用),不启动任何东西', async () => {
    const { refs, ops } = fake()
    expect(await refs.open(chromeWin)).toEqual({ ok: true, landed: 'window' })
    expect(ops('focus')).toEqual([{ op: 'focus', hwnd: 0x10a, wpid: 11 }])
    expect(ops('launch')).toEqual([])
  })

  it('最小化的、UWP 的窗口一样提(还原在脚本里做)', async () => {
    const { refs, ops } = fake()
    expect(await refs.open({ kind: 'window', id: 'notepad%2B%2B.exe', name: 'C:\\work\\todo.md - Notepad++' })).toEqual({ ok: true, landed: 'window' })
    expect(await refs.open({ kind: 'window', id: CALC_ID, name: '计算器' })).toEqual({ ok: true, landed: 'window' })
    expect(ops('focus').map((r) => [r.hwnd, r.wpid])).toEqual([[0x50f, 51], [0x20b, 21]])
  })

  it('窗口关了、应用还有别的窗口:切到它最前面那扇,不多开一个', async () => {
    const { refs, ops } = fake()
    expect(await refs.open({ kind: 'window', id: 'chrome.exe', name: '已经关掉的页' })).toEqual({ ok: true, landed: 'app' })
    expect(ops('focus').map((r) => r.hwnd)).toEqual([0x10a])
    expect(ops('launch')).toEqual([])
  })

  it('窗口关了、应用也没在跑:启动应用 —— 用的是系统给的启动目标,不是标识', async () => {
    const { refs, ops } = fake()
    expect(await refs.open({ kind: 'window', id: 'wechat.exe', name: '文件传输助手' })).toEqual({ ok: true, landed: 'app' })
    expect(ops('focus')).toEqual([])
    expect(ops('launch')).toEqual([{ op: 'launch', kind: 'aumid', value: INSTALLED.start[7].aumid }])
  })

  it('应用引用:在跑且有窗口 → 提最前面没最小化的那扇;只在托盘里 / 没在跑 → 启动', async () => {
    const f = fake()
    expect(await f.refs.open({ kind: 'app', id: 'chrome.exe', name: 'Chrome' })).toEqual({ ok: true, landed: 'app' })
    expect(await f.refs.open({ kind: 'app', id: 'discord.exe', name: 'Discord' })).toEqual({ ok: true, landed: 'app' })
    expect(await f.refs.open({ kind: 'app', id: 'foo%20tool.exe', name: 'Foo Tool' })).toEqual({ ok: true, landed: 'app' })
    expect(await f.refs.open({ kind: 'app', id: 'mspaint.exe', name: '画图' })).toEqual({ ok: true, landed: 'app' })
    expect(f.ops('focus').map((r) => r.hwnd)).toEqual([0x10a])
    expect(f.ops('launch')).toEqual([
      { op: 'launch', kind: 'aumid', value: 'com.squirrel.Discord.Discord' },
      { op: 'launch', kind: 'lnk', value: INSTALLED.links[2].lnk },
      { op: 'launch', kind: 'exe', value: 'C:\\Windows\\System32\\mspaint.exe' },
    ])
  })

  it('打包应用没在跑:按 AppsFolder 里原样的 AUMID 启动(不是标识里那份小写的)', async () => {
    const f = fake()
    f.state.snapshot = { ...SNAPSHOT, apps: APPS.filter((_, i) => i < 2), wins: [WINS[0]] }
    expect(await f.refs.open({ kind: 'app', id: CALC_ID, name: '计算器' })).toEqual({ ok: true, landed: 'app' })
    expect(f.ops('launch')).toEqual([{ op: 'launch', kind: 'aumid', value: CALC }])
  })

  it('这次运行里见过、不在开始菜单里的便携版:关掉之后按当时的 exe 路径启动', async () => {
    const f = fake()
    await f.refs.list()
    f.state.snapshot = { ...SNAPSHOT, apps: APPS.filter((_, i) => i !== 7), wins: WINS.filter((w) => w.a < 7).map((w) => w) }
    f.tick(10_000)
    expect(await f.refs.open({ kind: 'app', id: 'adobe%20premiere%20pro.exe', name: 'Premiere' })).toEqual({ ok: true, landed: 'app' })
    expect(f.ops('launch')).toEqual([{ op: 'launch', kind: 'exe', value: 'D:\\Tools\\Adobe Premiere Pro.exe' }])
  })

  it('只在后台跑、从没有过窗口的进程(系统服务):在跑归在跑,但不能凭一条引用把它启动起来', async () => {
    const f = fake()
    expect((await f.refs.status([{ kind: 'app', id: 'svchost.exe', name: 'x' }]))[0].state).toBe('running')
    expect(await f.refs.open({ kind: 'app', id: 'svchost.exe', name: 'x' })).toEqual({ ok: false, error: 'not_installed' })
    expect(f.ops('launch')).toEqual([])
    f.state.snapshot = { ...SNAPSHOT, apps: APPS.filter((_, i) => i !== 8) }
    f.tick(2_000)
    expect((await f.refs.status([{ kind: 'app', id: 'svchost.exe', name: 'x' }]))[0].state).toBe('missing')
  })

  it('系统不让抢前台:如实回 focus_denied,不退去多开一个实例', async () => {
    const f = fake()
    f.state.focus = () => ({ gone: false, focused: false, step: 2, min: false })
    expect(await f.refs.open(chromeWin)).toEqual({ ok: false, error: 'focus_denied' })
    expect(await f.refs.open({ kind: 'app', id: 'chrome.exe', name: 'Chrome' })).toEqual({ ok: false, error: 'focus_denied' })
    expect(f.ops('launch')).toEqual([])
  })

  it('刚列过的快照里的窗口其实已经关了:现列一遍再定,不拿失效的句柄交差', async () => {
    const f = fake()
    await f.refs.status([{ kind: 'app', id: 'chrome.exe', name: 'x' }]) // 悬停时问过状态,快照还热
    f.state.snapshot = { ...SNAPSHOT, wins: WINS.filter((w) => w.h !== 0x10a) }
    f.state.focus = (req) => (req.hwnd === 0x10a ? { gone: true, focused: false } : { gone: false, focused: true })
    expect(await f.refs.open({ kind: 'app', id: 'chrome.exe', name: 'Chrome' })).toEqual({ ok: true, landed: 'app' })
    expect(f.ops('focus').map((r) => r.hwnd)).toEqual([0x10a, 0x10c])
    expect(f.ops('snapshot')).toHaveLength(2)
  })

  it('没装 / 别的平台的标识 / 坏引用 / 启动失败', async () => {
    const f = fake()
    expect(await f.refs.open({ kind: 'app', id: 'nothere.exe', name: 'x' })).toEqual({ ok: false, error: 'not_installed' })
    expect(await f.refs.open({ kind: 'app', id: 'com.google.Chrome', name: 'x' })).toEqual({ ok: false, error: 'not_installed' })
    expect(await f.refs.open({ kind: 'app', id: 'a b; rm -rf', name: 'x' })).toEqual({ ok: false, error: 'bad_ref' })
    expect(await f.refs.open(null)).toEqual({ ok: false, error: 'bad_ref' })
    expect(f.ops('launch')).toEqual([])
    f.state.launch = { ok: false, error: 'launch_failed' }
    expect(await f.refs.open({ kind: 'app', id: 'wechat.exe', name: '微信' })).toEqual({ ok: false, error: 'not_installed' })
    f.state.raw.launch = new Error('timeout')
    expect(await f.refs.open({ kind: 'app', id: 'wechat.exe', name: '微信' })).toEqual({ ok: false, error: 'not_installed' })
  })

  it('窗口列不出来时仍能启动应用', async () => {
    const f = fake()
    f.state.raw.snapshot = new Error('x')
    expect(await f.refs.open({ kind: 'window', id: 'wechat.exe', name: 'x' })).toEqual({ ok: true, landed: 'app' })
  })

  it('渲染层来的文字不进命令行:脚本是常量、走绝对路径的 powershell,数据只在环境变量里,标题根本不出进程', async () => {
    const f = fake()
    const evil = { kind: 'window' as const, id: 'chrome.exe', name: `'; Remove-Item C:\\ -Recurse; '$(calc) "@` }
    await f.refs.status([evil]); await f.refs.open(evil); await f.refs.list(); await f.refs.frontmost()
    await f.refs.open({ kind: 'app', id: 'wechat.exe', name: evil.name })
    expect(f.calls.length).toBeGreaterThan(3)
    for (const c of f.calls) {
      expect(c.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(c.args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
      const script = c.args[c.args.length - 1]
      expect([PS_NATIVE, PS_SHELL]).toContain(script.replace(/\r\n/g, '\n'))
      expect(script).not.toMatch(/(^|[^\r])\n/) // 交给 PowerShell 的一律 CRLF
      expect(JSON.stringify(c.req)).not.toContain('Remove-Item')
      expect(c.timeoutMs).toBeGreaterThan(0)
    }
    // 请求里只有:op、自己的 pid、我们列出来的句柄 / pid、系统给的启动目标
    expect(new Set(f.calls.flatMap((c) => Object.keys(c.req)))).toEqual(new Set(['op', 'own', 'hwnd', 'wpid', 'kind', 'value']))
  })
})

describe('frontmost', () => {
  it('此刻的前台窗口不是自己的就是它;否则按前后顺序取第一扇,置顶的小窗口往后排', async () => {
    const f = fake()
    f.state.snapshot = { ...SNAPSHOT, fg: 0x30d }
    expect(await f.refs.frontmost()).toEqual({ kind: 'window', id: NOTEPAD11_ID, name: 'notes.txt - Notepad' })
    // Forsion 自己在前台(它的窗口不在快照里):取紧挨在后面的
    f.state.snapshot = { ...SNAPSHOT, fg: 0x999 }
    expect(await f.refs.frontmost()).toEqual({ kind: 'window', id: 'chrome.exe', name: 'Linear – Pricing - Google Chrome' })
    f.state.snapshot = { ...SNAPSHOT, fg: 0x999, wins: [win(0x1, 91, 4, '便签', { x: 0x108 }), ...WINS] }
    expect(await f.refs.frontmost()).toEqual({ kind: 'window', id: 'chrome.exe', name: 'Linear – Pricing - Google Chrome' })
    f.state.snapshot = { ...SNAPSHOT, fg: 0x999, wins: [win(0x1, 91, 4, '便签', { x: 0x108 })] }
    expect(await f.refs.frontmost()).toEqual({ kind: 'window', id: 'notepad%2B%2B.exe', name: '便签' })
    expect(f.ops('snapshot')).toHaveLength(4) // 每次都现列,不用旧快照
  })

  it('最小化的、别的桌面的不算;没标题就退成应用;没有窗口 / 列不出来 → null', async () => {
    const f = fake()
    f.state.snapshot = { ...SNAPSHOT, fg: 0, wins: [WINS[5], WINS[6], win(0x77, 41, 7, '', { c: 'X' })] }
    expect(await f.refs.frontmost()).toEqual({ kind: 'app', id: 'adobe%20premiere%20pro.exe', name: 'Adobe Premiere Pro' })
    f.state.snapshot = { ...SNAPSHOT, wins: [WINS[5], WINS[7]] }
    expect(await f.refs.frontmost()).toBeNull()
    f.state.raw.snapshot = 'garbage'
    expect(await f.refs.frontmost()).toBeNull()
  })

  it('取到的那扇记下来:之后标题变了也认得', async () => {
    const f = fake()
    const ref = (await f.refs.frontmost())!
    f.state.snapshot = { ...SNAPSHOT, wins: WINS.map((w) => (w.h === 0x10a ? { ...w, t: 'GitHub - Google Chrome' } : w)) }
    f.tick(2_000)
    expect((await f.refs.status([ref]))[0].state).toBe('live')
  })
})

describe('icons', () => {
  it('标识 → exe 路径 → 注入的取图标函数;问的是什么键回的就是什么键;结果缓存', async () => {
    const asked: string[] = []
    const f = fake({ fileIcon: async (p) => { asked.push(p); return `data:image/png;base64,${Buffer.from(p).toString('base64')}` } })
    const got = await f.refs.icons(['chrome.exe', 'Chrome.exe', 'wechat.exe', 'discord.exe', 'adobe%20premiere%20pro.exe', CALC_ID, 'nothere.exe', 'com.google.Chrome', 'bad id', 7])
    expect(Object.keys(got).sort()).toEqual(['chrome.exe', 'Chrome.exe', 'wechat.exe', 'discord.exe', 'adobe%20premiere%20pro.exe', CALC_ID, 'nothere.exe', 'com.google.Chrome'].sort())
    expect(got['chrome.exe']).toBe(got['Chrome.exe'])
    expect(got['chrome.exe']).toContain('data:image/png')
    expect(got['nothere.exe']).toBeNull()
    expect(got['com.google.Chrome']).toBeNull()
    expect(asked.sort()).toEqual([
      CHROME_EXE, 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe', 'C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe',
      'D:\\Tools\\Adobe Premiere Pro.exe', APPS[2].exe, // 便携版和在跑的打包应用:exe 路径来自进程
    ].sort())
    await f.refs.icons(['chrome.exe', 'wechat.exe'])
    expect(asked).toHaveLength(5)
  })

  it('没注入取图标函数 / 取图标失败 / 扫描拿不到:都是 null,不抛', async () => {
    expect(await fake().refs.icons(['chrome.exe'])).toEqual({ 'chrome.exe': null })
    expect(await fake({ fileIcon: async () => { throw new Error('no icon') } }).refs.icons(['chrome.exe'])).toEqual({ 'chrome.exe': null })
    const f = fake({ fileIcon: async () => 'data:x' })
    f.state.raw.installed = new Error('x'); f.state.raw.snapshot = new Error('x')
    expect(await f.refs.icons(['chrome.exe'])).toEqual({ 'chrome.exe': null })
    expect(await f.refs.icons('nope')).toEqual({})
  })
})

describe('已安装应用的缓存', () => {
  it('60 秒内不重扫;过期后先用旧的、后台刷新;刚装的应用点击时现扫一遍', async () => {
    const f = fake()
    await f.refs.list()
    f.tick(30_000)
    await f.refs.list()
    expect(f.ops('installed')).toHaveLength(1)
    f.state.installed = { ...INSTALLED, start: [...INSTALLED.start, { name: 'New App', aumid: 'New.App', target: 'C:\\Program Files\\New\\newapp.exe', args: '' }] }
    f.tick(40_000)
    const stale = await f.refs.list() // 过期:这次还是旧的,后台已经在扫
    expect(stale.apps.some((a) => a.id === 'newapp.exe')).toBe(false)
    expect(f.ops('installed')).toHaveLength(2)
    await new Promise((r) => setTimeout(r, 0))
    f.tick(2_000)
    expect((await f.refs.list()).apps.some((a) => a.id === 'newapp.exe')).toBe(true)
    expect(f.ops('installed')).toHaveLength(2)
  })

  it('缓存里没有的标识:点击时重扫一次再认', async () => {
    const f = fake()
    expect((await f.refs.status([{ kind: 'app', id: 'newapp.exe', name: 'x' }]))[0].state).toBe('missing')
    f.state.installed = { ...INSTALLED, links: [...INSTALLED.links, { name: 'New App', lnk: 'C:\\Start\\New App.lnk', target: 'C:\\Program Files\\New\\newapp.exe', args: '' }] }
    f.tick(10_000)
    expect(await f.refs.open({ kind: 'app', id: 'newapp.exe', name: 'x' })).toEqual({ ok: true, landed: 'app' })
    expect(f.ops('launch')).toEqual([{ op: 'launch', kind: 'lnk', value: 'C:\\Start\\New App.lnk' }])
  })

  it('扫描失败不清掉手上的缓存,一分钟内也不反复重试', async () => {
    const f = fake()
    await f.refs.list()
    f.state.raw.installed = new Error('x')
    f.tick(61_000)
    await f.refs.list()
    await new Promise((r) => setTimeout(r, 0))
    f.tick(5_000)
    const r = await f.refs.list()
    expect(r.apps.some((a) => a.id === 'wechat.exe')).toBe(true)
    expect(f.ops('installed')).toHaveLength(2)
  })
})

describe('createAppRefs 的平台分发', () => {
  it('win32 走这一半(带 icons);不碰 helper', async () => {
    const f = fake()
    const asked: unknown[] = []
    const refs = createAppRefs({
      platform: 'win32', ownPid: 1, home: 'C:\\Users\\me', now: () => 1,
      ask: async (p) => { asked.push(p); throw new Error('no helper on windows') },
      ensureHelper: async () => { asked.push('ensure'); throw new Error('no helper on windows') },
      run: async (_file, _args, opts) => {
        const req = JSON.parse(Buffer.from(opts!.env!.FSN_APPREFS_IN, 'base64').toString('utf8')) as Req
        return frame(req.op === 'snapshot' ? f.state.snapshot : f.state.installed)
      },
    })
    expect('icons' in refs).toBe(true)
    expect((await refs.list()).windows[0]).toEqual({ id: 'chrome.exe', app: 'Google Chrome', title: 'Linear – Pricing - Google Chrome' })
    expect((await refs.status([chromeWin]))[0].state).toBe('live')
    expect(asked).toEqual([])
  })
})

describe('脚本文本的硬约束', () => {
  it('不含反引号 / ${ (String.raw 模板里会出事),长度远小于 Windows 命令行上限,C# 段不用 C# 6 以后的语法糖', () => {
    for (const script of [PS_NATIVE, PS_SHELL]) {
      expect(script).not.toMatch(/`|\$\{/)
      expect(script.length).toBeLessThan(20_000) // CreateProcess 的命令行上限 32767,引号转义后还要留余量
      expect(script).toContain('$env:FSN_APPREFS_IN')
    }
    const cs = /@'\r?\n([\s\S]*?)\r?\n'@/.exec(PS_NATIVE)![1] // Windows 上检出的源码是 CRLF(仓库没钉行尾),脚本里的换行跟着变
    expect(cs).not.toMatch(/\$"|\?\.|=>|\bnameof\(|out var |\bis not\b/)
    expect(cs).not.toMatch(/^'@/m)
  })
})
