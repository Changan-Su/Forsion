/**
 * 实时音视频(通话插件)的**能力地基**体检 —— 裸 Electron + 内存夹具,几秒出结果。
 *
 * 为什么必须真跑:这里每一条都是「只读代码推不出来、普通浏览器台架也照不到」的:
 *
 *  · CSP 的 connect-src **管得着 WebSocket**,而 `https:` 这个 scheme-source **不覆盖 wss:**
 *    (CSP3 的 scheme-source 是逐字 scheme 匹配)。更毒的是失败姿势:`new WebSocket()`
 *    **不抛异常**,readyState 直接跳 3,只有一个 securitypolicyviolation 事件 —— 症状与
 *    「信令服务器挂了」逐字一致。全仓 frontend/src 里 `new WebSocket` 命中数为 0,
 *    这个洞从来没人踩过,所以也从来没人发现。
 *  · 反过来,RTCPeerConnection / ICE / DTLS-SRTP **完全不受 CSP 管**。别为了修上面那条
 *    把 CSP 放得比需要的宽 —— 媒体面本来就不归它管。
 *  · getDisplayMedia 今天必然失败(全仓无 setDisplayMediaRequestHandler),但要拿到**逐字**
 *    的错误名与文案,插件才能把「宿主没装接缝」和「用户取消」和「macOS 没给录屏权限」
 *    分开报 —— 这三种今天在界面上长得一模一样:按钮点了没反应。
 *  · enumerateDevices 在拿到授权**之前**返回的是空 label / 空 deviceId,先建选择器再要权限
 *    = 一排空白项。顺序必须是「先授权后枚举」。
 *
 *  · mini 窗 / 独立窗会把插件**再装一遍**,所以模块级通话状态是「每渲染进程一份」,必须仲裁。
 *    而实测结论反直觉:localStorage **跨渲染进程共享**(C8),但 storage 事件**不跨**(C10),
 *    BroadcastChannel 也**不跨**(C9,file:// 源隔离)。三条合起来只剩一条路:
 *    **租约 + 轮询**。照 web 直觉写 BroadcastChannel 或 storage 监听,症状同样是静默失灵。
 *
 * 负对照是本脚本的骨架:每条「放行」断言都配一条「本该拦住的照样拦住」,否则把 CSP 改成
 * `connect-src *` 也能让全部变绿(假绿母题)。C9/C10 刻意断言「跨不过」——那是实测既成事实,
 * 写成断言就能拦住将来照 web 直觉写协调逻辑的人;哪天它们红了,说明 Electron 变了,去简化仲裁。
 *
 * 用法:npm run check:rtc
 */
const { app, BrowserWindow, session, systemPreferences } = require('electron')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
/**
 * connect-src 要放行的源。**刻意是裸 `wss:` 而不是厂商域名白名单**,两条理由:
 *  ① 商用 RTC SDK 的信令主机是**调度器运行时下发**的(按 appid/地域/PoP 变,不随 SDK 发版),
 *    静态白名单会在某天悄悄过期 —— 而失败姿势是 C2 那种静默,排查成本极高。
 *  ② connect-src 里**已经有裸 `https:`** = 任意 https 主机可连。放 https 却禁 wss 是安全剧场:
 *    同一批主机换个 scheme 而已,信任边界一寸没动。真正的媒体面(见 C5)本来就不归 CSP 管。
 * 所以负对照换一条轴:**明文 `ws://` 必须仍被拦**(信令绝不允许裸奔)。
 */
const WSS_SCOPE = 'wss:'
/** 真实信令主机(厂商调度器下发的域名之一),裸 wss: 下应放行。 */
const WSS_IN_SCOPE = 'wss://trtc.rtc.qq.com/ws'
/** 负对照:明文信令,补了 CSP 之后**仍然必须**被拦。 */
const WS_PLAINTEXT = 'ws://csp-probe.invalid/ws'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
function note(name, detail) {
  console.log(`INFO  ${name}${detail ? '  | ' + detail : ''}`)
}

// ── 静态闸:真源还长着本脚本假设的样子吗 ────────────────────────────────────────
const indexHtml = readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8')
const CSP = (/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml) || [])[1] || ''
const connectSrc = (/connect-src ([^;]+)/.exec(CSP) || [])[1] || ''
check('S1 能从 frontend/index.html 解析出 connect-src(解析不出=下面全部无意义)',
  connectSrc.length > 0, `connect-src ${connectSrc.trim()}`)

const hasWss = /\bwss:/.test(connectSrc) || connectSrc.includes(WSS_SCOPE)
note(`S2 connect-src 目前${hasWss ? '已' : '**未**'}放行 wss(通话信令的必要条件)`,
  hasWss ? connectSrc.trim() : `缺 ${WSS_SCOPE}`)

// 两份页面对跑:**真源 CSP**(正断言,补完宿主就该全绿)与**剥掉 wss 的 CSP**(负对照,
// 复现「改动之前」的世界)。方向很重要:正断言必须盯着 index.html 的真实内容,否则本脚本
// 只是给「今天坏着」拍了张照,补完 CSP 自己反而变红。
const CSP_WITHOUT = CSP.replace(new RegExp('\\s*' + WSS_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
check('S3 负对照 CSP 生成成功(把 wss 源剥干净,用来复现改动前的世界)',
  !CSP_WITHOUT.includes(WSS_SCOPE), '')

// ── 夹具页面:用 file:// 装载,与生产 loadFile 同口径 ─────────────────────────────
const tmp = mkdtempSync(path.join(os.tmpdir(), 'forsion-rtc-'))
const pageFor = (csp, name) => {
  const p = path.join(tmp, name)
  writeFileSync(p, `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${csp}"><body>probe`)
  return p
}
const PAGE_LIVE = pageFor(CSP, 'live.html')       // frontend/index.html 的真实内容
const PAGE_BEFORE = pageFor(CSP_WITHOUT, 'before.html') // 剥掉 wss 源 = 改动前

/**
 * 在页面里跑一次探针。返回每个 URL 是否触发了 CSP 违规,以及构造函数是否抛错。
 * 判定依据是 securitypolicyviolation 事件而不是「连上没有」—— 后者依赖外网,不可复现。
 */
const PROBE = (urls) => `(async () => {
  const violations = []
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push({ uri: e.blockedURI, directive: e.effectiveDirective })
  })
  const out = []
  for (const u of ${JSON.stringify(urls)}) {
    let threw = null
    try { const ws = new WebSocket(u); ws.onerror = () => {}; ws.close() }
    catch (err) { threw = String(err && err.name || err) }
    out.push({ url: u, threw })
  }
  // 违规事件是异步派发的,给它一拍。
  await new Promise((r) => setTimeout(r, 400))
  return { out, violations }
})()`

const blockedIn = (res, host) =>
  res.violations.some((v) => v.directive === 'connect-src' && String(v.uri).includes(host))

async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false } })

  // ① 负对照:剥掉 wss 源的世界 —— 必须被拦,且构造函数不抛错(静默失败的实证)
  await win.loadFile(PAGE_BEFORE)
  const before = await win.webContents.executeJavaScript(PROBE([WSS_IN_SCOPE, WS_PLAINTEXT]))
  check('C1 负对照:不放行 wss 时信令被 connect-src 拦住(证明这条闸真的会出事)',
    blockedIn(before, 'trtc.rtc.qq.com'), JSON.stringify(before.violations.map((v) => v.uri)))
  check('C2 被拦时 new WebSocket() **不抛异常**(所以症状=「服务器挂了」,必须靠事件识别)',
    before.out.every((o) => o.threw === null), JSON.stringify(before.out))

  // ② 真源 CSP:射程内放行,射程外仍拦。C3 红 = 宿主那条 CSP 改动还没落地。
  await win.loadFile(PAGE_LIVE)
  const live = await win.webContents.executeJavaScript(PROBE([WSS_IN_SCOPE, WS_PLAINTEXT]))
  check(`C3 frontend/index.html 的 connect-src 放行 ${WSS_SCOPE}(射程内的信令不再违规)`,
    !blockedIn(live, 'trtc.rtc.qq.com'), JSON.stringify(live.violations.map((v) => v.uri)))
  check('C4 负对照:明文 ws:// 照样被拦(证明放行是有界的,不是把门拆了)',
    blockedIn(live, 'ws://csp-probe.invalid'), JSON.stringify(live.violations.map((v) => v.uri)))

  // ③ 媒体面不归 CSP 管 —— 别为了修信令把 CSP 放宽过头
  await win.loadFile(PAGE_LIVE)
  const rtc = await win.webContents.executeJavaScript(`(async () => {
    const violations = []
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective))
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
      pc.createDataChannel('probe')
      const offer = await pc.createOffer()
      pc.close()
      await new Promise((r) => setTimeout(r, 300))
      return { ok: true, sdpLen: (offer.sdp || '').length, violations }
    } catch (e) { return { ok: false, err: String(e), violations } }
  })()`)
  check('C5 线上 CSP 下 RTCPeerConnection/createOffer 正常(媒体面不受 CSP 管,只有信令面受)',
    rtc.ok && rtc.sdpLen > 0 && rtc.violations.length === 0,
    `sdp ${rtc.sdpLen} 字节, 违规 ${JSON.stringify(rtc.violations)}`)

  // ④ 屏幕共享:今天必然失败,把**逐字**错误钉下来,插件才能分开报三种成因
  const disp = await win.webContents.executeJavaScript(`(async () => {
    try { await navigator.mediaDevices.getDisplayMedia({ video: true }); return { ok: true } }
    catch (e) { return { ok: false, name: e.name, message: e.message } }
  })()`)
  check('C6 getDisplayMedia 今天失败(宿主尚无 setDisplayMediaRequestHandler)——记录逐字错误',
    disp.ok === false, `${disp.name}: ${disp.message}`)
  note('    ↑ 插件据此分流:NotSupportedError=宿主缺接缝 / AbortError=用户取消或没选源 / 其它=系统权限')

  // ⑤ 设备 label 的可见性是**全局**闸,不是逐设备闸:只要拿到过**任意一个**媒体授权
  //    (本机麦克风早被语音输入要走了),Chromium 就把所有设备的 label/deviceId 一并放出来;
  //    一个授权都没有时全是空串。所以断言必须随权限态走 —— 写死「授权前一定为空」会随机器飘。
  const anyGrant = ['camera', 'microphone'].some((m) => {
    try { return systemPreferences.getMediaAccessStatus(m) === 'granted' } catch { return true }
  })
  const devs = await win.webContents.executeJavaScript(`(async () => {
    const d = await navigator.mediaDevices.enumerateDevices()
    return { total: d.length, blankLabel: d.filter((x) => !x.label).length, blankId: d.filter((x) => !x.deviceId).length }
  })()`)
  check(anyGrant
    ? 'C7 已有媒体授权 → enumerateDevices 的 label 可见(设备选择器可用)'
    : 'C7 无任何媒体授权 → label 全空(此时建选择器=一排空白项,顺序必须先授权后枚举)',
    anyGrant ? devs.total > 0 && devs.blankLabel === 0 : devs.total === 0 || devs.blankLabel === devs.total,
    `已授权=${anyGrant}, 设备 ${devs.total} 个, 空 label ${devs.blankLabel}, 空 deviceId ${devs.blankId}`)
  note('    ↑ 不变式:label 可见性由「有没有任意一个媒体授权」决定,不由「这个设备有没有授权」决定')

  // ⑤b 装上 handler 之后,失败姿势必须**换掉**:从「宿主缺接缝」变成「没选源」。
  //     插件正是靠这两个逐字错误分流的,分不开就只剩「点了没反应」一种表现。
  //     夹具里刻意 useSystemPicker:false —— 开着的话 macOS 15+ 会弹系统原生选择器,
  //     台架会挂在那儿等人点。生产是怎么配的由上面 S5 静态守。
  session.defaultSession.setDisplayMediaRequestHandler(
    // 拒绝必抛(见 main.ts 的 denyShare 注释),这里同样要接住,否则台架冒 UnhandledPromiseRejection。
    (_request, callback) => { try { callback({}) } catch { /* 拒绝必抛 */ } },
    { useSystemPicker: false },
  )
  const disp2 = await win.webContents.executeJavaScript(`(async () => {
    try { await navigator.mediaDevices.getDisplayMedia({ video: true }); return { ok: true } }
    catch (e) { return { ok: false, name: e.name, message: e.message } }
  })()`)
  check('C11 装上 handler 后「没选源」报 AbortError 而非 NotSupportedError(两种成因可分流)',
    disp2.ok === false && disp2.name === 'AbortError',
    `${disp2.name}: ${disp2.message}`)
  session.defaultSession.setDisplayMediaRequestHandler(null)

  // ⑥ 跨渲染进程仲裁原语:mini 窗 / 独立窗会把插件**再装一遍**(MiniRoot → ensureAmadeusReady
  //    → installAmadeusPlugins),模块级状态是「每渲染进程一份」。同一个 userId 二次 enterRoom
  //    会被厂商 SDK 判成顶号,把用户自己先前那通电话踢掉 —— 所以必须有「谁持有这通电话」的仲裁。
  //    插件够得着的候选只有 localStorage 与 BroadcastChannel,而生产是 file:// 装载,
  //    file:// 的源是不是 opaque 决定了这两个通不通。只能实测。
  const win2 = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false } })
  await win2.loadFile(PAGE_LIVE)
  const KEY = 'forsion_rtc_probe'
  await win.webContents.executeJavaScript(
    `(() => { try { localStorage.setItem(${JSON.stringify(KEY)}, 'from-win1'); return 'ok' } catch (e) { return String(e.name) } })()`)
  const lsRead = await win2.webContents.executeJavaScript(
    `(() => { try { return localStorage.getItem(${JSON.stringify(KEY)}) } catch (e) { return 'THREW:' + e.name } })()`)
  check('C8 两个渲染进程共享 localStorage(file:// 下也成立 → 可用来做「谁持有通话」的仲裁)',
    lsRead === 'from-win1', `win2 读到: ${JSON.stringify(lsRead)}`)

  const bc = await win2.webContents.executeJavaScript(`(() => new Promise((resolve) => {
    let ch
    try { ch = new BroadcastChannel('forsion_rtc_probe') } catch (e) { return resolve('THREW:' + e.name) }
    const timer = setTimeout(() => resolve('TIMEOUT'), 1200)
    ch.onmessage = (e) => { clearTimeout(timer); resolve(e.data) }
  }))()`)
  // 订阅方先就位,再让 win1 广播。
  await new Promise((r) => setTimeout(r, 150))
  await win.webContents.executeJavaScript(
    `(() => { try { new BroadcastChannel('forsion_rtc_probe').postMessage('ping-from-win1'); return 'sent' } catch (e) { return String(e.name) } })()`)
  const bcResult = await bc
  // 断言方向刻意是「送不到」:这是实测出来的既成事实,写成断言 = 谁将来在插件里用了
  // BroadcastChannel 做跨窗协调,会在这里被拦下(它不报错,只是永远收不到,与 C2 同一种静默)。
  // 反过来这条哪天红了,说明 Electron 变了,去把仲裁简化掉。
  check('C9 BroadcastChannel **跨不过**渲染进程(file:// 源隔离)——别用它做跨窗协调',
    bcResult === 'TIMEOUT', `win2 收到: ${JSON.stringify(bcResult)}`)

  // storage 事件跨不跨窗,决定仲裁是事件驱动还是只能轮询。
  const stEvt = await win2.webContents.executeJavaScript(`(() => new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), 1500)
    window.addEventListener('storage', (e) => {
      if (e.key !== 'forsion_rtc_probe_evt') return
      clearTimeout(timer); resolve(String(e.newValue))
    })
  }))()`)
  await new Promise((r) => setTimeout(r, 150))
  await win.webContents.executeJavaScript(
    `localStorage.setItem('forsion_rtc_probe_evt', 'lease-taken-by-win1')`)
  const stResult = await stEvt
  // 同样刻意断言「不触发」:localStorage 是**共享但静默**的 —— 值读得到(C8),变化通知不到(本条)。
  // 结论:跨窗仲裁只能做成「租约 + 轮询」,不能等事件。写死成断言,免得有人照 web 直觉写监听。
  check('C10 storage 事件**跨不过**渲染进程 → 仲裁只能轮询租约,不能等事件',
    stResult === 'TIMEOUT', `win2 收到: ${JSON.stringify(stResult)}`)
  await win.webContents.executeJavaScript(
    `localStorage.removeItem('forsion_rtc_probe'); localStorage.removeItem('forsion_rtc_probe_evt')`)
  win2.destroy()

  // ⑦ 系统权限现状(非阻塞查询,不弹窗)
  for (const m of ['camera', 'microphone', 'screen']) {
    try { note(`P ${m} 系统授权状态`, systemPreferences.getMediaAccessStatus(m)) }
    catch (e) { note(`P ${m} 系统授权状态`, `查询失败(非 macOS?): ${e.message}`) }
  }

  win.destroy()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log('未通过: ' + failed.map((r) => r.name.split(' ')[0]).join(', '))
  app.exit(failed.length ? 1 : 0)
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
