/**
 * 真 SFU 连通性探针(**要真凭证、要真联网**,所以是 probe 不是 check,不进 CI)。
 *
 * 跑法:
 *   LIVEKIT_URL=wss://hk.forsion.net LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… \
 *     npm run probe:rtc
 *
 * 它回答的是「通话打不通,是谁的问题」——这问题光看服务端日志答不了:
 * 服务端会照常打出 `participant active / connectionType: udp`,看上去一切正常,
 * 而客户端其实在每 17 秒重连一次。2026-09-06 就栽在这:根因是 HK 的 LiveKit 停在
 * v1.9.0,而 livekit-client 2.22.2 先探 /rtc/v1 信令路径 —— 旧服务端没有这条路,
 * SDK 回落到旧路径后 SDP 协商永远超时(13s),表现为无限重连、永远进不了房。
 *
 * 三个判据(缺一不可):
 *  ① SDK 自己的告警 —— "v1 RTC path not found" 就是版本对不上,别再查网络了。
 *  ② 重连次数 —— 必须为 0。**只看「连上了」会被骗**:第一次握手永远是成功的。
 *  ③ framesDecoded 在涨 —— 这才是真有 RTP。
 *     ⚠️ 别拿 TrackSubscribed 当媒体证据:它在 setRemoteDescription 时就触发,
 *        一帧没到也会响。上一轮我就是被它骗过一次。
 */
const { app, BrowserWindow } = require('electron')
const { createHmac } = require('node:crypto')
const { readFileSync, writeFileSync, mkdtempSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const URL_ = process.env.LIVEKIT_URL
const KEY = process.env.LIVEKIT_API_KEY
const SECRET = process.env.LIVEKIT_API_SECRET
if (!URL_ || !KEY || !SECRET) {
  console.error('缺 LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET(生产值在 server 的 .env 里,别写进仓库)')
  process.exit(2)
}

const SDK = 'https://cdn.jsdelivr.net/npm/livekit-client@2.22.2/dist/livekit-client.umd.js'
const SECONDS = 24
const ROOM = 'PROBE' + Date.now().toString(36).toUpperCase()

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const mint = (id) => {
  const now = Math.floor(Date.now() / 1000)
  const si = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    iss: KEY, sub: id, nbf: now, exp: now + 900, name: id,
    video: { room: ROOM, roomJoin: true, roomCreate: true, canPublish: true, canSubscribe: true, canPublishData: true },
  })}`
  return `${si}.${createHmac('sha256', SECRET).update(si).digest('base64url')}`
}

// 用产品自己的 CSP 建页:探针要跟真插件受同一套限制,否则「探针能连、插件不能」白测。
const CSP = (/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/
  .exec(readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8')) || [])[1]
const tmp = mkdtempSync(path.join(os.tmpdir(), 'rtcprobe-'))
const page = path.join(tmp, 'p.html')
writeFileSync(page, `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="${CSP}"><body>`)

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: false } })
  await w.loadFile(page)
  const out = await w.webContents.executeJavaScript(`(async () => {
    const viol = []
    document.addEventListener('securitypolicyviolation', (e) => viol.push(e.blockedURI + ' / ' + e.effectiveDirective))
    const src = await (await fetch(${JSON.stringify(SDK)})).text()
    new Function(src)()
    const LK = window.LivekitClient
    const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1)
    const warn = [], ev = []
    let reconnects = 0
    // SDK 自己的日志才说得清「为什么重连」;外面看只能看到状态翻来翻去。
    // ⚠️ setLogExtension 的 lvl 是**数字**(trace0 debug1 info2 warn3 error4),不是字符串。
    //    写成 lvl === 'warn' 一条都收不到,版本探测那条判据会变成永不触发的死代码 —— 犯过。
    LK.setLogLevel('debug')
    LK.setLogExtension((lvl, msg) => {
      const n = typeof lvl === 'number' ? lvl : { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }[lvl]
      if (n >= 3) warn.push(at() + ' [' + lvl + '] ' + msg)
    })

    const mkTrack = () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180
      const ctx = c.getContext('2d')
      setInterval(() => {
        ctx.fillStyle = '#' + ((Date.now() / 100 | 0) % 0xffffff).toString(16).padStart(6, '0')
        ctx.fillRect(0, 0, 320, 180)
      }, 100)
      return c.captureStream(15).getVideoTracks()[0]
    }

    const A = new LK.Room(), B = new LK.Room()
    for (const [n, r] of [['A', A], ['B', B]]) {
      r.on(LK.RoomEvent.Reconnecting, () => { reconnects++; ev.push(at() + ' ' + n + ' 重连') })
      r.on(LK.RoomEvent.Disconnected, (x) => ev.push(at() + ' ' + n + ' 断开 reason=' + x))
    }
    try {
      await A.connect(${JSON.stringify(URL_)}, ${JSON.stringify(mint('probe-a'))})
      await B.connect(${JSON.stringify(URL_)}, ${JSON.stringify(mint('probe-b'))})
      ev.push(at() + ' 两端已连接')
      await A.localParticipant.publishTrack(mkTrack(), { name: 'a', source: LK.Track.Source.Camera })
      await B.localParticipant.publishTrack(mkTrack(), { name: 'b', source: LK.Track.Source.Camera })
      ev.push(at() + ' 两端已发布')
    } catch (e) {
      return { err: String(e), ev, warn, viol, reconnects }
    }

    const rtp = async (room) => {
      for (const [, p] of room.remoteParticipants)
        for (const [, pub] of p.videoTrackPublications)
          if (pub.track && pub.track.getReceiverStats) return await pub.track.getReceiverStats().catch(() => null)
      return null
    }
    const series = []
    for (let k = 0; k < ${SECONDS} / 2; k++) {
      await new Promise((r) => setTimeout(r, 2000))
      series.push({ t: at(), a: await rtp(A), b: await rtp(B), st: A.state + '/' + B.state })
    }
    const res = { ev, warn, viol, reconnects, series }
    await A.disconnect(); await B.disconnect()
    return res
  })()`)

  const line = (s) => (s ? `${s.framesDecoded}帧 ${s.bytesReceived}B ${s.frameWidth}x${s.frameHeight} 丢${s.packetsLost} 抖${Math.round((s.jitter || 0) * 1000)}ms` : '(无)')
  console.log(out.ev.join('\n'))
  if (out.err) console.log('错误: ' + out.err)
  for (const s of out.series) console.log(`${s.t} ${s.st}  A<= ${line(s.a)}   B<= ${line(s.b)}`)
  if (out.warn.length) console.log('\nSDK 告警:\n  ' + out.warn.join('\n  '))

  // ── 判据 ────────────────────────────────────────────────────────────────────
  const fails = []
  const version = out.warn.find((l) => /v1 RTC path not found/.test(l))
  if (version) fails.push('服务端版本落后于客户端 SDK(缺 /rtc/v1)。升 LiveKit 服务端,别去查网络。')
  if (out.reconnects > 0) fails.push(`会话中重连了 ${out.reconnects} 次(必须为 0)。第一次握手成功不代表通了。`)
  if (out.viol.length) fails.push('CSP 违规:' + JSON.stringify(out.viol))
  if (out.err) fails.push('连接失败:' + out.err)
  const first = out.series[0], last = out.series[out.series.length - 1]
  for (const [n, k] of [['A', 'a'], ['B', 'b']]) {
    const grew = last && first && last[k] && first[k] && last[k].framesDecoded > first[k].framesDecoded
    if (!grew) fails.push(`${n} 没有真正收到 RTP(framesDecoded 没涨)——订阅事件不算数`)
  }

  console.log('')
  for (const f of fails) console.log('FAIL  ' + f)
  console.log(fails.length ? `\n${fails.length} 项不通过` : `\n通过:${SECONDS}s 零重连,两端 framesDecoded 均在增长`)
  app.exit(fails.length ? 1 : 0)
}).catch((e) => { console.error(e); app.exit(1) })
