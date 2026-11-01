/**
 * 任务概览面板(.t2-tsum)的布局契约检查(真 Chromium 断言)。
 *
 * 为什么存在:「够宽才出现」整个特性挂在两条**纯 CSS 前提**上,靠肉眼推演都容易想当然:
 *  ① `@container (min-width:860px)` —— 容器是 `.t2-chat-view`(container-type:inline-size)。
 *     容器查询只能给**后代**改样式,给容器自身写规则是无效的;`.t2-tsum` 与 `.composer-anchor`
 *     都必须真的是后代才生效。
 *  ② 让位用的是 `.t2-chat-view:has(.t2-tsum.show, .agent-desk-card) .composer-anchor` —— :has() 条件
 *     挂在容器元素本身、而主语是后代,这条能不能在容器查询里落地,只有真浏览器说了算。
 *     不生效的后果不是报错,是正文左移 296px、输入框不动,中线歪掉。
 *  ③ 卡片折叠用原生 `<details>`(2026-10-25 起每段一张卡,`.t2-card`)。折叠得量**卡片自身**
 *     高度:关闭的 <details> 走 content-visibility:hidden,子元素的 rect 仍报旧尺寸,拿它判必假绿。
 *  ④ 卡头(10-29 用户定的卡头 3):折叠箭头紧挨标题,计数贴卡头右缘(第二轮 demo 两个 margin-left:auto 把计数推到中间,
 *     用户点名「太丑」);拖动把手和计数叠在同一格,鼠标停在卡头上才换成把手(停在正文上不换)。
 *     列表卡正文封顶 240 内滚,底部渐隐只在还有没露出来的内容时出现。
 * 另外钉住:收起时必须真的不占位、且进出确实有过渡(否则是硬闪不是丝滑)。
 *
 * 页面注入仓里**真实的 base.css + chat2.css**(不复制样式),故不会与源码漂移。
 * 面板显示什么内容不在这里 —— 那是纯函数,见 frontend/src/views/chat2/taskFacts.test.ts。
 *
 * 跑:npm run check:tasksummary   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

/** 复刻 ChatView 的真实结构与内联样式(见 views/ChatView.tsx 的根 div 与 .t2-rail 车道)。 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; height:100%; }
  ${BASE_CSS}
  ${CHAT_CSS}
</style></head><body>
  <div class="t2-chat-view" id="view" style="flex:1;min-height:0;display:flex;flex-direction:column;min-width:0;height:100vh;width:1400px">
    <div class="t2-chat-body">
      <div class="t2-stream" id="stream"><div class="t2-stream-inner" id="inner">正文</div></div>
      <div class="t2-rail" id="rail">
        <aside class="t2-tsum show" id="tsum">
          <details class="t2-card t2-tsum-in" id="prog" open>
            <summary class="t2-card-head"><span class="t2-card-title"><span>已完成</span><svg class="t2-tsum-chev" width="12" height="12" viewBox="0 0 24 24"></svg></span><span class="t2-card-end"><span class="t2-card-slot"><span class="t2-card-grip"></span></span></span></summary>
            <div class="t2-card-body"><button class="t2-tsum-attn" id="attn">需要批准</button></div>
          </details>
          <details class="t2-card" id="sec" open>
            <summary class="t2-card-head" id="sectitle"><span class="t2-card-title"><span id="sectx">来源</span><svg class="t2-tsum-chev" width="12" height="12" viewBox="0 0 24 24"></svg></span><span class="t2-card-end"><span class="t2-card-slot"><span class="t2-tsum-count" id="count">2</span><span class="t2-card-grip" id="grip"></span></span></span></summary>
            <div class="t2-card-body" id="secbody"><button class="t2-tsum-row act" id="row">a.md</button></div>
          </details>
        </aside>
      </div>
      <button class="jump-bottom t2-jump" id="jump">↓</button>
    </div>
    <div class="composer-anchor" id="anchor"><div class="t2-composer-wrap">输入框</div></div>
  </div>
</body></html>`

const measure = () => {
  const tsum = document.getElementById('tsum')
  const rail = document.getElementById('rail')
  const stream = document.getElementById('stream')
  const cs = getComputedStyle(tsum)
  // 面板宽的唯一真源在 CSS(--tsum-w),这里读出来比,免得断言把数字写死后与样式各走各的
  const wantW = parseFloat(getComputedStyle(document.getElementById('view')).getPropertyValue('--tsum-w'))
  const shown = cs.display !== 'none'
  return {
    wantW,
    railW: rail.getBoundingClientRect().width,
    shown,
    tsumW: tsum.getBoundingClientRect().width,
    tsumOpacity: Number(cs.opacity),
    anchorPadRight: parseFloat(getComputedStyle(document.getElementById('anchor')).paddingRight),
    streamPadRight: parseFloat(getComputedStyle(stream).paddingRight),
    streamW: stream.getBoundingClientRect().width,
    viewW: document.getElementById('view').getBoundingClientRect().width,
    transProps: cs.transitionProperty,
    transDur: cs.transitionDuration,
    // 「回到底部」按钮右缘要落在卡片左侧,不能压在卡片上
    jumpRight: document.getElementById('jump').getBoundingClientRect().right,
    tsumLeft: shown ? tsum.getBoundingClientRect().left : Infinity,
  }
}

/** 改宽度 → 等过渡跑完(最长 0.25s)再量。 */
async function at(p, width, cls) {
  await p.evaluate(({ width, cls }) => {
    document.getElementById('view').style.width = width + 'px'
    document.getElementById('tsum').className = cls
  }, { width, cls })
  await p.waitForTimeout(420)
  return p.evaluate(measure)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 800 } })
  await p.setContent(HTML)

  // ① 够宽 + 有事实 → 车道占 --tsum-w,正文让出同宽,输入框同步让位
  const wide = await at(p, 1400, 't2-tsum show')
  check('够宽时车道占满 --tsum-w', Math.abs(wide.railW - wide.wantW) <= 1, `railW=${wide.railW.toFixed(1)} 期望=${wide.wantW}`)
  check('够宽时卡片显示', wide.shown && wide.tsumOpacity > 0.99, `display=${wide.shown} opacity=${wide.tsumOpacity}`)
  check('⚠️输入框同步让位(:has() 在容器查询里生效)', Math.abs(wide.anchorPadRight - wide.wantW) <= 1,
    `padding-right=${wide.anchorPadRight} 期望=${wide.wantW}`)
  check('⚠️正文让出车道宽而不是被叠住', Math.abs(wide.streamPadRight - wide.wantW) <= 1,
    `stream padding-right=${wide.streamPadRight} 期望=${wide.wantW}`)
  check('⚠️「回到底部」让位,不压在卡片上', wide.jumpRight <= wide.tsumLeft,
    `jumpRight=${wide.jumpRight.toFixed(1)} tsumLeft=${wide.tsumLeft.toFixed(1)}`)

  // ②「两侧栏全开」这个最挤的常用布局必须还有(1512 屏 − 44 ribbon − 280 左 − 300 右 ≈ 888)
  const tight = await at(p, 888, 't2-tsum show')
  check('⚠️两侧栏全开(主区 888)时仍出现', tight.shown && Math.abs(tight.railW - tight.wantW) <= 1, `railW=${tight.railW.toFixed(1)}`)
  check('两侧栏全开时正文列仍 ≥560px', tight.streamW - tight.streamPadRight >= 560,
    `正文可用宽=${(tight.streamW - tight.streamPadRight).toFixed(1)}`)

  // ③ 真窄了 → 整块不显示,正文/输入框归位(不留空隙)
  const narrow = await at(p, 700, 't2-tsum show')
  check('⚠️窄了整块收掉(不留空隙)', !narrow.shown, `display=${narrow.shown ? 'flex' : 'none'}`)
  // 卡片退场后让位不是立刻归零,而是以斜率 1 连续收敛(700px→136,560px→0)——
  // 那是「跨阈值不出现一帧 296px 布局瞬跳」的代价,契约本身在 scripts/rail-jank.check.cjs
  check('窄了正文让位大幅收敛', narrow.streamPadRight < narrow.wantW / 2,
    `stream padding-right=${narrow.streamPadRight}(宽屏 ${narrow.wantW})`)
  check('窄了输入框与正文让位一致', Math.abs(narrow.anchorPadRight - narrow.streamPadRight) <= 1,
    `输入框=${narrow.anchorPadRight} 正文=${narrow.streamPadRight}`)
  check('收起后按钮真的 Tab 不到',
    await p.evaluate(() => { document.getElementById('attn').focus(); return document.activeElement.id !== 'attn' }))

  // ④ 够宽但没事实(无 .show)→ 同样不占位
  const noFacts = await at(p, 1400, 't2-tsum')
  check('没事实时不出卡(够宽也不显示)', !noFacts.shown, `display=${noFacts.shown ? 'flex' : 'none'}`)

  // ⑤ 进出是过渡不是硬闪。display 必须也在过渡列表里(transition-behavior: allow-discrete),
  //    否则**离场**没动画 —— display:none 是离散属性,不挂 allow-discrete 就是硬切。
  check('opacity/scale/translate/display 上都有过渡(丝滑进出的前提)',
    ['opacity', 'scale', 'translate', 'display'].every((k) => wide.transProps.includes(k)) && !/^0s/.test(wide.transDur),
    `${wide.transProps} / ${wide.transDur}`)

  // ⑥ 卡片折叠:.t2-card 是原生 <details>,确认关得上、内容真的失活、默认 ▸ 没漏出来、箭头紧挨标题、
  //    计数贴右缘、且收起是**过渡**不是硬切。量的是**卡片自身**高度(见头注 ③)。
  await at(p, 1400, 't2-tsum show')
  const secH = () => p.evaluate(() => document.getElementById('sec').getBoundingClientRect().height)
  const openH = await secH()
  await p.evaluate(() => { document.getElementById('sec').open = false })
  await p.waitForTimeout(90) // 过渡(0.25s)中途取一帧
  const midH = await secH()
  await p.waitForTimeout(420)
  const sec = await p.evaluate(() => {
    const st = getComputedStyle(document.getElementById('sectitle'))
    const title = document.getElementById('sectitle').getBoundingClientRect()
    const chev = document.querySelector('#sectitle .t2-tsum-chev').getBoundingClientRect()
    const count = document.getElementById('count').getBoundingClientRect()
    const grip = document.getElementById('grip').getBoundingClientRect()
    const tx = document.getElementById('sectx').getBoundingClientRect()
    const cs = getComputedStyle(document.getElementById('sec'))
    return {
      closedH: document.getElementById('sec').getBoundingClientRect().height,
      titleH: title.height,
      padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth),
      chevToText: chev.left - tx.right,
      countToRight: title.right - count.right,
      slotDx: Math.abs(grip.right - count.right),
      slotDy: Math.abs((grip.top + grip.bottom) / 2 - (count.top + count.bottom) / 2),
      closedFocusable: (document.getElementById('row').focus(), document.activeElement.id === 'row'),
      listStyle: st.listStyleType,
      cursor: st.cursor,
    }
  })
  check('⚠️折叠真的收起卡片正文(只剩卡头 + 卡片内边距)',
    openH > sec.closedH && sec.closedH - sec.titleH - sec.padY <= 1,
    `展开=${openH.toFixed(1)} 折叠=${sec.closedH.toFixed(1)} 卡头=${sec.titleH.toFixed(1)} 内边距=${sec.padY}`)
  check('⚠️折叠是过渡不是硬切(中途取到中间高度)',
    midH < openH - 1 && midH > sec.closedH + 1,
    `展开=${openH.toFixed(1)} 中途=${midH.toFixed(1)} 折叠=${sec.closedH.toFixed(1)}`)
  check('折叠后行 Tab 不到(内容真的失活,不只是看不见)', !sec.closedFocusable)
  check('卡头去掉了原生 ▸ 且是可点样式', sec.listStyle === 'none' && sec.cursor === 'pointer',
    `list-style=${sec.listStyle} cursor=${sec.cursor}`)
  check('⚠️折叠箭头紧挨标题(卡头 3)', sec.chevToText >= 2 && sec.chevToText <= 6, `标题右缘到箭头=${sec.chevToText.toFixed(1)}px`)
  check('⚠️计数贴卡头右缘(不被推到中间)', Math.abs(sec.countToRight) <= 1, `距右缘=${sec.countToRight.toFixed(1)}px`)
  check('拖动把手和计数叠在同一格', sec.slotDx <= 1 && sec.slotDy <= 1, `右缘差=${sec.slotDx.toFixed(1)} 中线差=${sec.slotDy.toFixed(1)}`)
  await p.evaluate(() => { document.getElementById('sec').open = true })
  await p.waitForTimeout(400)

  // ⑥b 规矩 6:开合按会话存,换会话那一下同一张卡的 open 会变 —— 栈 data-still 时直接到位,不播展开 / 收起
  await p.evaluate(() => { document.getElementById('tsum').setAttribute('data-still', '') })
  await p.evaluate(() => { document.getElementById('sec').open = false })
  await p.waitForTimeout(40)
  const stillH = await secH()
  check('⚠️栈 data-still 时折叠直接到位(换会话不播)', Math.abs(stillH - sec.closedH) <= 1, `40ms 后=${stillH.toFixed(1)} 折叠=${sec.closedH.toFixed(1)}`)
  await p.evaluate(() => { document.getElementById('tsum').removeAttribute('data-still'); document.getElementById('sec').open = true })
  await p.waitForTimeout(400)

  // ⑦ 列表卡正文封顶 240 内滚;底部渐隐只在下面还有内容时出现(滚到底收掉;没溢出不渐隐)
  await p.evaluate(() => { document.getElementById('secbody').innerHTML = '<button class="t2-tsum-row act">a.md</button>'.repeat(30) })
  await p.waitForTimeout(300)
  const fade = () => p.evaluate(() => {
    const b = document.getElementById('secbody')
    return { h: b.getBoundingClientRect().height, scroll: b.scrollHeight - b.clientHeight, fade: getComputedStyle(b).getPropertyValue('--t2-card-fade').trim() }
  })
  const long = await fade()
  check('⚠️列表卡正文封顶 240 且可滚', Math.abs(long.h - 240) <= 1 && long.scroll > 0, `h=${long.h.toFixed(1)} 可滚=${long.scroll}`)
  check('⚠️有没露出来的内容时底部渐隐', long.fade === '22px', `--t2-card-fade=${long.fade}`)
  await p.evaluate(() => { const b = document.getElementById('secbody'); b.scrollTop = b.scrollHeight })
  await p.waitForTimeout(100)
  const bottom = await fade()
  check('滚到底渐隐收掉', bottom.fade === '0px', `--t2-card-fade=${bottom.fade}`)
  await p.evaluate(() => { document.getElementById('secbody').innerHTML = '<button class="t2-tsum-row act" id="row">a.md</button>' })
  await p.waitForTimeout(300)
  const short = await fade()
  check('⚠️没溢出时不渐隐(最后一行不被抹淡)', short.fade === '0px' && short.scroll === 0, `--t2-card-fade=${short.fade} 可滚=${short.scroll}`)

  // ⑦b 限长给正文加封顶(TaskSummary 的 bodyCap)时子元素不被 flex 压扁:scrollHeight 照旧报自然高度,
  //    否则量出来变矮 → 撤封顶 → 又变高,来回翻(Codex 评审 P1;插件根自带 overflow:auto 时最容易压扁)
  await p.evaluate(() => { const b = document.getElementById('secbody'); b.innerHTML = '<div style="height:240px;overflow:auto"></div>'; b.style.maxHeight = '134px' })
  await p.waitForTimeout(400) // 封顶变化本身有过渡(--collapse-duration)
  const capped = await p.evaluate(() => {
    const b = document.getElementById('secbody')
    const out = { scroll: b.scrollHeight, h: b.getBoundingClientRect().height }
    b.innerHTML = '<button class="t2-tsum-row act" id="row">a.md</button>'; b.style.maxHeight = ''
    return out
  })
  await p.waitForTimeout(400)
  check('⚠️正文封顶时子元素不被压扁(scrollHeight 仍是自然高度)', capped.scroll >= 240 && Math.abs(capped.h - 134) <= 1, `scrollHeight=${capped.scroll} 高=${capped.h.toFixed(1)}`)

  // ⑧ 拖动把手:平时露计数;鼠标停在卡头上计数淡出、把手淡入;停在正文上不换
  const slot = () => p.evaluate(() => ({ grip: Number(getComputedStyle(document.getElementById('grip')).opacity), count: Number(getComputedStyle(document.getElementById('count')).opacity) }))
  await p.mouse.move(5, 5)
  await p.waitForTimeout(250)
  const idle = await slot()
  const box = await p.evaluate(() => {
    const h = document.getElementById('sectitle').getBoundingClientRect(), b = document.getElementById('secbody').getBoundingClientRect()
    return { x: h.left + h.width / 2, head: (h.top + h.bottom) / 2, body: (b.top + b.bottom) / 2 }
  })
  await p.mouse.move(box.x, box.body)
  await p.waitForTimeout(250)
  const onBody = await slot()
  await p.mouse.move(box.x, box.head)
  await p.waitForTimeout(250)
  const onHead = await slot()
  check('⚠️平时露计数、不露把手', idle.grip === 0 && idle.count === 1, `把手=${idle.grip} 计数=${idle.count}`)
  check('停在正文上不换', onBody.grip === 0 && onBody.count === 1, `把手=${onBody.grip} 计数=${onBody.count}`)
  check('⚠️停在卡头上计数换成把手', onHead.grip === 1 && onHead.count === 0, `把手=${onHead.grip} 计数=${onHead.count}`)

  // ⑨ 立体感三档(开发者选项,TaskSummary 把 SummaryElevation 写到 .t2-tsum[data-elev];2026-10-28 用户定缺省「半浮」)。
  //    浮 = 和输入卡同一枚投影 + 同族圆角;半浮 = 低一档的影子 + 圆角小一档;平 = 不投影;拿起来的那张三档都照旧浮。
  //    摘要栏不做「凹」(两轮被否),这里不给它留档位。
  const elev = (mode, lifted = false) => p.evaluate(({ mode, lifted }) => {
    document.documentElement.dataset.mode = 'light'
    document.getElementById('tsum').dataset.elev = mode
    const card = document.getElementById('sec'); card.classList.toggle('t2-card-lifted', lifted)
    const c = getComputedStyle(card)
    const out = { shadow: c.boxShadow, radius: parseFloat(c.borderTopLeftRadius) }
    card.classList.remove('t2-card-lifted')
    return out
  }, { mode, lifted })
  const fl = await elev('float'), hf = await elev('half'), ft = await elev('flat')
  check('「浮」= 输入卡那枚投影 + 同族圆角', fl.shadow !== 'none' && fl.radius === 16, `影=${fl.shadow} 圆角=${fl.radius}`)
  check('「半浮」影子比「浮」低一档、圆角小一档', hf.shadow !== 'none' && hf.shadow !== fl.shadow && hf.radius === 12, `影=${hf.shadow} 圆角=${hf.radius}`)
  check('「平」不投影', ft.shadow === 'none', `影=${ft.shadow}`)
  const liftHalf = await elev('half', true), liftFlat = await elev('flat', true)
  check('拿起来的那张三档都照旧浮', liftHalf.shadow !== hf.shadow && liftFlat.shadow !== 'none', `半浮拿起=${liftHalf.shadow} 平拿起=${liftFlat.shadow}`)
  await p.evaluate(() => { document.documentElement.dataset.flat = '1' })
  const hfFlatToggle = await elev('half')
  check('外观「扁平」开关下半浮的影子也清掉', hfFlatToggle.shadow === 'none', `影=${hfFlatToggle.shadow}`)
  await p.evaluate(() => { delete document.documentElement.dataset.flat; delete document.documentElement.dataset.mode })

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
})()
