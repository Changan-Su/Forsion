/**
 * 底部面板(第四个 ViewLocation)的 DOM 几何仪器 —— 真 Chromium + 真 Dockview + 真 dockviewStore
 * (harness.html?dock)。单测(lcl/engine/bottomPanel.test.ts)钉的是 store 契约,mock 掉了 Dockview;
 * 这里钉的是**只有真几何才能证**的三件事:
 *   ① 底部只落在**主区那一列**下方 —— 左右侧栏仍满高,不被它横跨(用户拍板的 panel alignment);
 *   ② 展开后确实到达目标高(≈ 容器 32%),不是停在 dockview 的默认最小高;
 *   ③ 收起后左右栏**宽度纹丝不动**(底部吞吐的高只在主区那一列内流动)。
 *
 * ⚠️量高必须 rAF 逐帧采样:同步循环不推进动画帧,读到的永远是起始值 = 假绿(同 main-remount 的教训)。
 * ⚠️浏览器**后台标签页不发 rAF** → 补间永远跑不完、面板卡在最小高。headless 下正常,但若改成
 *    headed 且窗口被遮挡,这条会假红;真遇到先确认 rAF 在跑,别急着改产品代码。
 *
 * 跑:npm run check:bottompanel            (5173 没起会自起 vite,跑完自收)
 *     npm run shot:bottompanel            (加截图,落 /tmp/bottom-panel-*.png,供人眼自查 DESIGN.md §8)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

const SHOT = process.argv.includes('--shot')

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
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?dock`

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 驱动一次 toggle,rAF 逐帧采底部组高,收尾回几何快照。 */
const toggle = (page, side) => page.evaluate(async (s) => {
  const d = window.__dock
  const h = [], card = [], pad = [], op = []
  await new Promise((done) => {
    const t0 = performance.now()
    const tick = () => {
      h.push(Math.round(d.bottomH()))
      card.push(d.cardBottom())
      pad.push(d.mainPadBottom())
      const mv = document.querySelector('.wb-view--main')
      op.push(mv ? Number(getComputedStyle(mv).opacity) : 1)
      if (performance.now() - t0 < 700) requestAnimationFrame(tick)
      else done()
    }
    d.toggle(s)
    requestAnimationFrame(tick)
  })
  return { h, card, pad, op, sbH: getComputedStyle(document.documentElement).getPropertyValue('--sb-h').trim(),
    main: d.rectOf('main'), left: d.rectOf('left'), right: d.rectOf('right'), bottom: d.rectOf('bottom'), locs: d.locs() }
}, side)

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => localStorage.clear()) // 布局/尺寸记忆都落 localStorage,别串味
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.dockh-body[data-tag="main"]', { timeout: 20000 })
    await page.waitForTimeout(500) // 等 pinSides 的 rAF²+60ms 沉降

    // 先把左右栏都开出来:底部「不横跨侧栏」这条,只有两侧真的在场时才验得到。
    await page.evaluate(() => { window.__dock.open('sidev', {}, false, 'left'); window.__dock.open('sidev', {}, false, 'right') })
    await page.waitForTimeout(600)
    const before = await page.evaluate(() => ({ left: window.__dock.rectOf('left'), right: window.__dock.rectOf('right') }))
    check('前置:左右栏都在场(否则下面两条无意义)', !!before.left && !!before.right,
      `left ${before.left && before.left.w} / right ${before.right && before.right.w}`)

    // ── 展开 ────────────────────────────────────────────────────────────────
    const open = await toggle(page, 'bottom')
    const openedH = open.h[open.h.length - 1]
    const vpH = 900

    check('展开:底部面板出现', !!open.bottom && openedH > 0, `高 ${openedH}`)
    // ② 到达目标高(容器 32%,钳 [120, 60%])。宽松到 ±40:容器高 = 视口减头部,不是整 900。
    check('⚠️展开:高度到位(≈容器 32%),不是卡在 dockview 默认最小高',
      Math.abs(openedH - Math.round(vpH * 0.32)) < 60 && openedH > 150,
      `实测 ${openedH} / 期望 ≈${Math.round(vpH * 0.32)}`)
    // 补间真的在动(采样有中间值),不是一帧到位 —— 也是「rAF 在跑」的自证,防上面注释说的假红。
    check('展开:高度是补间上去的(采样存在中间帧)', new Set(open.h).size > 3, `采到 ${new Set(open.h).size} 个不同高度`)
    // ⚠️用户实报「底部面板出来的时候,上面的面板会闪一下,很奇怪,不连贯」:Dockview 组自带 100px 默认
    // 最小高,起步的 setSize(1) 被钳在 100 → 补间还没开始主区就被一帧挤掉 100px。修法是展开前先把 min
    // 放开到 0(收起分支一直有,展开分支漏了)。判据 = **首帧必须贴 0**,不是「最后到没到位」。
    check('⚠️展开:起步贴 0,不被 dockview 的 100px 最小高钳住(用户报的「上面面板闪一下」)',
      open.h[0] <= 20, `首帧 ${open.h[0]}(被钳则 ≈100)`)

    // ① 只在主区下方:底部的左边界 = 主区左边界,右边界 = 主区右边界;且左右栏仍比它高。
    const b = open.bottom, m = open.main, l = open.left, r = open.right
    check('⚠️展开:底部只在**主区那一列**下方(左右边界与主区对齐)',
      !!b && !!m && Math.abs(b.x - m.x) <= 2 && Math.abs((b.x + b.w) - (m.x + m.w)) <= 2,
      b && m ? `bottom [${b.x},${b.x + b.w}] / main [${m.x},${m.x + m.w}]` : 'n/a')
    check('⚠️展开:左右侧栏没有被底部横跨(两侧仍比底部顶边更低地延伸到底)',
      !!l && !!r && !!b && (l.y + l.h) > b.y + 10 && (r.y + r.h) > b.y + 10,
      l && r && b ? `left底 ${l.y + l.h} / right底 ${r.y + r.h} / bottom顶 ${b.y}` : 'n/a')

    if (SHOT) {
      await page.screenshot({ path: '/tmp/bottom-panel-open.png' })
      console.log('      截图 → /tmp/bottom-panel-open.png')
    }

    // ── 收起 ────────────────────────────────────────────────────────────────
    const close = await toggle(page, 'bottom')
    check('收起:底部面板消失', close.h[close.h.length - 1] === 0 && !close.bottom, `末值 ${close.h[close.h.length - 1]}`)
    // ⚠️用户第二次实报:「展开不闪了,收起还是会闪一下」。根因不在补间(它全程平滑),而在**让位 CSS 的阶跃**:
    // 收起补间走完之后 bottomVisible 才翻假 → 主区纸卡的 padding-bottom 一帧从 4px 弹回 22px、底边瞬跳 19px。
    // 判据 = 整个 toggle 期间主区外框的 padding-bottom **恒定**,且纸卡底边**逐帧单调**、没有反向的大跳。
    // ⚠️前置:--sb-h 必须真的立着,否则这套让位 CSS 整片不生效 → 本条恒绿 = 假绿(当初就是这么漏掉的)。
    check('前置:台架 --sb-h 已立起(否则下面两条是假绿)', !!close.sbH && close.sbH !== '0px' && close.sbH !== '0', `--sb-h = ${close.sbH || '(空)'}`)
    check('⚠️收起:主区让位不发生阶跃(padding-bottom 全程恒定)',
      new Set(close.pad).size === 1, `出现过 ${[...new Set(close.pad)].join(' → ')}`)
    // ⚠️用户第三次实报「还是会闪一下」。前两轮量的都是**几何**,而这一下几何全程不变 —— 变的是 opacity:
    // 收起收尾时 Dockview 把纵向 branch node 收回成 leaf,主区子树被**摘下重挂**,而 `wb-view-enter`
    // 这个淡入类只加不摘、一直留在元素上 → 重挂即从头重播 0.22s 淡入 = 整页闪一下(左右栏同因)。
    // 修法:动画播完就把类摘掉(onAnimationEnd)。判据必须量 opacity,量几何永远看不见。
    check('⚠️收起:主区不重播淡入动画(opacity 全程为 1)',
      Math.min(...close.op) > 0.98, `最低 opacity ${Math.min(...close.op).toFixed(3)}(重播时会掉到 0)`)
    const jumps = close.card.map((v, i) => (i ? v - close.card[i - 1] : 0))
    // ⚠️用户第四次实报,并指出「闪的不是整页,是一些组件」——这条才是真凶:布局结构一变,Dockview 把主区
    // 子树摘下重挂,**其中所有 CSS 动画从头重播**(各视图自己的入场动画,不是我们的)。
    // 判据:放一个**已经播完**的短动画探针,开合面板后它不许回到 running。
    // ⚠️别用 currentTime 当唯一判据:修好之后我们会 finish() 它,finish 后的动画会**从 getAnimations()
    //   里消失**,`?? 0` 会把「没了」误读成「currentTime=0」= 假红(第一版就是这么写错的)。
    const replay = await page.evaluate(async () => {
      const el = document.querySelector('.wb-view--main')
      const st = document.createElement('style')
      st.textContent = '@keyframes bp-probe { from { opacity: .99 } to { opacity: 1 } }'
      document.head.appendChild(st)
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;width:1px;height:1px;animation:bp-probe 300ms linear'
      el.appendChild(probe)
      await new Promise((r) => setTimeout(r, 600))   // 播完
      const st0 = probe.getAnimations()[0]?.playState ?? 'gone'
      window.__dock.toggle('bottom')                 // 结构变化 → 会重挂
      await new Promise((r) => setTimeout(r, 150))   // 在 300ms 动画跑完之前采样
      const a = probe.getAnimations()[0]
      return { st0, st1: a?.playState ?? 'gone', t1: a ? Math.round(Number(a.currentTime) || 0) : -1 }
    })
    // ⚠️用户实报「在 calendar view 里开合会把日期退回到 4 月 3 号左右」——不是日期逻辑的锅:重挂会把
    // **所有滚动容器的 scrollTop 抹成 0**(同一个 DOM 节点也照样归零,实测 1500→0),日历的当前日期由
    // 滚动位置决定,被滚回区间开头就成了那个日期。聊天记录等一切滚动视图同受其害。
    const scroll = await page.evaluate(async () => {
      const el = document.querySelector('.wb-view--main')
      const box = document.createElement('div')
      box.id = 'bp-scrollprobe'
      box.style.cssText = 'height:120px;overflow:auto'
      const inner = document.createElement('div')
      inner.style.height = '4000px'
      box.appendChild(inner); el.appendChild(box)
      box.scrollTop = 1500
      await new Promise((r) => setTimeout(r, 120))
      const before = box.scrollTop
      window.__dock.toggle('bottom'); await new Promise((r) => setTimeout(r, 800))
      const afterOpen = document.querySelector('#bp-scrollprobe').scrollTop
      window.__dock.toggle('bottom'); await new Promise((r) => setTimeout(r, 800))
      const afterClose = document.querySelector('#bp-scrollprobe').scrollTop
      return { before, afterOpen, afterClose }
    })
    check('前置:滚动探针确实滚到了中间(否则下一条是假绿)', scroll.before > 1000, `before=${scroll.before}`)
    check('⚠️开合面板不丢滚动位置(用户报的「日历日期退回 4 月初」)',
      scroll.afterOpen === scroll.before && scroll.afterClose === scroll.before,
      `${scroll.before} → 展开后 ${scroll.afterOpen} → 收起后 ${scroll.afterClose}(丢了会变 0)`)

    check('前置:探针动画在 toggle 前确实已播完', replay.st0 === 'finished' || replay.st0 === 'gone', `toggle 前 playState=${replay.st0}`)
    check('⚠️开合面板不重播视图自己的入场动画(用户报的「一些组件闪一下」)',
      replay.st1 !== 'running', `toggle 后 playState=${replay.st1}${replay.t1 >= 0 ? ' t=' + replay.t1 : ''}(重播则为 running)`)

    // ③ 左右栏宽度纹丝不动 —— 底部吞吐的高只在主区那一列内流动,不该惊动横向布局。
    check('⚠️开合一轮:左右侧栏宽度纹丝不动',
      !!close.left && !!close.right && Math.abs(close.left.w - before.left.w) <= 2 && Math.abs(close.right.w - before.right.w) <= 2,
      close.left && close.right ? `left ${before.left.w}→${close.left.w} / right ${before.right.w}→${close.right.w}` : 'n/a')

    if (SHOT) {
      await page.screenshot({ path: '/tmp/bottom-panel-closed.png' })
      console.log('      截图 → /tmp/bottom-panel-closed.png')
    }

    // ⚠️假绿闸:上面那条「不重播淡入」可以用「把淡入动画整个删掉」蒙过去。所以必须同时钉住
    // **真正切视图时仍然要淡入** —— 两条一起才定义了正确行为(该播的播、不该播的不播)。
    await page.waitForTimeout(400)
    const fade = await page.evaluate(async () => {
      window.__dock.open('navv', { label: 'x' }, false, 'main') // 换个视图类型 = 该淡入
      const ops = []
      const t0 = performance.now()
      await new Promise((done) => {
        const tick = () => {
          const mv = document.querySelector('.wb-view--main')
          ops.push(mv ? Number(getComputedStyle(mv).opacity) : 1)
          if (performance.now() - t0 < 500) requestAnimationFrame(tick); else done()
        }
        requestAnimationFrame(tick)
      })
      return Math.min(...ops)
    })
    check('⚠️负对照:真正切视图时**仍然**淡入(否则「不闪」= 把动画删了的假绿)',
      fade < 0.9, `切视图最低 opacity ${fade.toFixed(3)}(该淡入 → 应接近 0)`)

    const bad = results.filter((x) => !x.ok)
    console.log(`\n${results.length - bad.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
