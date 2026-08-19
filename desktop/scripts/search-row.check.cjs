/**
 * 侧栏「内容匹配」命中行(.t2s-srow.t2s-deep)的布局契约检查(真 Chromium 断言)。
 *
 * 为什么存在:命中行是**两行**(标题 + 命中片段),而侧栏其它行都是定高单行——定高/裁剪样式
 * 漏一条覆盖,片段要么被压成一条缝、要么把行撑破;片段还必须 2 行截断(line-clamp),否则
 * 一条长命中能顶满整个侧栏。窄侧栏下日期还得留得住。这些只有真浏览器算得出来。
 *
 * 页面注入仓里**真实的 sidebar2.css**(不复制样式),故不会与源码漂移。
 * 截图落 /tmp/search-row.png 供人眼自查(DESIGN.md §8)。
 *
 * 跑:npm run check:searchrow   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const ROOT = path.resolve(__dirname, '..')
const BASE_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/styles/base.css'), 'utf8')
const SIDE_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/views/chat2/sidebar2.css'), 'utf8')

const LONG = '这是一条很长的命中片段'.repeat(20)

/** 复刻 SidebarPane 搜索态的真实结构:标题匹配行 + 内容匹配组。 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; }
  ${BASE_CSS}
  ${SIDE_CSS}
</style></head><body>
 <aside class="t2s-side" id="side" style="width:280px;height:600px">
  <div class="t2s-search"><input value="localStorage"></div>
  <div class="t2s-scroll" id="scroll">
    <button class="t2s-srow" id="titlerow" style="padding-left:22px">
      <span class="t2s-lead"><span class="t2s-lead-icon t2s-dim"></span></span>
      <span class="t2s-srow-title">标题里带 localStorage 的会话</span>
    </button>
    <div class="t2s-hint t2s-deep-head" id="head">内容匹配</div>
    <button class="t2s-srow t2s-deep" id="deep" style="padding-left:22px">
      <span class="t2s-lead"><span class="t2s-lead-icon t2s-dim"></span></span>
      <span class="t2s-deep-col">
        <span class="t2s-srow-title" id="dtitle">问候</span>
        <span class="t2s-deep-snip" id="snip">${LONG}</span>
      </span>
      <span class="t2s-deep-date" id="date">2026-08-05</span>
    </button>
    <button class="t2s-srow t2s-deep" id="deep2" style="padding-left:22px">
      <span class="t2s-lead"><span class="t2s-lead-icon t2s-dim"></span></span>
      <span class="t2s-deep-col">
        <span class="t2s-srow-title">短片段那条</span>
        <span class="t2s-deep-snip">assistant: "…localStorage 初始化有问题…"</span>
      </span>
      <span class="t2s-deep-date">2026-08-04</span>
    </button>
  </div>
 </aside>
</body></html>`

const measure = () => {
  const r = (id) => document.getElementById(id).getBoundingClientRect()
  const snip = document.getElementById('snip')
  const cs = getComputedStyle(snip)
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45
  return {
    titleRowH: r('titlerow').height,
    deepH: r('deep').height,
    deep2H: r('deep2').height,
    snipH: r('snip').height,
    lineHeight: lh,
    // 片段被 2 行截断:渲染高度 ≈ 2 行,而内容本身远超
    snipScrollH: snip.scrollHeight,
    snipRight: r('snip').right,
    dateLeft: r('date').left,
    deepRight: r('deep').right,
    sideRight: r('side').right,
    titleH: r('dtitle').height,
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 420, height: 700 } })
  await p.setContent(HTML)
  const m = await p.evaluate(measure)

  check('⚠️命中行比单行标题行高(两行没被定高压扁)', m.deepH > m.titleRowH + 4,
    `deep=${m.deepH.toFixed(1)} titleRow=${m.titleRowH.toFixed(1)}`)
  check('⚠️长片段被 2 行截断,不顶满侧栏', m.snipH <= m.lineHeight * 2 + 2 && m.snipScrollH > m.snipH + 2,
    `snipH=${m.snipH.toFixed(1)} lh=${m.lineHeight.toFixed(1)} scrollH=${m.snipScrollH}`)
  check('标题仍是一行(片段长不挤标题)', m.titleH <= m.lineHeight * 2, `titleH=${m.titleH.toFixed(1)}`)
  check('⚠️日期没被长片段挤出行外', m.dateLeft < m.deepRight && m.dateLeft > 0,
    `dateLeft=${m.dateLeft.toFixed(1)} rowRight=${m.deepRight.toFixed(1)}`)
  check('片段不横向溢出侧栏', m.snipRight <= m.sideRight + 1, `snipRight=${m.snipRight.toFixed(1)} sideRight=${m.sideRight.toFixed(1)}`)
  check('短片段那条不比长片段那条更高(两行封顶一致)', m.deep2H <= m.deepH + 1, `deep2=${m.deep2H.toFixed(1)} deep=${m.deepH.toFixed(1)}`)

  // 窄侧栏(用户可拖到 220)
  await p.evaluate(() => { document.getElementById('side').style.width = '220px' })
  await p.waitForTimeout(60)
  const narrow = await p.evaluate(measure)
  check('⚠️窄侧栏(220)下日期仍在行内、片段不溢出',
    narrow.dateLeft > 0 && narrow.dateLeft < narrow.deepRight && narrow.snipRight <= narrow.sideRight + 1,
    `dateLeft=${narrow.dateLeft.toFixed(1)} snipRight=${narrow.snipRight.toFixed(1)} sideRight=${narrow.sideRight.toFixed(1)}`)

  await p.evaluate(() => { document.getElementById('side').style.width = '280px' })
  await p.waitForTimeout(60)
  const shot = process.env.SEARCHROW_SHOT || '/tmp/search-row.png'
  await p.screenshot({ path: shot, fullPage: true })
  console.log(`\n截图:${shot}`)
  await browser.close()

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})()
