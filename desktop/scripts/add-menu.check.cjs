/**
 * Chat Box 添加胶囊的真实 CSS 几何契约。
 *
 * A 28px ＋ 平滑展开到 224px，菜单左缘稳定、胶囊与菜单等宽、标签居中。
 * B 一级菜单四个入口；对话 / View 二级菜单带搜索并贴边展开。
 * C 窄容器里展开项完整保留，其他胶囊与次要按钮彻底退出布局；宽容器不误藏。
 *
 * 跑：npm run check:addmenu
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium，设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const BASE = fs.readFileSync(path.join(__dirname, '../frontend/src/styles/base.css'), 'utf8')
const COMPOSER = fs.readFileSync(path.join(__dirname, '../frontend/src/views/chat2/composer2.css'), 'utf8')
const icon = (klass = '') => `<span class="fake-icon ${klass}"></span>`

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --bg-card:#fff; --bg:#fff; --border:#ddd; --border-width:1px; --overlay-light:#eee; --overlay-medium:#ddd;
  --radius-lg:12px; --radius-md:8px; --text:#111; --text-light:#222; --text-muted:#666; --text-faint:#999;
  --accent-ink:#3b5bdb; --font-ui:system-ui; --ease-spring:cubic-bezier(.2,.8,.2,1); --card-shadow:0 8px 28px rgba(0,0,0,.15); }
${BASE}
${COMPOSER}
body { margin:0; font-family:var(--font-ui); }
button { font:inherit; border:0; }
.stage { width:700px; margin:420px 0 0 40px; }
.fake-icon { display:inline-block; width:14px; height:14px; flex:none; }
.menus-hidden .composer-menu--add, .menus-hidden .add-menu-sub { display:none; }
</style></head><body>
<div class="stage t2c-card">
  <div class="t2c-row">
    <span class="add-pill-wrap t2c-capsule-peer" data-cmenu>
      <button class="t2c-pill add-pill-btn">
        ${icon('add-pill-plus')}<span class="add-pill-label">添加</span>${icon('add-pill-chevron')}
      </button>
      <div class="composer-menu composer-menu--add">
        <button class="menu-item"><span>新对话</span></button>
        <button class="menu-item"><span>添加文件或文件夹</span></button>
        <button class="menu-item add-menu-parent"><span>添加对话</span></button>
        <button class="menu-item add-menu-parent"><span>添加正在使用的 View</span></button>
      </div>
      <div class="composer-menu add-menu-sub" data-pane="conversation">
        <label class="add-menu-search">${icon()}<input placeholder="搜索全部对话"></label>
        <div class="add-menu-sub-scroll"><div class="menu-section">最近使用</div><button class="menu-item">设计讨论</button></div>
      </div>
    </span>
    <span class="mode-pill-wrap t2c-capsule-peer"><button class="t2c-pill mode-pill-btn">${icon()}<span class="t2c-pill-label">替我批准</span>${icon()}</button></span>
    <span class="t2c-grow"></span>
    <span class="t2c-ctxring t2c-collapse-on-capsule-open">${icon()}</span>
    <span class="model-pill-wrap t2c-capsule-peer"><button class="composer-chip model-pill-btn">${icon()}<span class="pill-marquee">GLM-4.7</span>${icon()}</button></span>
    <button class="t2c-iconbtn t2c-mic-control t2c-collapse-on-capsule-open">${icon()}</button>
    <button class="t2c-send">${icon()}</button>
  </div>
</div>
</body></html>`

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  await page.setContent(PAGE)
  const box = (sel) => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2 }
  }, sel)

  const closedW = (await box('.add-pill-btn')).w
  const trace = await page.evaluate(() => new Promise((resolve) => {
    document.querySelector('.add-pill-wrap').classList.add('is-open')
    document.querySelector('.add-pill-btn').classList.add('is-open')
    const out = []
    const t0 = performance.now()
    const tick = () => {
      out.push([performance.now() - t0, document.querySelector('.add-pill-btn').getBoundingClientRect().width, document.querySelector('.composer-menu--add').getBoundingClientRect().left])
      if (performance.now() - t0 < 240) requestAnimationFrame(tick)
      else resolve(out)
    }
    requestAnimationFrame(tick)
  }))
  const openW = trace.at(-1)[1]
  const mids = trace.filter(([t, w]) => t > 35 && t < 155 && w > closedW + 8 && w < openW - 8).length
  const xs = trace.map((f) => f[2])
  check('添加胶囊展开有连续宽度动画', mids >= 3, `${closedW.toFixed(1)} → ${openW.toFixed(1)}，中间帧 ${mids}`)
  check('添加菜单锚点不随胶囊横移', Math.max(...xs) - Math.min(...xs) < 3, `漂移 ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)}px`)

  await page.evaluate(() => document.querySelectorAll('.add-pill-btn,.composer-menu--add,.add-menu-sub').forEach((el) => el.getAnimations().forEach((a) => a.finish())))
  const pill = await box('.add-pill-btn')
  const menu = await box('.composer-menu--add')
  const labelBox = await box('.add-pill-label')
  check('添加胶囊与菜单同为 224px', Math.abs(pill.w - 224) < 1 && Math.abs(menu.w - 224) < 1)
  check('添加胶囊与菜单左缘对齐', Math.abs(pill.left - menu.left) < 1)
  check('添加文字在展开胶囊中居中', Math.abs(labelBox.cx - pill.cx) < 2, `偏差 ${Math.abs(labelBox.cx - pill.cx).toFixed(1)}px`)

  const structure = await page.evaluate(() => ({
    items: document.querySelectorAll('.composer-menu--add > .menu-item').length,
    parents: document.querySelectorAll('.composer-menu--add > .add-menu-parent').length,
    search: !!document.querySelector('.add-menu-sub .add-menu-search input'),
  }))
  check('一级菜单保留四个明确入口', structure.items === 4, `入口 ${structure.items}`)
  check('对话与 View 都是二级入口', structure.parents === 2)
  check('二级菜单提供搜索框', structure.search)
  const sub = await box('.add-menu-sub')
  check('二级菜单贴在一级菜单侧边且底边对齐', sub.left > menu.right && Math.abs(sub.bottom - menu.bottom) <= 1.1, `主菜单 right/bottom ${menu.right.toFixed(1)}/${menu.bottom.toFixed(1)}，子菜单 left/bottom ${sub.left.toFixed(1)}/${sub.bottom.toFixed(1)}`)

  await page.evaluate(() => { document.body.style.zoom = '1.1' })
  const scaledMenu = await box('.composer-menu--add')
  const scaledSub = await box('.add-menu-sub')
  check(
    '应用界面缩放后二级菜单仍在一级菜单侧边',
    scaledSub.left > scaledMenu.right && Math.abs(scaledSub.bottom - scaledMenu.bottom) <= 1.2,
    `主菜单 right/bottom ${scaledMenu.right.toFixed(1)}/${scaledMenu.bottom.toFixed(1)}，子菜单 left/bottom ${scaledSub.left.toFixed(1)}/${scaledSub.bottom.toFixed(1)}`,
  )
  await page.evaluate(() => { document.body.style.zoom = '' })

  await page.evaluate(() => {
    const menu = document.querySelector('.composer-menu--add')
    const sub = document.querySelector('.add-menu-sub')
    sub.classList.add('stacked')
    sub.style.bottom = `calc(100% + ${menu.offsetHeight + 6}px)`
  })
  const stackedMenu = await box('.composer-menu--add')
  const stackedSub = await box('.add-menu-sub')
  check('两侧都放不下时二级菜单完整叠到一级菜单上方', stackedSub.bottom < stackedMenu.top, `主菜单 top ${stackedMenu.top.toFixed(1)}，子菜单 bottom ${stackedSub.bottom.toFixed(1)}`)
  await page.evaluate(() => {
    const sub = document.querySelector('.add-menu-sub')
    sub.classList.remove('stacked')
    sub.style.bottom = ''
  })

  await page.evaluate(() => {
    document.querySelector('.stage').style.width = '480px'
    document.querySelector('.stage').classList.add('menus-hidden')
  })
  const narrow = await page.evaluate(() => {
    const shown = (s) => getComputedStyle(document.querySelector(s)).display !== 'none'
    const row = document.querySelector('.t2c-row')
    return {
      add: shown('.add-pill-wrap'), label: shown('.add-pill-label'), mode: shown('.mode-pill-wrap'),
      ctx: shown('.t2c-ctxring'), model: shown('.model-pill-wrap'), mic: shown('.t2c-mic-control'), send: shown('.t2c-send'),
      overflow: row.scrollWidth - row.clientWidth,
    }
  })
  check('窄宽度展开时只保留当前胶囊与核心动作', narrow.add && narrow.label && !narrow.mode && !narrow.ctx && !narrow.model && !narrow.mic && narrow.send, JSON.stringify(narrow))
  check('窄宽度底排不再堆叠或横向溢出', narrow.overflow <= 1, `溢出 ${narrow.overflow}px`)

  await page.evaluate(() => {
    document.querySelector('.stage').style.width = '700px'
    document.querySelector('.stage').classList.remove('menus-hidden')
  })
  const widePeers = await page.evaluate(() => ['.mode-pill-wrap', '.t2c-ctxring', '.model-pill-wrap', '.t2c-mic-control'].every((s) => getComputedStyle(document.querySelector(s)).display !== 'none'))
  check('宽度足够时不误藏其他控件', widePeers)

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
})().catch((err) => { console.error(err); process.exitCode = 1 })
