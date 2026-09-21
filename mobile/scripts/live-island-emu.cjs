/**
 * 灵动岛模拟器台架(2026-09-18)—— 真机/模拟器上跑着 debug 包时用:
 *   node scripts/live-island-emu.cjs eval "<js 表达式,可 await>"   在 app 的 WebView 里求值
 *   node scripts/live-island-emu.cjs notif                         只看活动通知里 id=7201 那条(没有就打 ABSENT)
 *   PKG=com.forsion.tangu.islandtest node scripts/…               换包名(真机上与正式版并存的测试包)
 *
 * 例:node scripts/live-island-emu.cjs eval "Capacitor.Plugins.LiveIsland.show({ title: 't', text: 'x', chip: '', since: Date.now(), sessionId: 's', channelName: 'c', more: 0 })"
 * 要驱动真 store(__forsionStore):`rm -rf dist && NODE_ENV=development npx vite build --mode development && npx cap copy android` 再出 debug 包;
 * 测完 `rm -rf dist && npm run build` 恢复。服务 / 冻结状态:`adb shell dumpsys activity services com.forsion.tangu`、`adb logcat | grep "freezing <pid>"`。
 *
 * 踩过的坑(都已在下面处理):
 *  - 只连 `attached=true` 的页:首启若发生 Activity 重建会多出一个旧页,往它发插件调用会落到「Handler on a dead thread」。
 *  - Playwright 的 connectOverCDP 对安卓 WebView 报错(不支持 browser context 管理),这里用原始 CDP。
 *  - dumpsys notification 只看「Notification List:」段,整段 grep 会混进别的记录。
 */
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
// 真机上 dumpsys notification 动辄几 MB,默认 1MB 缓冲会 ENOBUFS
const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools/adb'), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const PORT = 9339
const PKG = process.env.PKG || 'com.forsion.tangu'

async function evaluate(expr) {
  const pid = adb('shell', 'pidof', PKG).trim()
  if (!pid) throw new Error('app 没在跑')
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page' && JSON.parse(t.description || '{}').attached)
  if (!page) throw new Error('找不到 attached 的 WebView 页')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const res = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('求值超时(promise 一直没落地?)')), 15000)
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(t); resolve(d.result) } }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  return res.result.value
}

function notif() {
  const out = adb('shell', 'dumpsys', 'notification', '--noredact').split('\n')
  const start = out.findIndex((l) => l.startsWith('  Notification List:'))
  const rows = []
  let mine = false
  for (const l of out.slice(start + 1)) {
    if (/^ {2}\S/.test(l)) break
    if (l.includes('NotificationRecord(')) mine = l.includes(`pkg=${PKG} `) && l.includes('id=7201')
    if (mine && /importance=|^\s*flags=|android\.(title|text|subText|requestPromotedOngoing|shortCriticalText|showChronometer)=/.test(l)) rows.push(l.trim().replace(/^NotificationRecord\(.*?(importance=\d).*/, 'record $1'))
  }
  return rows.length ? rows.join('\n') : 'ABSENT'
}

const [cmd, arg] = process.argv.slice(2)
;(async () => {
  if (cmd === 'eval') console.log(JSON.stringify(await evaluate(arg)))
  else if (cmd === 'notif') console.log(notif())
  else { console.log('用法:eval "<js>" | notif'); process.exit(2) }
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
