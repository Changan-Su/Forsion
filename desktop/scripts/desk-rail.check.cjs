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
 * 2026-09-19 追加两组:
 *  ⑤ 新对话草稿态卡片在场(不再 gone):欢迎区 / Agent 选择条 / 输入卡 / 正文四条中线必须重合,
 *     且谁都不压卡片 —— 07-27 那条「空会话不上场」的理由就是 pickers 拿不到让位,这里实测它已被覆盖
 *     (草稿页另注入 compactChatPicker.css + composer2.css,pickers 按真实结构放进 .composer-anchor);
 *  ⑥ 伴随面撑满:卡片正文挂 .companion 后 zoom 归 1(文件末尾的覆盖块压过 0.75 缩镜),
 *     伴随面挂载槽(DeskCompanionHost 的行内布局)铺满正文;另跑一次不带 .companion 的负对照。
 *
 * 2026-09-25 追加(UIUX 评审 U-18):
 *  ⑦ Desk 零条目 → [data-idle] 72px 小坞:仍钉右下、底缘仍与输入框底线同线;正文 / 欢迎区 / 输入卡 /
 *     选择条中线回到**整列**中线(不再让 --tsum-w);窄到 780 时输入区(.t2c-inner 整盒,含吃点击的内边距)也不压小坞(对称让 88px);
 *     概览在场时概览 hug 全高、让位照旧满额。负对照:拿掉输入卡的对称让位,780 必须压上小坞。
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
const PICKER_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/components/compactChatPicker.css'), 'utf8')
const COMPOSER_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/views/chat2/composer2.css'), 'utf8')

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
  const rs = getComputedStyle(document.getElementById('rail'))
  return {
    railH: rail.height, railBottom: rail.bottom, colBottom: col.bottom,
    // 车道上下内边距实测而非写死:改 .t2-rail padding 时这条断言该跟着走,不该变成假红。
    railPadY: parseFloat(rs.paddingTop) + parseFloat(rs.paddingBottom),
    railPadTop: parseFloat(rs.paddingTop),
    railPadBottom: parseFloat(rs.paddingBottom),
    cardShown, cardTop: card.top, cardBottom: card.bottom, cardH: card.height,
    tsumShown: shown, tsumH: shown ? r('tsum').height : 0, tsumBottom: shown ? r('tsum').bottom : 0, tsumInH: shown ? r('tsumin').height : 0,
    marginTop: getComputedStyle(document.getElementById('card')).marginTop,
  }
}

/** ⑥:把卡片正文换成伴随面格子。槽的行内样式与 DeskCompanionHost.tsx 的 style 逐字同步(台架也靠它撑满)。 */
async function companionFill(p, withClass) {
  await p.evaluate((withClass) => {
    document.getElementById('view').style.width = '1400px'
    document.getElementById('tsum').className = 't2-tsum show'
    document.getElementById('card').className = 'agent-desk-card'
    const body = document.querySelector('#card .agent-desk-card-body')
    body.className = withClass ? 'agent-desk-card-body companion' : 'agent-desk-card-body'
    body.innerHTML = '<div class="agent-desk-pane agent-desk-companion"><div class="agent-desk-companion-slot" id="slot"'
      + ' style="position:relative;flex:1 1 0;min-height:0;min-width:0;overflow:hidden">'
      + '<canvas id="cv" style="position:absolute;inset:0;width:100%;height:100%;display:block"></canvas></div></div>'
  }, withClass)
  // 卡片从窄容器(④)回来会跑 scale 0.8→1 的进场动画,getBoundingClientRect 含 transform —— 等它跑完再量
  await p.waitForTimeout(700)
  return p.evaluate(() => {
    const body = document.querySelector('#card .agent-desk-card-body')
    const b = body.getBoundingClientRect(); const s = document.getElementById('slot').getBoundingClientRect()
    const c = document.getElementById('cv').getBoundingClientRect()
    const z = body.currentCSSZoom
    // zoom 1 时 clientWidth/Height 即视觉 CSS px(= 内容盒,已扣 border-top)
    const out = { zoom: z, bodyW: body.clientWidth, bodyH: body.clientHeight, bodyLeft: b.left, bodyBottom: b.bottom,
      slotW: s.width, slotH: s.height, slotLeft: s.left, slotBottom: s.bottom,
      canvasW: c.width, canvasH: c.height }
    body.innerHTML = '<div class="agent-desk-card-empty">空态</div>'
    body.className = 'agent-desk-card-body'
    return out
  })
}

/** ⑤ 草稿态页面:按 ChatView 真实结构 —— .t2-empty 与 .composer-anchor 都是 .t2-chat-col 的直接子,
 *  .newchat-pickers / .newchat-projectbar 在 anchor 里、输入卡之上;概览无 .show(草稿无事实)。 */
const PILLS = Array.from({ length: 6 }, (_, i) => `<button class="engine-pill${i === 0 ? ' selected' : ''}"><span class="engine-pill-icon"><span class="agent-pill-initial">A</span></span><span class="engine-pill-label">Agent ${i}</span></button>`).join('')
const DRAFT_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body { margin:0; height:100%; }
  ${BASE_CSS}
  ${CHAT_CSS}
  ${PICKER_CSS}
  ${COMPOSER_CSS}
</style></head><body>
  <div class="t2-chat-view" id="view" style="flex:1;min-height:0;display:flex;flex-direction:row;min-width:0;height:100vh;width:1400px">
    <div class="t2-chat-col" id="col">
      <div class="t2-chat-body"><div class="t2-stream" id="stream"><div class="t2-stream-inner" id="inner"></div></div></div>
      <div class="t2-empty" id="empty" style="top:200px"><div class="t2-empty-title">欢迎标题</div></div>
      <div class="composer-anchor" id="anchor">
        <div class="newchat-pickers" id="pickers"><div class="engine-picker agent-picker"><div class="engine-picker-bar" id="bar"><div class="engine-picker-scroll">${PILLS}</div></div></div></div>
        <div class="newchat-projectbar"><div class="newchat-projectbar-inner" id="proj"><div style="width:120px;height:24px"></div></div></div>
        <div class="t2c"><div class="t2c-inner" id="t2cinner"><div class="t2-composer" style="height:80px"></div></div></div>
      </div>
      <div class="t2-rail" id="rail">
        <aside class="t2-tsum" id="tsum"><div class="t2-tsum-in"></div></aside>
        <div class="agent-desk-card" id="card"><div class="agent-desk-card-head">Agent Desk</div><div class="agent-desk-card-body"><div class="agent-desk-card-empty">空态</div></div></div>
      </div>
    </div>
  </div>
</body></html>`

async function draftAt(p, width) {
  await p.evaluate((width) => { document.getElementById('view').style.width = width + 'px' }, width)
  await p.waitForTimeout(700) // 让位过渡 0.45s
  return p.evaluate(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect()
    const cx = (x) => +(x.left + x.width / 2).toFixed(1)
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none'
    const card = r('card')
    const hit = (x) => !(x.right <= card.left || x.left >= card.right || x.bottom <= card.top || x.top >= card.bottom)
    const overlaps = []
    for (const [name, id] of [['bar', 'bar'], ['empty', 'empty'], ['projectbar', 'proj'], ['composer', 't2cinner']]) {
      if (shown('card') && hit(r(id))) overlaps.push(name)
    }
    return {
      cardShown: shown('card'), tsumShown: shown('tsum'),
      barCx: cx(r('bar')), emptyCx: cx(r('empty')), composerCx: cx(r('t2cinner')), streamCx: cx(r('inner')),
      overlaps,
    }
  })
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
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 900 } })
  await p.setContent(HTML)

  // ① 概览在场:两卡高度固定 50/50(概览卡撑满上半、内容内滚);Desk 卡底缘=列底-16=输入框底线
  const both = await at(p, 1400, 't2-tsum show')
  // 用户口径:概览卡顶到聊天区上缘 == Desk 卡底到聊天区下缘。两者就是车道的上下内边距,必须同值。
  // 我自己在 2026-07-30 把顶部单独调成 4 过一次,肉眼看不出来,靠这条钉住。
  check('⚠️车道上下留白同值(两卡到聊天区上/下缘等距)', both.railPadTop === both.railPadBottom,
    `上=${both.railPadTop} 下=${both.railPadBottom}`)
  const half = (both.railH - both.railPadY - 10) / 2 // (车道内容高 − gap) / 2
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

  // ④ 窄容器(<760,按 .t2-chat-col 求值)→ 卡片整个不显示
  const narrow = await at(p, 700, 't2-tsum show')
  check('窄容器卡片收掉', !narrow.cardShown, `display=${narrow.cardShown ? 'flex' : 'none'}`)

  // ⑥ 伴随面撑满(卡片正文 .companion → zoom 1;挂载槽铺满正文内容盒)
  const fill = await companionFill(p, true)
  check('⚠️伴随面正文 zoom 归 1(文件末尾覆盖块压过 0.75 缩镜)', fill.zoom === 1, `currentCSSZoom=${fill.zoom}`)
  check('⚠️伴随面挂载槽铺满卡片正文', Math.abs(fill.slotW - fill.bodyW) <= 1 && Math.abs(fill.slotH - fill.bodyH) <= 1
    && Math.abs(fill.slotLeft - fill.bodyLeft) <= 1 && Math.abs(fill.slotBottom - fill.bodyBottom) <= 1 && fill.slotH > 100,
    `slot=${fill.slotW.toFixed(1)}×${fill.slotH.toFixed(1)} body内容盒=${fill.bodyW}×${fill.bodyH}`)
  check('伴随面画布(absolute inset 0)与挂载槽同尺寸', Math.abs(fill.canvasW - fill.slotW) <= 1 && Math.abs(fill.canvasH - fill.slotH) <= 1,
    `canvas=${fill.canvasW.toFixed(1)}×${fill.canvasH.toFixed(1)}`)
  const ctl = await companionFill(p, false)
  check('负对照:不挂 .companion 时正文仍是 0.75 缩镜(本组断言有分辨力)', ctl.zoom === 0.75, `currentCSSZoom=${ctl.zoom}`)

  // ⑤ 新对话草稿:卡片在场、概览不在场,四条中线重合且不压卡片
  await p.setContent(DRAFT_HTML)
  for (const width of [1400, 900, 780]) {
    const d = await draftAt(p, width)
    check(`⚠️草稿态卡片在场 @${width}`, d.cardShown && !d.tsumShown, `card=${d.cardShown} tsum=${d.tsumShown}`)
    const xs = [d.barCx, d.emptyCx, d.composerCx, d.streamCx]
    check(`⚠️草稿态四条中线重合(选择条/欢迎区/输入卡/正文) @${width}`, Math.max(...xs) - Math.min(...xs) <= 1,
      `bar=${d.barCx} empty=${d.emptyCx} composer=${d.composerCx} stream=${d.streamCx}`)
    check(`⚠️草稿态选择条/欢迎区/项目条/输入卡不压卡片 @${width}`, d.overlaps.length === 0, d.overlaps.join(',') || 'none')
  }
  // 负对照:把 pickers 挪回 anchor 外(07-27 当时的结构)—— 拿不到让位,中线必须分叉,否则上面那组没有分辨力
  await p.evaluate(() => {
    const pk = document.getElementById('pickers')
    document.getElementById('col').insertBefore(pk, document.getElementById('anchor'))
  })
  const old = await draftAt(p, 1400)
  check('负对照:pickers 在 anchor 外时中线分叉(本组断言有分辨力)', Math.abs(old.barCx - old.composerCx) > 50,
    `bar=${old.barCx} composer=${old.composerCx}`)

  // ⑦ 零条目小坞(pickers 放回 anchor 里,复位成真实结构)
  await p.setContent(DRAFT_HTML)
  await p.evaluate(() => document.getElementById('card').setAttribute('data-idle', ''))
  for (const width of [1400, 900, 780]) {
    const d = await draftAt(p, width)
    const g = await p.evaluate(() => {
      const card = document.getElementById('card').getBoundingClientRect()
      const col = document.getElementById('col').getBoundingClientRect()
      return { w: card.width, h: card.height, bottom: card.bottom, right: card.right, colBottom: col.bottom, colRight: col.right,
        colCx: +(col.left + col.width / 2).toFixed(1),
        headShown: getComputedStyle(document.querySelector('#card .agent-desk-card-head')).display !== 'none' }
    })
    check(`⚠️小坞 72×72、钉右下、底缘=输入框底线 @${width}`, d.cardShown && Math.abs(g.w - 72) <= 1 && Math.abs(g.h - 72) <= 1
      && Math.abs(g.bottom - (g.colBottom - 16)) <= 1 && Math.abs(g.right - (g.colRight - 16)) <= 1 && !g.headShown,
      `${g.w.toFixed(1)}×${g.h.toFixed(1)} bottom=${g.bottom.toFixed(1)}/${(g.colBottom - 16).toFixed(1)} right=${g.right.toFixed(1)}/${(g.colRight - 16).toFixed(1)} head=${g.headShown}`)
    const xs = [d.barCx, d.emptyCx, d.composerCx, d.streamCx]
    check(`⚠️小坞不让车道:四条中线回到整列中线 @${width}`, Math.max(...xs.map((x) => Math.abs(x - g.colCx))) <= 1,
      `col=${g.colCx} bar=${d.barCx} empty=${d.emptyCx} composer=${d.composerCx} stream=${d.streamCx}`)
    check(`⚠️小坞不被选择条/欢迎区/项目条/输入卡压住 @${width}`, d.overlaps.length === 0, d.overlaps.join(',') || 'none')
  }
  // 概览在场 + 小坞:概览不再被钉成半高(hug),让位按概览照旧满额
  await p.evaluate(() => { document.getElementById('tsum').className = 't2-tsum show'; document.querySelector('#tsum .t2-tsum-in').style.height = '60px' })
  await p.waitForTimeout(700)
  const withTsum = await p.evaluate(() => {
    const t = document.getElementById('tsum').getBoundingClientRect()
    const rail = document.getElementById('rail').getBoundingClientRect()
    return { tsumH: t.height, railH: rail.height, pad: getComputedStyle(document.getElementById('anchor')).paddingRight }
  })
  check('小坞 + 概览:概览 hug(不占半高)、输入框按概览满额让位', withTsum.tsumH < withTsum.railH / 3 && withTsum.pad === '296px',
    `tsum=${withTsum.tsumH.toFixed(1)} rail=${withTsum.railH.toFixed(1)} anchor.padding-right=${withTsum.pad}`)
  // 负对照:去掉输入卡的对称让位 → 780 时输入卡必须压上小坞(否则上面「不压」那条没有分辨力)
  await p.evaluate(() => {
    document.getElementById('tsum').className = 't2-tsum'
    document.getElementById('anchor').style.setProperty('padding-inline', '0px', 'important')
  })
  const ctlDock = await draftAt(p, 780)
  check('负对照:不让 88px 时 780 输入卡压上小坞(本组断言有分辨力)', ctlDock.overlaps.includes('composer'), ctlDock.overlaps.join(',') || 'none')

  await browser.close()
  const fails = results.filter((x) => !x.ok).length
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
