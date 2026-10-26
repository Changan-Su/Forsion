/**
 * 真 Electron:走查续八 8.13 的两处宿主 CSS(方案页:仓根 docs/ToBeImproved/走查续八_动效与组件开放方案_2026-10-26/plugins.html)。
 * npx electron-vite build && npm run check:pluginhost        截图落 SHOT_DIR(缺省系统临时目录 forsion-r8host-shots)
 * 样例插件 scripts/fixtures/r8dx-sample 只用公开接口:主区「导出」按钮 showModal() 一个原生 <dialog>,右栏挂 mountSettingsPage。
 * 钉住(窗口 1512 宽,视口断点 ≤820 不生效,只能靠窗格宽):
 *  - 插件 <dialog> 居中,不被 base.css 的 * { margin:0 } 推到左上角;
 *  - 右栏(<420)里的设置零件按窗格宽换行:wrap 行(分段 / 下拉 / 步进 / 输入)控件换到标题下面、标题不被挤成一字一行;
 *    开关行留在一行;中英文都看;
 *  - 窗格成了 query 容器后,里面 position:fixed 的东西仍按视口定位(右键菜单 / 悬停提示都是这么画的)。
 * 全程打隔离 loopback 桩引擎,不碰真账号。
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, makeReporter, shotDir, captureWindow, sleep } = require('./lib/uiux-electron.cjs')

const FIXTURE = path.join(__dirname, 'fixtures', 'r8dx-sample')
const SHOTS = shotDir('r8host')
const { check, summary } = makeReporter()

// 页面里跑:右栏设置行的几何
function probeRight() {
  const pane = document.querySelector('[data-r8="settings"]')?.closest('.wb-view')
  const rows = [...document.querySelectorAll('[data-r8="settings"] .settings-control-row')].map((r) => {
    const copy = r.querySelector('.settings-control-copy').getBoundingClientRect()
    const ctl = r.querySelector('.settings-row-control')?.getBoundingClientRect()
    const strong = r.querySelector('.settings-control-copy strong')
    return {
      fit: r.dataset.fit, dir: getComputedStyle(r).flexDirection, title: strong?.textContent,
      rowW: Math.round(r.getBoundingClientRect().width), copyW: Math.round(copy.width),
      // 一行字的标题高 ≈ 行高;一字一行时会高出几倍
      titleLines: strong ? Math.round(strong.getBoundingClientRect().height / parseFloat(getComputedStyle(strong).lineHeight)) : 0,
      below: ctl ? ctl.top >= copy.bottom - 1 : null,
    }
  })
  // 窗格里放一个 fixed 探针:应当贴着视口左上角,而不是窗格左上角
  const fx = document.createElement('div'); fx.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px'
  pane?.append(fx); const fr = fx.getBoundingClientRect(); fx.remove()
  return { paneW: pane ? Math.round(pane.getBoundingClientRect().width) : 0, cq: pane ? getComputedStyle(pane).containerType : '', rows, fixed: [Math.round(fr.left), Math.round(fr.top)] }
}

;(async () => {
  const ctx = await launch({ tag: 'r8host', overrideHome: true, beforeLaunch: ({ home }) => {
    fs.cpSync(FIXTURE, path.join(home, 'plugins', 'r8dx-sample'), { recursive: true })
  } })
  const { app, win } = ctx
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    for (const c of [{ mode: 'light', lang: 'zh' }, { mode: 'dark', lang: 'zh' }, { mode: 'light', lang: 'en' }]) {
      const tag = `${c.mode}-${c.lang}`
      await win.evaluate((o) => {
        localStorage.setItem('forsion_theme_pref', o.mode); localStorage.setItem('tangu_locale', o.lang)
        localStorage.setItem('forsion_default_space', 'r8dx')
      }, c)
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('[data-r8="settings"] .settings-control-row', { timeout: 30_000 })
      await sleep(1500)
      // 静默窗口换明暗后不一定重绘:抖 1px 逼一次(否则 capturePage 拍到旧帧)
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const [x, y] = w.getContentSize(); w.setContentSize(x - 1, y); w.setContentSize(x, y) })
      await win.mouse.move(1500, 940) // 指针停在上一轮的「导出」上会留一枚悬停提示进截图
      await sleep(500)

      const r =await win.evaluate(probeRight)
      const wrap = r.rows.filter((x) => x.fit === 'wrap'), inline = r.rows.filter((x) => x.fit === 'inline')
      check(`[${tag}] 右栏是窄窗格且是 query 容器`, r.paneW > 0 && r.paneW < 420 && r.cq === 'inline-size', `paneW=${r.paneW} container-type=${r.cq}`)
      check(`[${tag}] 右栏 wrap 行(分段 / 下拉 / 步进 / 输入)换到标题下面,标题一行`,
        wrap.length >= 3 && wrap.every((x) => x.dir === 'column' && x.below && x.titleLines <= 1),
        wrap.map((x) => `${x.title}:${x.dir}/${x.below ? '下' : '旁'}/${x.titleLines}行`).join(' '))
      check(`[${tag}] 右栏开关行留在一行,标题不被挤成一字一行`, inline.length >= 2 && inline.every((x) => x.dir === 'row' && x.copyW >= 120 && x.titleLines <= 2),
        inline.map((x) => `${x.title}:${x.dir}/copy${x.copyW}/${x.titleLines}行`).join(' '))
      check(`[${tag}] 窗格里的 position:fixed 仍按视口定位`, r.fixed[0] === 0 && r.fixed[1] === 0, `fixed 探针落在 ${r.fixed}`)
      if (c.lang === 'zh') await captureWindow(app, path.join(SHOTS, `right-${tag}.png`))

      await win.click('[data-r8="export"]')
      await win.waitForSelector('[data-r8="dialog"][open]', { timeout: 5000 })
      await win.evaluate(() => document.getAnimations().forEach((a) => a.finish()))
      const d = await win.evaluate(() => {
        const e = document.querySelector('[data-r8="dialog"]'), b = e.getBoundingClientRect()
        return { dx: Math.round(b.left + b.width / 2 - innerWidth / 2), dy: Math.round(b.top + b.height / 2 - innerHeight / 2), anim: getComputedStyle(e).animationName }
      })
      check(`[${tag}] 插件 showModal() 的 <dialog> 居中,宿主进场动效还在`, Math.abs(d.dx) <= 2 && Math.abs(d.dy) <= 2 && d.anim === 'ui-menu-enter', `偏离中心 dx=${d.dx} dy=${d.dy} animation=${d.anim}`)
      if (c.lang === 'zh') await captureWindow(app, path.join(SHOTS, `dialog-${tag}.png`))
      await win.keyboard.press('Escape')
      await sleep(300)
    }
    console.log(`截图:${SHOTS}`)
  } finally { await ctx.close() }
  process.exit(summary() ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
