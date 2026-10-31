// 目录水滴的帧间隔(真 Electron + 真 GPU 合成,不是无头):展开 / 收起各 12 遍,和同窗口闲置时比。融球滤镜贵在合成,
// 只有真窗口量得到;窗口被挡住或没聚焦时 rAF 会降频,所以先打印 visibilityState。用法:npm run build && node scripts/floating-toc-fps.probe.cjs
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const titles = ['同步冲突时按块合并的整体方案说明', '先比对块再比对整篇内容的理由', '离线编辑回到线上后的处理顺序']
const answer = (i) => [`## ${titles[i % 3]} ${i}`, '正文第一段,足够长,让它在聊天列里折成两行。'.repeat(3), `### 细节 ${i}`, '第二段。'].join('\n\n')
const messages = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: i % 2 ? answer(i) : `问题 ${i}`, timestamp: i + 1 }))

;(async () => {
  const { app, win, close } = await U.launch({ tag: 'ftocfps', messages })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 })
    await win.waitForSelector('.lcl-ftoc', { timeout: 15_000 })
    await sleep(1500)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus() })
    await sleep(400)
    const out = await win.evaluate(async () => {
      const stat = (a) => { const s = [...a].sort((x, y) => x - y); const at = (q) => +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1); return { n: a.length, p50: at(0.5), p95: at(0.95), max: +s[s.length - 1].toFixed(1), over20: a.filter((x) => x > 20).length, over34: a.filter((x) => x > 34).length } }
      const frames = (run, ms) => new Promise((res) => { const out = []; let last = performance.now(); const t0 = last; run(); const tick = (n) => { out.push(n - last); last = n; n - t0 < ms ? requestAnimationFrame(tick) : res(out.slice(1)) }; requestAnimationFrame(tick) })
      const wait = (m) => new Promise((r) => setTimeout(r, m))
      const hit = document.querySelector('.lcl-ftoc-hit'), info = { visibility: document.visibilityState, focus: document.hasFocus(), dpr: devicePixelRatio, size: [innerWidth, innerHeight] }
      const idle = await frames(() => {}, 1500), open = [], close = []
      for (let i = 0; i < 12; i++) {
        open.push(...await frames(() => hit.click(), 470)); await wait(150)
        if (!info.panel) { const r = document.querySelector('.lcl-ftoc-panel').getBoundingClientRect(); info.panel = [Math.round(r.width), Math.round(r.height)] }
        close.push(...await frames(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), 330)); await wait(250)
      }
      return { info, idle: stat(idle), open: stat(open), close: stat(close) }
    })
    console.log(JSON.stringify(out))
    await win.locator('.lcl-ftoc-hit').click()
    await sleep(210)
    await win.screenshot({ path: process.env.FTOC_SHOT || '/tmp/ftoc-pour.png' })
  } finally {
    await close()
  }
})().catch((error) => { console.error(error); process.exit(1) })
