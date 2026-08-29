/**
 * 网页引用的定位地基:Chromium 原生 scroll-to-text-fragment 在**内置浏览器的 <webview> guest**
 * 里到底活不活。整条网页引用链(聊天链接 → Desk 内置浏览器 → 滚到那句话)全押在这上面,
 * 而规范对文本片段有「非同文档导航 + 用户激活或浏览器发起」的限制 —— 只读规范推不出结论,
 * 必须真跑(2026-08-28 立此桩:当时读规范以为 B 不成立,实测成立)。
 *
 * 不依赖 app 构建产物,裸 Electron + 本地 http 夹具,几秒出结果。
 * 用法:npm run check:textfrag
 */
const { app, BrowserWindow } = require('electron')
const http = require('http')

const NEEDLE = 'quicksilver phrase forty'      // 第 200 段(共 400)→ 命中应落在全文 ~50%
const NEEDLE2 = 'zephyr marker two hundred sixty' // 第 260 段 → ~65%
const body = Array.from({ length: 400 }, (_, i) =>
  `<p>para ${i} — ${i === 200 ? NEEDLE : i === 260 ? NEEDLE2 : 'filler text lorem ipsum dolor sit amet'}</p>`).join('\n')
const PAGE = `<!doctype html><meta charset=utf-8><title>probe</title><style>p{margin:24px 0;font:16px/1.6 sans-serif}</style>${body}`
const HOST = `<!doctype html><meta charset=utf-8><body style="margin:0"><webview id=w src="http://127.0.0.1:PORT/page.html#:~:text=${encodeURIComponent(NEEDLE)}" style="width:900px;height:600px;display:inline-flex"></webview>`

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const srv = http.createServer((req, res) => {
  const p = req.url.split('#')[0]
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(p.startsWith('/page') ? PAGE : HOST.replace('PORT', String(srv.address().port)))
})

let guest = null
app.on('web-contents-created', (_e, wc) => { if (wc.getType() === 'webview') guest = wc })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** guest 的滚动位置,归一成 0..1 —— 断绝对像素会随字体/行高飘。 */
async function ratio() {
  const [y, h, vh] = await guest.executeJavaScript('[scrollY, document.documentElement.scrollHeight, innerHeight]')
  return h > vh ? +(y / (h - vh)).toFixed(3) : 0
}

app.whenReady().then(() => {
  srv.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${srv.address().port}/page.html`
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { webviewTag: true, contextIsolation: true } })
    await win.loadURL(`http://127.0.0.1:${srv.address().port}/host.html`)
    for (let i = 0; i < 100 && !guest; i++) await sleep(50)
    if (!guest) { check('guest 挂上了', false, '<webview> 没创建出 guest'); return finish() }
    await new Promise((r) => guest.once('did-finish-load', r))
    await sleep(1200)

    const a = await ratio()
    check('T1 冷加载带 #:~:text= 直接落在引语上(引用条首次点开走这条)', Math.abs(a - 0.5) < 0.08, `位置=${a}`)

    // 同一页点第二条引语 = 只换 fragment = 同文档导航。规范对它有活化限制,实测在 Electron 里
    // 成立(loadURL 算浏览器发起)—— 这条绿着,BrowserView 就只需 loadURL,不必重挂 webview。
    await guest.loadURL(`${base}#:~:text=${encodeURIComponent(NEEDLE2)}`)
    await sleep(1200)
    const b = await ratio()
    check('T2 同页换 fragment(同文档导航)照样定位 → 第二条引语可就地跳,不必重挂 webview', Math.abs(b - 0.65) < 0.08, `位置=${b}`)

    // 回顶再来一次:排除「本来就已经滚在那儿」的假绿
    await guest.executeJavaScript('scrollTo(0,0)')
    await sleep(300)
    await guest.loadURL(`${base}#:~:text=${encodeURIComponent(NEEDLE)}`)
    await sleep(1200)
    const b2 = await ratio()
    check('T3 回顶后再换 fragment 仍回到引语(T2 不是「原地没动」的假绿)', Math.abs(b2 - 0.5) < 0.08, `位置=${b2}`)

    // 兜底路(本轮没用上):T2 若被上游改红,改走 findInPage 就是解法,先把它可用性钉在这。
    await guest.executeJavaScript('scrollTo(0,0)')
    await sleep(300)
    const found = await new Promise((r) => {
      guest.once('found-in-page', (_e, res) => r(res.matches))
      guest.findInPage(NEEDLE2)
      setTimeout(() => r(-1), 4000)
    })
    await sleep(800)
    const c = await ratio()
    guest.stopFindInPage('clearSelection')
    check('T4 findInPage 兜底可用(T2 红了改走这条)', found === 1 && Math.abs(c - 0.65) < 0.08, `matches=${found} 位置=${c}`)

    // 负对照:不带 fragment 冷加载必须停在顶部 —— 否则上面几条的「滚动」可能来自别的原因
    await guest.loadURL(`${base}?x=1`)
    await sleep(1200)
    const d = await ratio()
    check('T5 负对照:不带 fragment 冷加载停在顶部(证明滚动确实来自文本片段)', d === 0, `位置=${d}`)
    finish()
  })
})

function finish() {
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} 通过`)
  app.exit(ok === results.length ? 0 : 1)
}
app.on('window-all-closed', () => app.quit())
