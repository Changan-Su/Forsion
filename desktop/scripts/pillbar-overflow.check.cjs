/**
 * 新对话 pill 选择条(EnginePicker / AgentPicker)溢出契约检查(真 Chromium 断言)。
 *
 * 为什么存在:「⋯ 翻页」整个特性挂在一个**纯 CSS 布局前提**上 —— `.engine-picker-bar` 原本是
 * `inline-flex`(按内容自适应宽度),于是 `scrollWidth === clientWidth` 恒成立,
 * 「宽度放不下」这件事**永远测不出来**,⋯ 永远不出现。修法是 `.engine-picker{max-width:100%}`
 * + `.engine-picker-bar{max-width:100%}` 让它被可用宽度卡住。这个 flex 交叉轴尺寸链
 * (父级 align-items:center → 子项 fit-content → 再被 max-width 百分比夹住)靠肉眼推演极易想当然,
 * 故拿真浏览器钉住:**改这几条 CSS / 改 .newchat-pickers 结构后必跑**。
 *
 * 页面直接注入仓里**真实的 base.css**(不复制样式),故不会与源码漂移。
 * 翻页落点数学不在这里 —— 那是纯函数,见 frontend/src/components/pillBar.test.ts。
 *
 * 跑:node scripts/pillbar-overflow.check.cjs   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

const BASE_CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/styles/base.css'), 'utf8')
const SIDEBAR_CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/views/chat2/sidebar2.css'), 'utf8')

/** 复刻 ChatView 的真实结构:.t2-chat-view(内联 flex 列)> .newchat-pickers > .engine-picker > PillBar。 */
function page(nPills, viewWidth) {
  const pills = Array.from({ length: nPills }, (_, i) =>
    `<button class="engine-pill${i === nPills - 1 ? ' selected' : ''}" aria-checked="${i === nPills - 1}">
       <span class="engine-pill-icon"><span class="agent-pill-initial">A</span></span>
       <span class="engine-pill-label">Agent ${i}</span>
     </button>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --bg-card:#fff; --bg:#fff; --border:#ddd; --border-width:1px; --overlay-light:#eee;
            --text:#111; --text-muted:#666; --text-faint:#999; --font-ui:system-ui; }
    body { margin:0; }
    /* ChatView 根:style={{ flex:1, minHeight:0, display:'flex', flexDirection:'column', minWidth:0 }} */
    .t2-chat-view { display:flex; flex-direction:column; min-width:0; width:${viewWidth}px; }
    ${BASE_CSS}
  </style></head><body>
    <div class="t2-chat-view">
      <div class="newchat-pickers">
        <div class="engine-picker agent-picker">
          <div class="engine-picker-bar" data-more>
            <div class="engine-picker-scroll" role="radiogroup">${pills}</div>
            <button class="engine-picker-more">⋯</button>
          </div>
          <div class="engine-picker-hint">选择 Agent</div>
        </div>
      </div>
    </div>
  </body></html>`
}

/** 工作区左栏的档位条:.t2sw(flex 列,被侧栏宽度卡住)> PillBar。
 *  ⚠️侧栏变体把 bar 从 inline-flex 改成 flex —— 正是本文件开头警告的那条链,故单独钉一遍:
 *  只准**胶囊层**横滚,整个侧栏绝不能跟着横向滚动(2026-08-25 用户实报)。 */
function sidePage(nPills, sideWidth) {
  const pills = Array.from({ length: nPills }, (_, i) =>
    `<button class="t2sw-seg${i === 0 ? ' on' : ''}" aria-checked="${i === 0}">档位 ${i}</button>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root { --bg-card:#fff; --bg:#fff; --border:#ddd; --border-width:1px; --overlay-light:#eee;
            --overlay-medium:#ddd; --text:#111; --text-muted:#666; --text-faint:#999; --font-ui:system-ui; }
    body { margin:0; }
    /* 侧栏容器:固定宽 + flex 列(与 WorkspaceHost 里的侧栏面板同构) */
    .side-host { width:${sideWidth}px; display:flex; flex-direction:column; min-width:0; overflow:hidden; }
    .t2sw { display:flex; flex-direction:column; min-height:0; min-width:0; flex:1; }
    ${BASE_CSS}
    ${SIDEBAR_CSS}
  </style></head><body>
    <div class="side-host">
      <div class="t2sw">
        <div class="engine-picker-bar" data-more>
          <div class="engine-picker-scroll" role="radiogroup">${pills}</div>
          <button class="engine-picker-more">⋯</button>
        </div>
        <div class="t2sw-body"></div>
      </div>
    </div>
  </body></html>`
}

const measureSide = () => {
  const host = document.querySelector('.side-host')
  const bar = document.querySelector('.engine-picker-bar')
  const scroll = document.querySelector('.engine-picker-scroll')
  return {
    hostW: host.getBoundingClientRect().width,
    hostScrollW: host.scrollWidth,
    barW: bar.getBoundingClientRect().width,
    clientW: scroll.clientWidth,
    scrollW: scroll.scrollWidth,
  }
}

const measure = () => {
  const bar = document.querySelector('.engine-picker-bar')
  const scroll = document.querySelector('.engine-picker-scroll')
  const more = document.querySelector('.engine-picker-more')
  const view = document.querySelector('.t2-chat-view')
  return {
    viewW: view.getBoundingClientRect().width,
    barW: bar.getBoundingClientRect().width,
    clientW: scroll.clientWidth,
    scrollW: scroll.scrollWidth,
    moreRight: more.getBoundingClientRect().right,
    barRight: bar.getBoundingClientRect().right,
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 1200, height: 700 } })

  // ① 放不下:20 个 pill 塞进 420px 的聊天区 → 必须被卡住宽度并测得出溢出
  await p.setContent(page(20, 420))
  const many = await p.evaluate(measure)
  check('放不下时 bar 被可用宽度卡住(不撑破聊天区)', many.barW <= many.viewW + 1,
    `barW=${many.barW.toFixed(1)} viewW=${many.viewW.toFixed(1)}`)
  check('⚠️放不下时溢出测得出(scrollWidth > clientWidth,否则 ⋯ 永不出现)', many.scrollW - many.clientW > 1,
    `scrollW=${many.scrollW} clientW=${many.clientW}`)
  check('⋯ 钉在 bar 右端内侧', many.moreRight <= many.barRight + 1 && many.moreRight > many.barRight - 40,
    `moreRight=${many.moreRight.toFixed(1)} barRight=${many.barRight.toFixed(1)}`)

  // ② 放得下:3 个 pill → 不得误报溢出(否则窄列表也会冒出 ⋯)
  await p.setContent(page(3, 900))
  const few = await p.evaluate(measure)
  check('放得下时不误报溢出(⋯ 不该出现)', few.scrollW - few.clientW <= 1,
    `scrollW=${few.scrollW} clientW=${few.clientW}`)
  check('放得下时 bar 仍按内容收窄(不被拉满宽)', few.barW < 900,
    `barW=${few.barW.toFixed(1)}`)

  // ③ 滚动真的可行(overflow-x:auto 生效,且能滚到底)
  await p.setContent(page(20, 420))
  const scrolled = await p.evaluate(() => {
    const el = document.querySelector('.engine-picker-scroll')
    el.scrollLeft = 99999
    return { left: el.scrollLeft, max: el.scrollWidth - el.clientWidth }
  })
  check('内层可横向滚动且能到底', scrolled.left > 0 && Math.abs(scrolled.left - scrolled.max) <= 1,
    `left=${scrolled.left} max=${scrolled.max}`)

  // ④ 侧栏变体(工作区档位条):档位多到放不下时,**只有胶囊层横滚,侧栏本身不横滚**。
  await p.setContent(sidePage(8, 260))
  const side = await p.evaluate(measureSide)
  check('侧栏:溢出测得出(⋯ 会出现)', side.scrollW - side.clientW > 1,
    `scrollW=${side.scrollW} clientW=${side.clientW}`)
  check('⚠️侧栏:整条不撑破侧栏宽(否则整个 view 跟着左右滑)', side.barW <= side.hostW + 1,
    `barW=${side.barW.toFixed(1)} hostW=${side.hostW.toFixed(1)}`)
  check('⚠️侧栏:宿主容器自身无横向滚动内容', side.hostScrollW <= side.hostW + 1,
    `hostScrollW=${side.hostScrollW} hostW=${side.hostW.toFixed(1)}`)

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})()
