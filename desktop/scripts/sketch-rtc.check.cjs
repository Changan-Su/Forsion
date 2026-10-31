/**
 * Intelligent UI 卡的 WebRTC 外泄回归探针:真 Electron 主窗(真 CSP)+ 无头 Chromium(web/index.html 的 CSP),
 * 每条路各跑一次「去掉守卫和 csp 属性的卡」(负对照,必须连到假 TURN)和真 buildSketchDoc 产物(一条都不许连到);
 * 最后在 Electron 里走一遍真聊天消息里的真 SketchCard,确认 iframe 的属性和文档都接对了。
 * 判据是假 TURN/TCP 收到带路线名的 USERNAME,这就是真正出去的东西;不看候选类型(走 TCP 的 TURN 没有候选也已经外泄)。
 * 假 TURN 回 401 + REALM + NONCE,客户端才会带 USERNAME 重发,和真服务器一样。
 *
 * 用法:npm run build && npm run check:sketchrtc(要有桌面构建产物;不碰外网)。升 Electron 时必跑:守卫是列举式的,见 sketchGuard.js 头注。
 * 只看 Electron 或只看网页:--only=electron / --only=web
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { chromium } = require('playwright-core')
const electron = require('./lib/launch-electron.cjs')
const { findChromium } = require('./lib/find-chromium.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const COMPONENTS = path.join(ROOT, 'frontend/src/components')
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7)

/** 真 buildSketchDoc:esbuild 的同步 API 没有插件,把 `?raw` 改写成 text loader 导入,结果和 vite 一致。 */
function loadWrapper() {
  const entry = path.join(COMPONENTS, 'sketchWrapper.ts')
  const source = fs.readFileSync(entry, 'utf8').replace(/from '(\.\/[^']+)\?raw'/g, (_, file) => `from '${file}'`)
  const code = buildSync({
    stdin: { contents: source, resolveDir: COMPONENTS, loader: 'ts' }, bundle: true, write: false, logLevel: 'silent',
    platform: 'node', format: 'cjs', loader: { '.css': 'text', '.js': 'text' },
  }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  return mod.exports
}
const { buildSketchDoc, SKETCH_SANDBOX, SKETCH_CSP } = loadWrapper()
const guardTag = `<script>${fs.readFileSync(path.join(COMPONENTS, 'sketchGuard.js'), 'utf8')}</script>`
const realDoc = (body) => {
  const doc = buildSketchDoc(body, {}, null, 'nonce')
  assert.ok(doc.includes(guardTag), 'buildSketchDoc 产物里没有守卫')
  return doc
}
// 负对照只拿掉守卫和 shadowrootmode 的剥离,其余和真卡逐字一致
const controlDoc = (body) => realDoc(body).replace(guardTag, '').replaceAll('data-shadowrootmode', 'shadowrootmode')

/** 假 TURN/TCP:记下 USERNAME 里的路线名。 */
const seen = new Set()
function startTurn() {
  const attr = (type, value) => {
    const head = Buffer.alloc(4); head.writeUInt16BE(type, 0); head.writeUInt16BE(value.length, 2)
    return Buffer.concat([head, value, Buffer.alloc((4 - value.length % 4) % 4)])
  }
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    socket.on('data', (data) => {
      const route = /route-[a-z0-9-]+/.exec(data.toString('latin1'))
      if (route) { seen.add(route[0]); return }
      if (data.length < 20 || data.readUInt16BE(0) !== 3) return // 只回 Allocate
      const body = Buffer.concat([attr(9, Buffer.from([0, 0, 4, 1, 85])), attr(0x14, Buffer.from('x')), attr(0x15, Buffer.from('n1'))])
      const head = Buffer.alloc(20); head.writeUInt16BE(0x0113, 0); head.writeUInt16BE(body.length, 2); data.copy(head, 4, 4, 20)
      socket.write(Buffer.concat([head, body]))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const payload = (id, port) => `(async()=>{const P=window.RTCPeerConnection||window.webkitRTCPeerConnection;const pc=new P({iceServers:[{urls:'turn:127.0.0.1:${port}?transport=tcp',username:'route-${id}',credential:'p'}],iceTransportPolicy:'relay'});pc.createDataChannel('x');await pc.setLocalDescription(await pc.createOffer())})()`
const attrEscape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
/** 字符串字面量,内联进 <script> 也闭合不了外层标签。 */
const lit = (s) => JSON.stringify(s).replace(/<\//g, '<\\/')

/** 卡内脚本能走的每条路。control:false = 去掉守卫也出不去(被别的层挡住),留着防它哪天变成能出去;'browser' = 看浏览器版本有没有这个入口。 */
function routes(port, site) {
  // 动态路线里 shadowrootmode 拆开写:静态剥离碰不到脚本拼出来的串,测的才是守卫里的删除
  const route = (id, make, opts = {}) => {
    const js = payload(id, port), script = `<script>${js}<\/script>`
    return { id, body: make({ js, script, frame: `<iframe srcdoc="${attrEscape(script)}"></iframe>` }), control: opts.control ?? true, final: opts.final }
  }
  return [
    route('direct', ({ script }) => script),
    route('srcdoc-static', ({ frame }) => frame),
    route('srcdoc-dynamic', ({ script }) => `<script>const f=document.createElement('iframe');f.srcdoc=${lit(script)};document.body.append(f)</script>`),
    route('javascript-src', ({ js }) => `<script>const f=document.createElement('iframe');f.src='javascript:'+encodeURIComponent(${lit(js)});document.body.append(f)</script>`),
    route('busy-wait', ({ script }) => `<script>const f=document.createElement('iframe');f.srcdoc=${lit(script)};document.body.append(f);const t=Date.now();while(Date.now()-t<400);</script>`),
    route('poison-globals', ({ script }) => `<script>Object.defineProperty(window,'length',{get:()=>0});Function.prototype.call=()=>0;Function.prototype.apply=()=>0;Element.prototype.remove=()=>{};Document.prototype.querySelectorAll=()=>[];const f=document.createElement('iframe');f.srcdoc=${lit(script)};document.body.append(f)</script>`),
    route('in-svg', ({ frame }) => `<svg><foreignObject>${frame}</foreignObject></svg>`),
    route('root-swap', ({ script }) => `<script>document.documentElement.remove();const h=document.createElement('html');document.append(h);const f=document.createElement('iframe');f.srcdoc=${lit(script)};h.append(f)</script>`),
    route('document-open', ({ script }) => `<script>document.open();document.close();const h=document.documentElement||document.appendChild(document.createElement('html'));const f=document.createElement('iframe');f.srcdoc=${lit(script)};h.append(f)</script>`),
    route('final-morph', ({ frame }) => frame, { final: true }),
    route('document-write', ({ frame }) => `<script>document.write(${lit(frame)})</script>`),
    route('replay-frame', ({ script }) => `<script>const f=document.createElement('iframe');f.srcdoc=${lit(script)};for(let i=0;i<40;i++)setTimeout(()=>document.body.append(f),i*5)</script>`),
    route('shadow-closed', ({ frame }) => `<div id=h></div><script>h.attachShadow({mode:'closed'}).innerHTML=${lit(frame)}</script>`),
    route('dsd-static', ({ frame }) => `<div><template shadowrootmode="closed">${frame}</template></div>`),
    route('dsd-empty-then-fill', ({ frame }) => `<div id=h><template shadowrootmode="open"></template></div><script>h.shadowRoot.innerHTML=${lit(frame)}</script>`),
    route('dsd-internals', ({ frame }) => `<x-y><template shadowrootmode="closed"></template></x-y><script>customElements.define('x-y',class extends HTMLElement{constructor(){super();this.attachInternals().shadowRoot.innerHTML=${lit(frame)}}})</script>`),
    route('sethtmlunsafe-dsd', ({ frame }) => `<div id=h></div><script>h.setHTMLUnsafe('<div id=i><template shadow'+'rootmode=open></template></div>');document.getElementById('i').shadowRoot.innerHTML=${lit(frame)}</script>`),
    route('parsehtmlunsafe-dsd', ({ frame }) => `<script>const e=document.adoptNode(Document.parseHTMLUnsafe('<div id=i><template shadow'+'rootmode=open></template></div>').getElementById('i'));document.body.append(e);e.shadowRoot.innerHTML=${lit(frame)}</script>`),
    route('sethtml-dsd', ({ frame }) => `<div id=h></div><script>h.setHTML('<div id=i><template shadow'+'rootmode=open></template></div>');document.getElementById('i').shadowRoot.innerHTML=${lit(frame)}</script>`, { control: 'browser' }),
    route('parsehtml-dsd', ({ frame }) => `<script>const e=document.adoptNode(Document.parseHTML('<div id=i><template shadow'+'rootmode=open></template></div>').getElementById('i'));document.body.append(e);e.shadowRoot.innerHTML=${lit(frame)}</script>`, { control: 'browser' }),
    route('write-dsd', ({ frame }) => `<script>document.write('<div id=i><template shadow'+'rootmode=open></template></div>');document.getElementById('i').shadowRoot.innerHTML=${lit(frame)}</script>`),
    // 自导航换文档 = 新 realm、没有守卫。回环页靠 iframe 的 csp 属性拒显(Electron 的 frame-src 放行本机);其余由宿主 frame-src 挡,
    // javascript: 自导航在沙箱帧里不执行,control:false 钉住。
    route('self-loopback', () => `<script>location.href='${site}/r/self-loopback'</script>`),
    route('meta-refresh-loopback', () => `<meta http-equiv="refresh" content="0;url=${site}/r/meta-refresh-loopback">`),
    route('self-data', ({ script }) => `<script>location.href='data:text/html,'+encodeURIComponent(${lit(script)})</script>`, { control: false }),
    route('self-blob', ({ script }) => `<script>location=URL.createObjectURL(new Blob([${lit(script)}],{type:'text/html'}))</script>`, { control: false }),
    route('self-javascript', ({ script }) => `<script>location='javascript:'+encodeURIComponent(JSON.stringify(${lit(script)}))</script>`, { control: false }),
    route('meta-refresh-data', ({ script }) => `<meta http-equiv="refresh" content="0;url=data:text/html,${encodeURIComponent(script)}">`, { control: false }),
    route('meta-refresh-javascript', ({ script }) => `<meta http-equiv="refresh" content="0;url=javascript:${encodeURIComponent(JSON.stringify(script))}">`, { control: false }),
  ]
}

const FIXTURE_OK = `<fs-checklist><script type="application/json">{"items":["a"]}</script></fs-checklist><div id="x" onclick="this.dataset.hit=1"></div><script>addEventListener('load',()=>{document.getElementById('x').click();parent.postMessage({ok:{iui:!!window.forsionIntelligentUi,click:document.getElementById('x').dataset.hit,rtc:typeof RTCPeerConnection,figure:!!customElements.get('fs-checklist')}},'*')})</script>`

/** 在 page 里按 SketchCard 的姿势挂一张卡,等 ms 后摘掉,回收卡发的消息。final = 走直播收尾那条路(卡装好后 postMessage 终稿)。 */
const mount = (page, doc, { csp = SKETCH_CSP, ms = 700, final } = {}) => page.evaluate(({ doc, sandbox, csp, ms, final }) => new Promise((done) => {
  const f = document.createElement('iframe')
  f.setAttribute('sandbox', sandbox); if (csp) f.setAttribute('csp', csp)
  f.style.cssText = 'position:fixed;left:-99px;width:9px;height:9px'; f.srcdoc = doc
  const got = []
  const on = (e) => { if (e.source === f.contentWindow) got.push(e.data) }
  if (final) f.onload = () => f.contentWindow.postMessage({ type: 'sketch-final', html: final }, '*')
  addEventListener('message', on); document.body.append(f)
  setTimeout(() => { removeEventListener('message', on); f.remove(); done(got) }, ms)
}), { doc, sandbox: SKETCH_SANDBOX, csp, ms, final })

async function runOn(name, page, port, site) {
  const rows = [], failed = []
  for (const route of routes(port, site)) {
    const hit = async (doc, csp) => {
      seen.clear(); await mount(page, doc, { csp, final: route.final && route.body }); await page.waitForTimeout(200)
      return seen.has(`route-${route.id}`)
    }
    const load = route.final ? '' : route.body
    const control = await hit(controlDoc(load), '')
    const guarded = await hit(realDoc(load))
    rows.push({ route: route.id, control, guarded })
    if (route.control !== 'browser' && control !== route.control) failed.push(`${route.id}: 负对照 ${control},应为 ${route.control}`)
    if (guarded) failed.push(`${route.id}: 守卫下外泄`)
  }
  const ok = (await mount(page, realDoc(FIXTURE_OK), { ms: 500 })).find((m) => m?.ok)?.ok
  if (!ok?.iui || !ok.click || !ok.figure || ok.rtc !== 'undefined') failed.push(`正常卡异常: ${JSON.stringify(ok)}`)
  // 守卫按名字默认全删,这里钉住删完只剩核对过不解析 shadowrootmode 的那几个
  const parsers = (await mount(page, realDoc(`<script>parent.postMessage({list:[Element.prototype,ShadowRoot.prototype,CharacterData.prototype,Document,Document.prototype].flatMap((o)=>Object.getOwnPropertyNames(o)).filter((k)=>/html|write/i.test(k))},'*')</script>`), SKETCH_SANDBOX, 300)).find((m) => m?.list)?.list
  const KNOWN = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'getHTML']
  const unknown = [...new Set(parsers ?? ['(no reply)'])].filter((k) => !KNOWN.includes(k))
  if (unknown.length) failed.push(`未核对的解析入口: ${unknown.join(', ')}`)
  console.log(`\n── ${name} ──`)
  console.log('route'.padEnd(26), 'control'.padEnd(8), 'guarded')
  for (const r of rows) console.log(r.route.padEnd(26), String(r.control).padEnd(8), r.guarded)
  return failed.map((f) => `${name} ${f}`)
}

/** 真聊天消息 → 真 SketchCard:属性接对了、卡里没有 RTC、子帧被摘掉、假 TURN 没收到东西。 */
async function checkRealCard(app, win, port) {
  for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await enterSpace(win, 'tangu')
  if (!(await win.locator('.t2s-search input').first().isVisible().catch(() => false))) await win.locator('.dv-edge-left').click().catch(() => {})
  await win.locator('.t2s-srow[data-sel-id="s1"]').first().click({ timeout: 15_000 })
  const card = win.locator('.sketch-frame').first()
  await card.waitFor({ timeout: 15_000 })
  await win.waitForTimeout(1200)
  const attrs = await card.evaluate((el) => ({ sandbox: el.getAttribute('sandbox'), csp: el.getAttribute('csp') }))
  const frame = await (await card.elementHandle()).contentFrame()
  const inner = await frame.evaluate(() => ({ rtc: typeof RTCPeerConnection, frames: window.length, text: document.getElementById('ui-ok')?.textContent }))
  const failed = []
  if (attrs.sandbox !== SKETCH_SANDBOX || attrs.csp !== SKETCH_CSP) failed.push(`真卡 iframe 属性不对: ${JSON.stringify(attrs)}`)
  if (inner.rtc !== 'undefined' || inner.frames !== 0 || inner.text !== 'rendered') failed.push(`真卡内部不对: ${JSON.stringify(inner)}`)
  if (seen.size) failed.push(`真卡外泄: ${[...seen].join(', ')}`)
  console.log(`\n真 SketchCard: ${JSON.stringify({ ...attrs, csp: attrs.csp === SKETCH_CSP, ...inner, leaks: seen.size })}`)
  return failed
}

async function main() {
  const turn = await startTurn()
  const port = turn.address().port
  const webCsp = /Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(path.join(ROOT, '../web/index.html'), 'utf8'))[1]
  // 同一台站点:/ 是带 web CSP 的宿主页,/r/<id> 是卡自导航要去的、没有 CSP 的页
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    const id = /^\/r\/([a-z-]+)/.exec(req.url)?.[1]
    res.end(id ? `<script>${payload(id, port)}</script>` : `<!doctype html><meta http-equiv="Content-Security-Policy" content="${webCsp}"><body>`)
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  const siteUrl = `http://127.0.0.1:${site.address().port}`
  const failed = []
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-rtc-'))
  try {
    if (only !== 'web') {
      const html = `<div id="ui-ok">rendered</div><script>${payload('ui-direct', port)}</script><iframe srcdoc="${attrEscape(`<script>${payload('ui-srcdoc', port)}</script>`)}"></iframe>`
      const args = JSON.stringify({ title: 'probe', html })
      const stub = await startStubEngine({
        sessions: [{ id: 's1', title: 'probe', summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: null, project_path: '/tmp/probe', project_name: 'probe', created_at: '2026-10-31 09:00:00', updated_at: '2026-10-31 09:00:00' }],
        messages: [{ id: 'm1', role: 'model', content: '', timestamp: Date.now(), tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sketch', arguments: args }, ui_content_offset: 0 }], tool_results: [{ tool_call_id: 'c1', name: 'sketch', content: 'Sketch card rendered in the conversation.', isError: false }] }],
        models: [{ id: 'm1', name: 'probe', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }],
      })
      for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'probe' }))
      }
      const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
      try {
        const win = await app.firstWindow()
        await win.waitForSelector('#root'); await win.waitForTimeout(2000)
        failed.push(...await runOn(`Electron ${await app.evaluate(() => process.versions.electron)}`, win, port, siteUrl))
        seen.clear()
        failed.push(...await checkRealCard(app, win, port))
      } finally { await app.close().catch(() => {}); await stub.close?.() }
    }
    if (only !== 'electron') {
      const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
      try {
        const page = await browser.newPage({ locale: 'zh-CN' })
        await page.goto(`${siteUrl}/`)
        failed.push(...await runOn(`Chromium ${browser.version()}`, page, port, siteUrl))
      } finally { await browser.close() }
    }
  } finally { turn.close(); site.close(); fs.rmSync(home, { recursive: true, force: true }) }
  if (failed.length) { console.error(`\n✗ ${failed.length} 项失败:\n  ${failed.join('\n  ')}`); process.exit(1) }
  console.log('\n✓ 负对照全部外泄,守卫下全部挡住')
}
main().catch((e) => { console.error(e); process.exit(1) })
