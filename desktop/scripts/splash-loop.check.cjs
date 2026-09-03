/**
 * 启动闪屏(#tangu-splash)的退场契约检查(真 Chromium 断言)。
 *
 * 为什么存在:闪屏原来是「2100ms 定时器到点就撤」,启动慢(装插件/扫工作目录)时会在应用还没
 * 起来时露出半成品。改成「logo 动画无限循环 + 首帧画出来才淡出」后,风险换了个方向:
 *  ① 循环真的在循环吗 —— 少个 infinite 就退化成"播完就僵住"的静止 logo,肉眼要盯够 1.6s 才看得出;
 *  ② 首帧出来后真的会撤吗 —— 撤不掉 = 整个应用被一层 fixed 盖住,灾难;
 *  ③ 首帧**永远**出不来(初始化抛错)时的天花板 —— 这是新方案唯一的"把用户锁死"路径。
 *
 * 直接喂仓里真实的 frontend/index.html(不复制样式/脚本,故不会与源码漂移)。setContent 下
 * `<script type="module" src="/src/main.tsx">` 必然加载失败 → #root 恒空 = 天然模拟"启动很慢"。
 *
 * 跑:npm run check:splash   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const HTML = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8')
const CYCLE = 1600

const state = () => {
  const s = document.getElementById('tangu-splash')
  if (!s) return { gone: true }
  const logo = s.querySelector('.tangu-splash-logo')
  const anims = [...logo.getAnimations(), ...s.querySelectorAll('#panel-stack, #tree-mark, #tree-outline')]
    .flatMap((x) => (x.getAnimations ? x.getAnimations() : [x]))
  return {
    gone: false,
    out: s.classList.contains('out'),
    names: anims.map((a) => a.animationName),
    infinite: anims.every((a) => a.effect.getComputedTiming().iterations === Infinity),
    running: anims.every((a) => a.playState === 'running'),
    // 跑过了一整轮还在跑 = 真的在循环(不是"播完僵住")
    pastFirstCycle: Math.max(0, ...anims.map((a) => a.currentTime || 0)),
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 820 } })

  // ── ①+② 首帧迟迟不来 → 一直循环;首帧一到 → 撤走 ──
  await page.setContent(HTML)
  await page.waitForTimeout(CYCLE * 2 + 300) // 越过两轮
  const looping = await page.evaluate(state)
  check('首帧未出:闪屏还在(没被定时器撤走)', !looping.gone && !looping.out)
  check('四条动画都是 infinite(含接缝遮罩 p2m-seam)',
    !!looping.infinite && looping.names.includes('p2m-seam') && looping.names.length === 4, (looping.names || []).join(','))
  check('两轮之后仍在跑(真循环,不是播完僵住)', !!looping.running && looping.pastFirstCycle > CYCLE, `t=${Math.round(looping.pastFirstCycle)}ms`)

  // 接缝不"眨眼":循环回卷那一帧 logo 必须已经淡到近乎透明(否则「落定 → 突然隐形」看着像故障)。
  // 直接 seek 动画时间轴,不靠等待,零抖动。
  const seam = await page.evaluate((cycle) => {
    const logo = document.querySelector('#tangu-splash .tangu-splash-logo')
    const at = (ms) => {
      logo.getAnimations().forEach((a) => { a.currentTime = ms })
      return parseFloat(getComputedStyle(logo).opacity)
    }
    return { mid: at(cycle / 2), edge: at(cycle - 20), start: at(10) }
  }, CYCLE)
  check('接缝被遮住(回卷处近乎透明,中段全不透明)',
    seam.mid > 0.99 && seam.edge < 0.3 && seam.start < 0.35, `start=${seam.start} mid=${seam.mid} edge=${seam.edge}`)

  await page.evaluate(() => { document.getElementById('root').appendChild(document.createElement('div')) })
  // 落定时刻 = 下一个 (n*CYCLE - 300);最坏再等一整轮 + 380ms 淡出
  await page.waitForTimeout(CYCLE + 900)
  const after = await page.evaluate(state)
  check('首帧画出后闪屏被移除', !!after.gone)

  // ── ③ 天花板:首帧永远不来也必须自己撤(10s) ──
  await page.setContent(HTML)
  await page.waitForTimeout(9000)
  const beforeCeil = await page.evaluate(state)
  check('天花板前不早退(9s 仍在)', !beforeCeil.gone)
  await page.waitForTimeout(2000)
  const afterCeil = await page.evaluate(state)
  check('10s 天花板:首帧永远不来也会自己撤走', !!afterCeil.gone)

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
