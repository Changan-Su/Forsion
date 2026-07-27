/**
 * Agent Desk 卡片态的垂直几何契约检查(真 Chromium 断言)。
 *
 * 为什么存在:「严格上下 50/50 + 卡片钉底」全挂在几条纯 CSS 前提上,肉眼推演容易想当然:
 *  ① `.t2-rail:has(.agent-desk-card) .t2-tsum.show { flex: 0 0 calc(50% - 5px) }` —— 百分比
 *     flex-basis 在列向容器里按**车道高**解析,车道是 inset 定位才有确定高;
 *  ② `.agent-desk-card { margin-top: auto }` —— 概览不在场时靠 auto margin 吸掉上方空间钉底,
 *     概览在场时两个半高 + gap 恰好占满、auto 归零;这两种状态都得真浏览器量过才算数;
 *  ③ 容器查询按 `.t2-chat-col`(nearest container)求值,不是 `.t2-chat-view`——层级错了阈值就错。
 *
 * 页面注入仓里**真实的 base.css + chat2.css**(不复制样式),DOM 复刻 ChatView 真实层级
 * (t2-chat-view row → t2-chat-col → t2-chat-body → t2-stream + t2-rail)。
 *
 * 跑:node scripts/desk-rail.check.cjs   (playwright-core 自装 chromium;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  // playwright 自己的解析跨平台;失败再退回 mac-arm 缓存扫描(与 task-summary.check 同款兜底)
  try {
    const p = chromium.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch { /* fallthrough */ }
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

/** 复刻 ChatView 真实层级:view(row) → col(column,容器,relative) → body(t2-stream) + composer + t2-rail。
 *  rail 锚整列:Desk 卡底缘须与输入框底线(t2c-inner padding-bottom 16 → 列底 -16)同线。 */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; height:100%; }
  ${BASE_CSS}
  ${CHAT_CSS}
</style></head><body>
  <div class="t2-chat-view" id="view" style="flex:1;min-height:0;display:flex;flex-direction:row;min-width:0;height:100vh;width:1400px">
    <div class="t2-chat-col" id="col">
      <div class="t2-chat-body" id="body">
        <div class="t2-stream" id="stream"><div class="t2-stream-inner">正文</div></div>
      </div>
      <div class="composer-anchor" style="height:120px">输入框</div>
      <div class="t2-rail" id="rail">
        <aside class="t2-tsum show" id="tsum"><div class="t2-tsum-in" id="tsumin">
          <div class="t2-tsum-state done">已完成</div>
          <div class="t2-tsum-sub">短内容</div>
        </div></aside>
        <div class="agent-desk-card" id="card">
          <div class="agent-desk-card-head">Agent Desk</div>
          <div class="agent-desk-card-body"><div class="agent-desk-card-empty">空态</div></div>
        </div>
      </div>
    </div>
  </div>
</body></html>`

const measure = () => {
  const r = (id) => document.getElementById(id).getBoundingClientRect()
  const rail = r('rail'); const card = r('card'); const col = r('col')
  const tsum = document.getElementById('tsum')
  const shown = getComputedStyle(tsum).display !== 'none'
  const cardShown = getComputedStyle(document.getElementById('card')).display !== 'none'
  return {
    railH: rail.height, railBottom: rail.bottom, colBottom: col.bottom,
    cardShown, cardTop: card.top, cardBottom: card.bottom, cardH: card.height,
    tsumShown: shown, tsumH: shown ? r('tsum').height : 0, tsumBottom: shown ? r('tsum').bottom : 0, tsumInH: shown ? r('tsumin').height : 0,
    marginTop: getComputedStyle(document.getElementById('card')).marginTop,
  }
}

async function at(p, width, tsumCls, cardCls = 'agent-desk-card') {
  await p.evaluate(({ width, tsumCls, cardCls }) => {
    document.getElementById('view').style.width = width + 'px'
    document.getElementById('tsum').className = tsumCls
    document.getElementById('card').className = cardCls
  }, { width, tsumCls, cardCls })
  await p.waitForTimeout(500)
  return p.evaluate(measure)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await p.setContent(HTML)

  // ① 概览在场:两卡高度固定 50/50(概览卡撑满上半、内容内滚);Desk 卡底缘=列底-16=输入框底线
  const both = await at(p, 1400, 't2-tsum show')
  const half = (both.railH - 32 - 10) / 2 // (车道内容高 − gap) / 2
  check('⚠️两卡高度固定各半', Math.abs(both.tsumH - half) <= 2 && Math.abs(both.cardH - half) <= 2,
    `tsum=${both.tsumH.toFixed(1)} card=${both.cardH.toFixed(1)} 期望=${half.toFixed(1)}`)
  check('⚠️概览卡撑满上半(stretch,非 hug)', Math.abs(both.tsumInH - both.tsumH) <= 2,
    `卡=${both.tsumInH.toFixed(1)} 车道半格=${both.tsumH.toFixed(1)}`)
  check('⚠️卡片底缘与输入框底线同线(列底-16)', Math.abs(both.cardBottom - (both.colBottom - 16)) <= 1,
    `cardBottom=${both.cardBottom.toFixed(1)} 期望=${(both.colBottom - 16).toFixed(1)}`)
  check('两卡间只隔 gap,无空带', Math.abs(both.cardTop - (both.tsumBottom + 10)) <= 2,
    `cardTop=${both.cardTop.toFixed(1)} 概览底+gap=${(both.tsumBottom + 10).toFixed(1)}`)

  // ② 概览不在场(无 .show):卡片仍固定下半、钉底
  const solo = await at(p, 1400, 't2-tsum')
  check('⚠️概览不在场:卡片仍半高钉底', Math.abs(solo.cardH - half) <= 2 && Math.abs(solo.cardBottom - (solo.colBottom - 16)) <= 1,
    `card=${solo.cardH.toFixed(1)} 期望=${half.toFixed(1)}`)

  // ③ .gone(侧板展开期间):卡片隐身且不再触发让位/概览减半(:has(:not(.gone)))
  const gone = await at(p, 1400, 't2-tsum show', 'agent-desk-card gone')
  check('⚠️gone 卡隐身且概览拿回 hug', !gone.cardShown && gone.tsumInH <= gone.tsumH + 1 && gone.tsumH < half,
    `cardShown=${gone.cardShown} tsum=${gone.tsumH.toFixed(1)}(hug)`)

  // ④ 窄容器(<860,按 .t2-chat-col 求值)→ 卡片整个不显示
  const narrow = await at(p, 700, 't2-tsum show')
  check('窄容器卡片收掉', !narrow.cardShown, `display=${narrow.cardShown ? 'flex' : 'none'}`)

  await browser.close()
  const fails = results.filter((x) => !x.ok).length
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
