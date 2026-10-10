/**
 * 台架「点了链接之后,认这次点击打开的那张页」的判定(scripts/lib/opened-page.cjs)认得对不对。
 * 起因(2026-10-10):真模型场景 user-research 的「点击来源实际打开官方网页」拿页面当前地址和链接逐字比,
 * Obsidian 帮助站加载完会把地址栏改写成短地址 → 页面打开了却判成没打开,6 次里红了 2 次。
 *
 * 不靠模型、不依赖 app 构建产物:裸 Electron + 本地 http 夹具 + <webview>(产品里来源也是开在 webview 里)。
 * 用法:npm run check:sourceopen            # 本地夹具,几秒
 *       npm run check:sourceopen -- --real  # 另外真开一次 Obsidian 那个长地址(要联网)
 */
const electron = require('electron')
const http = require('http')
const opened = require('./lib/opened-page.cjs')
const { app, BrowserWindow, webContents } = electron

const page = (title, script = '') => `<!doctype html><meta charset=utf-8><title>${title}</title><p>${title}</p><script>${script}</script>`
const srv = http.createServer((req, res) => {
  const p = req.url.split('?')[0]
  if (p === '/moved') { res.writeHead(302, { location: `/plain?from=moved` }); return res.end() }
  if (p === '/slow') return setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page('Plain')) }, 1500)
  res.writeHead(p === '/missing' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(p === '/host' ? '<!doctype html><meta charset=utf-8><body>'
    : p === '/Files+and+folders/How+it+stores+data' ? page('How it stores data', `history.replaceState(null, '', '/data-storage')`)
    : p === '/missing' ? page('Page not found')
    : page('Plain'))
})

const results = []
function check(name, ok, detail) {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 改之前的认法,留作对照:当前地址和链接逐字相等的那张页。
const oldLookup = (href) => webContents.getAllWebContents().find((c) => c.getURL().split('#')[0] === href.split('#')[0])

let host = null, guest = null
app.on('web-contents-created', (_e, wc) => { if (wc.getType() === 'webview') guest = wc })
/** 「点击」打开一个地址:宿主页里新挂一个 webview(和 Desk 上每个来源一格一样),等它加载完。 */
async function open(url, settled = () => true) {
  guest = null
  await host.executeJavaScript(`{ const w = document.createElement('webview'); w.src = ${JSON.stringify(url)}; w.style.cssText = 'display:inline-flex;width:400px;height:300px'; document.body.append(w) } 0`)
  for (let i = 0; i < 100 && !guest; i++) await sleep(50)
  if (!guest) throw new Error('<webview> 没创建出 guest')
  for (let i = 0; i < 400 && (guest.isLoading() || !guest.getTitle() || !settled(guest)); i++) await sleep(50)
}

app.dock?.hide()
app.whenReady().then(() => srv.listen(0, '127.0.0.1', async () => {
  try {
    const port = srv.address().port, base = `http://127.0.0.1:${port}`
    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webviewTag: true, contextIsolation: true } })
    await win.loadURL(`${base}/host`)
    host = win.webContents

    let href = `${base}/plain?n=1`, since = opened.watch(electron)
    await sleep(500)
    check('T1 负对照:点了什么都没打开 → 红', !opened.ok(opened.find(electron, { href, since })))

    href = `${base}/Files+and+folders/How+it+stores+data`; since = opened.watch(electron)
    await open(href)
    let found = opened.find(electron, { href, since })
    check('T2 页面加载完自己改写了地址栏 → 认得出、绿', opened.ok(found) && found.loadedFrom === href && found.url === `${base}/data-storage`, JSON.stringify(found))
    check('T2 对照:改之前的认法(比当前地址)在这张页上落空', !oldLookup(href))

    href = `${base}/missing`; since = opened.watch(electron)
    await open(href)
    found = opened.find(electron, { href, since })
    check('T3 负对照:打开的是「Page not found」→ 红(页认到了,红在标题)', !!found && !opened.ok(found), JSON.stringify(found))

    href = `${base}/plain?n=4`; since = opened.watch(electron)
    await open(`http://localhost:${port}/plain?n=4`)
    check('T4 负对照:点了之后打开的是别的站 → 红(那张页确实加载出来了)', guest.getTitle() === 'Plain' && !opened.ok(opened.find(electron, { href, since })), `打开的是 ${guest.getURL()}`)

    href = `${base}/moved`; since = opened.watch(electron)
    await open(href)
    check('T5 链接被服务器跳转走 → 照旧红(这次没放宽,见 lib 的 ponytail 注释)', guest.getTitle() === 'Plain' && !opened.ok(opened.find(electron, { href, since })), `落在 ${guest.getURL()}`)

    href = `${base}/plain?n=6`; since = opened.watch(electron)
    await open(href)
    const first = opened.ok(opened.find(electron, { href, since }))
    since = opened.watch(electron)
    await sleep(300)
    check('T6 负对照:点击之前就开着的同地址页面不算这次点击打开的 → 红', first && !opened.ok(opened.find(electron, { href, since })))
    check('T6 对照:改之前的认法会把它算成打开了', !!oldLookup(href))

    href = `${base}/slow`
    const pending = open(href) // 不等它:服务器压着 1.5 秒不回
    for (let i = 0; i < 100 && !guest?.isLoadingMainFrame(); i++) await sleep(10)
    await sleep(100)
    since = opened.watch(electron)
    await pending
    check('T7 负对照:点击之前就在加载、点击之后才加载完的页面不算这次点击打开的 → 红(那张页确实加载出来了)', guest.getTitle() === 'Plain' && guest.getURL() === href && !opened.ok(opened.find(electron, { href, since })))

    if (process.argv.includes('--real')) {
      href = 'https://obsidian.md/help/Files+and+folders/How+Obsidian+stores+data'; since = opened.watch(electron)
      await open(href, (g) => g.getURL() !== href) // 等站点把地址改写完,否则对照那条没有意义
      found = opened.find(electron, { href, since })
      check('T8 真站:Obsidian 帮助站的长地址 → 认得出、绿', opened.ok(found) && found.loadedFrom === href, JSON.stringify(found))
      check('T8 对照:地址栏已被站点改写,改之前的认法落空', found?.url !== href && !oldLookup(href))
    }
  } catch (e) { check(`脚本自己出错:${e.message}`, false) }
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通过`)
  app.exit(results.every(Boolean) ? 0 : 1)
}))
