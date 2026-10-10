/**
 * 手机版内容安全策略(mobile/index.html 的 CSP)观测台架 —— `npm run build && npm run e2e:csp`(mobile 目录)。
 *
 * 起因(2026-10-09 盘点):手机的策略比桌面少 media-src / worker-src / frame-src,connect-src 少 wss: blob: data:,
 * 这些都回落到 `default-src 'self'` —— 笔记里的音视频、three.js 的 blob 线程与 blob / data 取数、实时通话的 wss
 * 在手机上被静默拦掉(页面上只是「不动」,控制台才有一行违规)。
 *
 * 真把 mobile/dist 在手机视口的 headless Chromium 里跑,在页面里逐类发起一次真实加载,按浏览器派发的
 * `securitypolicyviolation` 事件判定(不解析策略文本:文本对不对不算数,浏览器拦没拦才算)。两张表:
 *   · 该放行的:策略不许拦(网络本身通不通无所谓 —— 台架把外站掐了,判据只有「有没有违规事件」);
 *   · 该拦着的:策略必须拦 —— 这是安全边界,放开任何一条都要先想清楚再改这张表。
 * 手机与桌面不同的地方(别照抄桌面那一行):
 *   · 外站页面一律不许进框架,**桌面放行的两家内嵌播放器也不放**;blob: / data: 页面同样不许。安卓 WebView 里
 *     Capacitor 的原生桥在老内核上退回 addJavascriptInterface,对**所有**框架可见 —— 框进来的页面等于拿到
 *     文件 / 设备接口。要在手机上内嵌播放,先换成不带原生桥的独立 WebView 或交给系统浏览器;
 *   · 不放行 amadeus-asset:(安卓这一侧没有接这个协议的拦截器,放了也加载不出来);
 *   · ws: 只给本机回环(调试),不给任意主机的明文长连接。
 * 负对照(2026-10-09 实跑):改之前的策略 → 「该放行的」里红 8 条(三种媒体 / blob 线程 / wss / 本机 ws / blob 与 data 取数;
 * 带 sandbox 的 srcdoc 框架本来就不被拦),「该拦着的」全绿。
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

/** 探针表。run 在页面里执行(字符串化后 evaluate),做一次真实加载;want = 策略该不该放行。
 *  directive 只是写给人看的「归哪条指令管」,判定不靠它。 */
const PROBES = [
  // ── 该放行的 ────────────────────────────────────────────────────────────────
  { id: 'media-https', want: 'allow', directive: 'media-src', what: '笔记 / 收藏夹里的远程音视频(云端库的附件就是 https 地址)',
    run: () => { const a = new Audio('https://media.e2e.test/a.mp3'); a.load() } },
  { id: 'media-blob', want: 'allow', directive: 'media-src', what: '本机生成的音视频(录音回放、视频工作室预览)',
    run: () => { const a = new Audio(URL.createObjectURL(new Blob([new Uint8Array(64)], { type: 'audio/wav' }))); a.load() } },
  { id: 'media-data', want: 'allow', directive: 'media-src', what: '内联的短音效(data: 地址)',
    run: () => { const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='); a.load() } },
  { id: 'worker-blob', want: 'allow', directive: 'worker-src', what: 'blob 线程(three.js 的网格 / 贴图解码器)',
    run: () => { try { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); setTimeout(() => w.terminate(), 300) } catch { /* 被拦时有的内核直接抛 */ } } },
  { id: 'connect-wss', want: 'allow', directive: 'connect-src', what: '实时通话的 wss 长连接',
    run: () => { try { const s = new WebSocket('wss://rtc.e2e.test/x'); setTimeout(() => s.close(), 300) } catch { /* 同上 */ } } },
  { id: 'connect-ws-loopback', want: 'allow', directive: 'connect-src', what: '本机回环的 ws(调试时连本机引擎)',
    run: () => { try { const s = new WebSocket('ws://127.0.0.1:9/x'); setTimeout(() => s.close(), 300) } catch { /* 同上 */ } } },
  { id: 'connect-blob', want: 'allow', directive: 'connect-src', what: '按 blob: 地址取数(three.js 加载器)',
    run: () => fetch(URL.createObjectURL(new Blob(['x']))).catch(() => {}) },
  { id: 'connect-data', want: 'allow', directive: 'connect-src', what: '按 data: 地址取数(模型里内嵌的贴图 / 缓冲)',
    run: () => fetch('data:text/plain,x').catch(() => {}) },
  { id: 'frame-srcdoc-sandbox', want: 'allow', directive: 'frame-src', what: '沙箱化的内联框架(视频工作室的场景预览、聊天里的草图)',
    run: () => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.srcdoc = '<p>e2e</p>'; document.body.appendChild(f) } },
  // ── 该拦着的(安全边界) ─────────────────────────────────────────────────────────
  { id: 'frame-youtube', want: 'block', directive: 'frame-src', what: '内嵌播放器 youtube-nocookie(桌面放行;手机上外站框架拿得到原生桥,不放)',
    run: () => { const f = document.createElement('iframe'); f.src = 'https://www.youtube-nocookie.com/embed/e2e'; document.body.appendChild(f) } },
  { id: 'frame-bilibili', want: 'block', directive: 'frame-src', what: '内嵌播放器 player.bilibili.com(同上)',
    run: () => { const f = document.createElement('iframe'); f.src = 'https://player.bilibili.com/player.html?bvid=e2e'; document.body.appendChild(f) } },
  { id: 'frame-any-https', want: 'block', directive: 'frame-src', what: '任意 https 页面进框架',
    run: () => { const f = document.createElement('iframe'); f.src = 'https://evil.e2e.test/'; document.body.appendChild(f) } },
  { id: 'frame-data', want: 'block', directive: 'frame-src', what: 'data: 页面进框架',
    run: () => { const f = document.createElement('iframe'); f.src = 'data:text/html,<p>x</p>'; document.body.appendChild(f) } },
  { id: 'frame-blob', want: 'block', directive: 'frame-src', what: 'blob: 页面进框架(与本页同源,等于内联脚本的另一条路)',
    run: () => { const f = document.createElement('iframe'); f.src = URL.createObjectURL(new Blob(['<p>x</p>'], { type: 'text/html' })); document.body.appendChild(f) } },
  { id: 'connect-ws-remote', want: 'block', directive: 'connect-src', what: '任意主机的明文 ws',
    run: () => { try { const s = new WebSocket('ws://rtc.e2e.test/x'); setTimeout(() => s.close(), 300) } catch { /* 同上 */ } } },
  { id: 'script-remote', want: 'block', directive: 'script-src', what: '外站脚本',
    run: () => { const s = document.createElement('script'); s.src = 'https://evil.e2e.test/x.js'; document.head.appendChild(s) } },
  { id: 'object-remote', want: 'block', directive: 'object-src', what: '外站插件对象(<object>)',
    run: () => { const o = document.createElement('object'); o.data = 'https://evil.e2e.test/x.swf'; document.body.appendChild(o) } },
]

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) { const exe = path.join(root, d, rel); if (fs.existsSync(exe)) return exe }
    }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = await startPreview(root)
  const appUrl = preview.url // 系统分配的空闲端口,E2E_PORT 可指定(见 lib/preview.cjs)

  let browser = null
  const fails = []
  const check = (ok, name, extra) => {
    if (!ok) fails.push(name)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  | ${extra}` : ''}`)
  }
  try {
    await preview.ready()

    browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN' })
    await ctx.addInitScript(() => {
      try { localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('forsion_token', 'e2e-csp') } catch { /* ignore */ }
      // 尽早挂上:策略违规事件只派发一次,不回放。
      window.__csp = []
      document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ d: e.effectiveDirective, uri: String(e.blockedURI || '').slice(0, 80) }))
    })
    const page = await ctx.newPage()
    await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"e2e"}' }))
    await page.route('**/api/**', (r) => r.abort())
    // 外站一律由台架兜住(不真出网):内嵌播放器给一页空白,别的 404。放行与否看的是策略,不是这些回包。
    await page.route(/^https:\/\/(www\.youtube-nocookie\.com|player\.bilibili\.com)\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>player</p>' }))
    await page.route(/^https?:\/\/[^/]*e2e\.test\//, (r) => r.fulfill({ status: 404, body: '' }))
    await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForSelector('.mb-topbar [aria-label="more"]', { timeout: 30_000 })
    await page.waitForTimeout(2500)

    const policy = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '')
    console.log(`      策略: ${policy}\n`)
    check(policy.includes("default-src 'self'"), "防空过:页面带着策略,且缺省档是 'self'")
    const bootNoise = await page.evaluate(() => window.__csp.length)
    check(bootNoise === 0, '启动过程本身没有违规(探针之前的基线)', bootNoise ? JSON.stringify(await page.evaluate(() => window.__csp.slice(0, 5))) : '')

    let lastWant = ''
    for (const p of PROBES) {
      if (p.want !== lastWant) { console.log(p.want === 'allow' ? '\n── 该放行的 ──' : '\n── 该拦着的(安全边界) ──'); lastWant = p.want }
      await page.evaluate(() => { window.__csp.length = 0 })
      await page.evaluate(`(${p.run.toString()})()`).catch(() => {})
      await page.waitForTimeout(700)
      const hits = await page.evaluate(() => window.__csp.slice())
      const blocked = hits.length > 0
      const detail = blocked ? `被 ${[...new Set(hits.map((h) => h.d))].join(' / ')} 拦下(${hits[0].uri})` : '没有违规事件'
      check(p.want === 'allow' ? !blocked : blocked, `${p.what}  [${p.directive}]`, detail)
    }
  } catch (e) {
    check(false, '台架异常', String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e))
  } finally {
    if (browser) await browser.close().catch(() => {})
    preview.kill()
  }
  console.log(`\n${fails.length ? `✗ ${fails.length} 项失败` : '✓ 全部通过'}`)
  process.exit(fails.length ? 1 : 0)
}

main()
