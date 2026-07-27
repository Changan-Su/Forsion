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
 *  ③ 分区折叠用原生 `<details>`,而 `.t2-tsum-sec` 上写着 `display:flex`。折叠得量**分区自身**
 *     高度:关闭的 <details> 走 content-visibility:hidden,子元素的 rect 仍报旧尺寸,拿它判必假绿。
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
        <aside class="t2-tsum show" id="tsum"><div class="t2-tsum-in">
          <button class="t2-tsum-attn" id="attn">需要批准</button>
          <details class="t2-tsum-sec" id="sec" open>
            <summary class="t2-tsum-sectitle" id="sectitle"><span>来源</span><span class="t2-tsum-count">2</span><svg class="t2-tsum-chev" width="12" height="12" viewBox="0 0 24 24"></svg></summary>
            <div class="t2-tsum-scroll" id="secbody"><button class="t2-tsum-row act" id="row">a.md</button></div>
          </details>
        </div></aside>
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
  const p = await browser.newPage({ viewport: { width: 1600, height: 800 } })
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

  // ⑥ 分区折叠:.t2-tsum-sec 是带 display:flex 的原生 <details>,确认关得上、内容真的失活、
  //    默认 ▸ 没漏出来、chevron 贴右缘、且收起是**过渡**不是硬切。注意量的是**分区自身**高度:
  //    关闭的 <details> 走 content-visibility:hidden,子元素的 rect 仍报旧尺寸,拿它判折叠必假绿。
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
    return {
      closedH: document.getElementById('sec').getBoundingClientRect().height,
      titleH: title.height,
      chevGapToRight: title.right - chev.right,
      borderTop: getComputedStyle(document.getElementById('sec')).borderTopStyle,
      closedFocusable: (document.getElementById('row').focus(), document.activeElement.id === 'row'),
      listStyle: st.listStyleType,
      cursor: st.cursor,
    }
  })
  // 折叠后除了标题,只应剩标题自己的下边距(3px)——不画分割线、不留内边距
  check('⚠️折叠真的收起分区内容(除标题外不留高度)',
    openH > sec.closedH && sec.closedH - sec.titleH <= 8,
    `展开=${openH.toFixed(1)} 折叠=${sec.closedH.toFixed(1)} 标题=${sec.titleH.toFixed(1)} 余=${(sec.closedH - sec.titleH).toFixed(1)}`)
  check('⚠️折叠是过渡不是硬切(中途取到中间高度)',
    midH < openH - 1 && midH > sec.closedH + 1,
    `展开=${openH.toFixed(1)} 中途=${midH.toFixed(1)} 折叠=${sec.closedH.toFixed(1)}`)
  check('折叠后行 Tab 不到(内容真的失活,不只是看不见)', !sec.closedFocusable)
  check('分区标题去掉了原生 ▸ 且是可点样式', sec.listStyle === 'none' && sec.cursor === 'pointer',
    `list-style=${sec.listStyle} cursor=${sec.cursor}`)
  check('chevron 贴标题行右缘', Math.abs(sec.chevGapToRight) <= 1, `距右缘=${sec.chevGapToRight.toFixed(1)}px`)
  check('分区之间不画分割线', sec.borderTop === 'none', `border-top-style=${sec.borderTop}`)
  await p.evaluate(() => { document.getElementById('sec').open = true })

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
})()
