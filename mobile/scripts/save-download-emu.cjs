/**
 * P1-DL「存到下载」模拟器台架 —— 真 APK 里经 window.tangu.saveDownload → 原生 ForsionDownloads → MediaStore.Downloads,
 * 判据只认设备这一侧:`content query content://media/external/downloads`(显示名 / 大小 / MIME / 目录)与
 * /sdcard/Download 里文件的 sha256,不认「调用没抛」。
 *
 * 前置(一次;真机或 AVD 都行,本台架只用 adb + CDP):
 *   AVD 已开机(emulator -avd Forsion_API_35 -no-window -no-snapshot-save),adb 在 $ANDROID_HOME/platform-tools
 *   cd mobile && rm -rf dist && VITE_API_ORIGIN=http://localhost:8790 npm run build && npx cap sync android \
 *     && (cd android && ./gradlew :app:assembleDebug) && adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 *   ⚠️ cap sync 会把 android/capacitor.settings.gradle 改写成 node_modules 软链的真实路径 —— 别提交那份改动。
 *
 * 用法:ANDROID_SERIAL=emulator-5640 npm run emu:savedl   (KEEP=1 留下本轮落的文件人工看)
 *
 * 覆盖:普通文本 → 原名落进 Download/、字节逐字一致;同名再存 → MediaStore 去重、回的是实际名;扩展名与 MIME 不一致
 * (data.csv + text/plain)→ 名字不被追加 .txt;带路径 / RTLO / 控制符的名字 → 规整后落在 Download/ 根;~35 MB → 分块
 * 落盘、sha256 一致、进程没死、logcat 无 OOM;51 MB → too_large,设备上什么都不多;传到一半重载页面 → 待定行被收掉
 * (没有残留的 .pending-* 文件)。
 */
const { execFileSync } = require('node:child_process')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const SERIAL = process.env.ANDROID_SERIAL || ''
const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools/adb'), [...(SERIAL ? ['-s', SERIAL] : []), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const PKG = process.env.FORSION_ANDROID_PACKAGE || 'com.forsion.tangu'
const PORT = Number(process.env.HUB_PORT || 8790)
const CDP_PORT = Number(process.env.CDP_PORT || 9354)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b64u = (s) => Buffer.from(s).toString('base64url')
const TOKEN = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ userId: 'u_emu_dl', username: 'u_emu_dl' }))}.emu-sig`
const RUN = `p1dl-${Date.now().toString(36)}`
const EXTEND_ACCEPTANCE = process.env.FORSION_EXTEND_ACCEPTANCE === '1'
if (EXTEND_ACCEPTANCE && (!SERIAL || !PKG.endsWith('.nativepreview'))) throw new Error('Extend acceptance requires an explicit isolated emulator and nativepreview package')
const LEGACY_TEXT = '# Existing local note\n\nPreserve this note through account adoption and relaunch.\n'
const LEGACY_PATH = 'vault/legacy-extend-fixture.md'


// ───── 假 hub:只要让垫片装得上、启动别 401 登出 ─────
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Forsion-Client', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Private-Network': 'true' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  req.resume()
  const p = new URL(req.url, 'http://x').pathname
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)) }
  if (p === '/api/mobile-extend/legacy-content') { res.writeHead(200, { 'Content-Type': 'text/plain', ...cors }); return res.end('Existing native account bytes') }
  if (p === '/api/auth/me') return send(200, { id: 'u_emu_dl', username: 'u_emu_dl' })
  if (p === '/api/auth/refresh') return send(401, { detail: 'emu: no refresh' })
  if (p === '/api/agent/sessions') return send(200, { sessions: [] })
  return send(200, {})
})

// ───── CDP ─────
async function evaluate(expr, timeoutMs = 60000) {
  const pid = adb('shell', 'pidof', PKG).trim()
  if (!pid) throw new Error('app 没在跑')
  adb('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && /localhost/.test(t.url)) || list.find((t) => t.type === 'page')
  if (!page) throw new Error('找不到 WebView 页')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const res = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('求值超时')), timeoutMs)
    ws.onmessage = (msg) => { const d = JSON.parse(msg.data); if (d.id === 1) { clearTimeout(t); resolve(d.result) } }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  return res.result.value
}
const js = (body, ms) => evaluate(`(async () => { ${body} })()`, ms)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${JSON.stringify(detail).slice(0, 800)}`}`)
}

async function boot() {
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`)
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'pm', 'clear', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.MainActivity`)
  await sleep(4000)
  for (let i = 0; i < 30; i++) {
    try {
      if (EXTEND_ACCEPTANCE) await js(`
        await Capacitor.Plugins.Filesystem.writeFile({ path: ${JSON.stringify(LEGACY_PATH)}, directory: 'DATA', data: ${JSON.stringify(LEGACY_TEXT)}, encoding: 'utf8', recursive: true })
        localStorage.setItem('amadeus_vault_mode', 'local')
        localStorage.setItem('amadeus_last_page', 'legacy-extend-fixture.md')
        return true`)
      await evaluate(`Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN)} }).then(() => 'ok')`)
      await evaluate(`localStorage.setItem('forsion_tangu_onboarding_done', '1'), 'ok'`)
      await sleep(1500)
      if (adb('shell', `run-as ${PKG} cat shared_prefs/CapacitorStorage.xml`).includes('forsion_token')) break
    } catch (e) { if (process.env.EMU_DEBUG) console.log('  boot: token step', String(e.message || e).slice(0, 160)) }
    await sleep(1000)
  }
  if (!adb('shell', `run-as ${PKG} cat shared_prefs/CapacitorStorage.xml`).includes('forsion_token')) throw new Error('token 没落进 CapacitorStorage')
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.MainActivity`)
  let last = null
  for (let i = 0; i < 90; i++) {
    try { last = await evaluate('JSON.stringify({ url: location.href, dl: typeof (window.tangu && window.tangu.saveDownload), plugins: typeof window.amadeus?.listPlugins, shell: !!document.querySelector(".mb-shell") })'); if (JSON.parse(last).dl === 'function' && (!EXTEND_ACCEPTANCE || (JSON.parse(last).plugins === 'function' && JSON.parse(last).shell))) return } catch (e) { last = String(e.message || e) }
    await sleep(1000)
  }
  throw new Error(`垫片没装上(window.tangu.saveDownload 缺席):${last}`)
}

/** Downloads 集合里本轮(RUN 前缀)的行。content 的 --where 里单引号要过两层 shell,整条命令交给设备 shell 一次。 */
function rows() {
  const out = adb('shell', `content query --uri content://media/external/downloads --projection _display_name:_size:mime_type:relative_path:is_pending --where "_display_name LIKE '${RUN}%'"`)
  return out.split('\n').filter((l) => l.startsWith('Row:')).map((l) => {
    const o = {}
    for (const m of l.matchAll(/(_display_name|_size|mime_type|relative_path|is_pending)=(.*?)(?=, (?:_display_name|_size|mime_type|relative_path|is_pending)=|$)/g)) o[m[1]] = m[2]
    return o
  })
}
const rowOf = (name) => rows().find((r) => r._display_name === name)
const sha = (name) => adb('shell', 'sha256sum', `'/sdcard/Download/${name}'`).trim().split(/\s+/)[0]
const sdDownload = () => adb('shell', 'ls', '-a', '/sdcard/Download').split('\n').map((s) => s.trim()).filter(Boolean)

async function extendAcceptance() {
  const hash = require('node:crypto').createHash('sha256').update(LEGACY_TEXT).digest('hex')
  const localHash = () => adb('shell', `run-as ${PKG} sha256sum files/${LEGACY_PATH}`).trim().split(/\s+/)[0]
  check('Extend: old local note bytes remain after sign-in', localHash() === hash)
  const actual = await js(`const p = (await window.amadeus.listPlugins()).find(p => p.id === 'forsion-extend'); return { version: p?.version, locked: p?.locked, mobile: window.tangu.extendMobile, pages: await window.amadeus.listPages(), last: localStorage.getItem('amadeus_last_page') }`)
  check('Extend: signed0.9.3 loaded in APK with local vault selection preserved', actual.version === '0.9.3' && actual.locked && actual.mobile && actual.pages.includes('legacy-extend-fixture.md') && actual.last === 'legacy-extend-fixture.md', actual)
  const name = `${RUN}-extend-native.txt`
  const saved = await js(`const r = await window.tangu.account.request('/mobile-extend/legacy-content'); return window.tangu.account.saveDownload(await r.blob(), ${JSON.stringify(name)})`)
  check('Extend: account download reaches native MediaStore with exact bytes', saved?.ok && sha(name) === require('node:crypto').createHash('sha256').update('Existing native account bytes').digest('hex'), saved)
  await js(`window.dispatchEvent(new CustomEvent('forsion:open-settings', { detail: 'forsion/fx:forsion-extend:account-details' })); return true`)
  for (let i = 0; i < 30; i++) { if (await js(`return !!document.querySelector('[data-fx-page="account-details"]')?.textContent.includes('u_emu_dl')`)) break; await sleep(300) }
  const accountUi = await js(`return document.querySelector('[data-fx-page="account-details"]')?.textContent || ''`)
  check('Extend: real account settings renderer works inside Android WebView', accountUi.includes('u_emu_dl'), accountUi.slice(0, 300))
  const shotRoot = path.resolve(__dirname, '../outputs/extend-mobile')
  require('node:fs').mkdirSync(shotRoot, { recursive: true })
  require('node:fs').writeFileSync(path.join(shotRoot, 'android-account.png'), execFileSync(path.join(sdk, 'platform-tools/adb'), ['-s', SERIAL, 'exec-out', 'screencap', '-p']))

  await js(`await window.tangu.forsionLogout(); return true`)
  check('Extend: signing out preserves old local note bytes', localHash() === hash)
  await js(`await Capacitor.Plugins.Preferences.set({ key: 'forsion_token', value: ${JSON.stringify(TOKEN)} }); return true`)
  // Preferences resolves before Android's asynchronous disk flush; verify persistence before killing the process.
  await sleep(1500)
  if (!adb('shell', `run-as ${PKG} cat shared_prefs/CapacitorStorage.xml`).includes('forsion_token')) throw new Error('fixture token not persisted before relaunch')
  adb('shell', 'am', 'force-stop', PKG)
  adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.MainActivity`)
  for (let i = 0; i < 45; i++) { try { if (await js(`return !!window.tangu?.account && !!window.amadeus?.listPlugins`)) break } catch {} await sleep(500) }
  const restored = await js(`return { token: (await Capacitor.Plugins.Preferences.get({ key: 'forsion_token' })).value, mode: localStorage.getItem('amadeus_vault_mode'), last: localStorage.getItem('amadeus_last_page'), pages: await window.amadeus.listPages() }`)
  check('Extend: relaunch preserves token, local mode, selected note and actual file bytes', restored.token === TOKEN && restored.mode === 'local' && restored.last === 'legacy-extend-fixture.md' && restored.pages.includes('legacy-extend-fixture.md') && localHash() === hash, { ...restored, token: restored.token === TOKEN ? '[fixture token preserved]' : '[missing]' })
}

async function run() {
  const pid0 = adb('shell', 'pidof', PKG).trim()

  // ① 普通文本
  const n1 = `${RUN}-report.txt`
  const r1 = await js(`return await window.tangu.saveDownload(${JSON.stringify(n1)}, 'text/plain;charset=utf-8', new Blob(['hello P1-DL\\n']))`)
  const row1 = rowOf(n1)
  check('① 普通文本:回原名、落在 Download/、大小对、MIME text/plain、已不是待定行', r1?.name === n1 && row1 && row1.relative_path === 'Download/' && row1._size === '12' && row1.mime_type === 'text/plain' && row1.is_pending === '0', { r1, row1 })
  check('① 字节逐字一致(sha256)', row1 && sha(n1) === require('node:crypto').createHash('sha256').update('hello P1-DL\n').digest('hex'), sha(n1))

  // ② 同名再存:MediaStore 去重,回的是实际名
  const r2 = await js(`return await window.tangu.saveDownload(${JSON.stringify(n1)}, 'text/plain', new Blob(['second']))`)
  check('② 同名再存:回的是 MediaStore 去重后的实际名(≠ 原名),两份都在', r2 && r2.name !== n1 && r2.name.startsWith(`${RUN}-report`) && r2.name.endsWith('.txt') && !!rowOf(r2.name) && !!rowOf(n1), { r2, rows: rows().map((r) => r._display_name) })

  // ③ 扩展名与 MIME 不一致:名字不被追加 .txt
  const n3 = `${RUN}-data.csv`
  const r3 = await js(`return await window.tangu.saveDownload(${JSON.stringify(n3)}, 'text/plain', new Blob(['a,b\\n1,2\\n']))`)
  const row3 = rowOf(n3)
  check('③ data.csv + text/plain:名字原样(没变成 .csv.txt),MIME 跟扩展名走', r3?.name === n3 && row3 && row3.mime_type !== 'text/plain', { r3, row3, all: rows() })

  // ④ 带路径 / RTLO / 控制符 / FAT 非法字符的名字
  const raw4 = `../../${RUN}-ev‮il\u0007:x.txt`
  const want4 = `${RUN}-evil_x.txt`
  const r4 = await js(`return await window.tangu.saveDownload(${JSON.stringify(raw4)}, 'text/plain', new Blob(['x']))`)
  const row4 = rowOf(want4)
  check('④ 名字规整:只剩最后一段、去掉 RTLO / 控制符、: → _,落在 Download/ 根', r4?.name === want4 && row4 && row4.relative_path === 'Download/', { r4, row4 })

  // ⑤ ~35 MB:分块落盘、sha256 一致、进程没死、logcat 无 OOM
  adb('logcat', '-c')
  const n5 = `${RUN}-big.zip`
  const big = await js(`
    const n = 35 * 1024 * 1024, buf = new Uint8Array(n)
    let x = 12345; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; buf[i] = x >>> 24 }
    const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('')
    const t0 = performance.now()
    const r = await window.tangu.saveDownload(${JSON.stringify(n5)}, 'application/zip', new Blob([buf]))
    return { r, h, ms: Math.round(performance.now() - t0) }`, 180000)
  const row5 = rowOf(n5)
  const pid5 = adb('shell', 'pidof', PKG).trim()
  const oom = adb('logcat', '-d', '-b', 'main,crash').split('\n').filter((l) => /OutOfMemory|FATAL EXCEPTION/.test(l))
  check(`⑤ 35 MB:落盘 ${row5?._size} 字节、sha256 一致(${big?.ms} ms)`, big?.r?.name === n5 && row5 && Number(row5._size) === 35 * 1024 * 1024 && sha(n5) === big.h, { big, row5 })
  check('⑤ 35 MB:进程还是同一个、logcat 无 OOM / FATAL', pid5 && pid5 === pid0 && oom.length === 0, { pid0, pid5, oom: oom.slice(0, 5) })

  // ⑥ 51 MB:too_large,设备上什么都不多
  const before6 = rows().length
  const r6 = await js(`
    try { await window.tangu.saveDownload(${JSON.stringify(`${RUN}-huge.bin`)}, '', new Blob([new Uint8Array(51 * 1024 * 1024)])); return { ok: true } }
    catch (e) { return { ok: false, code: e.code, msg: String(e.message) } }`, 120000)
  check('⑥ 51 MB:拒绝(code=too_large),Downloads 里没多出任何行', r6 && r6.ok === false && r6.code === 'too_large' && rows().length === before6, { r6, before6, after: rows().length })

  // ⑦ 传到一半重载页面:待定行被收掉(没有残留的 .pending-* 文件,也没有半截文件)
  const n7 = `${RUN}-half.bin`
  await js(`
    const P = Capacitor.Plugins.ForsionDownloads
    const { id } = await P.begin({ name: ${JSON.stringify(n7)}, mime: 'application/octet-stream', size: 3 * 1024 * 1024 })
    await P.append({ id, data: btoa(String.fromCharCode(...new Uint8Array(3000))) })
    return id`)
  const pendingBefore = sdDownload().filter((f) => f.includes(n7))
  await evaluate('setTimeout(() => location.reload(), 50), 1').catch(() => 0)
  let pendingAfter = null
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    pendingAfter = sdDownload().filter((f) => f.includes(n7))
    if (pendingAfter.length === 0) break
  }
  check('⑦ 传到一半重载:重载前有待定文件、重载后被收掉(无 .pending-*、无半截文件)', pendingBefore.length === 1 && /^\.pending-/.test(pendingBefore[0]) && pendingAfter.length === 0, { pendingBefore, pendingAfter })

  console.log('\n设备上本轮的 Downloads 行:')
  for (const r of rows()) console.log(`  ${JSON.stringify(r)}`)
  console.log(adb('shell', 'ls', '-l', '/sdcard/Download').split('\n').filter((l) => l.includes(RUN)).map((l) => `  ${l}`).join('\n'))
  // 收尾:本轮落下的文件删掉(AVD 的 /sdcard 跨次开机都在);KEEP=1 留着人工看
  if (!process.env.KEEP) {
    adb('shell', `content delete --uri content://media/external/downloads --where "_display_name LIKE '${RUN}%'"`)
    for (const f of sdDownload().filter((x) => x.includes(RUN))) adb('shell', 'rm', '-f', `'/sdcard/Download/${f}'`)
  }
}

;(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
  try {
    await boot()
    if (EXTEND_ACCEPTANCE) await extendAcceptance()
    await run()
  } catch (e) {
    check('harness', false, e.message)
  }
  server.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
