/**
 * 首次本机确认弹框的真 Electron 仪器(P1 · K4 §6「dev Electron 里的首次确认弹框」):
 *   真 electron/remoteSessions.ts(esbuild 现打成 CJS)+ 与 main.ts 同一段 confirm(挂父窗的 showMessageBox + signal)+ 真 Electron。
 * 判据:
 *   D1 未受信设备请求会话档 → 闸当场 403 pending,弹框(文案按主进程语言、名字取名册 registeredName)
 *   D2 弹框开着时主循环不冻:同进程的 loopback HTTP 服务(= unitWeb 所在的那个事件循环)照常应答,5 次均 < 500ms
 *   D3 关掉开关 → signal 真关框(showMessageBox 以取消收尾、aborted=true),待确认清空、不落信任
 *   D4 「本账号的浏览器与网页版」那一种(en)同样弹、同样可被 TTL / 关开关收掉
 * 截图(macOS screencapture,需终端有「屏幕录制」权限;没有就跳过截图、判据照跑):$RS_DIALOG_SHOTS 或 $TMPDIR/forsion-remote-sessions-dialog/。
 *
 * 跑:node scripts/remote-sessions-dialog.electron.cjs
 *     (Electron 台架规矩:先 node <repo>/.claude/hooks/devlock.cjs acquire --vehicle=e2e;本脚本只杀自己拉起的那个 PID)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-rs-dialog-'))
const shots = process.env.RS_DIALOG_SHOTS || path.join(os.tmpdir(), 'forsion-remote-sessions-dialog')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`) }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 把真控制器打成 CJS(electron 外置)──
const entry = path.join(work, 'entry.ts')
fs.writeFileSync(entry, `export { createRemoteSessions, confirmDialogOptions } from ${JSON.stringify(path.join(ROOT, 'electron/remoteSessions.ts'))}\nexport { setMainLocale } from ${JSON.stringify(path.join(ROOT, 'electron/mainI18n.ts'))}\n`)
const bundle = path.join(work, 'rs.cjs')
const esb = spawnSync(path.join(ROOT, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${bundle}`], { encoding: 'utf8' })
if (esb.status !== 0) { console.error(esb.stderr); process.exit(2) }

// ── 2. Electron 主进程脚本(confirm 与 main.ts 逐行同构)──
const mainJs = path.join(work, 'main.cjs')
fs.writeFileSync(mainJs, `
const { app, BrowserWindow, dialog } = require('electron')
const http = require('http')
app.setPath('userData', ${JSON.stringify(path.join(work, 'userdata'))})
const rsMod = require(${JSON.stringify(bundle)})
rsMod.setMainLocale(process.env.RS_LANG || 'zh')
const emit = (o) => process.stdout.write('@@' + JSON.stringify(o) + '\\n')
let win = null
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 860, height: 600, title: 'Forsion', backgroundColor: '#f7f6f3' })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="font:14px -apple-system,sans-serif;padding:48px;background:#f7f6f3;color:#2b2b2b"><h2>Forsion</h2><p>P1-K4 remote session prompt harness</p></body>'))
  win.focus()
  const server = http.createServer((q, s) => s.end('pong')).listen(0, '127.0.0.1', () => emit({ port: server.address().port }))
  let disk = JSON.stringify({ v: 1, enabled: true, migratedFromUnitHost: false, trusted: [] })
  const rs = rsMod.createRemoteSessions({
    file: () => '/nonexistent/remote-sessions.json', unitHostEnabled: async () => true,
    readCap: async () => 'auto-edit', writeCap: async () => {},
    accountId: () => 'https://cloud.test::u1',
    lookupUnit: async () => ({ name: '小米 14(改过名)', registeredName: '小米 14', kind: 'phone', platform: 'android', createdAt: '2026-09-20T08:00:00.000Z' }),
    confirm: async (opts, signal) => {
      const w = win && !win.isDestroyed() ? win : null
      if (!w) return null
      emit({ dialog: 'open', message: opts.message, detail: opts.detail, buttons: opts.buttons })
      // RS_NOPARENT=1 只给负对照用:不挂父窗 = mac 上 app-modal、冻住主循环(D2 必红)
      const r = process.env.RS_NOPARENT === '1' ? await dialog.showMessageBox({ ...opts, signal }) : await dialog.showMessageBox(w, { ...opts, signal })
      emit({ dialog: 'closed', response: r.response, aborted: signal.aborted })
      return signal.aborted ? null : r.response === 0
    },
    permitted: () => true, isLocked: () => false,
    onChanged: (v) => emit({ view: { enabled: v.enabled, pending: v.pending.length, trusted: v.trusted.length } }),
    log: (m) => emit({ log: m }),
    readFile: async () => disk, writeFile: async (_f, d) => { disk = JSON.stringify(d) },
  })
  await rs.init()
  const PHONE = { kind: 'unit', caller: { unit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', kind: 'phone', name: '断言里的名字', platform: 'android', registeredAt: '2026-09-20T08:00:00.000Z' } }
  process.stdin.on('data', async (buf) => {
    for (const cmd of buf.toString().split('\\n').filter(Boolean)) {
      if (cmd === 'unit' || cmd === 'account') {
        const g = rs.gate.gateEngine({ method: 'POST', path: '/agent/runs', via: 'tunnel', caller: cmd === 'unit' ? PHONE : { kind: 'account' } })
        emit({ gate: g.ok ? 'ok' : g.body })
      } else if (cmd === 'off') { await rs.setEnabled(false); emit({ off: true, disk: JSON.parse(disk) }) }
      else if (cmd === 'on') { await rs.setEnabled(true); emit({ on: true }) }
      else if (cmd === 'bounds') { emit({ bounds: win.getBounds() }) }
      else if (cmd.startsWith('shot ')) {
        // 屏幕截图裁到窗口(sheet 是挂在窗口上的子窗,单截窗口截不到它):需要 Electron 自己有「屏幕录制」权限,没有就回 null
        try {
          const { desktopCapturer, screen } = require('electron')
          const b = win.getBounds()
          const d = screen.getDisplayMatching(b)
          const sf = d.scaleFactor
          const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width * sf, height: d.size.height * sf } })
          const src = srcs.find((x) => String(x.display_id) === String(d.id)) || srcs[0]
          const img = src && !src.thumbnail.isEmpty() ? src.thumbnail.crop({ x: Math.round((b.x - d.bounds.x) * sf), y: Math.round((b.y - d.bounds.y) * sf), width: Math.round(b.width * sf), height: Math.round(b.height * sf) }) : null
          if (img && !img.isEmpty()) { require('fs').writeFileSync(cmd.slice(5), img.toPNG()); emit({ shot: cmd.slice(5) }) } else emit({ shot: null, sources: srcs.length })
        } catch (e) { emit({ shot: null, err: String(e && e.message || e) }) }
      }
      else if (cmd === 'quit') { app.exit(0) }
    }
  })
  emit({ ready: true })
})
`)

async function run(lang, kind) {
  const electronBin = require(path.join(ROOT, 'node_modules/electron'))
  const child = spawn(electronBin, [mainJs, '-ApplePersistenceIgnoreState', 'YES'], { env: { ...process.env, RS_LANG: lang, ELECTRON_ENABLE_LOGGING: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (line.startsWith('@@')) { try { events.push(JSON.parse(line.slice(2))) } catch { /* 半行 */ } }
    }
  })
  child.stderr.on('data', () => {})
  const waitFor = async (pred, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(pred); if (e) return e; await pause(50) } return null }
  const send = (c) => child.stdin.write(c + '\n')
  const tag = `${lang}-${kind}`
  try {
    const ready = await waitFor((e) => e.ready)
    const { port } = (await waitFor((e) => e.port)) || {}
    check(`${tag}: 真 Electron 起来了`, !!ready && !!port)
    send(kind)
    const gate = await waitFor((e) => e.gate)
    check(`${tag} D1: 闸当场 403 REMOTE_CALLER_UNCONFIRMED{pending}(不等弹框)`, gate?.gate?.code === 'REMOTE_CALLER_UNCONFIRMED' && gate.gate.state === 'pending', gate)
    const open = await waitFor((e) => e.dialog === 'open')
    check(`${tag} D1: 弹出确认框`, !!open, open?.message)
    if (kind === 'unit') check(`${tag} D1: 名字取名册 registeredName,不用断言自报 / 可改的 name`, /小米 14/.test(open?.message || '') && !/改过名|断言里的名字/.test(open?.message || ''), open?.message)
    if (lang === 'en') check(`${tag} D1: en 文案无汉字`, !/[一-鿿]/.test(JSON.stringify([open?.message, open?.buttons])) , open)
    await pause(900) // sheet 动画落定
    if (process.env.RS_HOLD_MS) { console.log(`  弹框保持 ${process.env.RS_HOLD_MS}ms(手动 / computer-use 截图)`); await pause(Number(process.env.RS_HOLD_MS)) }
    // D2:弹框开着,同进程 HTTP 照常应答
    const lat = []
    for (let n = 0; n < 5; n++) {
      const t0 = Date.now()
      const ok = await new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (s) => { s.resume(); s.on('end', () => r(true)) }); q.on('timeout', () => { q.destroy(); r(false) }); q.on('error', () => r(false)) })
      lat.push(ok ? Date.now() - t0 : -1)
      await pause(150)
    }
    check(`${tag} D2: 弹框期间主循环不冻(loopback HTTP 5/5 应答且 < 500ms)`, lat.every((x) => x >= 0 && x < 500), lat)
    const file = path.join(shots, `${tag}.png`)
    send(`shot ${file}`)
    const shot = await waitFor((e) => 'shot' in e, 8000)
    if (shot?.shot) console.log(`  截图:${shot.shot}`)
    else {
      send('bounds')
      const b = (await waitFor((e) => e.bounds))?.bounds
      const sc = b && process.platform === 'darwin' ? spawnSync('screencapture', ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, file], { encoding: 'utf8' }) : null
      console.log(sc?.status === 0 && fs.existsSync(file) ? `  截图:${file}` : `  (截图跳过:没有屏幕录制权限 —— ${JSON.stringify(shot)} / ${(sc?.stderr || '').trim()})`)
    }
    // D3:关开关 → signal 真关框,结果丢弃
    send('off')
    const closed = await waitFor((e) => e.dialog === 'closed')
    const off = await waitFor((e) => e.off)
    check(`${tag} D3: 关开关 → signal 关框(aborted),不落信任`, !!closed && closed.aborted === true && off?.disk?.trusted?.length === 0 && off?.disk?.enabled === false, { closed, disk: off?.disk })
  } finally {
    send('quit')
    await pause(500)
    try { process.kill(child.pid, 'SIGKILL') } catch { /* 已退 */ }
  }
}

;(async () => {
  await run('zh', 'unit')
  await run('en', 'account')
  const fails = results.filter((r) => !r.ok).length
  console.log(fails ? `\n❌ ${fails} 条未过` : `\n✅ 全部通过 —— 截图:${shots}`)
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
