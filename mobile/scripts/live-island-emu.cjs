/**
 * 灵动岛模拟器台架(2026-09-18)—— 真机/模拟器上跑着 debug 包时用:
 *   node scripts/live-island-emu.cjs eval "<js 表达式,可 await>"   在 app 的 WebView 里求值
 *   node scripts/live-island-emu.cjs notif                         只看活动通知里岛那两条:id=7201 常驻、7203 完成态(都没有就打 ABSENT)
 *   node scripts/live-island-emu.cjs perm                          通知权限回执的两条路(Android 13+;会撤掉本包的通知权限并冷启两次,结束时权限是「已允许」)
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
    if (l.includes('NotificationRecord(')) mine = l.includes(`pkg=${PKG} `) && /id=720[13] /.test(l)
    if (mine && /importance=|^\s*flags=|android\.(title|text|subText|requestPromotedOngoing|shortCriticalText|showChronometer)=/.test(l)) rows.push(l.trim().replace(/^NotificationRecord\(.*?(importance=\d).*/, 'record $1'))
  }
  return rows.length ? rows.join('\n') : 'ABSENT'
}

/**
 * 第一发 show 会弹系统的通知权限框,答完才贴。两条路都要对:
 *  ① 答之前 run 已经结束 → 点「允许」后不许把那条旧岛贴回来(没人再去撤它,会一直挂着);
 *  ② 没结束 → 点「允许」后岛出现。
 * 权限框只能从没授权的状态问出来:每轮先撤权限(撤权限会杀进程)再冷启。
 */
async function perm() {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const show = (o) => `Capacitor.Plugins.LiveIsland.show(${JSON.stringify({ title: 'perm', text: 'running', chip: '', sessionId: 's', channelName: 'c', more: 0, since: Date.now(), ...o })})`
  async function allow() {
    for (let i = 0; i < 20; i++) {
      await pause(500)
      let xml = ''
      try { adb('shell', 'uiautomator', 'dump', '/sdcard/island-perm.xml'); xml = adb('shell', 'cat', '/sdcard/island-perm.xml') } catch { continue }
      const m = xml.match(/resource-id="com\.android\.permissioncontroller:id\/permission_allow_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
      if (m) { adb('shell', 'input', 'tap', String((+m[1] + +m[3]) >> 1), String((+m[2] + +m[4]) >> 1)); return }
    }
    throw new Error('权限框没出现(系统低于 Android 13,或这个包被记成了「不再询问」)')
  }
  async function round(endsFirst) {
    adb('shell', 'am', 'force-stop', PKG)
    adb('shell', 'pm', 'revoke', PKG, 'android.permission.POST_NOTIFICATIONS')
    adb('shell', 'pm', 'clear-permission-flags', PKG, 'android.permission.POST_NOTIFICATIONS', 'user-set', 'user-fixed')
    adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.MainActivity`)
    for (let i = 0; ; i++) {
      await pause(1000)
      try { if (await evaluate('document.readyState === "complete" && !!window.Capacitor?.Plugins?.LiveIsland')) break } catch (e) { if (i > 30) throw e }
    }
    await pause(3000) // 页面启动时自己那一发 reset 先过去
    await evaluate(`void ${show({})}; 1`) // 答完权限框才落定:不等它
    await pause(1500)
    if (endsFirst) await evaluate(`void ${show({ done: true, quiet: true })}; 1`)
    await pause(500)
    await allow()
    await pause(2500)
    return notif()
  }
  const stale = await round(true)
  const fresh = await round(false)
  await evaluate(`void ${show({ done: true, quiet: true })}; 1`)
  const [gone, up] = [stale === 'ABSENT', /android\.text=.*running/.test(fresh)]
  console.log(`${gone && up ? 'PASS' : 'FAIL'} 权限回执:答之前已结束 → ${gone ? '不贴' : `把旧岛贴回来了\n${stale}`};没结束 → ${up ? '岛出现' : `岛没出现\n${fresh}`}`)
  if (!gone || !up) process.exit(1)
}

const [cmd, arg] = process.argv.slice(2)
;(async () => {
  if (cmd === 'eval') console.log(JSON.stringify(await evaluate(arg)))
  else if (cmd === 'notif') console.log(notif())
  else if (cmd === 'perm') await perm()
  else { console.log('用法:eval "<js>" | notif | perm'); process.exit(2) }
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
