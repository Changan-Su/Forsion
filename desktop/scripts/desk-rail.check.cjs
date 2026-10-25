/**
 * Agent Desk 卡片态的垂直几何契约检查(真 Chromium 断言)。
 *
 * 为什么存在:摘要栏卡片栈(2026-10-25 用户改为多卡片,方案 A)的几何全挂在几条纯 CSS 前提上:
 *  ① 卡片 hug 内容、Desk 展开固定 380 —— 原来两卡写死 calc(50% - 5px),大窗口下 Desk 被拉得很长(用户报);
 *     这里在 900 高与 1400 高两档各量一次,Desk 卡高必须一样;
 *  ② 空着的 Desk 收起只剩卡头;.gone(侧板展开)隐身且不触发让位;只有 Desk 时栈照样出现(:has 判);
 *  ③ 卡片多了整栈在车道里滚,不顶出车道;
 *  ④ 容器查询按 `.t2-chat-col`(nearest container)求值,不是 `.t2-chat-view`——层级错了阈值就错。
 *  (2026-10-25 之前钉的是「严格 50/50 + Desk 卡底与输入框底线同线」,随用户改判撤掉。)
 *
 * 页面注入仓里**真实的 base.css + chat2.css**(不复制样式),DOM 复刻 ChatView 真实层级
 * (t2-chat-view row → t2-chat-col → t2-chat-body → t2-stream + t2-rail)。
 *
 * 2026-09-19 追加两组:
 *  ⑤ 新会话草稿不挂载 Desk:欢迎区 / Agent 选择条 / 输入卡 / 正文四条中线必须重合并居中整列,
 *     会话开始后的卡片让位仍由负对照检查
 *     (草稿页另注入 compactChatPicker.css + composer2.css,pickers 按真实结构放进 .composer-anchor);
 *  ⑥ 伴随面撑满:卡片正文挂 .companion 后 zoom 归 1(文件末尾的覆盖块压过 0.75 缩镜),
 *     伴随面挂载槽(DeskCompanionHost 的行内布局)铺满正文;另跑一次不带 .companion 的负对照。
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
        <aside class="t2-tsum show" id="tsum">
          <details class="t2-card t2-tsum-in" id="tsumin" open>
            <summary class="t2-card-head"><span class="t2-card-title"><span class="t2-tsum-state done">已完成</span></span><span class="t2-card-end"><svg class="t2-tsum-chev" width="12" height="12"></svg></span></summary>
            <div class="t2-card-body"><div class="t2-tsum-sub">短内容</div></div>
          </details>
          <details class="t2-card agent-desk-card" id="card" open>
            <summary class="t2-card-head"><span class="t2-card-title"><span>Agent Desk</span></span><span class="t2-card-end"><svg class="t2-tsum-chev" width="12" height="12"></svg></span></summary>
            <div class="t2-card-body agent-desk-card-frame act" id="frame"><div class="agent-desk-card-body"><div class="agent-desk-card-empty">内容</div></div></div>
          </details>
        </aside>
      </div>
    </div>
  </div>
</body></html>`

const measure = () => {
  const r = (id) => document.getElementById(id).getBoundingClientRect()
  const disp = (id) => getComputedStyle(document.getElementById(id)).display !== 'none'
  const rs = getComputedStyle(document.getElementById('rail'))
  const tsumShown = disp('tsum'); const cardShown = disp('card')
  const stack = document.getElementById('tsum')
  return {
    railH: r('rail').height, railBottom: r('rail').bottom,
    // 车道上下内边距实测而非写死:改 .t2-rail padding 时这条断言该跟着走,不该变成假红。
    railPadTop: parseFloat(rs.paddingTop), railPadBottom: parseFloat(rs.paddingBottom),
    tsumShown, stackH: tsumShown ? r('tsum').height : 0, stackBottom: tsumShown ? r('tsum').bottom : 0,
    stackScroll: tsumShown ? stack.scrollHeight - stack.clientHeight : 0,
    progH: tsumShown ? r('tsumin').height : 0,
    cardShown, cardH: cardShown ? r('card').height : 0,
    frameH: cardShown && document.getElementById('frame') ? r('frame').height : 0,
    streamPad: parseFloat(getComputedStyle(document.getElementById('stream')).paddingRight),
  }
}

/** ⑥:把卡片正文换成伴随面格子。槽的行内样式与 DeskCompanionHost.tsx 的 style 逐字同步(台架也靠它撑满)。 */
async function companionFill(p, withClass) {
  await p.evaluate((withClass) => {
    document.getElementById('view').style.width = '1400px'
    document.getElementById('tsum').className = 't2-tsum show'
    document.getElementById('card').className = 't2-card agent-desk-card'
    document.getElementById('card').open = true
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
        <aside class="t2-tsum" id="tsum"></aside>
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
    const shown = (id) => !!document.getElementById(id) && getComputedStyle(document.getElementById(id)).display !== 'none'
    const card = document.getElementById('card') ? r('card') : null
    const hit = (x) => !(x.right <= card.left || x.left >= card.right || x.bottom <= card.top || x.top >= card.bottom)
    const overlaps = []
    for (const [name, id] of [['bar', 'bar'], ['empty', 'empty'], ['projectbar', 'proj'], ['composer', 't2cinner']]) {
      if (shown('card') && hit(r(id))) overlaps.push(name)
    }
    return {
      cardShown: shown('card'), tsumShown: shown('tsum'), colCx: cx(r('col')),
      barCx: cx(r('bar')), emptyCx: cx(r('empty')), composerCx: cx(r('t2cinner')), streamCx: cx(r('inner')),
      overlaps,
    }
  })
}

async function at(p, width, tsumCls, cardCls = 't2-card agent-desk-card', cardOpen = true) {
  await p.evaluate(({ width, tsumCls, cardCls, cardOpen }) => {
    document.getElementById('view').style.width = width + 'px'
    document.getElementById('tsum').className = tsumCls
    document.getElementById('card').className = cardCls
    document.getElementById('card').open = cardOpen
  }, { width, tsumCls, cardCls, cardOpen })
  await p.waitForTimeout(700) // 进场 0.3s + 折叠 0.25s
  return p.evaluate(measure)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 900 } })
  await p.setContent(HTML)

  // ① 卡片 hug 内容:进度卡只有自己那点高,Desk 展开正文固定 380,栈高 = 两卡 + gap + 投影留白
  const both = await at(p, 1400, 't2-tsum show')
  // 用户口径(07-30 起):卡栈顶到聊天区上缘 == 车道底到聊天区下缘,车道上下内边距同值。
  check('⚠️车道上下留白同值', both.railPadTop === both.railPadBottom, `上=${both.railPadTop} 下=${both.railPadBottom}`)
  check('⚠️进度卡 hug 内容(不被拉高)', both.progH < 120, `progH=${both.progH.toFixed(1)}`)
  check('⚠️Desk 展开正文固定 380', Math.abs(both.frameH - 380) <= 1, `frameH=${both.frameH.toFixed(1)}`)
  check('⚠️栈 hug 两卡(不撑满车道)', Math.abs(both.stackH - (both.progH + both.cardH + 10 + 20)) <= 2 && both.stackH < both.railH - 100,
    `stack=${both.stackH.toFixed(1)} 两卡+gap+留白=${(both.progH + both.cardH + 30).toFixed(1)} rail=${both.railH.toFixed(1)}`)

  // ② 大窗口(1400 高):Desk 卡高与 900 高时一样(原来 50/50 会被拉到 ~690)
  await p.setViewportSize({ width: 1600, height: 1400 })
  const tall = await at(p, 1400, 't2-tsum show')
  check('⚠️大窗口下 Desk 不被拉长', Math.abs(tall.cardH - both.cardH) <= 1, `900 高=${both.cardH.toFixed(1)} 1400 高=${tall.cardH.toFixed(1)}`)
  await p.setViewportSize({ width: 1600, height: 900 })

  // ③ 空着的 Desk 收起只剩卡头
  const shut = await at(p, 1400, 't2-tsum show', 't2-card agent-desk-card empty', false)
  check('⚠️收起的 Desk 只剩卡头', shut.cardShown && shut.cardH < 60, `cardH=${shut.cardH.toFixed(1)}`)

  // ④ 只有 Desk(无 .show)时栈照样出现、照样让位
  const solo = await at(p, 1400, 't2-tsum')
  check('⚠️只有 Desk 时栈仍出现并让位', solo.tsumShown && solo.cardShown && solo.streamPad > 100, `stack=${solo.tsumShown} pad=${solo.streamPad}`)

  // ⑤ .gone(侧板展开期间):Desk 隐身;没有别的卡时整栈收起、不让位(否则侧板 + 车道双重挤正文)
  const gone = await at(p, 1400, 't2-tsum show', 't2-card agent-desk-card gone')
  check('gone 的 Desk 隐身,进度卡照常', !gone.cardShown && gone.tsumShown, `card=${gone.cardShown} stack=${gone.tsumShown}`)
  const goneSolo = await at(p, 1400, 't2-tsum', 't2-card agent-desk-card gone')
  check('⚠️只剩 gone 的 Desk:栈收起且不让位', !goneSolo.tsumShown && goneSolo.streamPad === 0, `stack=${goneSolo.tsumShown} pad=${goneSolo.streamPad}`)

  // ⑥ 卡片多到超出车道:整栈在车道里滚,不顶出车道底
  await p.evaluate(() => {
    const tpl = document.getElementById('tsumin')
    for (let i = 0; i < 6; i++) { const c = tpl.cloneNode(true); c.id = `extra${i}`; c.querySelector('.t2-card-body').innerHTML = '<div class="t2-tsum-row">row</div>'.repeat(8); document.getElementById('tsum').insertBefore(c, tpl) }
  })
  const many = await at(p, 1400, 't2-tsum show')
  check('⚠️卡片多了整栈内滚、不出车道', many.stackScroll > 0 && many.stackBottom <= many.railBottom - many.railPadBottom + 1,
    `可滚=${many.stackScroll.toFixed(0)} 栈底=${many.stackBottom.toFixed(1)} 车道内容底=${(many.railBottom - many.railPadBottom).toFixed(1)}`)
  await p.evaluate(() => { for (let i = 0; i < 6; i++) document.getElementById(`extra${i}`).remove() })

  // ⑦ 窄容器(<760,按 .t2-chat-col 求值)→ 整栈不显示
  const narrow = await at(p, 700, 't2-tsum show')
  check('窄容器整栈收掉', !narrow.tsumShown, `display=${narrow.tsumShown ? 'flex' : 'none'}`)

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

  // ⑤ 新会话草稿:不挂载卡片、概览不在场,四条中线回到整列中心。
  await p.setContent(DRAFT_HTML)
  for (const width of [1400, 900, 780]) {
    const d = await draftAt(p, width)
    check(`⚠️草稿态不显示卡片 @${width}`, !d.cardShown && !d.tsumShown, `card=${d.cardShown} tsum=${d.tsumShown}`)
    const xs = [d.barCx, d.emptyCx, d.composerCx, d.streamCx]
    check(`⚠️草稿态四条中线重合(选择条/欢迎区/输入卡/正文) @${width}`, Math.max(...xs) - Math.min(...xs) <= 1,
      `bar=${d.barCx} empty=${d.emptyCx} composer=${d.composerCx} stream=${d.streamCx}`)
    check(`⚠️草稿态选择条/欢迎区/项目条/输入卡不压卡片 @${width}`, d.overlaps.length === 0, d.overlaps.join(',') || 'none')
    check(`⚠️草稿态不为 Desk 让位 @${width}`, Math.abs(d.composerCx - d.colCx) <= 1,
      `composer=${d.composerCx} col=${d.colCx}`)
  }
  // 负对照:把 pickers 挪回 anchor 外(07-27 当时的结构)—— 拿不到让位,中线必须分叉,否则上面那组没有分辨力
  await p.evaluate(() => {
    document.getElementById('tsum').insertAdjacentHTML('beforeend', '<details class="t2-card agent-desk-card" id="card" open><summary class="t2-card-head">Agent Desk</summary><div class="t2-card-body agent-desk-card-frame"><div class="agent-desk-card-body"></div></div></details>')
    const pk = document.getElementById('pickers')
    document.getElementById('col').insertBefore(pk, document.getElementById('anchor'))
  })
  const old = await draftAt(p, 1400)
  check('负对照:pickers 在 anchor 外时中线分叉(本组断言有分辨力)', Math.abs(old.barCx - old.composerCx) > 50,
    `bar=${old.barCx} composer=${old.composerCx}`)

  await browser.close()
  const fails = results.filter((x) => !x.ok).length
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
