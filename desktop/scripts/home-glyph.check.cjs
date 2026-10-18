/**
 * 主页主题背景「字阵」端到端契约(真 Electron + 假引擎 + 隔离 home,不碰用户数据)。
 * 方案:docs/ToBeImproved/主页插件化与美化方案_2026-10-17/code.html 的 C(只有涟漪,不和纹样联动 —— 10-17 用户定)。
 *
 * 判据全读真画布像素(.hpw-glyph-canvas 的 alpha 和、平均色),几何断言看不出这些:
 *  G1 画布铺满可见区域;字阵下四边的边缘模糊层不画
 *  G2 ⚠️静置是零帧:不碰它时画布一个像素都不变
 *  G3 在输入框打字,光标处亮起来;G4 1.5 秒后暗回静置
 *  G5 点空白处一圈;G6 点按钮不算空白处
 *  G7 输入框聚焦时字阵不被虚化(聚焦景深开着也一样)
 *  G8 切到暗色,字跟着换色(不用重开主页)
 *  G9 「动态效果」关掉 = 打字、点空白处都不响应
 *  G10 壁纸面板里五张主题背景,字阵那张缩略图有字
 *  G11 ⚠️从壁纸面板里选字阵(面板开着时聚焦景深把背景层放大 1.045、正在动画):画布尺寸仍按未变换的可见区域算
 *      (评审抓到的:按 getBoundingClientRect 定尺寸会大 4.5%,之后 ResizeObserver 不再来,字一直糊、涟漪落点偏)
 * 另存截图:亮 / 暗 / 青绿 · 暗的静置与打字、壁纸面板。
 *
 * 插件档(2026-10-18):HOME_PLUGIN_DIR=<Forsion-Home 检出,先 npm run build> 时字阵由插件 forsion-home 画(scripts/lib/home-plugin.cjs),
 *  另加 G0:正文真的来自插件(挂不上会悄悄退回内置主页,不核就是假绿)。
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:homeglyph(GUI 台架,建议走 node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run check:homeglyph)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { HOME_PLUGIN_DIR, installHomePlugin, homeBody } = require('./lib/home-plugin.cjs')

const ROOT = path.resolve(__dirname, '..')
const OUT = process.env.HOME_GLYPH_ARTIFACT_DIR || path.join(os.tmpdir(), 'forsion-home-glyph')
const W = 1512
const H = 950
const KEY = 'forsion.homepage.wallpaper.v1'
const LOOKS = { light: ['light', 'cream'], dark: ['dark', 'cream'], tealdark: ['dark', 'teal'] }
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

/** 画布像素:每 4 个像素取 1 个,alpha 和 + 有字像素的平均色。 */
const pixels = (win) => win.evaluate(() => {
  const c = document.querySelector('.hp-root .hpw-glyph-canvas')
  if (!c || !c.width) return null
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let a = 0; let n = 0; let r = 0; let g = 0; let b = 0
  for (let i = 3; i < d.length; i += 16) if (d[i]) { a += d[i]; n++; r += d[i - 3]; g += d[i - 2]; b += d[i - 1] }
  return { a, n, rgb: n ? [r / n, g / n, b / n].map(Math.round) : [0, 0, 0] }
})

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-home-glyph-'))
  installHomePlugin(home)
  const stub = await startStubEngine({ models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'stub', source: 'forsion', contextWindow: 272000 }] })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s.W, s.H) }, { W, H })
    await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.evaluate((u) => window.tangu.setConfig({ mode: 'external', backendUrl: u, token: 'home-glyph' }), stub.url)

    const setLook = (look) => win.evaluate(([m, s]) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark'); r.dataset.skin = s; r.dataset.bg = s }, LOOKS[look])
    const open = async (prefs) => {
      await win.evaluate(({ key, prefs, trial }) => {
        localStorage.setItem('forsion_tangu_active_space', 'home'); localStorage.setItem(key, JSON.stringify({ source: 'theme', themePreset: 'glyph', ...prefs }))
        if (trial) localStorage.setItem('forsion.dev.coreTrial', 'forsion-home')
      }, { key: KEY, prefs, trial: !!HOME_PLUGIN_DIR })
      await win.reload(); await win.waitForSelector(prefs.themePreset && prefs.themePreset !== 'glyph' ? '.hp-root .hp-wallpaper-art' : '.hp-root .hpw-glyph-canvas', { timeout: 30_000 })
      if (HOME_PLUGIN_DIR) bodies.push(await homeBody(win)) // 插件异步装上之前先露出的是内置那份:等它换过来再量
      await win.waitForTimeout(1200)
      await win.waitForSelector('.hp-composer .t2c-ta:not(:disabled)', { timeout: 10_000 }).catch(() => {})
      await win.mouse.move(W - 4, H - 4)
    }
    const shot = (name) => win.screenshot({ path: path.join(OUT, `${name}.png`) })
    const typeInto = async (text) => { await win.locator('.hp-composer .t2c-ta').click(); await win.keyboard.type(text, { delay: 90 }) }
    const clearComposer = async () => { await win.locator('.hp-composer .t2c-ta').fill(''); await win.mouse.click(W - 40, H - 30); await win.waitForTimeout(1500) }

    const bodies = []
    await open({ motion: true })
    if (HOME_PLUGIN_DIR) check('G0 插件档:字阵所在的主页来自插件 forsion-home', bodies[0] === 'plugin', JSON.stringify({ body: bodies[0], dir: HOME_PLUGIN_DIR }))
    await setLook('light'); await win.waitForTimeout(300)
    const geo = await win.evaluate(() => {
      const c = document.querySelector('.hp-root .hpw-glyph-canvas').getBoundingClientRect(); const a = document.querySelector('.hp-root .hp-wallpaper-art').getBoundingClientRect()
      return { dw: Math.abs(c.width - a.width), dh: Math.abs(c.height - a.height), edge: getComputedStyle(document.querySelector('.hp-root .hp-wallpaper-edge')).display }
    })
    check('G1 字阵铺满可见区域,边缘模糊层不画', geo.dw < 2 && geo.dh < 2 && geo.edge === 'none', JSON.stringify(geo))
    const rest = await pixels(win); await win.waitForTimeout(700); const rest2 = await pixels(win)
    check('G2 静置零帧:画布不变', rest && rest.a === rest2.a && rest.n === rest2.n, `${rest?.a} → ${rest2?.a}`)
    await shot('rest-light')

    await typeInto('帮我整理')
    const typed = await pixels(win)
    check('G3 打字时光标处亮起来', typed.a > rest.a * 1.01, `${rest.a} → ${typed.a}`)
    await shot('type-light')
    const blur = await win.evaluate(() => ({ focused: document.querySelector('.hp-root').classList.contains('hp-composer-focused'), filter: getComputedStyle(document.querySelector('.hp-root .hp-wallpaper-art')).filter }))
    check('G7 输入框聚焦时字阵不被虚化', blur.focused && blur.filter === 'none', JSON.stringify(blur))
    await win.waitForTimeout(1500)
    const settled = await pixels(win)
    check('G4 1.5 秒后暗回静置', Math.abs(settled.a - rest.a) <= rest.a * 0.002, `${rest.a} vs ${settled.a}`)
    await clearComposer()

    const base = await pixels(win)
    await win.mouse.click(Math.round(W * 0.16), Math.round(H * 0.3))
    await win.waitForTimeout(160)
    const clicked = await pixels(win)
    check('G5 点空白处一圈', clicked.a > base.a * 1.01, `${base.a} → ${clicked.a}`)
    await win.waitForTimeout(1500)
    const base2 = await pixels(win)
    await win.locator('.hp-wallpaper-button').click(); await win.waitForTimeout(160)
    const onButton = await pixels(win)
    check('G6 点按钮不算空白处', onButton.a === base2.a, `${base2.a} → ${onButton.a}`)
    await win.waitForSelector('.hp-wallpaper-sheet', { timeout: 5000 })
    const thumbs = await win.evaluate(() => {
      const presets = [...document.querySelectorAll('.hp-theme-presets button')].map((b) => b.dataset.preset)
      const c = document.querySelector('.hp-theme-preview[data-preset="glyph"] .hpw-glyph-canvas')
      let n = 0
      if (c && c.width) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) n++ }
      return { presets, n }
    })
    check('G10 壁纸面板五张主题背景,字阵缩略图有字', thumbs.presets.join() === 'orbit,path,paper,rings,glyph' && thumbs.n > 50, JSON.stringify(thumbs))
    await shot('sheet-light')
    await setLook('dark'); await win.waitForTimeout(400); await shot('sheet-dark')
    await win.keyboard.press('Escape'); await win.mouse.click(W - 40, H - 30); await win.waitForTimeout(1500)

    const dark = await pixels(win)
    check('G8 切到暗色字跟着换色', rest.rgb[0] < 128 && dark.rgb[0] > 128, `${rest.rgb} → ${dark.rgb}`)
    await shot('rest-dark')
    await typeInto('帮我整理这周'); await shot('type-dark'); await clearComposer()
    await setLook('tealdark'); await win.waitForTimeout(400)
    await typeInto('帮我整理这周'); await shot('type-tealdark'); await clearComposer()

    await open({ motion: false })
    await setLook('dark'); await win.waitForTimeout(400)
    const off0 = await pixels(win)
    await typeInto('帮我整理'); const off1 = await pixels(win)
    await win.mouse.click(Math.round(W * 0.16), Math.round(H * 0.3)); await win.waitForTimeout(160); const off2 = await pixels(win)
    check('G9 动态效果关掉:打字、点空白处都不响应', off0.a === off1.a && off0.a === off2.a, `${off0.a} / ${off1.a} / ${off2.a}`)

    await open({ themePreset: 'orbit', motion: true, focusBlur: true })
    await setLook('light'); await win.waitForTimeout(300)
    await win.locator('.hp-wallpaper-button').click(); await win.waitForSelector('.hp-wallpaper-sheet', { timeout: 5000 }); await win.waitForTimeout(700)
    await win.locator('.hp-theme-presets button[data-preset="glyph"]').click(); await win.waitForTimeout(900)
    const size = () => win.evaluate(() => {
      const art = document.querySelector('.hp-root .hp-wallpaper-art'); const c = document.querySelector('.hp-root .hpw-glyph-canvas')
      const want = [Math.round(art.clientWidth * (art.currentCSSZoom || 1) * devicePixelRatio), Math.round(art.clientHeight * (art.currentCSSZoom || 1) * devicePixelRatio)]
      return { got: c ? [c.width, c.height] : null, want }
    })
    const inSheet = await size()
    await win.keyboard.press('Escape'); await win.waitForTimeout(900)
    const afterSheet = await size()
    const same = (x) => x.got && x.got[0] === x.want[0] && x.got[1] === x.want[1]
    check('G11 从壁纸面板里选字阵,画布尺寸按未变换的可见区域', same(inSheet) && same(afterSheet), JSON.stringify({ inSheet, afterSheet }))
    if (HOME_PLUGIN_DIR) check('G0b 插件档:三次重开主页都是插件画的', bodies.length === 3 && bodies.every((b) => b === 'plugin'), JSON.stringify(bodies))
  } finally {
    await app.close().catch(() => {}); stub.close?.()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图在 ${OUT}`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
