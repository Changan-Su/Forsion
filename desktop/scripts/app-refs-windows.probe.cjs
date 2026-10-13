/**
 * 应用 / 窗口引用 · Windows 真机探针:对着这台机器真跑 electron/appRefsWin.ts(本机 macOS 跑不了那两段 PowerShell)。
 *
 * 做法:esbuild 现打包 appRefsWin.ts → 用和 main.ts 同款的 execFile 选项起真的 PowerShell →
 *   ① 已安装应用的三路来源各扫到多少(AppsFolder / 开始菜单 .lnk / App Paths),AppsFolder 给不给快捷方式目标;
 *   ② 起记事本(标题带一次性口令)和一扇自己的 WinForms 窗口 → 列得出来、形状对、标识合法且不是 ApplicationFrameHost;
 *   ③ 状态五种里的四种(live / running / closed / missing)+ macOS 来的标识;
 *   ④ 点击:提窗口后**另起一个 PowerShell 读 GetForegroundWindow** 核对(不信后端自己报的);最小化后再提要还原;
 *      窗口改了标题仍认得(这次运行里记过的那一扇);应用引用在窗口开着时只切不多开;
 *   ⑤ 关掉 → closed / idle;按标识启动 → 窗口出现;关掉自己的窗口 → closed。
 * 只打印字段名、数量和自己建的那两扇窗口的标题,不打印机器上别的窗口 / 应用的名字。
 *
 * 用法(仅 Windows):node scripts/app-refs-windows.probe.cjs
 * 由 .github/workflows/probe-app-refs-windows.yml 调用。结果:outputs/app-refs-windows/results.json。
 * 测不到的(要人在真桌面上点):见该 workflow 头注释里列的那几项。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile, execFileSync, spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'outputs', 'app-refs-windows')
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const TOKEN = crypto.randomBytes(4).toString('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  return !!ok
}
async function until(fn, timeout = 30_000, interval = 500) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await sleep(interval)
  }
}

function loadBackend() {
  const { buildSync } = require('esbuild')
  const src = buildSync({ entryPoints: [path.join(ROOT, 'electron', 'appRefsWin.ts')], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs' }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require)
  return mod.exports
}

// ── 和 main.ts 里那个 run 同款的选项(windowsHide、环境变量并进去、不经 shell);多记一份耗时和失败时的 stderr ──
const timings = []
const run = (file, args, opts) => new Promise((resolve, reject) => {
  let op = '?'
  try { op = JSON.parse(Buffer.from(opts.env.FSN_APPREFS_IN, 'base64').toString('utf8')).op } catch { /* 不是后端的调用 */ }
  const t0 = Date.now()
  execFile(file, args, { timeout: opts?.timeoutMs ?? 8_000, maxBuffer: 4 << 20, windowsHide: true, ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}) }, (err, stdout, stderr) => {
    timings.push({ op, ms: Date.now() - t0, ok: !err })
    if (err) {
      console.log(`  [powershell ${op} failed after ${Date.now() - t0}ms] ${String(err.message).split('\n')[0].slice(0, 200)}`)
      const tail = String(stderr || '').trim().split(/\r?\n/).slice(0, 12).join('\n    ')
      if (tail) console.log(`    ${tail}`)
      reject(err)
    } else resolve(String(stdout))
  }).stdin?.end()
})

// ── 独立于后端的观测 / 摆布:前台窗口是谁、某个句柄还在不在 / 是不是最小化;最小化它、改它的标题 ──
const NATIVE = `
Add-Type -IgnoreWarnings -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FsnProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr h, string s);
}
'@
$h = [IntPtr][long]$env:FSN_PROBE_HWND
if ($env:FSN_PROBE_CMD -eq 'min') { [void][FsnProbe]::ShowWindow($h, 6) }
if ($env:FSN_PROBE_CMD -eq 'title') { [void][FsnProbe]::SetWindowTextW($h, $env:FSN_PROBE_TEXT) }
[Console]::Out.Write((@{ fg = [FsnProbe]::GetForegroundWindow().ToInt64(); iconic = [FsnProbe]::IsIconic($h); alive = [FsnProbe]::IsWindow($h) } | ConvertTo-Json -Compress))
`
function native(hwnd, cmd = '', text = '') {
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', NATIVE.replace(/\r?\n/g, '\r\n')],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, FSN_PROBE_HWND: String(hwnd || 0), FSN_PROBE_CMD: cmd, FSN_PROBE_TEXT: text } })
  return JSON.parse(out.trim())
}
/** 标题里带口令的进程(系统自己报的 pid / 主窗口句柄,不经后端)。口令是本脚本生成的十六进制串。 */
function processByTitle(needle) {
  const out = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
    `ConvertTo-Json -Compress -InputObject @(Get-Process | Where-Object { $_.MainWindowTitle -like '*${needle}*' } | ForEach-Object { @{ pid = $_.Id; hwnd = $_.MainWindowHandle.ToInt64() } })`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  return JSON.parse(out.trim() || '[]')
}
const kill = (pid) => { try { process.kill(pid) } catch { /* 已经没了 */ } }

async function main() {
  if (process.platform !== 'win32') { console.error('This probe requires Windows'); process.exit(2) }
  fs.mkdirSync(OUT, { recursive: true })
  const backend = loadBackend()
  const { PS_NATIVE, PS_SHELL, parseWinInstalled, parseWinSnapshot, resolveWinView, buildWinIndex, canonWinId, createWinAppRefs } = backend
  const refs = createWinAppRefs({ ownPid: process.pid, run, fileIcon: async (p) => (fs.existsSync(p) ? 'data:probe' : null) })
  const ps = (script, req, timeoutMs) => run(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script.replace(/\r?\n/g, '\r\n')],
    { env: { FSN_APPREFS_IN: Buffer.from(JSON.stringify(req), 'utf8').toString('base64') }, timeoutMs })
  const rawView = async () => resolveWinView(parseWinSnapshot(await ps(PS_NATIVE, { op: 'snapshot', own: process.pid }, 20_000)))
  const spawned = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-appref-'))

  console.log(`os ${os.release()} | node ${process.version} | script chars: native ${PS_NATIVE.length}, shell ${PS_SHELL.length}`)
  try {
    const n = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString() + " | appx packages: " + @(Get-AppxPackage -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim()
    console.log(`powershell ${n}`)
  } catch (e) { console.log(`powershell info unavailable: ${String(e.message).split('\n')[0]}`) }

  try {
    // 这个探针会起、也会杀记事本:机器上已经开着记事本就不跑(新版记事本是一个进程管所有窗口,杀了会连带关掉别人的)
    const isNotepad = (id) => id === 'notepad.exe' || id.startsWith('microsoft.windowsnotepad_')
    if ((await rawView()).windows.some((w) => isNotepad(w.id))) { console.error('Close Notepad first: this probe starts and kills Notepad.'); process.exit(2) }

    // ── ① 已安装应用:三路来源 ──
    const installedRaw = parseWinInstalled(await ps(PS_SHELL, { op: 'installed' }, 60_000).catch(() => null))
    if (check('installed scan returns a readable frame', !!installedRaw)) {
      const withTarget = installedRaw.start.filter((s) => /\.exe$/i.test(s.target)).length
      const packaged = installedRaw.start.filter((s) => backend.isPackagedAumid(s.aumid)).length
      console.log(`  sources: start=${installedRaw.start.length} (exe target=${withTarget}, packaged=${packaged}), links=${installedRaw.links.length}, appPaths=${installedRaw.paths.length}, errors=${JSON.stringify(installedRaw.errors)}`)
      check('AppsFolder lists Start-menu apps', installedRaw.start.length > 0, installedRaw.start.length)
      check('AppsFolder items expose System.Link.TargetParsingPath for classic apps', withTarget > 0, withTarget)
      check('Start-menu .lnk scan resolves targets', installedRaw.links.some((l) => /\.exe$/i.test(l.target)), installedRaw.links.length)
      check('App Paths registry is readable', installedRaw.paths.length > 0, installedRaw.paths.length)
      check('no source reported an error', installedRaw.errors.length === 0, installedRaw.errors)
      const index = buildWinIndex(installedRaw)
      const listed = [...index.values()].filter((a) => a.listed)
      console.log(`  index: ${index.size} ids (${listed.length} listed; launch kinds: ${JSON.stringify(listed.reduce((m, a) => ({ ...m, [a.launch.kind]: (m[a.launch.kind] || 0) + 1 }), {}))}; with icon path: ${listed.filter((a) => a.icon).length})`)
      check('index has launchable apps', listed.length > 0, listed.length)
    }

    // ── ② 起两扇自己的窗口 ──
    const fileA = path.join(tmp, `fsn-appref-a-${TOKEN}.txt`)
    fs.writeFileSync(fileA, '')
    const tokenA = `fsn-appref-a-${TOKEN}`
    const titleB = `fsn-appref-b-${TOKEN}`
    spawn('notepad.exe', [fileA], { detached: true, stdio: 'ignore' }).unref()
    const formB = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = $env:FSN_PROBE_TITLE; $f.Width = 480; $f.Height = 320; $f.ShowInTaskbar = $true; [System.Windows.Forms.Application]::Run($f)'],
    // 不带 windowsHide:那个开关是让进程的**第一次 ShowWindow 按隐藏处理**,窗体会跟着控制台一起看不见(第一次真跑就栽在这:列不出这扇窗口)
    { stdio: 'ignore', env: { ...process.env, FSN_PROBE_TITLE: titleB } })
    spawned.push(formB.pid)

    let list = null
    const both = await until(async () => {
      list = await refs.list()
      return list.windows.some((w) => w.title.includes(tokenA)) && list.windows.some((w) => w.title === titleB)
    }, 60_000, 1_000)
    console.log(`  list: windows=${list.windows.length}, apps=${list.apps.length} (running=${list.apps.filter((a) => a.running).length}), error=${list.error ?? 'none'}`)
    console.log(`  window fields: ${Object.keys(list.windows[0] || {}).join(',')} | app fields: ${Object.keys(list.apps[0] || {}).join(',')}`)
    check('list has no error', !list.error, list.error)
    check('both probe windows are listed', both, { notepad: list.windows.some((w) => w.title.includes(tokenA)), form: list.windows.some((w) => w.title === titleB) })
    check('window shape {id, app, title} with canonical ids', list.windows.length > 0 && list.windows.every((w) => typeof w.app === 'string' && typeof w.title === 'string' && w.title && canonWinId(w.id) === w.id))
    check('app shape {id, name, running} with canonical ids', list.apps.length > 0 && list.apps.every((a) => typeof a.name === 'string' && a.name && typeof a.running === 'boolean' && canonWinId(a.id) === a.id))
    check('nothing is attributed to ApplicationFrameHost', ![...list.windows, ...list.apps].some((x) => /applicationframehost/i.test(x.id)))
    check('running apps come first', list.apps.findIndex((a) => !a.running) === -1 || list.apps.slice(list.apps.findIndex((a) => !a.running)).every((a) => !a.running))
    const kinds = list.windows.reduce((m, w) => { const k = w.id.includes('%21') ? 'aumid' : 'exe'; return { ...m, [k]: (m[k] || 0) + 1 } }, {})
    console.log(`  window id kinds: ${JSON.stringify(kinds)}`)
    if (!both) throw new Error('probe windows did not appear; cannot continue')

    const winA = list.windows.find((w) => w.title.includes(tokenA))
    const winB = list.windows.find((w) => w.title === titleB)
    console.log(`  A: id=${winA.id} app=${winA.app} title=${winA.title}`)
    console.log(`  B: id=${winB.id} app=${winB.app} title=${winB.title}`)
    check('own WinForms window is owned by powershell.exe', winB.id === 'powershell.exe', winB.id)
    check('Notepad id is an exe name or a packaged AUMID', winA.id === 'notepad.exe' || /^microsoft\.windowsnotepad_[a-z0-9]{13}%21/.test(winA.id), winA.id)
    check('window owner apps are listed as running under the same id', [winA, winB].every((w) => list.apps.some((a) => a.id === w.id && a.running)))

    const sysA = processByTitle(tokenA)[0]
    const sysB = processByTitle(titleB)[0]
    check('system reports a main window for both', !!sysA && !!sysB, { a: !!sysA, b: !!sysB })
    spawned.push(sysA?.pid)
    const view = await rawView()
    const rawA = view.windows.find((w) => w.title.includes(tokenA))
    const rawB = view.windows.find((w) => w.title === titleB)
    check('hwnd / pid match what the system reports', rawA?.hwnd === sysA?.hwnd && rawA?.pid === sysA?.pid && rawB?.hwnd === sysB?.hwnd && rawB?.pid === sysB?.pid,
      { a: [rawA?.hwnd === sysA?.hwnd, rawA?.pid === sysA?.pid], b: [rawB?.hwnd === sysB?.hwnd, rawB?.pid === sysB?.pid] })
    check('own process windows are excluded', !view.windows.some((w) => w.pid === process.pid))
    console.log(`  raw view: windows=${view.windows.length} (off-desktop=${view.windows.filter((w) => !w.onScreen).length}, minimized=${view.windows.filter((w) => w.min).length}, untitled=${view.windows.filter((w) => !w.title).length}), running ids=${view.running.size}`)

    const refA = { kind: 'window', id: winA.id, name: winA.title }
    const refB = { kind: 'window', id: winB.id, name: winB.title }
    const appA = { kind: 'app', id: winA.id, name: winA.app }

    // ── ③ 状态 ──
    const states = async (list_) => (await refs.status(list_)).map((s) => s.state)
    // 状态类的检查都留重试余量:某一次 PowerShell 超时后,后端 15 秒内不再重起(那段时间窗口一律报 closed),不该算成红
    const settles = async (list_, want) => {
      let got = null
      const ok = await until(async () => { got = await states(list_); return JSON.stringify(got) === JSON.stringify(want) }, 25_000, 1_500)
      return { ok: !!ok, got }
    }
    const st = await settles([refA, refB, appA, { kind: 'window', id: winA.id, name: `no-such-window-${TOKEN}` },
      { kind: 'app', id: `fsn-not-installed-${TOKEN}.exe`, name: 'x' }, { kind: 'app', id: 'com.apple.finder', name: 'Finder' }], ['live', 'live', 'running', 'closed', 'missing', 'missing'])
    check('status: live / live / running / closed / missing / missing', st.ok, st.got)
    const icons = await refs.icons([winA.id, winB.id, `fsn-not-installed-${TOKEN}.exe`])
    check('icons: both ids resolve to an existing exe path; unknown id is null', icons[winA.id] === 'data:probe' && icons[winB.id] === 'data:probe' && icons[`fsn-not-installed-${TOKEN}.exe`] === null, icons)

    // ── ④ 点击 ──
    const front = await refs.frontmost()
    check('frontmost returns a reference shape', !!front && (front.kind === 'window' || front.kind === 'app') && canonWinId(front.id) === front.id, front && { kind: front.kind, ours: front.name.includes(TOKEN) })

    const openAndObserve = async (label, ref, sys, landed) => {
      const r = await refs.open(ref)
      const seen = await until(() => { const n = native(sys.hwnd); return n.fg === sys.hwnd && !n.iconic ? n : null }, 5_000, 300)
      return check(`open ${label}: backend says landed=${landed} and the system foreground window is it`, r.ok && r.landed === landed && !!seen, { result: r, foreground: !!seen })
    }
    await openAndObserve('window B', refB, sysB, 'window')
    await openAndObserve('window A', refA, sysA, 'window')
    await openAndObserve('window B again (from behind A)', refB, sysB, 'window')

    check('minimize A (system call) took effect', native(sysA.hwnd, 'min').alive && (await until(() => native(sysA.hwnd).iconic, 5_000, 300)))
    await sleep(1_200) // 让后端那份 1 秒内复用的快照过期
    check('status: minimized window is still live', (await settles([refA], ['live'])).ok)
    await openAndObserve('minimized window A (restores it)', refA, sysA, 'window')

    // 标题变了:B 是 list() 时记过的那一扇 —— 标题全变(对不上任何相近规则)仍认得、仍提得上来
    const renamed = `fsn-renamed-${TOKEN}`
    native(sysB.hwnd, 'title', renamed)
    check('title change took effect', await until(async () => (await rawView()).windows.some((w) => w.hwnd === sysB.hwnd && w.title === renamed), 10_000, 500))
    await sleep(1_200)
    check('status: remembered window is live after its title changed', (await settles([refB], ['live'])).ok)
    await openAndObserve('window A (to move away from B)', refA, sysA, 'window')
    await openAndObserve('window B by its old title', refB, sysB, 'window')

    // 应用引用:窗口开着 → 只切过去,不多开
    const countA = async () => (await rawView()).windows.filter((w) => w.id === winA.id).length
    const before = await countA()
    await openAndObserve('app A while its window is open (switches, does not launch)', appA, sysA, 'app')
    await sleep(1_500)
    check('no extra window was opened', (await countA()) === before, { before, after: await countA() })

    // ── ⑤ 关掉 → 状态翻转;按标识启动 ──
    kill(sysA.pid)
    check('A is gone (system)', await until(() => !native(sysA.hwnd).alive, 15_000, 500))
    const closed = await until(async () => { const s = await states([refA, appA]); return s[0] === 'closed' && s[1] === 'idle' ? s : null }, 20_000, 1_500)
    check('status after closing: window closed, app idle (still known on this machine)', !!closed, closed || await states([refA, appA]))

    const launched = await refs.open(appA)
    check('open app A when not running: launched', launched.ok && launched.landed === 'app', launched)
    const back = await until(async () => (await rawView()).windows.find((w) => w.id === winA.id), 30_000, 1_000)
    check('a window of app A appeared after launch', !!back)
    if (back) spawned.push(back.pid)
    await sleep(1_200)
    check('status after launch: app running', (await settles([appA], ['running'])).ok)
    check('window reference to the closed window falls back to the app', await (async () => { const r = await refs.open(refA); return r.ok && (r.landed === 'app' || r.landed === 'window') })())

    const bad = await refs.open({ kind: 'app', id: `fsn-not-installed-${TOKEN}.exe`, name: 'x' })
    check('open unknown id: not_installed', !bad.ok && bad.error === 'not_installed', bad)

    kill(formB.pid)
    check('B is gone (system)', await until(() => !native(sysB.hwnd).alive, 15_000, 500))
    const closedB = await until(async () => ((await states([refB]))[0] === 'closed'), 20_000, 1_500)
    check('status after closing B: closed', closedB)
  } catch (e) {
    check('probe ran to the end', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  } finally {
    try { for (const w of (await rawView()).windows.filter((x) => x.title.includes(TOKEN))) kill(w.pid) } catch { /* 尽力 */ }
    for (const pid of spawned) if (pid) kill(pid)
    fs.rmSync(tmp, { recursive: true, force: true })
    const byOp = {}
    for (const t of timings) (byOp[t.op] ||= []).push(t.ms)
    const summary = Object.fromEntries(Object.entries(byOp).map(([op, ms]) => { ms.sort((a, b) => a - b); return [op, { n: ms.length, median: ms[ms.length >> 1], max: ms[ms.length - 1] }] }))
    console.log(`  powershell timings (ms): ${JSON.stringify(summary)} | failed calls: ${timings.filter((t) => !t.ok).length}`)
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ os: os.release(), results, timings: summary }, null, 2))
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
  process.exitCode = failed.length ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
