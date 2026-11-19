// ctx.ui.capture / ctx.ui.record 的真 Electron 仪器(2026-11-19,演示插件第二期的底座)。
// 样例插件 scripts/fixtures/plugin-capture-sample(四角纯色 + 每 50ms 变一次的计数器)与 plugin-capture-other(别的插件的视图)
// 装进隔离 home,在真主进程 capturePage 上量:
//   出图 —— 像素尺寸 = 元素 CSS 尺寸 × 屏幕密度、四个角是四种纯色(反向验:矩形挪 50px 角就对不上)、scale 只降不升、
//            webContents 缩放 1.1(⌘=)与 body CSS zoom 1.1(界面缩放)下照样对得上;
//   拒绝 —— 宿主元素 / 别的插件的视图(not-owned)、半截滚出滚动容器(clipped,滚进来就放行)、被宿主之外的层盖住(covered)、
//            自己的浮层 / 右键菜单盖着不算、脱离文档(detached);
//   录屏 —— 2.5s 录像能解码、尺寸对、时长对、至少 N 个不同的帧;同窗第二段 busy;cancel 得 null;maxSeconds 自停后 stop() 照样拿到;
//            指定 WebM 得 WebM。实测帧率记 NOTE。
// 跑法(先 npx electron-vite build):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="plugin capture" --eta=4 -- node scripts/plugin-capture.check.cjs
// 产物:$PCAP_OUT(缺省系统临时目录下 plugin-capture/)里的 png / 视频 + results.json;有断言不过时退出码 1。
const fs = require('fs'), os = require('os'), path = require('path')
const { launch, boot, sleep } = require('./lib/uiux-electron.cjs')

const FIX = path.join(__dirname, 'fixtures')
const OUT = process.env.PCAP_OUT || path.join(os.tmpdir(), 'plugin-capture')
fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }
const note = (name, detail) => { results.push({ name, note: true, detail }); console.log('NOTE', name, JSON.stringify(detail)) }

// ── 页面里跑的工具(win.evaluate 的函数体自带,不依赖外部闭包)──
/** 截一张 + 在页面里解码 PNG、读四个角(各自往里缩 10 CSS px)和中间计数器那块有没有非白像素。 */
const shootStage = async ({ sel, scale, raw }) => {
  const ctx = window.__pcap.ctx
  const el = document.querySelector(sel)
  const r = el.getBoundingClientRect()
  let res
  if (raw) {
    // 反向验:绕过 ctx 直接问主进程,矩形挪 raw px —— 角上该对不上
    const rep = await window.tangu.captureRegion({ rect: { x: r.left + raw, y: r.top + raw, width: r.width, height: r.height }, format: 'png' })
    if (!rep.ok) return { err: rep.code }
    res = { bytes: rep.data, width: rep.width, height: rep.height, scale: rep.width / r.width }
  } else {
    try { res = await ctx.ui.capture(el, scale ? { scale } : undefined) } catch (e) { return { err: e.code || String(e) } }
  }
  const bmp = await createImageBitmap(new Blob([res.bytes], { type: 'image/png' }))
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
  const g = c.getContext('2d'); g.drawImage(bmp, 0, 0)
  const k = bmp.width / r.width
  const px = (x, y) => Array.from(g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3))
  const W = r.width, H = r.height
  const mid = g.getImageData(Math.round(60 * k), Math.round(90 * k), Math.round(120 * k), Math.round(64 * k)).data
  let dark = 0; for (let i = 0; i < mid.length; i += 4) if (mid[i] < 80 && mid[i + 1] < 80 && mid[i + 2] < 80) dark++
  let b64 = ''; const u8 = res.bytes; for (let i = 0; i < u8.length; i += 0x8000) b64 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return {
    width: res.width, height: res.height, scale: res.scale, pngW: bmp.width, pngH: bmp.height, css: { w: W, h: H }, dpr: devicePixelRatio,
    tl: px(10, 10), tr: px(W - 10, 10), bl: px(10, H - 10), br: px(W - 10, H - 10), dark, png: btoa(b64),
  }
}
const near = (p, q, tol = 40) => !!p && p.every((v, i) => Math.abs(v - q[i]) <= tol)
const cornersOk = (s) => near(s.tl, [255, 0, 0]) && near(s.tr, [0, 255, 0]) && near(s.bl, [0, 0, 255]) && near(s.br, [255, 255, 0])
const corners = (s) => ({ tl: s.tl, tr: s.tr, bl: s.bl, br: s.br })

/** 期望的 ctx.ui.capture 拒绝码。setup 返回要截的元素选择器或直接元素;cleanup 可选。 */
const refuse = async (win, label, fn, want) => {
  const got = await win.evaluate(fn)
  check(`refuse: ${label} → ${want}`, got === want, got)
}

;(async () => {
  const ctx = await launch({
    tag: 'pcap', overrideHome: true,
    beforeLaunch: ({ home }) => {
      for (const p of ['plugin-capture-sample', 'plugin-capture-other']) fs.cpSync(path.join(FIX, p), path.join(home, 'plugins', p), { recursive: true })
    },
  })
  const { app, win } = ctx
  let failed = false
  try {
    await boot(app, win, { space: 'pcap', width: 1400, height: 900 })
    await win.waitForSelector('[data-pc="stage"]', { timeout: 30_000 })
    await win.waitForSelector('[data-pc-other]', { timeout: 30_000 }).catch(() => {})
    await win.mouse.move(1390, 890)
    await sleep(800)
    const has = await win.evaluate(() => ({ capture: typeof window.__pcap?.ctx?.ui?.capture, record: typeof window.__pcap?.ctx?.ui?.record }))
    check('ctx.ui.capture / record exist on the desktop host', has.capture === 'function' && has.record === 'function', has)

    // ── 出图 ──
    const a =await win.evaluate(shootStage, { sel: '[data-pc="stage"]' })
    if (a.png) fs.writeFileSync(path.join(OUT, 'stage.png'), Buffer.from(a.png, 'base64'))
    check('capture: PNG size = element CSS size × screen density', !a.err && a.width === Math.round(480 * a.dpr) && a.height === Math.round(300 * a.dpr) && a.pngW === a.width && a.scale === a.dpr,
      { err: a.err, width: a.width, height: a.height, dpr: a.dpr, scale: a.scale })
    check('capture: the four corners are the four solid colours (the element, nothing around it)', cornersOk(a), corners(a))
    check('capture: the counter is drawn (not a blank frame)', a.dark > 200, a.dark)
    const shifted = await win.evaluate(shootStage, { sel: '[data-pc="stage"]', raw: 50 })
    check('reverse: the same check on a rect shifted 50px goes red', !shifted.err && !cornersOk(shifted), corners(shifted))
    const one = await win.evaluate(shootStage, { sel: '[data-pc="stage"]', scale: 1 })
    check('capture: scale 1 → CSS-pixel size', one.width === 480 && one.height === 300 && cornersOk(one), { w: one.width, h: one.height, err: one.err })
    const up = await win.evaluate(shootStage, { sel: '[data-pc="stage"]', scale: 8 })
    check('capture: scale above the screen density does not invent pixels', up.width === a.width && up.scale === a.dpr, { w: up.width, scale: up.scale })

    // webContents 缩放 1.1(⌘=)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.1))
    await sleep(800)
    const z = await win.evaluate(shootStage, { sel: '[data-pc="stage"]' })
    check('capture under webContents zoom 1.1: corners still match, size follows the density', !z.err && cornersOk(z) && Math.abs(z.width - 480 * z.dpr) <= 1, { err: z.err, w: z.width, dpr: z.dpr, ...corners(z) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    await sleep(500)
    // body CSS zoom 1.1(界面缩放 / 网页端缺省)
    await win.evaluate(() => { document.body.style.zoom = '1.1' })
    await sleep(800)
    const bz = await win.evaluate(shootStage, { sel: '[data-pc="stage"]' })
    check('capture under body CSS zoom 1.1: corners still match', !bz.err && cornersOk(bz), { err: bz.err, w: bz.width, ...corners(bz) })
    await win.evaluate(() => { document.body.style.zoom = '' })
    await sleep(500)

    // ── 拒绝 ──
    await refuse(win, 'a host element (ribbon / root)', async () => {
      const el = document.querySelector('.rb-space') || document.querySelector('#root')
      try { await window.__pcap.ctx.ui.capture(el); return 'resolved' } catch (e) { return e.code }
    }, 'not-owned')
    await refuse(win, "another plugin's view", async () => {
      try { await window.__pcap.ctx.ui.capture(document.querySelector('[data-pc-other]')); return 'resolved' } catch (e) { return e.code }
    }, 'not-owned')
    await refuse(win, 'an element half scrolled out of its scroller', async () => {
      const s = document.querySelector('[data-pc="scroller"]'); s.scrollTop = 0
      try { await window.__pcap.ctx.ui.capture(document.querySelector('[data-pc="half"]')); return 'resolved' } catch (e) { return e.code }
    }, 'clipped')
    const scrolledIn = await win.evaluate(async () => {
      const s = document.querySelector('[data-pc="scroller"]'); s.scrollTop = 60
      await new Promise((r) => setTimeout(r, 100))
      try { const r = await window.__pcap.ctx.ui.capture(document.querySelector('[data-pc="half"]')); return r.width } catch (e) { return e.code }
    })
    check('positive control: scrolled fully into view → captured', typeof scrolledIn === 'number', scrolledIn)
    await refuse(win, 'a layer that is not the plugin\'s lies on top', async () => {
      const r = document.querySelector('[data-pc="stage"]').getBoundingClientRect()
      const cover = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'pcap-cover' }))
      Object.assign(cover.style, { position: 'fixed', left: `${r.left + 200}px`, top: `${r.top + 100}px`, width: '200px', height: '150px', background: '#888', zIndex: 99999 })
      try { await window.__pcap.ctx.ui.capture(document.querySelector('[data-pc="stage"]')); return 'resolved' } catch (e) { return e.code } finally { cover.remove() }
    }, 'covered')
    const ownFloat = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const f = ctx.ui.float({ scope: 'window', anchor: 'top-start' })
      f.el.innerHTML = '<div style="width:300px;height:200px;background:#123456"></div>'
      await new Promise((r) => setTimeout(r, 600))
      const stage = document.querySelector('[data-pc="stage"]').getBoundingClientRect(), fr = f.el.getBoundingClientRect()
      const overlaps = fr.left < stage.right && fr.right > stage.left && fr.top < stage.bottom && fr.bottom > stage.top
      let stageRes, floatRes
      try { stageRes = (await ctx.ui.capture(document.querySelector('[data-pc="stage"]'))).width } catch (e) { stageRes = e.code }
      try { floatRes = (await ctx.ui.capture(f.el)).width } catch (e) { floatRes = e.code }
      f.close()
      return { overlaps, stageRes, floatRes }
    })
    check('own window-scope float: capturable itself', typeof ownFloat.floatRes === 'number', ownFloat)
    if (ownFloat.overlaps) check('own float on top of the stage does not count as covered', typeof ownFloat.stageRes === 'number', ownFloat)
    else note('own float did not overlap the stage (anchor placement); covered-by-own-float checked in unit tests', ownFloat)
    const ownMenu = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const stage = document.querySelector('[data-pc="stage"]'), r = stage.getBoundingClientRect()
      const close = ctx.ui.contextMenu(r.left + 200, r.top + 60, [{ label: 'One', run() {} }, { label: 'Two', run() {} }, { label: 'Three', run() {} }])
      await new Promise((res) => setTimeout(res, 500))
      const menuUp = !!document.elementFromPoint(r.left + 230, r.top + 80)?.closest('[role="menu"], .ui-menu, .lcl-menu, .ctx-menu')
      let out; try { out = (await ctx.ui.capture(stage)).width } catch (e) { out = e.code }
      close()
      return { out, menuUp }
    })
    check('own context menu open over the stage: not covered', typeof ownMenu.out === 'number', ownMenu)
    await refuse(win, 'a detached element', async () => {
      try { await window.__pcap.ctx.ui.capture(document.createElement('div')); return 'resolved' } catch (e) { return e.code }
    }, 'detached')
    const typeErr = await win.evaluate(() => { try { window.__pcap.ctx.ui.capture('nope'); return 'no throw' } catch (e) { return e.name } })
    check('a non-element throws TypeError synchronously', typeErr === 'TypeError', typeErr)

    // ── 录屏 ──
    const rec = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const stage = document.querySelector('[data-pc="stage"]')
      const t0 = performance.now()
      const r = await ctx.ui.record(stage, { fps: 30, maxSeconds: 20 })
      const startMs = performance.now() - t0
      let busy; try { await ctx.ui.record(stage); busy = 'resolved' } catch (e) { busy = e.code }
      await new Promise((res) => setTimeout(res, 2500))
      const res = await r.stop()
      const again = await r.stop()
      // 解码:<video> 读尺寸 / 时长,逐个时刻画进 canvas,数计数器那块有几种不同的画面
      const url = URL.createObjectURL(new Blob([res.bytes], { type: res.mime }))
      const v = document.createElement('video'); v.muted = true; v.src = url
      await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('decode failed: ' + (v.error && v.error.message))) })
      let duration = v.duration
      if (!Number.isFinite(duration)) { v.currentTime = 1e6; await new Promise((ok) => { v.onseeked = ok }); duration = v.duration; v.currentTime = 0 }
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
      const g = c.getContext('2d', { willReadFrequently: true })
      const k = v.videoWidth / 480
      const seen = new Set()
      const times = Array.from({ length: 10 }, (_, i) => (duration * (i + 0.5)) / 10)
      let tl = null
      for (const t of times) {
        v.currentTime = t; await new Promise((ok) => { v.onseeked = ok })
        g.drawImage(v, 0, 0)
        const d = g.getImageData(Math.round(60 * k), Math.round(90 * k), Math.round(240 * k), Math.round(140 * k)).data
        let h = 0; for (let i = 0; i < d.length; i += 64) h = (h * 31 + (d[i] >> 4)) | 0
        seen.add(h)
        if (!tl) tl = Array.from(g.getImageData(Math.round(10 * k), Math.round(10 * k), 1, 1).data.slice(0, 3))
      }
      URL.revokeObjectURL(url)
      let b64 = ''; const u8 = res.bytes; for (let i = 0; i < u8.length; i += 0x8000) b64 += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
      return { startMs, busy, mime: res.mime, width: res.width, height: res.height, frames: res.frames, durationMs: res.durationMs, stoppedBy: res.stoppedBy,
        sameAgain: again === res, bytes: res.bytes.length, vw: v.videoWidth, vh: v.videoHeight, duration, distinct: seen.size, tl, dpr: devicePixelRatio, video: btoa(b64) }
    })
    const ext = /mp4/.test(rec.mime) ? 'mp4' : 'webm'
    if (rec.video) fs.writeFileSync(path.join(OUT, `stage.${ext}`), Buffer.from(rec.video, 'base64'))
    delete rec.video
    note('record: measured', { mime: rec.mime, frames: rec.frames, durationMs: rec.durationMs, fps: Math.round((rec.frames / rec.durationMs) * 1000 * 10) / 10, bytes: rec.bytes, startMs: Math.round(rec.startMs), size: `${rec.width}x${rec.height}` })
    check('record: default format is MP4 / H.264', /^video\/mp4/.test(rec.mime), rec.mime)
    check('record: second recording in the same window → busy', rec.busy === 'busy', rec.busy)
    const ew = Math.floor((480 * rec.dpr) / 2) * 2, eh = Math.floor((300 * rec.dpr) / 2) * 2
    check('record: frame size = element × density (even), decoder agrees', rec.width === ew && rec.height === eh && rec.vw === rec.width && rec.vh === rec.height, { w: rec.width, h: rec.height, vw: rec.vw, vh: rec.vh, ew, eh })
    check('record: decoded duration ≈ 2.5 s', rec.duration > 1.8 && rec.duration < 3.6, rec.duration)
    check('record: at least 6 distinct frames out of 10 samples (the counter moves)', rec.distinct >= 6, rec.distinct)
    check('record: at least 20 frames captured in 2.5 s', rec.frames >= 20, rec.frames)
    check('record: video shows the element (red top-left corner)', near(rec.tl, [255, 0, 0], 60), rec.tl)
    check('record: stop() twice returns the same result; stoppedBy = stop', rec.sameAgain && rec.stoppedBy === 'stop', { sameAgain: rec.sameAgain, stoppedBy: rec.stoppedBy })

    const misc = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const stage = document.querySelector('[data-pc="stage"]')
      const r1 = await ctx.ui.record(stage, { maxSeconds: 1 })
      const auto = await r1.done
      const after = await r1.stop()
      const r2 = await ctx.ui.record(stage)
      r2.cancel()
      const cancelled = await r2.done
      const r3 = await ctx.ui.record(stage, { mimeType: 'video/webm;codecs=vp9', fps: 15 })
      await new Promise((res) => setTimeout(res, 800))
      const webm = await r3.stop()
      let bad; try { await ctx.ui.record(stage, { mimeType: 'video/x-nope' }); bad = 'resolved' } catch (e) { bad = e.code }
      let clipped; try { const s = document.querySelector('[data-pc="scroller"]'); s.scrollTop = 0; await ctx.ui.record(document.querySelector('[data-pc="half"]')); clipped = 'resolved' } catch (e) { clipped = e.code }
      return { autoBy: auto && auto.stoppedBy, autoMs: auto && auto.durationMs, afterSame: after === auto, cancelled, webmMime: webm && webm.mime, webmBytes: webm && webm.bytes.length, bad, clipped }
    })
    check('record: maxSeconds stops it by itself; stop() afterwards returns that video', misc.autoBy === 'maxSeconds' && misc.autoMs >= 900 && misc.autoMs < 2500 && misc.afterSame, misc)
    check('record: cancel() → done resolves null', misc.cancelled === null, misc.cancelled)
    check('record: mimeType video/webm;codecs=vp9 gives WebM', /^video\/webm/.test(misc.webmMime || '') && misc.webmBytes > 1000, { mime: misc.webmMime, bytes: misc.webmBytes })
    check('record: unknown mimeType → unsupported', misc.bad === 'unsupported', misc.bad)
    check('record: same visibility rules at the start (half scrolled out → clipped)', misc.clipped === 'clipped', misc.clipped)

    // 录屏画幅比原生小:主进程先缩再送(scale 1 在 Retina 上 = 一半)
    const low = await win.evaluate(async () => {
      const stage = document.querySelector('[data-pc="stage"]')
      const r = await window.__pcap.ctx.ui.record(stage, { scale: 1 })
      await new Promise((res) => setTimeout(res, 1500))
      const out = await r.stop()
      const url = URL.createObjectURL(new Blob([out.bytes], { type: out.mime }))
      const v = document.createElement('video'); v.muted = true; v.src = url
      await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('decode failed')) })
      v.currentTime = 0.5; await new Promise((ok) => { v.onseeked = ok })
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0)
      const tl = Array.from(g.getImageData(10, 10, 1, 1).data.slice(0, 3))
      URL.revokeObjectURL(url)
      return { w: out.width, h: out.height, vw: v.videoWidth, vh: v.videoHeight, frames: out.frames, durationMs: out.durationMs, tl }
    })
    check('record scale 1: 480×300 video (resized in main before IPC), red top-left, frames flowing', low.w === 480 && low.h === 300 && low.vw === 480 && near(low.tl, [255, 0, 0], 60) && low.frames >= 20, low)
    // 奇数尺寸元素:画幅取偶数,和原生差一两像素 → 主进程不缩、渲染层吸收(记帧率)
    const odd = await win.evaluate(async () => {
      const stage = document.querySelector('[data-pc="stage"]')
      stage.style.width = '481px'; stage.style.height = '301px'
      await new Promise((res) => setTimeout(res, 200))
      try {
        const r = await window.__pcap.ctx.ui.record(stage, { scale: 1 })
        await new Promise((res) => setTimeout(res, 1500))
        const out = await r.stop()
        return { size: `${out.width}x${out.height}`, frames: out.frames, fps: Math.round((out.frames / out.durationMs) * 10000) / 10 }
      } finally { stage.style.width = '480px'; stage.style.height = '300px' }
    })
    check('record an odd-sized element (481×301 at scale 1): even frame, frames flowing', odd.size === '480x300' && odd.frames >= 20, odd)
    note('record: odd-sized element at scale 1', odd)

    // 自己开的对话框 / popover / 确认框:里面的元素能截,盖在视图上也不算挡
    const dlg = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const h = ctx.ui.openDialog({ title: 'Capture dialog', mount(el) { el.innerHTML = '<div data-pc="dlg" style="width:200px;height:80px;background:#00aa00"></div>' } })
      await new Promise((res) => setTimeout(res, 600))
      let inner, under
      try { inner = (await ctx.ui.capture(document.querySelector('[data-pc="dlg"]'))).width } catch (e) { inner = e.code }
      try { under = (await ctx.ui.capture(document.querySelector('[data-pc="stage"]'))).width } catch (e) { under = e.code }
      h.close()
      await new Promise((res) => setTimeout(res, 400))
      return { inner, under }
    })
    check('own openDialog: its content is capturable, and it does not count as covering the view', typeof dlg.inner === 'number' && typeof dlg.under === 'number', dlg)
    const pop = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const anchor = document.querySelector('[data-pc="count"]')
      const h = ctx.ui.popover(anchor, { mount(el) { el.innerHTML = '<div data-pc="pop" style="width:160px;height:60px;background:#aa00aa"></div>' } })
      await new Promise((res) => setTimeout(res, 600))
      let inner, under
      try { inner = (await ctx.ui.capture(document.querySelector('[data-pc="pop"]'))).width } catch (e) { inner = e.code }
      try { under = (await ctx.ui.capture(document.querySelector('[data-pc="stage"]'))).width } catch (e) { under = e.code }
      h.dispose()
      await new Promise((res) => setTimeout(res, 300))
      return { inner, under }
    })
    check('own popover: its content is capturable, and it does not count as covering the view', typeof pop.inner === 'number' && typeof pop.under === 'number', pop)
    const conf = await win.evaluate(async () => {
      const ctx = window.__pcap.ctx
      const answer = ctx.ui.confirm({ title: 'Capture confirm' })
      await new Promise((res) => setTimeout(res, 600))
      let under; try { under = (await ctx.ui.capture(document.querySelector('[data-pc="stage"]'))).width } catch (e) { under = e.code }
      window.__pcapConfirm = answer
      return { under, open: !!document.querySelector('dialog[open]') }
    })
    await win.keyboard.press('Escape')
    await sleep(400)
    check('own confirm dialog open over the view: not covered', typeof conf.under === 'number' && conf.open, conf)

    // 大块区域的实测帧率(只记不判):整个插件视图容器,原生密度
    const big = await win.evaluate(async () => {
      const host = document.querySelector('[data-pc="stage"]').closest('[data-plugin-view-host]')
      const r = await window.__pcap.ctx.ui.record(host, { fps: 30 })
      await new Promise((res) => setTimeout(res, 2000))
      const out = await r.stop()
      return out && { size: `${out.width}x${out.height}`, frames: out.frames, durationMs: out.durationMs, mb: Math.round(out.bytes.length / 1e4) / 100 }
    }).catch((e) => ({ err: String(e) }))
    note('record: whole plugin view at native density, fps 30 asked', big && big.frames ? { ...big, fps: Math.round((big.frames / big.durationMs) * 10000) / 10 } : big)

    // 自查截图:整窗一张(DESIGN §8:几何全绿 ≠ 看起来对)
    const full = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(OUT, 'window.png'), Buffer.from(full, 'base64'))
  } catch (e) {
    console.error(e)
    failed = true
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
    await ctx.close()
  }
  const bad = results.filter((r) => !r.note && !r.ok)
  console.log(`\n${results.filter((r) => !r.note).length - bad.length}/${results.filter((r) => !r.note).length} passed — artefacts in ${OUT}`)
  process.exit(failed || bad.length ? 1 : 0)
})()
