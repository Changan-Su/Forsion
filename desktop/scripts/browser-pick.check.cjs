/**
 * 内置浏览器「点选元素发进对话」整链(借鉴 Comma 方案 2.4;契约见 shared/browserPick.ts):
 * 真 Electron(out/ 产物)× 真 <webview> guest × 桩引擎,本地夹具页自带点击计数器。
 *
 *   P1 工具条上有点选键;按下 → aria-pressed + 顶上提示条
 *   P2 guest 里悬停 → 中性灰高亮 + 标签 `tag.class  W × H`(真鼠标事件经 sendInputEvent 走 guest 的命中测试)
 *   P3 ⌥ 选上一层:标签换成父元素;再动鼠标回到指针下那个
 *   P4 点下:网页自己的点击处理器**没被触发**;输入框多一张元素磁贴(标题 = 元素文字、副行 = 网页元素 · 选择器 · 域名)
 *   P5 Esc 取消:不挂磁贴、高亮罩撤掉、按钮弹起
 *   P6 发出去:模型收到的正文带 URL / 选择器 / 元素文字,附件里有一张元素截图(PNG 宽高 ≈ 元素尺寸)
 *   P7 安全边界:点选脚本跑在独立世界,网页主世界里看不到 window.__forsionPick;guest 照旧没有 window.tangu
 * 截图(明 / 暗)落 SHOT_DIR(缺省 /tmp/forsion-browserpick-shots),自己看一眼。
 *
 * 先 `npx electron-vite build`。用法:npm run check:browserpick
 */
const http = require('http')
const path = require('path')
const { launch, boot, sleep, shotDir, makeReporter, captureWindow } = require('./lib/uiux-electron.cjs')

const PAGE = `<!doctype html><meta charset=utf-8><title>Pick fixture</title>
<style>
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #f6f4ef; color: #222 }
  header { padding: 28px 40px }
  nav.links { display: flex; gap: 12px; padding: 0 40px }
  a.btn { display: inline-block; padding: 10px 18px; border-radius: 8px; background: #1f6feb; color: #fff; text-decoration: none }
  section.card { margin: 28px 40px; padding: 20px; background: #fff; border-radius: 12px; width: 420px }
  .dark { background: #111; color: #eee }
</style>
<header><h1>Pick fixture page</h1></header>
<nav class="links"><a class="btn" href="#docs">Docs</a><a class="btn" id="react-99887" href="#dl">Download for macOS</a></nav>
<section class="card"><h2>Pricing</h2><p class="lead">Plus is twelve dollars a month and includes sync.</p></section>
<script>
  window.__clicks = 0; window.__downs = 0
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a.btn')) { e.preventDefault(); window.__clicks++ } })
  document.querySelectorAll('a.btn').forEach((a) => a.addEventListener('mousedown', () => { window.__downs++ }))
</script>`

/** 截图里「按钮蓝」(#1f6feb 一带)的占比 + 尺寸。toBitmap 是 BGRA。 */
const blueShare = (app, b64) => app.evaluate(({ nativeImage }, data) => {
  const img = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  let blue = 0
  for (let i = 0; i < bmp.length; i += 4) { const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]; if (b > 200 && r < 90 && g > 80 && g < 150) blue++ }
  return { width, height, blue: +(blue / Math.max(1, bmp.length / 4)).toFixed(3) }
}, b64)

async function main() {
  const rep = makeReporter()
  const { check, note } = rep
  const dir = shotDir('browserpick')
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url.startsWith('/dark') ? PAGE.replace('background: #f6f4ef; color: #222', 'background: #121212; color: #eee') : PAGE)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const host = `127.0.0.1:${srv.address().port}`
  const env = await launch({ tag: 'browserpick' })
  const { app, win, stub } = env
  try {
    await boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    // 开一个内置浏览器标签(和页面里 target=_blank 回投同一条路)
    await app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send('app:open-url', u, true), `${base}/page.html`)
    await win.waitForSelector('webview', { timeout: 15_000 })
    const guestReady = async () => app.evaluate(({ webContents }, b) => {
      const g = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(b))
      return g ? { id: g.id, loading: g.isLoading() } : null
    }, base)
    let g = null
    for (let i = 0; i < 80; i++) { g = await guestReady(); if (g && !g.loading) break; await sleep(150) }
    check('P0 内置浏览器标签开出来、夹具页加载完', !!g && !g.loading, JSON.stringify(g))
    if (!g) throw new Error('no guest')
    await sleep(600)
    const inGuest = (code) => app.evaluate(async ({ webContents }, a) => webContents.fromId(a.id).executeJavaScript(a.code), { id: g.id, code })
    const send = (ev) => app.evaluate(({ webContents }, a) => { webContents.fromId(a.id).sendInputEvent(a.ev) }, { id: g.id, ev })
    const rectOf = (sel) => inGuest(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
    const label = () => inGuest(`(() => { const h = document.querySelector('forsion-pick'); const l = h && h.shadowRoot && h.shadowRoot.querySelector('[data-forsion-pick-label]'); return h ? (l ? l.textContent : '') : null })()`)
    const pressed = () => win.evaluate(() => document.querySelector('[data-press="pick"]')?.getAttribute('aria-pressed') ?? null)
    const tiles = () => win.evaluate(() => [...document.querySelectorAll('[data-element-target] .att-tile--element')].filter((t) => t.getClientRects().length).map((t) => ({
      head: t.querySelector('.att-tile-head')?.textContent, sub: t.querySelector('.att-tile-sub')?.textContent,
    })))

    check('P1a 工具条上有点选键(在外部打开左边)', await win.evaluate(() => {
      const b = document.querySelector('[data-press="pick"]')
      return !!b && b.nextElementSibling?.title === '用系统浏览器打开' && b.title === '点选元素发进对话'
    }))
    const before = await tiles()

    // ── P2/P3/P4:悬停 → ⌥ 上一层 → 点下
    await win.click('[data-press="pick"]')
    for (let i = 0; i < 20 && (await label()) === null; i++) await sleep(100)
    const hint = await win.evaluate(() => document.querySelector('.browser-pick-hint')?.textContent || '')
    check('P1b 按下 → aria-pressed=true + 提示条', (await pressed()) === 'true' && hint.includes('点一下要发的元素') && hint.includes('Esc 取消'), `hint=${hint}`)
    const r = await rectOf('#react-99887')
    const cx = Math.round(r.x + r.w / 2), cy = Math.round(r.y + r.h / 2)
    await send({ type: 'mouseMove', x: cx, y: cy })
    await sleep(250)
    const l1 = await label()
    check('P2 悬停 → 标签 `a.btn  W × H`', l1 === `a.btn  ${Math.round(r.w)} × ${Math.round(r.h)}`, `label=${JSON.stringify(l1)}`)
    const look = await inGuest(`(() => { const h = document.querySelector('forsion-pick'); const b = h.shadowRoot.firstElementChild; const cs = getComputedStyle(b); return { bg: cs.backgroundColor, border: cs.borderTopWidth + ' ' + cs.borderTopColor, display: cs.display } })()`)
    check('P2b 高亮是中性灰底 + 2px 中性描边', /rgba\(128, 128, 128/.test(look.bg) && look.border.startsWith('2px rgba(110, 110, 110'), JSON.stringify(look))
    await captureWindow(app, path.join(dir, 'pick-light.png'))
    // ⌥:真按键进 guest
    await send({ type: 'keyDown', keyCode: 'Alt' })
    await send({ type: 'keyUp', keyCode: 'Alt' })
    await sleep(200)
    const l2 = await label()
    check('P3a ⌥ → 选上一层(nav.links)', (l2 || '').startsWith('nav.links  '), `label=${JSON.stringify(l2)}`)
    await send({ type: 'mouseMove', x: cx + 2, y: cy })
    await sleep(200)
    // 同一个元素上挪一点不回落(depth 只在换元素时清零)→ 移到另一个元素再回来
    const r0 = await rectOf('a.btn')
    await send({ type: 'mouseMove', x: Math.round(r0.x + 5), y: Math.round(r0.y + 5) })
    await sleep(120)
    await send({ type: 'mouseMove', x: cx, y: cy })
    await sleep(200)
    const l3 = await label()
    check('P3b 换个元素再回来 → 回到指针下那个', (l3 || '').startsWith('a.btn  '), `label=${JSON.stringify(l3)}`)
    await send({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
    await send({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
    let after = before
    for (let i = 0; i < 60; i++) { after = await tiles(); if (after.length > before.length) break; await sleep(100) }
    const page = await inGuest('({ clicks: window.__clicks, downs: window.__downs, hash: location.hash, overlay: !!document.querySelector("forsion-pick"), mainWorld: typeof window.__forsionPick, tangu: typeof window.tangu })')
    check('P4a 网页自己的点击 / 按下处理器没被触发,也没跟着链接跳', page.clicks === 0 && page.downs === 0 && page.hash === '', JSON.stringify(page))
    check('P4b 高亮罩撤掉,按钮弹起', !page.overlay && (await pressed()) === 'false', `overlay=${page.overlay} pressed=${await pressed()}`)
    const tile = after[after.length - 1]
    check('P4c 输入框多一张元素磁贴', after.length === before.length + 1, JSON.stringify(after))
    check('P4d 磁贴标题 = 元素文字(引号)', tile?.head === '「Download for macOS」', `head=${tile?.head}`)
    check('P4e 副行 = 网页元素 · 选择器 · 域名(生成的 id 不进选择器)', tile?.sub === `网页元素 · a.btn:nth-of-type(2) · ${host}`, `sub=${tile?.sub}`)
    await sleep(300)
    await captureWindow(app, path.join(dir, 'tile-light.png'))
    check('P7 点选脚本在独立世界:主世界看不到 __forsionPick;guest 没有 window.tangu', page.mainWorld === 'undefined' && page.tangu === 'undefined', JSON.stringify(page))

    // ── P5:Esc 取消(键盘落在 guest)
    await win.click('[data-press="pick"]')
    for (let i = 0; i < 20 && (await label()) === null; i++) await sleep(100)
    await send({ type: 'mouseMove', x: cx, y: cy })
    await sleep(150)
    await send({ type: 'keyDown', keyCode: 'Escape' })
    await send({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(400)
    const t5 = await tiles()
    check('P5a guest 里 Esc → 取消:没多磁贴、罩撤掉、按钮弹起', t5.length === after.length && (await label()) === null && (await pressed()) === 'false', `tiles=${t5.length} pressed=${await pressed()}`)
    // 焦点在宿主时的 Esc(按完键点回地址栏)
    await win.click('[data-press="pick"]')
    for (let i = 0; i < 20 && (await label()) === null; i++) await sleep(100)
    await win.focus('input[placeholder="输入网址或搜索词"]').catch(() => {})
    await win.keyboard.press('Escape')
    await sleep(400)
    check('P5b 焦点在宿主时 Esc 也能取消', (await label()) === null && (await pressed()) === 'false', `pressed=${await pressed()}`)
    // 再按一次点选键 = 取消
    await win.click('[data-press="pick"]')
    for (let i = 0; i < 20 && (await label()) === null; i++) await sleep(100)
    await win.click('[data-press="pick"]')
    await sleep(400)
    check('P5c 再按一次点选键 = 取消', (await label()) === null && (await pressed()) === 'false')

    // ── P7b:页面脚本伪造的点击 / 按键不算数(isTrusted=false)
    await win.click('[data-press="pick"]')
    for (let i = 0; i < 20 && (await label()) === null; i++) await sleep(100)
    await send({ type: 'mouseMove', x: cx, y: cy })
    await sleep(150)
    const n7 = (await tiles()).length
    await inGuest(`(() => {
      const o = { bubbles: true, cancelable: true, clientX: ${cx}, clientY: ${cy}, button: 0 }
      window.dispatchEvent(new MouseEvent('click', o))
      document.querySelector('forsion-pick')?.dispatchEvent(new MouseEvent('click', o))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })()`)
    await sleep(500)
    check('P7b 页面合成的 click / Esc 不触发点选也不取消', (await tiles()).length === n7 && (await pressed()) === 'true' && (await label()) !== null, `tiles=${(await tiles()).length} pressed=${await pressed()}`)
    await send({ type: 'keyDown', keyCode: 'Escape' })
    await sleep(400)

    // ── P6:发出去
    const runsBefore = stub.seen.runs.length
    const sent = await win.evaluate(() => {
      const card = [...document.querySelectorAll('[data-element-target]')].find((c) => c.querySelector('.att-tile--element') && c.getClientRects().length)
      const ta = card?.querySelector('textarea')
      if (!ta) return false
      ta.focus()
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, 'Make this button not wrap')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })
    await sleep(200)
    if (sent) await win.keyboard.press('Enter')
    for (let i = 0; i < 60 && stub.seen.runs.length === runsBefore; i++) await sleep(100)
    const run = stub.seen.runs[stub.seen.runs.length - 1]
    const msg = (run && run.message) || ''
    check('P6a 正文:你写的在前,元素段带 URL / 选择器 / 文字', stub.seen.runs.length > runsBefore
      && msg.startsWith('Make this button not wrap')
      && msg.includes(`URL: ${base}/page.html`) && msg.includes('Selector: a.btn:nth-of-type(2)') && msg.includes('Text: "Download for macOS"'),
      JSON.stringify(msg).slice(0, 400))
    const shot = run && run.attachments && run.attachments.find((a) => /^element-/.test(a.name || ''))
    const c1 = shot && shot.data ? await blueShare(app, shot.data) : null
    const sf = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor)
    note('截图', JSON.stringify({ c1, element: { w: r.w, h: r.h }, scaleFactor: sf, size: shot && shot.size }))
    const near = (a, b) => Math.abs(a - b) <= Math.max(4, b * 0.08)
    // 截的就是那颗蓝按钮:蓝色占大半(圆角 / 白字占掉一些)。截偏 / 截成两倍大的一块时蓝色占比掉到三成以下
    check('P6b 附件里有一张元素截图,截的正是那颗按钮(尺寸 ≈ 元素 × 屏幕缩放,蓝色占大半)',
      !!c1 && near(c1.width, r.w * sf) && near(c1.height, r.h * sf) && c1.blue > 0.55, JSON.stringify({ name: shot && shot.name, c1 }))
    let left = await tiles()
    for (let i = 0; i < 30 && left.length; i++) { await sleep(100); left = await tiles() }
    check('P6c 发完磁贴清掉', left.length === 0, JSON.stringify(left))

    // ── P8:宿主缩放 110%(用户 dev 的设置,body 上的 CSS zoom)下点选,截图仍对准元素
    await win.evaluate(() => { document.body.style.zoom = '1.1'; window.dispatchEvent(new Event('resize')) })
    await sleep(800)
    await win.click('[data-press="pick"]')
    for (let i = 0; i < 20 && (await label()) === null; i++) await sleep(100)
    const rz = await rectOf('a.btn')
    const zx = Math.round(rz.x + rz.w / 2), zy = Math.round(rz.y + rz.h / 2)
    await send({ type: 'mouseMove', x: zx, y: zy })
    await sleep(250)
    const lz = await label()
    await send({ type: 'mouseDown', x: zx, y: zy, button: 'left', clickCount: 1 })
    await send({ type: 'mouseUp', x: zx, y: zy, button: 'left', clickCount: 1 })
    let tz = []
    for (let i = 0; i < 60; i++) { tz = await tiles(); if (tz.length) break; await sleep(100) }
    const runsZ = stub.seen.runs.length
    await win.evaluate(() => {
      const ta = [...document.querySelectorAll('[data-element-target]')].find((c) => c.querySelector('.att-tile--element') && c.getClientRects().length)?.querySelector('textarea')
      ta?.focus()
    })
    await win.keyboard.press('Enter')
    for (let i = 0; i < 60 && stub.seen.runs.length === runsZ; i++) await sleep(100)
    const runZ = stub.seen.runs[stub.seen.runs.length - 1]
    const shotZ = runZ && runZ.attachments && runZ.attachments.find((a) => /^element-/.test(a.name || ''))
    const cz = shotZ && shotZ.data ? await blueShare(app, shotZ.data) : null
    note('110% 截图', JSON.stringify({ label: lz, tile: tz[0], rect: rz, cz }))
    check('P8 宿主 110% 缩放下:悬停对准、磁贴挂上、截图仍是那颗按钮', (lz || '').startsWith('a.btn') && tz.length === 1 && stub.seen.runs.length > runsZ && !!cz && cz.blue > 0.55,
      JSON.stringify({ lz, tz: tz.length, cz }))
    await win.evaluate(() => { document.body.style.zoom = ''; window.dispatchEvent(new Event('resize')) })
    await sleep(400)

    // ── 暗色截图(宿主暗色 + 暗底网页)
    await app.evaluate(({ BrowserWindow }, u) => BrowserWindow.getAllWindows()[0].webContents.send('app:open-url', u, true), `${base}/dark.html`)
    let g2 = null
    for (let i = 0; i < 80; i++) {
      g2 = await app.evaluate(({ webContents }, b) => {
        const x = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().startsWith(b + '/dark'))
        return x ? { id: x.id, loading: x.isLoading() } : null
      }, base)
      if (g2 && !g2.loading) break
      await sleep(150)
    }
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await sleep(600)
    if (g2) {
      await win.evaluate(() => [...document.querySelectorAll('[data-press="pick"]')].filter((b) => b.getClientRects().length).pop()?.click())
      await sleep(400)
      const rd = await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript(`(() => { const r = document.querySelectorAll('a.btn')[1].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`), g2.id)
      await app.evaluate(({ webContents }, a) => webContents.fromId(a.id).sendInputEvent({ type: 'mouseMove', x: Math.round(a.x), y: Math.round(a.y) }), { id: g2.id, ...rd })
      await sleep(300)
      await captureWindow(app, path.join(dir, 'pick-dark.png'))
      await app.evaluate(({ webContents }, id) => webContents.fromId(id).sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }), g2.id)
    }
    note('截图', dir)
  } finally {
    await env.close()
    srv.close()
  }
  process.exit(rep.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
