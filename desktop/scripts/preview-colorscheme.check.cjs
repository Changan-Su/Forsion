/**
 * 本地 HTML 预览的画布底色是否照页面自己的 color-scheme 画(2026-11-26 白屏取证)。
 *
 * 现象:页面根元素声明 `color-scheme: dark`、自己不设背景 —— 独立浏览器里是深底白字,Agent Desk 的预览格里整片白。
 * 根因:<webview> guest 缺省 `transparent: true`(Electron WebPreferences 文档原话:文字颜色仍按根元素的配色方案变,
 * 背景保持透明),宿主又给 webview 元素写死 `background: #fff` → 白字压白底。
 * 主进程 will-attach-webview 会删掉渲染层传的 webpreferences,所以开关只能在主进程那里给。
 *
 * 台架:真 Electron(已构建的 out/)× 隔离 home × 可编剧假引擎。三份夹具页:
 *   dark-min   :root{color-scheme:dark},无背景            ← 被测
 *   light-min  无 color-scheme,无背景                      ← 对照:哪里都应白底黑字
 *   dark-bg    :root{color-scheme:dark} + body 自己的深色背景 ← 对照:哪里都应深底
 * 每份在三处取样(整窗截图里按元素矩形裁,底色取右下角空白处,「墨量」= 与底色差得远的像素占比):
 *   desk-preview  Agent Desk 的 HTML 预览格(HtmlPreview → <webview>)
 *   desk-browser  Agent Desk 里的内置浏览器(同一个令牌地址)
 *   toplevel      同一个 Electron 里的顶层窗口直接开这个地址(= 独立浏览器的行为)
 * 外加宿主亮 / 暗两种主题各跑一遍。
 *
 * 断言:三处的底色深浅与 toplevel 一致,且 dark-min 在 Desk 两处墨量 > 0(看得见字)。
 *
 * 跑(经 devlock):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="预览 color-scheme" --eta=4 -- npm run check:previewscheme
 * 先 npm run build。DESK_DIR=<别的检出的 desktop 目录> 可拿另一份构建做对照(例如未修的 main)。截图写到 OUT(缺省临时目录)。
 */
const fs = require('fs'); const os = require('os'); const path = require('path')
const DESK = process.env.DESK_DIR ? path.resolve(process.env.DESK_DIR) : path.join(__dirname, '..')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const OUT = process.env.OUT || path.join(os.tmpdir(), 'preview-colorscheme-check'); fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const page = (title, css) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css} body{font:28px/1.4 system-ui,sans-serif;margin:24px}</style></head>` +
  `<body><h1>${title}</h1><p>This line has no background of its own.</p><p>这一行也没有自己的背景。</p></body></html>`
const FIX = {
  'dark-min': page('dark-min', ':root{color-scheme:dark}'),
  'light-min': page('light-min', ''),
  'dark-bg': page('dark-bg', ':root{color-scheme:dark} body{background:#203040}'),
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const isDark = (rgb) => lum(rgb) < 128

async function main() {
  if (!fs.existsSync(path.join(DESK, 'out/main/main.js'))) throw new Error(`先在 ${DESK} 跑 npm run build`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-previewscheme-'))
  const userData = path.join(home, 'userdata'); const vault = path.join(home, 'vault'); const proj = path.join(home, 'proj')
  for (const d of [userData, `${userData}-dev`, vault, proj]) fs.mkdirSync(d, { recursive: true })
  for (const [n, html] of Object.entries(FIX)) fs.writeFileSync(path.join(proj, `${n}.html`), html)
  const S = { id: 'pcs-s1', title: '预览配色', summary: '', archived: false, model_id: 'm1', project_path: proj, project_name: 'proj', projectless: false,
    agent_config: { execMode: 'host', cwd: proj }, created_at: '2026-11-26 10:00:00', updated_at: '2026-11-26 10:00:00' }
  const stub = await startStubEngine({
    sessions: [S], messages: [],
    override: async ({ path: route, method }) => {
      if (route === '/agent/runs' && method === 'GET') return { runs: [] }
      if (/^\/agent\/sessions\/[^/]+\/messages$/.test(route) && method === 'GET') return { messages: [] }
      return undefined
    },
  })
  for (const dir of [userData, `${userData}-dev`]) {
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ localVault: vault, lastVault: vault }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' },
  })
  const out = { desk: DESK, checks: [], samples: [], errors: [] }
  const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2))
  const check = (name, ok, got) => { out.checks.push({ name, ok: !!ok, got }); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(got ?? null).slice(0, 300)) }
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 900))
    await win.waitForSelector('#root', { timeout: 40_000 }); await sleep(2500)
    for (const l of ['跳过引导', 'Skip']) { const b = win.locator(`text=${l}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    win.setDefaultTimeout(5000)

    const send = async (text) => { const ta = win.locator('.t2c-ta').first(); await ta.click(); await ta.fill(text); await ta.press('Enter') }
    const present = async (views, text) => {
      stub.script([
        { type: 'status', payload: { phase: 'llm_call', stage: 'sending', iteration: 0 }, delay: 120 },
        { type: 'desk_present', payload: { views, size: 'wide' }, delay: 150 },
        { type: 'done', payload: { content: '' }, delay: 150 },
      ])
      await send(text); await sleep(3500)
    }
    const expand = async () => {
      const open = await win.evaluate(() => !!document.querySelector('.agent-desk.open'))
      if (!open) { await win.locator('.agent-desk-card button[title="展开"]').first().click().catch(() => {}); await sleep(1500) }
    }
    // 宿主整窗截图里按矩形裁:底色 = 右下角 8×8 均值;墨量 = 与底色亮度差 > 60 的像素占比
    const measureWin = (rect) => app.evaluate(async ({ BrowserWindow }, r) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible()) || BrowserWindow.getAllWindows()[0]
      const img = await w.capturePage({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) })
      const { width, height } = img.getSize(); const bm = img.toBitmap() // BGRA
      const px = (x, y) => { const i = (y * width + x) * 4; return [bm[i + 2], bm[i + 1], bm[i]] }
      const L = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
      let bg = [0, 0, 0], n = 0
      for (let y = height - 14; y < height - 6; y++) for (let x = width - 14; x < width - 6; x++) { const p = px(x, y); bg = bg.map((v, k) => v + p[k]); n++ }
      bg = bg.map((v) => Math.round(v / n))
      let ink = 0, tot = 0
      for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) { tot++; if (Math.abs(L(px(x, y)) - L(bg)) > 60) ink++ }
      return { bg, ink: +(ink / tot).toFixed(4), png: img.toPNG().toString('base64') }
    }, rect)
    const guestInfo = (needle) => app.evaluate(async ({ webContents }, nd) => {
      const g = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getType() === 'webview' && w.getURL().includes(nd))
      return Promise.all(g.map((w) => w.executeJavaScript(`(() => { const d = document.createElement('div'); d.style.background = 'Canvas'; document.documentElement.appendChild(d);
        const canvas = getComputedStyle(d).backgroundColor; d.remove(); const cs = getComputedStyle(document.documentElement);
        return { url: location.href, colorScheme: cs.colorScheme, rootBg: cs.backgroundColor, bodyBg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, canvas } })()`).catch((e) => ({ err: String(e) }))))
    }, needle)
    const deskWebviewRect = () => win.evaluate(() => {
      const vs = [...document.querySelectorAll('.agent-desk webview')].filter((v) => { const r = v.getBoundingClientRect(); return r.width > 50 && r.height > 50 })
      const v = vs[vs.length - 1]; if (!v) return null
      const r = v.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 420), src: v.getAttribute('src'), hostBg: getComputedStyle(v).backgroundColor }
    })
    const keep = (tag, m) => { const p = path.join(OUT, `${tag}.png`); fs.writeFileSync(p, Buffer.from(m.png, 'base64')); return p }
    const topLevel = (url) => app.evaluate(async ({ BrowserWindow }, u) => {
      const w = new BrowserWindow({ width: 700, height: 420, show: true, x: 40, y: 40, webPreferences: { sandbox: true } })
      await w.loadURL(u); await new Promise((r) => setTimeout(r, 900))
      const img = await w.capturePage(); w.destroy()
      const { width, height } = img.getSize(); const bm = img.toBitmap()
      const px = (x, y) => { const i = (y * width + x) * 4; return [bm[i + 2], bm[i + 1], bm[i]] }
      const L = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
      let bg = [0, 0, 0], n = 0
      for (let y = height - 14; y < height - 6; y++) for (let x = width - 14; x < width - 6; x++) { const p = px(x, y); bg = bg.map((v, k) => v + p[k]); n++ }
      bg = bg.map((v) => Math.round(v / n))
      let ink = 0, tot = 0
      for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) { tot++; if (Math.abs(L(px(x, y)) - L(bg)) > 60) ink++ }
      return { bg, ink: +(ink / tot).toFixed(4), png: img.toPNG().toString('base64') }
    }, url)

    for (const theme of ['light', 'dark']) {
      await win.evaluate((t) => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_theme_pref', t) }, theme)
      await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
      for (const name of Object.keys(FIX)) {
        const tag = `${theme}-${name}`
        try {
          await present([{ type: 'file', path: path.join(proj, `${name}.html`), name: `${name}.html` }], `show ${tag}`)
          await expand(); await sleep(1200)
          const r1 = await deskWebviewRect()
          if (!r1) { check(`${tag} Desk 预览格挂出了 webview`, false, null); continue }
          const url = r1.src.replace(/\?n=\d+$/, '')
          const m1 = await measureWin(r1); const g1 = await guestInfo(`${name}.html`)
          await present([{ type: 'view', view: 'browser', params: { url }, name: 'browser' }], `browser ${tag}`)
          await expand(); await sleep(2500)
          const r2 = await deskWebviewRect(); const m2 = r2 ? await measureWin(r2) : null
          const m3 = await topLevel(url)
          const s = { tag, url, hostBg: r1.hostBg, guest: g1[0] || null,
            preview: { bg: m1.bg, ink: m1.ink, shot: keep(`${tag}-desk-preview`, m1) },
            browser: m2 && { bg: m2.bg, ink: m2.ink, shot: keep(`${tag}-desk-browser`, m2) },
            toplevel: { bg: m3.bg, ink: m3.ink, shot: keep(`${tag}-toplevel`, m3) } }
          out.samples.push(s); save()
          console.log('SAMPLE', tag, JSON.stringify({ guest: s.guest, preview: s.preview.bg, pInk: s.preview.ink, browser: s.browser?.bg, bInk: s.browser?.ink, top: s.toplevel.bg, tInk: s.toplevel.ink }))
          check(`${tag} 预览格底色深浅 = 顶层窗口(${isDark(m3.bg) ? '深' : '浅'})`, isDark(m1.bg) === isDark(m3.bg), { preview: m1.bg, toplevel: m3.bg })
          check(`${tag} 内置浏览器底色深浅 = 顶层窗口`, m2 && isDark(m2.bg) === isDark(m3.bg), { browser: m2?.bg, toplevel: m3.bg })
          check(`${tag} 预览格看得见字(墨量 > 0.5%)`, m1.ink > 0.005, m1.ink)
          check(`${tag} 内置浏览器看得见字(墨量 > 0.5%)`, m2 && m2.ink > 0.005, m2?.ink)
        } catch (e) { out.errors.push({ tag, err: String(e && e.stack || e).slice(0, 600) }); console.log('ERROR', tag, String(e && e.message || e).slice(0, 300)) }
        save()
      }
    }
  } finally {
    save()
    await app.close().catch(() => {})
    try { await stub.close?.() } catch { /* 假引擎已停 */ }
  }
  const fail = out.checks.filter((c) => !c.ok).length
  console.log(`\n${out.checks.length - fail} passed / ${fail} failed / errors ${out.errors.length} → ${path.join(OUT, 'result.json')}`)
  process.exit(fail || out.errors.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
