/**
 * 右下角界面缩放提示(uiZoom.ts showZoomHud)的真 Electron 检查:⌘= 弹出且显示比例、不吃 body zoom、
 * 点「重置」回 100% 并藏掉按钮、1.5s 后自己收起。截图落在 TANGU_HOME 下供肉眼复核。
 * 跑:npm run build && node scripts/zoom-hud.check.cjs   (隔离 TANGU_HOME,不碰真实数据)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.resolve(__dirname, '..')
let failed = 0
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-zoomhud-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    const state = () => win.evaluate(() => {
      const h = document.querySelector('.ui-zoom-hud')
      if (!h) return null
      const r = h.getBoundingClientRect()
      return { parent: h.parentElement.tagName, open: h.hasAttribute('data-open'), pct: h.querySelector('.ui-zoom-hud-pct').textContent,
        resetHidden: h.querySelector('button').hidden, zoom: document.body.style.zoom, right: innerWidth - r.right, bottom: innerHeight - r.bottom }
    })
    await win.keyboard.press('Meta+Equal')
    await win.keyboard.press('Meta+Equal')
    await win.waitForTimeout(300)
    let s = await state()
    check('⌘= 后弹出、显示 120%', s?.open && s.pct === '120%' && s.zoom === '1.2', JSON.stringify(s))
    check('挂在 <html> 上、贴右下 16px(不吃 body zoom)', s?.parent === 'HTML' && Math.abs(s.right - 16) < 1 && Math.abs(s.bottom - 16) < 1)
    await win.screenshot({ path: path.join(home, 'zoom-hud.png') })
    await win.click('.ui-zoom-hud-reset')
    await win.waitForTimeout(200)
    s = await state()
    check('点重置回 100%、按钮藏起', s?.pct === '100%' && s.resetHidden && s.zoom === '', JSON.stringify(s))
    await win.mouse.move(10, 10)
    await win.waitForTimeout(2600)
    s = await state()
    check('移开后自动收起', s && !s.open, JSON.stringify(s))
    console.log('截图:', path.join(home, 'zoom-hud.png'))
  } finally {
    await app.close()
  }
  process.exit(failed ? 1 : 0)
})()
