/**
 * 手机端左右抽屉的**几何仪器**(390×844,pointer:coarse)。静态复刻 + 真 CSS,不需要起 dev server。
 *
 * 钉三件移动抽屉容易回退的事:
 *  1) 露边:抽屉不许铺满,右侧要留出能看见/能点的主区。**关键是 --uiz 与 body zoom 不许失配** ——
 *     uiZoom.apply(1) 走的是「清 inline zoom + 移除 --uiz」,而 singleColumn.css 里 (pointer:coarse)
 *     那条 `body{zoom:1.15}` 是 CSS 层的,清不掉;--uiz 一掉回 1,`--mb-panelw = 86vw/1` 再被 zoom 放大
 *     1.15 倍 ≈ 99vw,露边只剩几个 px。D2 就是这条的负对照。
 *  2) 抽屉内文件树的**实际渲染字号/行高**:.t2s-* 是桌面鼠标尺度(13px/28px 行),端级 zoom 之后仍太小,
 *     .mb-drawer-body 上再叠一档 zoom 才够手指用。
 *  3) 圆角只落在面向主区的暴露边,贴屏边保持齐平;竖屏抽屉与横屏 docked sidecol
 *     使用同一轮廓,子内容必须被裁住。
 *
 * 跑:npm run check:drawer
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium(设 CHROMIUM_EXE 指一个)')
}

const GENESIS = path.resolve(__dirname, '../..')
const read = (p) => fs.readFileSync(path.join(GENESIS, p), 'utf8')
const CSS = [
  'desktop/frontend/src/styles/base.css',
  'desktop/frontend/src/views/chat2/sidebar2.css',
  'lcl/engine/engine.css',
  'lcl/engine/singleColumn.css',
].map(read).join('\n')

const HTML = `<!doctype html><meta name=viewport content="width=device-width">
<style>${CSS}</style>
<div class="mb-shell"><div class="mb-body push-left">
  <aside class="mb-drawer mb-drawer--left open">
    <div class="mb-drawer-bar"><button class="mb-drawer-select">工作区</button></div>
    <div class="mb-drawer-body"><div class="t2s-side t2sw"><div class="t2s-scroll">
      <div class="t2s-group-sessions">
        <div class="t2s-folder-row" id="folder"><span>0-Obsidian Mountain</span></div>
        <div class="t2s-srow" id="row"><span class="t2s-srow-title">01-Inbox</span></div>
      </div>
    </div></div></div>
    <div class="mb-drawer-foot"><div class="mb-spacebar"><button class="mb-tab on"><span class="mb-tab-label">笔记</span></button></div></div>
  </aside>
  <main class="mb-main"></main>
</div></div>`

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  })
  const page = await ctx.newPage()
  await page.setContent(HTML)

  // 元素自身到根的累积 zoom(getBoundingClientRect 已含,font-size 没有)
  const CUMZOOM = `(el)=>{let z=1;for(let n=el;n;n=n.parentElement)z*=parseFloat(getComputedStyle(n).zoom)||1;return z}`

  const geo = async () =>
    await page.evaluate(() => {
      const d = document.querySelector('.mb-drawer--left').getBoundingClientRect()
      return {
        uiz: getComputedStyle(document.documentElement).getPropertyValue('--uiz').trim() || '(unset)',
        bodyZoom: getComputedStyle(document.body).zoom,
        vw: window.innerWidth,
        gap: +(window.innerWidth - d.width).toFixed(1),
        gapPct: +(((window.innerWidth - d.width) / window.innerWidth) * 100).toFixed(1),
      }
    })

  // ── D1-D2 露边 ───────────────────────────────────────────────────────────
  const g0 = await geo()
  check('D1 手机端抽屉留出露边(≥18% 视口,且明显够点)', g0.gapPct >= 18 && g0.gap >= 60, `露边 ${g0.gap}px = ${g0.gapPct}% (vw=${g0.vw})`)

  // uiZoom.apply(1) 的真实行为:清 inline zoom + 移除 --uiz。CSS 那条 1.15 接管,--uiz 必须跟着回 1.15。
  await page.evaluate(() => {
    document.body.style.zoom = ''
    document.documentElement.style.removeProperty('--uiz')
  })
  const g1 = await geo()
  check(
    'D2 ⚠️ uiZoom 重置(清 inline)后露边不塌 —— --uiz 必须由 CSS 那条 (pointer:coarse) 一起兜住',
    g1.gapPct >= 18,
    `--uiz=${g1.uiz} bodyZoom=${g1.bodyZoom} 露边 ${g1.gap}px = ${g1.gapPct}%`,
  )

  // 负对照:抹掉 :root{--uiz} 那条,失配应当当场现形(这条**期望是塌**,塌了才说明 D2 真的在测东西)
  await page.evaluate(() => {
    const s = document.createElement('style')
    s.id = 'neg'
    s.textContent = '@media (pointer: coarse) and (max-width: 820px){ :root { --uiz: initial } }'
    document.head.appendChild(s)
  })
  const gNeg = await geo()
  await page.evaluate(() => document.getElementById('neg').remove())
  check('D3 负对照:去掉 --uiz 同步后露边确实塌(证明 D2 不是假绿)', gNeg.gapPct < g1.gapPct - 5, `塌到 ${gNeg.gap}px = ${gNeg.gapPct}%`)

  // ── D4-D6 抽屉内字号 ─────────────────────────────────────────────────────
  const f = await page.evaluate((cumSrc) => {
    const cum = eval(cumSrc)
    const pick = (sel) => {
      const el = document.querySelector(sel)
      const cs = getComputedStyle(el)
      return {
        font: +(parseFloat(cs.fontSize) * cum(el)).toFixed(2),
        h: +el.getBoundingClientRect().height.toFixed(1),
        cum: +cum(el).toFixed(4),
      }
    }
    return { row: pick('#row'), folder: pick('#folder'), sel: pick('.mb-drawer-select'), tab: pick('.mb-tab-label') }
  }, CUMZOOM)

  check('D4 文件行字号 ≥16px 视口px(桌面 13px × 端级 1.15 只有 15,不够手指用)', f.row.font >= 16, `${f.row.font}px (累积 zoom ${f.row.cum})`)
  check('D5 文件行高 ≥36px(触控行)', f.row.h >= 36, `${f.row.h}px`)
  check('D6 文件夹行与文件行同一档(别只放大一半)', Math.abs(f.folder.font - f.row.font) < 0.5, `folder=${f.folder.font} row=${f.row.font}`)
  check(
    'D7 抽屉 chrome(顶部选择器 / 底部 Space 标签)**不跟着**放大 —— 只罩 .mb-drawer-body',
    f.sel.cum < f.row.cum && f.tab.cum < f.row.cum,
    `select=${f.sel.cum} tab=${f.tab.cum} vs body=${f.row.cum}`,
  )

  // ── D8-D11 暴露边圆角 ──────────────────────────────────────────────────
  const corners = await page.evaluate(() => {
    const readCorners = (el) => {
      const cs = getComputedStyle(el)
      return {
        tl: parseFloat(cs.borderTopLeftRadius),
        tr: parseFloat(cs.borderTopRightRadius),
        br: parseFloat(cs.borderBottomRightRadius),
        bl: parseFloat(cs.borderBottomLeftRadius),
        overflow: cs.overflow,
      }
    }
    const left = document.querySelector('.mb-drawer--left')
    const right = left.cloneNode(false)
    right.className = 'mb-drawer mb-drawer--right open'
    document.querySelector('.mb-body').appendChild(right)
    return { left: readCorners(left), right: readCorners(right) }
  })
  check(
    'D8 左抽屉贴屏边为直角、暴露边上下圆角',
    corners.left.tl === 0 && corners.left.bl === 0 && corners.left.tr > 0 && corners.left.br > 0,
    JSON.stringify(corners.left),
  )
  check(
    'D9 右抽屉镜像圆角,且两侧子内容都裁进轮廓',
    corners.right.tr === 0 && corners.right.br === 0 && corners.right.tl > 0 && corners.right.bl > 0
      && corners.left.overflow === 'clip' && corners.right.overflow === 'clip',
    JSON.stringify(corners.right),
  )
  const docked = await page.evaluate(() => {
    const sidecol = document.querySelector('.mb-drawer--left').cloneNode(false)
    sidecol.className = 'mb-sidecol'
    document.querySelector('.mb-body').appendChild(sidecol)
    const cs = getComputedStyle(sidecol)
    return {
      tl: parseFloat(cs.borderTopLeftRadius),
      tr: parseFloat(cs.borderTopRightRadius),
      br: parseFloat(cs.borderBottomRightRadius),
      bl: parseFloat(cs.borderBottomLeftRadius),
      overflow: cs.overflow,
    }
  })
  check(
    'D10 横屏 docked sidecol 沿用左抽屉的内容侧圆角',
    docked.tl === 0 && docked.bl === 0 && docked.tr > 0 && docked.br > 0 && docked.overflow === 'clip',
    JSON.stringify(docked),
  )
  const squareNeg = await page.evaluate(() => {
    const s = document.createElement('style')
    s.textContent = '.mb-drawer, .mb-sidecol { border-radius: 0 !important }'
    document.head.appendChild(s)
    return [...document.querySelectorAll('.mb-drawer, .mb-sidecol')].every((el) => {
      const cs = getComputedStyle(el)
      return [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
        .every((value) => parseFloat(value) === 0)
    })
  })
  check('D11 负对照:抹掉圆角后所有 Side Panel 确实退回四角全直', squareNeg, `square=${squareNeg}`)

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
