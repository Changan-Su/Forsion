/**
 * 右栏开合期间,Live Card 车道(任务概览 + Agent Desk)与聊天区的交接契约(真 Chromium 断言)。
 *
 * 病史:右栏是 JS 补间的(dockviewStore.tweenGroupWidth,200ms,1-(1-k)³),而聊天区给车道
 * 让位曾是「容器查询二值切换 + 250ms CSS 过渡」——两段动画各跑各的,补间停了 CSS 还在跑
 * (实测滞后 44px / 拖到 350ms),肉眼就是「面板停了字还在窜」。卡片离场则是 display:none 硬切。
 *
 * ⚠️本脚本**只断言几何上确定、可复现的契约**:
 *   ① 让位与卡片同生共死(在场=满额不遮正文,退场=0 让正文回到居中)
 *   ② 让位不滞后于右栏补间
 *   ③ 卡片进/出场都是动画,不是硬切
 *   ④ 让位的两条路径分开:因内容出现=平滑过渡,因宽度跨阈值=瞬时(靠把 transition 写进容器查询)
 * **不**断言「正文位移多少像素」—— 试过,那个量随滚动位置、锚点落在哪条消息上剧烈波动,
 * 同一份代码两次可以跑出 1px 和 313px。逐帧位移仍会打印出来供人看,但不作为红绿判据,
 * 免得留下一条会随机变红、逼后人去「修」一个测不准的数字的假防线。
 *
 * 文本重排的物理:列宽一变,整段就重新折行,视口里各元素的相对距离必然改变。
 * 单锚点补偿只能钉住一个元素,钉不住其余。要真正零位移只能让列宽恒定,而
 * 正文 820 + 车道 296 = 1116 > 常见主区宽(888),几何上放不下 —— 这是取舍不是 bug。
 *
 * 注入仓里真实的 base.css + chat2.css,故不会与源码漂移。
 * 跑:npm run check:railjank   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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
const CHAT_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/views/chat2/chat2.css'), 'utf8')

// ⚠️消息长度必须参差:若每条一样长,列宽跨临界时所有段落**同帧**多折一行,
// 会人为制造出「一次跳 216px」的最坏同相,量到的不是产品行为而是 fixture 的假象。
const TEXT = '这是一段用于制造真实换行的正文。列宽一变整段就要重新折行,总高度随之变化,'
  + '而滚动位置不会自动补偿,画面里的字就会上下窜。'
const msgs = Array.from({ length: 24 }, (_, i) =>
  `<div class="t2-asst" ${i === 14 ? 'id="marker"' : ''}><div class="t2-avatar">T</div><div class="t2-asst-col">
     <div class="t2-name">TANGU</div><div class="t2-content"><p>${i}. ${TEXT.slice(0, 18 + (i * 37) % 60).repeat(1 + (i % 4))}</p></div></div></div>`).join('')

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; height:100%; }
  ${BASE_CSS}
  ${CHAT_CSS}
</style><style id="variant"></style></head><body>
  <div class="t2-chat-view" id="view" style="height:100vh;display:flex;flex-direction:column;width:1188px">
    <div class="t2-chat-body">
      <div class="t2-stream" id="stream"><div class="t2-stream-inner">${msgs}</div></div>
      <div class="t2-rail"><aside class="t2-tsum show" id="tsum"><div class="t2-tsum-in">
        <div class="t2-tsum-state running"><span class="t2-tsum-state-tx">正在运行</span></div>
        <details class="t2-tsum-sec" open><summary class="t2-tsum-sectitle"><span>来源</span></summary>
          <div class="t2-tsum-scroll"><div class="t2-tsum-row">a.md</div><div class="t2-tsum-row">b.ts</div></div></details>
      </div></aside></div>
    </div>
    <div class="composer-anchor" id="anchor"><div class="t2-composer-wrap"><div class="t2-composer">输入框</div></div></div>
  </div>
</body></html>`

/** 页内:按 dockviewStore.tweenGroupWidth 的真实曲线补间容器宽,逐帧采样。 */
const RUN = `(from, to) => new Promise((resolve) => {
  const view = document.getElementById('view')
  const stream = document.getElementById('stream')
  const marker = document.getElementById('marker')
  const tsum = document.getElementById('tsum')
  const samples = []
  const ease = (k) => 1 - Math.pow(1 - k, 3)
  const DURATION = 200            // 与 tweenGroupWidth 一致
  let start = 0
  const step = (ts) => {
    if (!start) start = ts
    const el = ts - start
    view.style.width = Math.round(from + (to - from) * ease(Math.min(1, el / DURATION))) + 'px'
    const cs = getComputedStyle(tsum)
    samples.push({
      t: el,
      markerY: marker.getBoundingClientRect().top,
      padR: parseFloat(getComputedStyle(stream).paddingRight),
      opacity: Number(cs.opacity),
      shown: cs.display !== 'none',
    })
    if (el < DURATION + 400) requestAnimationFrame(step)  // 补间后再采 400ms,抓 CSS 过渡的拖尾
    else resolve(samples)
  }
  requestAnimationFrame(step)
})`

const stats = (s) => {
  const jumps = s.slice(1).map((x, i) => Math.abs(x.markerY - s[i].markerY))
  const tweenEnd = s.find((x) => x.t >= 200) || s[s.length - 1]
  return {
    maxJump: Math.max(...jumps),
    lag: Math.abs(s[s.length - 1].padR - tweenEnd.padR),
    shownMs: (() => { const v = s.filter((x) => x.shown); return v.length ? v[v.length - 1].t - v[0].t : 0 })(),
    opacities: [...new Set(s.filter((x) => x.shown).map((x) => x.opacity.toFixed(2)))],
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 900 } })
  await p.setContent(HTML)
  const reset = async (w) => {
    await p.evaluate((w) => { document.getElementById('view').style.width = w + 'px' }, w)
    await p.waitForTimeout(500)
    await p.evaluate(() => { const s = document.getElementById('stream'); s.scrollTop = s.scrollHeight * 0.5 })
    await p.waitForTimeout(200)
  }
  const play = (from, to) => p.evaluate(`(${RUN})(${from},${to})`)

  // 三种开合:卡片留场 / 卡片退场(跨 760 阈值) / 卡片进场
  await reset(1188); const stay = stats(await play(1188, 888))
  await reset(1188); const exit = stats(await play(1188, 720))
  await reset(720); const enter = stats(await play(720, 1188))
  console.log('\n[仅供参考·不作判据] 视口内容位移(最大帧间跳变 px):'
    + ` 退场=${exit.maxJump.toFixed(0)} 进场=${enter.maxJump.toFixed(0)} 留场=${stay.maxJump.toFixed(0)}`)
  console.log('  (随滚动位置波动剧烈,详见文件抬头;红绿只看下面的几何契约)')

  // ⚠️按方向拆:**开**右栏(卡片退场)是用户报「面板停了字还在窜」的那一路,必须同帧落位。
  // 关右栏(卡片进场)方向上,容器查询二次求值会让过渡赶上末班车、拖一小段尾巴 —— 那一路
  // 正文本来就在变宽、也没人抱怨过,留一点缓动反而更顺,故只设个宽上限防它退化回病史值。
  check('⚠️开右栏时让位与面板补间同帧落位(病史:补间停了还在动 44px)', exit.lag <= 1,
    `补间结束后还在变=${exit.lag.toFixed(1)}px`)
  check('关右栏时让位的收尾不超过一个过渡尾巴', enter.lag <= 40, `补间结束后还在变=${enter.lag.toFixed(1)}px`)
  check('⚠️退场是动画不是硬切(display 挂了 allow-discrete)', exit.shownMs >= 150 && exit.opacities.length >= 5,
    `卡片可见=${exit.shownMs.toFixed(0)}ms opacity 档数=${exit.opacities.length}`)
  check('进场从隐藏态起手(@starting-style 生效)', Number(enter.opacities[0]) <= 0.2,
    `首帧 opacity=${enter.opacities[0]}`)

  // 让位与卡片同生共死:在场=满额(不遮正文),退场=0(正文回到居中)
  const shift = await p.evaluate(() => {
    const view = document.getElementById('view')
    const read = (w) => { view.style.width = w + 'px'; return parseFloat(getComputedStyle(document.getElementById('stream')).paddingRight) }
    return { wide: read(1400), tight: read(888), narrow: read(700), floor: read(560) }
  })
  check('⚠️卡片在场时全额让位(不遮正文)', shift.wide === 296 && shift.tight === 296,
    `1400px→${shift.wide} 888px→${shift.tight}`)
  check('⚠️卡片退场后让位归零(正文在聊天区里居中,右侧不留空带)',
    shift.narrow === 0 && shift.floor === 0, `700px→${shift.narrow} 560px→${shift.floor}`)
  // 阈值两侧的**稳态**必须一边满额一边归零。⚠️不能用「逐 1px 同步扫描」测:让位现在带过渡,
  // 同步循环里读到的是动画中途值(根本没推进帧),会得出「纹丝不动」的假绿。必须等过渡跑完再读。
  const settled = async (w) => {
    await p.evaluate((w) => { document.getElementById('view').style.width = w + 'px' }, w)
    await p.waitForTimeout(600)
    return p.evaluate(() => parseFloat(getComputedStyle(document.getElementById('stream')).paddingRight))
  }
  const above = await settled(761), below = await settled(759)
  check('⚠️卡片阈值(760)两侧:上满额、下归零', above === 296 && below === 0,
    `761px→${above} 759px→${below}`)

  // ⚠️两种让位路径必须**分别**成立(过渡写在容器查询里才做得到,见 chat2.css):
  //   内容驱动(会话开跑,容器宽不变)→ 平滑;宽度驱动(开右栏)→ 瞬时,免得和右栏补间各跑各的。
  await p.evaluate(() => {
    document.getElementById('view').style.width = '1400px'
    document.getElementById('tsum').className = 't2-tsum'
  })
  await p.waitForTimeout(300)
  const byContent = await p.evaluate(`(() => {
    document.getElementById('tsum').className = 't2-tsum show'
    return new Promise((r) => {
      const o = [], t0 = performance.now()
      const f = () => {
        o.push([performance.now() - t0,
          parseFloat(getComputedStyle(document.getElementById('stream')).paddingRight),
          parseFloat(getComputedStyle(document.getElementById('anchor')).paddingRight)])
        if (performance.now() - t0 < 700) requestAnimationFrame(f); else r(o)
      }
      requestAnimationFrame(f)
    })
  })()`)
  const midFrames = byContent.filter((x) => x[1] > 1 && x[1] < 295).length
  check('⚠️卡片因内容出现时,让位是平滑过渡(用户要的丝滑)', midFrames >= 10,
    `0→296 的中间帧=${midFrames}(硬切=0)`)
  check('过渡期间输入框与正文让位始终一致(中线不歪)',
    byContent.every((x) => Math.abs(x[1] - x[2]) <= 1))

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
})()
