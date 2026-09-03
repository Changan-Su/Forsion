/**
 * 计划卡(.plan-card)+ 回退菜单(.rewind-menu)的布局契约检查(真 Chromium 断言)。
 *
 * 为什么存在(三条都只有真浏览器能说话):
 *  ① `.plan-body` 有 `max-height + overflow-y:auto`。决策按钮**必须在滚动区外面**——一旦被塞进
 *     滚动容器里,长计划下用户根本看不到「批准」,而单测/typecheck 全绿。
 *  ② 新的顶层卡类必须落在 chat2.css 的 `.t2-asst-col > …` 阅读宽白名单里(700px),否则满铺。
 *     卡壳复用 `.plan-card` 就是为了继承它,这条钉住「以后别改类名」。
 *  ③ 回退菜单借 `.composer-menu` 的卡壳,而那货默认 `bottom:100%`(向上弹,贴输入框)。消息行上
 *     必须向下弹,否则菜单盖住上一条消息、且贴着屏顶时不可见。
 *  另钉:5 个决策按钮在窄栏要换行(flex-wrap)而不是捅出卡片右缘。
 *
 * 页面注入仓里**真实的 base.css + chat2.css**(不复制样式),故不会与源码漂移。
 * 截图落 /tmp/plan-card.png 供人眼自查(DESIGN.md §8 观感自查)。
 *
 * 跑:npm run check:plancard   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

const longPlan = Array.from({ length: 40 }, (_, i) => `<p>${i + 1}. 计划步骤 ${i + 1}:改点东西然后验证一下</p>`).join('')

/** 复刻 EditorialMessage 的真实结构(助手列里的计划卡 + 用户行的回退菜单)。 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; }
  ${BASE_CSS}
  ${CHAT_CSS}
</style></head><body>
 <div class="t2-chat-view" style="width:1000px">
  <div class="t2-stream"><div class="t2-stream-inner" id="inner">
    <div class="t2-userwrap" id="userwrap">
      <div class="t2-actions" id="uacts">
        <button class="t2-iconbtn">c</button>
        <span style="position:relative;display:inline-flex" data-cmenu>
          <button class="t2-iconbtn" id="rwbtn">r</button>
          <div class="composer-menu rewind-menu left" id="rwmenu">
            <div class="menu-section">回退到这条消息</div>
            <button class="menu-item"><span class="grow">仅回退代码(3 个文件)</span></button>
            <button class="menu-item"><span class="grow">仅回退对话(原文回输入框)</span></button>
            <button class="menu-item" disabled><span class="grow">代码 + 对话都回退</span></button>
            <div class="menu-section rewind-note">只覆盖 agent 用写文件工具改过的文件;终端命令(run_bash)改的不在内。</div>
          </div>
        </span>
      </div>
      <div class="t2-user-col"><div class="t2-user">帮我改一下登录页</div></div>
    </div>
    <div class="t2-userwrap" id="lowwrap">
      <div class="t2-actions" id="lowacts">
        <span style="position:relative;display:inline-flex" data-cmenu>
          <button class="t2-iconbtn" id="lowbtn">r</button>
          <div class="composer-menu rewind-menu left up" id="lowmenu">
            <div class="menu-section">回退到这条消息</div>
            <button class="menu-item"><span class="grow">仅回退代码(1 个文件)</span></button>
            <button class="menu-item"><span class="grow">仅回退对话</span></button>
          </div>
        </span>
      </div>
      <div class="t2-user-col"><div class="t2-user">再看看底部这条</div></div>
    </div>
    <div class="t2-asst"><div class="t2-avatar">T</div><div class="t2-asst-col" id="col">
      <div class="t2-content">好的,先给计划。</div>
      <div class="plan-card" id="card">
        <div class="tg-card-title">📋 实施计划 <span class="plan-verdict">已批准</span></div>
        <div class="plan-body" id="body">${longPlan}</div>
        <div class="approval-actions" id="actions">
          <button class="btn primary sm">批准并开始执行</button>
          <button class="btn ghost sm">批准,手动开始</button>
          <button class="btn ghost sm">编辑计划</button>
          <button class="btn ghost sm">打回</button>
          <button class="btn danger sm">拒绝</button>
        </div>
      </div>
    </div></div>
  </div></div>
  <div class="composer-anchor" id="anchor"><div class="t2-composer-wrap" style="height:96px">输入框</div></div>
 </div>
</body></html>`

const measure = () => {
  const r = (id) => document.getElementById(id).getBoundingClientRect()
  const body = document.getElementById('body')
  const menu = document.getElementById('rwmenu')
  return {
    cardW: r('card').width,
    colW: r('col').width,
    cardRight: r('card').right,
    actionsRight: r('actions').right,
    actionsTop: r('actions').top,
    bodyBottom: r('body').bottom,
    bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    bodyMaxH: parseFloat(getComputedStyle(body).maxHeight),
    // 决策按钮在滚动区之外:actions 的 offsetParent 是卡片而非正文容器
    actionsInsideBody: body.contains(document.getElementById('actions')),
    menuTop: menu.getBoundingClientRect().top,
    menuH: menu.getBoundingClientRect().height,
    // 被上下同时定位压扁时高度会塌成一条缝,而「向下弹」的断言照样绿 → 必须单独钉住不压缩
    menuSqueezed: menu.scrollHeight > menu.clientHeight + 1,
    btnBottom: r('rwbtn').bottom,
    menuLeft: menu.getBoundingClientRect().left,
    menuRight: menu.getBoundingClientRect().right,
    innerRight: r('inner').right,
    // 按钮总宽 > 卡片内宽时必须换行:量首末按钮是否同一行
    firstBtnTop: document.querySelectorAll('#actions .btn')[0].getBoundingClientRect().top,
    lastBtnTop: document.querySelectorAll('#actions .btn')[4].getBoundingClientRect().top,
    // 菜单开着时这行动作必须自己保持可见(平时 opacity:0 靠 hover;无头环境没有 hover)
    actsOpacity: Number(getComputedStyle(document.getElementById('uacts')).opacity),
    // 向上翻的那份:要在按钮之上、且整体高于悬浮输入卡顶边
    upMenuBottom: document.getElementById('lowmenu').getBoundingClientRect().bottom,
    upMenuTop: document.getElementById('lowmenu').getBoundingClientRect().top,
    lowBtnTop: r('lowbtn').top,
    anchorTop: r('anchor').top,
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 900 } })
  await p.setContent(HTML)
  const m = await p.evaluate(measure)

  check('卡片吃阅读宽上限(700,不满铺)', m.cardW <= 701 && m.colW > 701, `cardW=${m.cardW.toFixed(1)} colW=${m.colW.toFixed(1)}`)
  check('⚠️长计划正文自己滚(不把整卡撑长)', m.bodyScrolls && m.bodyMaxH <= 400, `scrolls=${m.bodyScrolls} maxH=${m.bodyMaxH}`)
  check('⚠️决策按钮在滚动区外(长计划下也看得见)', !m.actionsInsideBody && m.actionsTop >= m.bodyBottom - 1,
    `insideBody=${m.actionsInsideBody} actionsTop=${m.actionsTop.toFixed(1)} bodyBottom=${m.bodyBottom.toFixed(1)}`)
  check('按钮不捅出卡片右缘', m.actionsRight <= m.cardRight + 1, `actions=${m.actionsRight.toFixed(1)} card=${m.cardRight.toFixed(1)}`)
  check('⚠️回退菜单向下弹(不是 .composer-menu 默认的向上)', m.menuTop >= m.btnBottom - 1,
    `menuTop=${m.menuTop.toFixed(1)} btnBottom=${m.btnBottom.toFixed(1)}`)
  check('⚠️回退菜单没被上下同时定位压成缝(单类覆盖会被后面的 .composer-menu 反压)',
    !m.menuSqueezed && m.menuH > 100, `h=${m.menuH.toFixed(1)} squeezed=${m.menuSqueezed}`)
  check('回退菜单不溢出消息列右缘', m.menuRight <= m.innerRight + 1, `menuRight=${m.menuRight.toFixed(1)} innerRight=${m.innerRight.toFixed(1)}`)

  check('⚠️菜单开着时动作行不随鼠标离开而隐形(:has 规则在)', m.actsOpacity > 0.99, `opacity=${m.actsOpacity}`)
  check('⚠️.up 向上翻:落在按钮之上,不被悬浮输入卡盖住', m.upMenuBottom <= m.lowBtnTop + 1 && m.upMenuBottom <= m.anchorTop + 1,
    `menuBottom=${m.upMenuBottom.toFixed(1)} btnTop=${m.lowBtnTop.toFixed(1)} anchorTop=${m.anchorTop.toFixed(1)}`)

  // 窄栏:5 个按钮必须换行而不是溢出(flex-wrap)
  await p.evaluate(() => { document.querySelector('.t2-chat-view').style.width = '420px' })
  await p.waitForTimeout(80)
  const narrow = await p.evaluate(measure)
  check('⚠️窄栏按钮换行,不溢出卡片', narrow.lastBtnTop > narrow.firstBtnTop && narrow.actionsRight <= narrow.cardRight + 1,
    `firstTop=${narrow.firstBtnTop.toFixed(1)} lastTop=${narrow.lastBtnTop.toFixed(1)} actionsRight=${narrow.actionsRight.toFixed(1)}`)

  await p.evaluate(() => { document.querySelector('.t2-chat-view').style.width = '1000px' })
  await p.waitForTimeout(80)
  const shot = process.env.PLANCARD_SHOT || '/tmp/plan-card.png'
  await p.screenshot({ path: shot, fullPage: true })
  console.log(`\n截图:${shot}`)
  await browser.close()

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})()
