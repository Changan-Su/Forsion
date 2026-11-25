/** Real Electron:划线菜单 —— 选中文字后浮出来的那一条(DESIGN §6「划线菜单」)。
 * 钉住:
 *   聊天 —— 条在选区上方居中、不越出视口,外壳是圆角矩形(不是胶囊);组成 = 引用 / 在侧栏提问 / 顺便问 / 翻译(+ ⋯);
 *           「引用」照旧挂卡;翻译开**只读**结果卡(没有「替换」),目标语言按界面语言定,缺省走目录里的机器翻译模型,
 *           卡上写明谁译的,卡头换语言重译,点卡外面收;自动选上的机器翻译模型失败时落回聊天模型;
 *           插件动作按 scope / when 进 ⋯;输入框里的选区不出;点到外面收。
 *   跟着那段字走(划线菜单方案 B,2026-11-08)—— 聊天 / 插件视图滚动时条跟着走、滚出可见区只藏不收、滚回来原样出现;
 *           ⋯ 展开时那一行不动、面板往远离选区的一侧长;不经鼠标切标签时结果卡藏起、切回来还在;插件 show({ getRect }) 也跟。
 *   插件视图 —— ctx.ui.mountSelectionBar:自己的工具(颜色点 / 图标钮)+ 宿主的动作区;接管「问 Tangu」;source 交给动作;
 *           output:'none' 不出卡;show() / hide();输入框里不出;排法设置(工具在前 / 动作在前);dispose 后不再出。
 *   插件常驻 / 朗读 / 自动 / 翻译归属(2026-11-21,第三个实例:探针插件 id 就叫 translation)—— 装着 translation 插件宿主翻译不出;
 *           placement:'bar' 上条、第 4 个起进 ⋯ 并提示「还有 N 个放不下」;⋯ 里的钉 / 条上右键「收进 ⋯」生效;朗读没配模型出提示卡、
 *           配了之后三态(合成中 → 播放中 → 静止);结果卡的原文 / 小喇叭 / 卡头语言记住;卡头开「划选后自动」后划选出卡(条留着)、
 *           新划选在同一张卡里重跑(不卸载不闪)并中止旧请求、同段同语言不重复请求;设置里的管理表列出这些动作。
 * 笔记那一半(格式工具栏里的动作区)在浏览器台架 `npm run check:editorai -- --group=H`。
 * npm run build && npm run check:selectionbar        ZOOM=1.1 再跑一遍(用户的开发版常年 110%)
 * 全程打隔离 loopback stub(引擎 /agent/inline 按剧本回 SSE),不碰真账号、不烧模型额度;对真的机器翻译接口这里证不了。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const ZOOM = Number(process.env.ZOOM || 1)
let checks = 0
const failed = []
/** 红了记下来接着往下走(后面的步骤多半互不依赖;真依赖的会自己超时抛错),收尾时有一条红就非零退出。 */
function check(name, condition, detail) {
  if (condition) { console.log(`PASS ${name}`); checks++; return }
  failed.push(name)
  console.log(`FAIL ${name}${detail ? ` | ${detail}` : ''}`)
}
/** main() 里装上:一段抛了就拍一张、记下当时页面上有什么 —— 下次红了从证据查起,不用再占一次锁去猜。 */
let onStepFail = null
/** 一段和后面互不依赖的步骤:里面抛了(等不到元素之类)记一条红,后面的段照跑。 */
// 调试用:STEP=<名字片段> 只跑名字里含它的段(实例照样起)
async function step(name, fn) {
  if (process.env.STEP && !name.includes(process.env.STEP)) return
  try { await fn() } catch (e) {
    failed.push(name)
    console.log(`FAIL ${name} | 抛错: ${String((e && e.message) || e).split('\n')[0]}`)
    if (onStepFail) await onStepFail(name).catch(() => {})
  }
}
async function until(fn, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 120)) } }

const now = Date.now()
const SESSIONS = [{ id: 'sess-main', title: 'Parser 重构', model_id: 'm1', created_at: now, updated_at: now, projectless: true }]
const REPLY = '好的,代号 AZURE-FALCON 已记下。接下来重构解析器的词法阶段,先把记号流和错误恢复拆开,再补一组边界用例。'
/** 一段长的历史回复:让聊天区真能滚(跟随那几段要真滚动,不是派一个假的 scroll 事件)。FOLLOW 在中间,上下都有余量。 */
const FOLLOW = '跟随锚点这一句用来看划线条跟不跟着滚动'
const HISTORY = Array.from({ length: 50 }, (_, i) => (i === 20 ? `${FOLLOW},后面还有几个字。` : `第 ${i + 1} 条历史:这是一段用来把聊天撑高的回复,里面没有台架要找的字。`)).join('\n\n')
const MESSAGES = [
  { id: 'u0', role: 'user', content: '先给我一份长一点的历史记录。', timestamp: now - 900 },
  { id: 'a0', role: 'model', content: HISTORY, timestamp: now - 800 },
  { id: 'u1', role: 'user', content: '记住:项目代号是 AZURE-FALCON。', timestamp: now - 500 },
  { id: 'a1', role: 'model', content: `${REPLY}\n\nThe lexer should stay a pure function of its input.`, timestamp: now - 400 },
]
const sse = (events) => ({ __buffer: Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')), contentType: 'text/event-stream' })

const PLUGIN_MAIN = `
window.__selprobe = { ran: [], asked: [], tools: [], bar: null }
ctx.registerSelectionAction({ id: 'note-only', title: '只在笔记', run: function () { return 'x' } })
ctx.registerSelectionAction({ id: 'everywhere', title: '到处', scope: 'all', icon: 'bookmark', run: function (cx) { return 'E:' + cx.view + ':' + cx.editable + ':' + (cx.pagePath === undefined) + ':' + (cx.source && cx.source.title) } })
ctx.registerSelectionAction({ id: 'long', title: '长的才有', scope: ['chat'], when: function (cx) { return cx.length >= 15 }, run: function () { return 'x' } })
ctx.registerSelectionAction({ id: 'own', title: '只在自己的视图', scope: 'own', output: 'none', run: function (cx) { window.__selprobe.ran.push(cx.text + '|' + cx.view + '|' + (cx.source && cx.source.page)) } })
ctx.registerView({ id: 'reader', title: 'Sel Probe', mount: function (el) {
  el.innerHTML = '<div class="selprobe" style="height:100%;overflow:auto;padding:260px 60px 120px;font-size:15px;line-height:1.7;color:var(--text)"><p id="selprobe-p">Plugin view paragraph for the selection bar check.</p><input id="selprobe-in" value="text inside an input" style="width:260px"/><div style="height:1600px"></div></div>'
  var bar = ctx.ui && ctx.ui.mountSelectionBar ? ctx.ui.mountSelectionBar(el, {
    view: 'reader',
    tools: [
      { id: 'yellow', title: 'Highlight', color: '#ffd400', run: function (sel) { window.__selprobe.tools.push('yellow:' + sel.text) } },
      { id: 'note', title: 'Annotate', icon: 'annotate', run: function (sel) { window.__selprobe.tools.push('note:' + sel.text); window.getSelection().removeAllRanges() } },
    ],
    source: function () { return { title: 'Probe doc', page: 7 } },
    ask: function (sel) { window.__selprobe.asked.push(sel.text) },
  }) : null
  window.__selprobe.bar = bar
  return function () { if (bar) bar.dispose() }
} })
window.__selprobe.open = function () { return ctx.openView('reader') }
`

/** 第三个实例的探针插件:id 就叫 translation(契约 §5:装着它,宿主自己的翻译就不出)。只注册一个支持自动 / 卡头语言 / 原文 / 小喇叭的
 *  「翻译」。11-22 翻译插件随包后,translation 是宿主认的核心插件(版本 1.0.0 高于随包版,播种不换它,但照样记成内置):
 *  它的动作站在宿主那组、不占插件位,和装出去的产品一样。占位那几个放在另一个普通插件 pinprobe(SLOTS_MAIN)里。run 记下拿到的语言 / 是不是自动、被中止的次数;delay 可调(测「新划选中止旧请求」)。 */
const PINS_MAIN = `
window.__pins = { runs: [], aborted: 0, delay: 0 }
function tr(cx) {
  window.__pins.runs.push({ text: cx.text, language: cx.language, auto: !!cx.auto })
  var d = window.__pins.delay
  return new Promise(function (res, rej) {
    var settled = false
    var tm = setTimeout(function () { settled = true; res('T(' + cx.language + '|' + (cx.auto ? 'auto' : 'manual') + '):' + cx.text.slice(0, 6)) }, d)
    // 只数在飞时被中止的(已经出结果的卡被换掉时宿主也会 abort 它的 signal,那不算)
    if (cx.signal) cx.signal.addEventListener('abort', function () { if (settled) return; clearTimeout(tm); window.__pins.aborted++; rej(new Error('aborted')) })
  })
}
ctx.registerSelectionAction({ id: 'translate', title: { zh: '翻译', en: 'Translate' }, icon: 'languages', scope: 'all', placement: 'bar', auto: true, card: { language: true, source: true, speak: true }, run: tr })
`
/** 第三个实例的第二个探针插件 pinprobe(普通插件):四个要上条的(插件位 3 颗,放不下的进 ⋯),一个缺省进 ⋯ 的。 */
const SLOTS_MAIN = `
;[['b1', '摘录到今日笔记', 'bookmark'], ['b2', '查词典', 'book-open'], ['b3', '生成闪卡', 'layout-grid'], ['b4', '做成分享图', 'image']].forEach(function (a) {
  ctx.registerSelectionAction({ id: a[0], title: a[1], icon: a[2], scope: 'all', placement: 'bar', run: function () { return a[0] } })
})
ctx.registerSelectionAction({ id: 'm1', title: '搜索网页', icon: 'globe', scope: 'all', run: function () { return 'web' } })
`
/** 一段 1.2 秒的静音 WAV(8 kHz / 16 bit / 单声道):朗读的假合成结果,够看「播放中」再自己放完。 */
function silentWav(seconds = 1.2) {
  const rate = 8000, n = Math.round(rate * seconds), data = n * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(data, 40)
  return b
}

/** 用滚轮把 `text` 滚到屏中间附近(最多 30 下)。 */
async function wheelTo(win, rootSel, text) {
  const yOf = () => win.evaluate(({ rootSel, text }) => {
    for (const root of document.querySelectorAll(rootSel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) if (n.data.includes(text)) return n.parentElement.getBoundingClientRect().top
    }
    return null
  }, { rootSel, text })
  const c = await win.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: Math.min(r.bottom, innerHeight) - 100 } }, rootSel)
  await win.mouse.move(c.x, c.y)
  for (let i = 0; i < 30; i++) {
    const y = await yOf()
    if (y == null) throw new Error(`text not found: ${text}`)
    const mid = (await win.evaluate(() => innerHeight)) / 2
    if (Math.abs(y - mid) < 200) return
    await win.mouse.wheel(0, Math.max(-400, Math.min(400, y - mid)))
    await win.waitForTimeout(80)
  }
}

/** 视图里一处露在外面(没被卡盖住、也不在视口外)的点:四个角挨个试。点一下 = 没划出东西。 */
async function blankIn(win, rootSel) {
  const p = await win.evaluate((sel) => {
    const root = document.querySelector(sel)
    const r = root.getBoundingClientRect()
    const top = Math.max(r.top, 0) + 4, bottom = Math.min(r.bottom, innerHeight) - 4
    for (const [x, y] of [[r.left + 4, bottom], [r.right - 4, bottom], [r.left + 4, top], [r.right - 4, top]]) {
      if (root.contains(document.elementFromPoint(x, y))) return { x, y }
    }
    return null
  }, rootSel)
  if (!p) throw new Error(`no uncovered blank point in ${rootSel}`)
  return p
}

/** 候选里第一段没被浮着的卡盖住的,拖选它;返回选中的是哪一段。 */
async function dragSelectAny(win, rootSel, texts) {
  const why = []
  for (const text of texts) {
    try { await dragSelect(win, rootSel, text); return text } catch (e) { if (!/drag points covered/.test(String(e?.message))) throw e; why.push(String(e.message)) }
  }
  throw new Error(`all drag candidates covered: ${why.join(' | ')}`)
}

/** 真鼠标拖选 `root` 里第一处 `text`(松手才出条)。返回选区外接矩形(视口 px)。 */
async function dragSelect(win, rootSel, text) {
  const r = await win.evaluate(({ rootSel, text }) => {
    // 先清掉上一次留下的选区:按在已选中的字上再拖,浏览器起的是「拖走这段文字」,不是一次新的选择(没有 mouseup)。
    window.getSelection()?.removeAllRanges()
    for (const root of document.querySelectorAll(rootSel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        const i = n.data.indexOf(text)
        if (i < 0) continue
        n.parentElement.scrollIntoView({ block: 'center' })
        const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1)
        const b = document.createRange(); b.setStart(n, i + text.length - 1); b.setEnd(n, i + text.length)
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect()
        return { x0: ra.left + 1, y0: ra.top + ra.height / 2, x1: rb.right - 1, y1: rb.top + rb.height / 2 }
      }
    }
    return null
  }, { rootSel, text })
  if (!r) throw new Error(`text not found: ${text}`)
  await win.waitForTimeout(250) // scrollIntoView 引起的滚动先落定(滚动会把条收掉)
  const at = await win.evaluate(({ rootSel, text }) => {
    for (const root of document.querySelectorAll(rootSel)) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode())) {
        const i = n.data.indexOf(text)
        if (i < 0) continue
        const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1)
        const b = document.createRange(); b.setStart(n, i + text.length - 1); b.setEnd(n, i + text.length)
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect()
        return { x0: ra.left + 1, y0: ra.top + ra.height / 2, x1: rb.right - 1, y1: rb.top + rb.height / 2 }
      }
    }
    return null
  }, { rootSel, text })
  // 起点 / 终点被浮着的卡盖住:真人也划不到那段字,是台架选的字不对,直说
  const hit = await win.evaluate(({ at, rootSel }) => [[at.x0, at.y0], [at.x1, at.y1]].map(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return el?.closest(rootSel) ? null : (el?.closest('[data-testid]')?.getAttribute('data-testid') || el?.className || String(el))
  }), { at, rootSel })
  if (hit.some(Boolean)) throw new Error(`drag points covered or off-screen (${text}): ${JSON.stringify(hit)} at ${JSON.stringify(at)}`)
  await win.mouse.move(at.x0, at.y0)
  await win.mouse.down()
  await win.mouse.move((at.x0 + at.x1) / 2, (at.y0 + at.y1) / 2, { steps: 4 })
  await win.mouse.move(at.x1, at.y1, { steps: 4 })
  await win.mouse.up()
  await win.waitForTimeout(250)
  return win.evaluate(() => {
    const s = window.getSelection()
    if (!s || !s.rangeCount || s.isCollapsed) return null
    const b = s.getRangeAt(0).getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, text: s.toString() }
  })
}
/** 条的现状:位置、外壳、行里各枚按钮的 data-act(竖线记成 '|')。 */
const barState = (win) => win.evaluate(() => {
  const el = document.querySelector('[data-testid="selection-bar"]:not([data-lcl-exit])') // 收起时的退场替身(useExitGhost)不算
  if (!el) return null
  const b = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    left: b.left, right: b.right, top: b.top, bottom: b.bottom,
    view: el.getAttribute('data-view'), dense: el.hasAttribute('data-dense'), popover: el.classList.contains('ui-popover'),
    radius: parseFloat(cs.borderTopLeftRadius), position: cs.position, inBody: el.parentElement === document.body,
    // 工具包在 .selbar-tool / .selbar-split 里(10 月加的分体工具):取里面主按钮的 data-act
    row: [...el.querySelectorAll('.selbar-row > *')].map((x) => (x.classList.contains('selbar-sep') ? '|' : x.getAttribute('data-act') || x.querySelector(':scope > [data-act]')?.getAttribute('data-act') || '?')),
    vw: innerWidth, vh: innerHeight,
    // 跟随(方案 B):看不见时只藏(data-anchor-hidden,透明);⋯ 展开时 .selbar-row 钉住、面板往哪边长(data-grow)
    hidden: el.hasAttribute('data-anchor-hidden'), opacity: cs.opacity, grow: el.dataset.grow ?? null,
    rowBox: (() => { const r = el.querySelector('.selbar-row')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null })(),
    panelBox: (() => { const r = el.querySelector('.selbar-panel')?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom } : null })(),
  }
})
/** 结果卡(换语言重开时有一份退场替身 data-lcl-exit,不算)。 */
const PANEL = '[data-testid="inline-ai-panel"]:not([data-lcl-exit])'
const card = (win) => win.evaluate(() => {
  const el = document.querySelector('[data-testid="inline-ai-panel"]:not([data-lcl-exit])')
  if (!el) return null
  const b = el.getBoundingClientRect()
  return {
    phase: el.getAttribute('data-phase'), readonly: el.hasAttribute('data-readonly'), top: b.top, left: b.left, right: b.right, bottom: b.bottom,
    preview: el.querySelector('[data-testid="inline-ai-preview"]')?.textContent ?? null,
    acts: [...el.querySelectorAll('button[data-act]')].map((x) => x.getAttribute('data-act')),
    lang: el.querySelector('[data-testid="inline-ai-lang"]')?.value ?? null,
    service: el.querySelector('[data-testid="inline-ai-service"]')?.textContent ?? null,
    serviceEngine: el.querySelector('[data-testid="inline-ai-service"]')?.getAttribute('data-engine') ?? null,
    hint: el.querySelector('[data-testid="inline-ai-hint"]')?.textContent ?? null,
    title: el.querySelector('.am-ai-title')?.textContent ?? null,
    hidden: el.hasAttribute('data-anchor-hidden'), opacity: getComputedStyle(el).opacity,
  }
})
/** 当前 DOM 选区的外接矩形(没有 / 收起 = null)。 */
const selRect = (win) => win.evaluate(() => {
  const s = window.getSelection()
  if (!s || !s.rangeCount || s.isCollapsed) return null
  const b = s.getRangeAt(0).getBoundingClientRect()
  return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
})
/** 某段字现在的外接矩形(选区没了也能量:切标签回来后用它比卡的位置)。 */
const textRect = (win, rootSel, text) => win.evaluate(({ rootSel, text }) => {
  for (const root of document.querySelectorAll(rootSel)) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const i = n.data.indexOf(text)
      if (i < 0) continue
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length)
      const b = r.getBoundingClientRect()
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }
    }
  }
  return null
}, { rootSel, text })
/** 滚 sel 所在的滚动容器(往上找第一个能滚的祖先;sel 自己能滚就是它),返回实际滚了多少(缩放前的局部 px;屏上的位移要 × ZOOM)。 */
const scrollIn = (win, sel, dy) => win.evaluate(({ sel, dy }) => {
  let el = document.querySelector(sel)
  while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
  if (!el) return 0
  const before = el.scrollTop
  el.scrollTop += dy
  return el.scrollTop - before
}, { sel, dy })
/** 等锚点重摆(一帧合并)+ 藏 / 现的淡入淡出(100ms)放完。 */
const frames = (win) => win.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250)))))
/** 条贴着选区:水平居中 ±2,在上方(或放不下翻到下方)离开不到 16px。 */
const hugs = (b, s) => !!b && !!s && Math.abs((b.left + b.right) / 2 - (s.left + s.right) / 2) <= 2 &&
  ((b.bottom <= s.top + 1 && s.top - b.bottom < 16) || (b.top >= s.bottom - 1 && b.top - s.bottom < 16))
/** 引导结束有时停在别的 Space(蓬洲云页)而不是 Tangu:进不了聊天就点回 Tangu;还是不行就留证据(截图 + 当时的 Space 与页面字)再抛。 */
async function ensureTangu(win, shotsDir) {
  const ta = win.locator('.t2c-ta').first()
  if (!(await ta.isVisible().catch(() => false))) {
    await win.waitForTimeout(800)
    await win.evaluate(() => document.querySelector('[data-space-id="tangu"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }
  await ta.waitFor({ timeout: 30000 }).catch(async (e) => {
    if (shotsDir) await win.screenshot({ path: path.join(shotsDir, 'fail-boot.png') }).catch(() => {})
    console.log(`DIAG boot | ${JSON.stringify(await win.evaluate(() => ({ spaces: [...document.querySelectorAll('[data-space-id]')].map((x) => x.dataset.spaceId), body: document.body.innerText.slice(0, 300) })).catch(() => null))}`)
    throw e
  })
}
/** 不经鼠标切到某个标签(Agent / 命令面板开视图就是这样;只派 pointer 事件 + click,不派 mousedown —— 那算「点到外面」)。 */
const switchTab = (win, title) => win.evaluate((title) => {
  const tab = [...document.querySelectorAll('.dv-tab')].find((t) => (t.textContent || '').includes(title))
  if (!tab) return false
  for (const type of ['pointerdown', 'pointerup']) tab.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerType: 'mouse', isPrimary: true }))
  tab.click()
  return true
}, title)
const cardDone = (win) => until(async () => { const c = await card(win); return c && (c.phase === 'done' || c.phase === 'error') ? c : null }, 10000)
/** 浮层的入场动效(180ms 从透明淡入)放完再往下:假引擎秒回,不等的话拍到的是半透明的那一帧。 */
// 封顶 1 秒:页面上要是有转个不停的动画(连接中的圈之类),它的 finished 永远不来,不封顶整条台架就挂在这儿。
const settle = (win) => win.evaluate(() => Promise.race([Promise.allSettled(document.getAnimations().map((a) => a.finished)), new Promise((r) => setTimeout(r, 1000))]).then(() => undefined))
async function shot(win, file) { await settle(win); await win.screenshot({ path: file }) }
/** 等条出现、入场动效放完再量:动效里有 1.5% 的缩放(以左上角为原点),半途量出来的中心会偏左一两个像素 —— 110% 下正好超出 ±2 的容差。 */
async function barReady(win, ms = 5000) { if (!(await until(() => barState(win), ms))) return null; await settle(win); return barState(win) }
/** 点开 ⋯,返回里面的项;给了 id 就点它。 */
async function pickMore(win, id) {
  const btn = win.locator('[data-testid="selection-bar"] [data-act="more"]')
  if (!(await btn.count())) return []
  await btn.click()
  await win.locator('[data-testid="selbar-more"]').waitFor({ timeout: 3000 })
  const items = await win.evaluate(() => [...document.querySelectorAll('[data-testid="selbar-more"] [data-ai]')].map((b) => b.getAttribute('data-ai')))
  if (id) await win.locator(`[data-testid="selbar-more"] [data-ai="${id}"]`).click()
  return items
}

/** 起一个隔离的实例:自己的数据目录、探针插件、登进假引擎;首帧前把偏好(语言 / 明暗 / 缩放)写好再重载一次。
 *  ⚠️ 连接配置要写进 `<user-data-dir>-dev`:未打包的构建把 userData 改成了它(electron/main.ts),只写在 userdata/ 里应用读不到,
 *  外部令牌是空的 —— 开机不连(boot 要有令牌),只有点掉首启引导那一下不看令牌连一次,之后主窗一重载就停在「先在设置里连接后端」
 *  (10-14 取证:两边都写之后重载四次都连得回)。换语言 / 明暗仍然另起一个实例,首帧就按新偏好起。 */
async function launch(stubUrl, prefs, fixture = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-selbar-'))
  const userdata = path.join(home, 'userdata'); fs.mkdirSync(userdata)
  const vault = path.join(home, 'vault'); fs.mkdirSync(vault)
  for (const [name, content] of Object.entries(fixture.notes || {})) fs.writeFileSync(path.join(vault, name), content)
  const pluginId = fixture.pluginId || 'selprobe'
  const plugin = path.join(home, 'plugins', pluginId); fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(path.join(plugin, 'main.js'), fixture.pluginMain || PLUGIN_MAIN)
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify({ id: pluginId, name: fixture.pluginName || pluginId, version: '1.0.0', minAppVersion: '0.0.1', description: '台架用的划线条探针,不是产品插件' }))
  for (const x of fixture.extraPlugins || []) {
    const dir = path.join(home, 'plugins', x.id); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'main.js'), x.main)
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: x.id, name: x.name, version: '1.0.0', minAppVersion: '0.0.1', description: '台架用的划线条探针,不是产品插件' }))
  }
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const token = ['test', Buffer.from(JSON.stringify({ sub: 'test-selbar', exp: Math.floor(Date.now() / 1000) + 86400 * 10 })).toString('base64url'), 'test'].join('.')
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: stubUrl, token }))
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stubUrl, cloudUrl: stubUrl, token }))
  }
  const app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl } })
  const win = await app.firstWindow()
  // 2026-11-22 翻译插件随包:启动时真的 @forsion/translation 会被播种进 plugins/translation,宿主翻译随之让位。
  // 前两个实例要证的是「没装翻译插件」那条宿主翻译路径(网页 / 手机 / 旧构建仍走它),这里把播种进来的那份拿掉,下面的重载按没装读。
  if (pluginId !== 'translation' && !fixture.keepBundledTranslation) fs.rmSync(path.join(home, 'plugins', 'translation'), { recursive: true, force: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
  await win.waitForSelector('#root')
  await win.evaluate(({ prefs, zoom }) => {
    localStorage.setItem('forsion_default_space', 'tangu')
    localStorage.removeItem('forsion_selection_bar_order')
    for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v)
    // 2.10.0 那次「缩放回到默认」的一次性迁移会清掉存着的缩放:应用首帧可能还没跑到它,这里先标成已迁移,不然重载时被清回 100%。
    if (zoom !== 1) { localStorage.setItem('forsion_ui_zoom_default_2_10_0', '1'); localStorage.setItem('forsion_ui_zoom', String(zoom)) }
  }, { prefs, zoom: ZOOM })
  await win.reload({ waitUntil: 'domcontentloaded' })
  return { app, win, home }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const inline = []
  let failMt = false
  const tts = { calls: 0, delay: 0 }
  const stub = await startStubEngine({
    sessions: SESSIONS,
    messages: MESSAGES,
    models: [{ id: 'm1', name: 'Stub Chat', provider: 'stub', contextWindow: 128_000 }],
    modelsMeta: { translateModels: [{ id: 'qwen-mt', name: 'Qwen MT Flash', provider: 'bailian', apiModelId: 'qwen-mt-flash' }] },
    handle: async ({ path: route, method, body }) => {
      if (route === '/agent/runs') return { runs: [] }
      if (route === '/agent/tts' && method === 'POST') {
        tts.calls++
        if (tts.delay) await new Promise((r) => setTimeout(r, tts.delay))
        return { __buffer: silentWav(), contentType: 'audio/wav' }
      }
      if (route === '/api/brain/users/me') return { id: 'test-selbar', username: 'Selbar tester' }
      if (route === '/agent/inline' && method === 'POST') {
        const b = await body()
        inline.push(b)
        if (failMt && b.model_id === 'qwen-mt') return { __code: 500, body: { detail: 'mt upstream down' } }
        const answer = `译文（${b.language}）:${String(b.selection).slice(0, 8)}`
        return sse([...answer.match(/[\s\S]{1,5}/g).map((text) => ({ type: 'delta', text })), { type: 'done', content: answer, toolCallText: false }])
      }
    },
  })
  let app
  try {
    const first = await launch(stub.url, { tangu_locale: 'zh' })
    app = first.app
    let win = first.win
    const shots = path.join(first.home, 'screenshots'); fs.mkdirSync(shots)
    onStepFail = async (name) => {
      const file = path.join(shots, `fail-${failed.length}.png`)
      await win.screenshot({ path: file })
      const dom = await win.evaluate(() => ({
        onboarding: !!document.querySelector('.ob-shell'),
        shell: document.querySelector('.shell-host') ? getComputedStyle(document.querySelector('.shell-host')).visibility : null,
        rows: [...document.querySelectorAll('.t2s-srow')].map((r) => `${(r.textContent || '').trim().slice(0, 30)}:${r.offsetWidth}x${r.offsetHeight}`),
        bar: !!document.querySelector('[data-testid="selection-bar"]'), card: !!document.querySelector('[data-testid="inline-ai-panel"]'),
        active: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).slice(0, 40)}` : null,
      }))
      console.log(`DIAG ${name} | ${JSON.stringify(dom)} | ${file}`)
    }
    check('主窗离开首启引导', await skipOnboarding(win))
    await win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' }) // 登录后首次同步卡 2.5s 后弹、会盖住划线条(同 btw.check)
    const input = win.locator('.t2c-ta').first()
    await ensureTangu(win, shots)
    await win.locator('text=Parser 重构').first().click()
    await win.locator('.t2-content', { hasText: 'AZURE-FALCON 已记下' }).first().waitFor({ timeout: 15000 })
    if (ZOOM !== 1) check(`界面缩放 ${ZOOM} 已生效`, Math.abs((await win.evaluate(() => document.body.currentCSSZoom || 1)) - ZOOM) < 0.01)
    const CHAT = '[data-chat-surface="chat"] .t2-content'
    // 先等探针插件装好:条上有没有 ⋯ 取决于它注册的动作
    check('探针插件已加载', (await until(() => win.evaluate(() => !!window.__selprobe), 15000)) === true)

    // ── 聊天:条的位置、外壳、组成 ──
    const sel1 = await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    const bar1 = await barReady(win)
    check('聊天里选中文字 → 划线条出现,挂在 body 下、fixed', !!sel1 && !!bar1 && bar1.inBody && bar1.position === 'fixed' && bar1.view === 'chat', JSON.stringify({ sel1, bar1 }))
    check('条在选区上方、水平居中(±2px)、不越出视口', bar1.bottom <= sel1.top + 1 && sel1.top - bar1.bottom < 16 && Math.abs((bar1.left + bar1.right) / 2 - (sel1.left + sel1.right) / 2) <= 2 && bar1.left >= 0 && bar1.right <= bar1.vw && bar1.top >= 0, JSON.stringify({ sel1, bar1 }))
    check('外壳是共用的 .ui-popover 圆角矩形(不是胶囊)', bar1.popover && bar1.radius > 0 && bar1.radius <= 14 && (await win.locator('.t2-quote-menu').count()) === 0, `radius=${bar1.radius}`)
    check('组成:引用 / 顺便问 / 翻译 / 朗读 / ⋯(10-18「在侧栏提问」并进顺便问;11-21 加朗读;聊天没有自己的工具,不画竖线)', bar1.row.join(',') === 'quote,btw,translate,speak,more', bar1.row.join(','))
    await shot(win, path.join(shots, 'chat-bar.png'))
    // 选区贴着聊天区顶上时条会压到标签栏上,标签栏是窗口拖拽区(不看层叠):条自己得打 no-drag 的洞,不然按下去是拖窗口。
    // CDP 派发的点击不经过系统的拖拽区,这里只能钉计算样式;先确认标签栏那边读得出 drag,读不出就如实跳过。
    const region = await win.evaluate(() => {
      const r = (el) => { if (!el) return null; const cs = getComputedStyle(el); return cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region') || '' }
      return { strip: r(document.querySelector('.dv-tabs-and-actions-container')), bar: r(document.querySelector('[data-testid="selection-bar"]')) }
    })
    if (region.strip === 'drag') check('条不算窗口拖拽区(压到标签栏上也点得动)', region.bar === 'no-drag', JSON.stringify(region))
    else console.log(`SKIP 拖拽区的计算值读不出来,这一条没验 | ${JSON.stringify(region)}`)

    // ── 滚动:条跟着那段字走(划线菜单方案 B,2026-11-08);滚出可见区只藏不收,滚回来原样出现 ──
    // 负对照(实跑):ViewSelectionBar 里 followRef 恒为 false(滚动 / 盒子变了就收的旧路)→ 这一段红。
    await step('聊天里滚动跟着走', async () => {
      // 聊天贴底时,脚本一次大跨度改 scrollTop(scrollIntoView 也是)会被弹回去;真人是滚轮滚上去的,这里也用滚轮
      await wheelTo(win, CHAT, FOLLOW)
      await dragSelect(win, CHAT, FOLLOW)
      const b0 = await barReady(win)
      const d1 = await scrollIn(win, CHAT, -80) // 往上滚 80 = 字往下走 80
      await frames(win)
      const s1 = await selRect(win), b1 = await barState(win)
      check('聊天区滚动:条不收,跟着那段字走(位移 = 滚动量,仍在选区上方居中)', !!b0 && d1 < -40 && !!b1 && !b1.hidden && hugs(b1, s1) && Math.abs((b1.top - b0.top) + d1 * ZOOM) <= 2, JSON.stringify({ d1, b0, b1, s1 }))
      const d2 = await scrollIn(win, CHAT, 4000)
      await frames(win)
      const b2 = await barState(win)
      check('那段字滚出可见区:条只藏不收(还挂着、透明),选区还在', d2 > 400 && !!b2 && b2.hidden && b2.opacity === '0' && !!(await selRect(win)), JSON.stringify({ d2, b2 }))
      await scrollIn(win, CHAT, -d2)
      await frames(win)
      const s3 = await selRect(win), b3 = await barState(win)
      check('滚回来:条原样出现、贴着那段字', !!b3 && !b3.hidden && b3.opacity === '1' && hugs(b3, s3), JSON.stringify({ b3, s3 }))
      await shot(win, path.join(shots, 'chat-bar-follow.png'))
    })

    // ── 输入区里的选区不出;点到外面收 ──
    await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    await until(() => barState(win), 5000)
    await input.click() // 输入框:在消息流外面,点了哪儿也不去
    check('点到聊天区外面条就收', (await until(async () => !(await barState(win)), 3000)) === true)
    await input.fill('输入框里的一段字')
    await input.focus()
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await input.dispatchEvent('mouseup')
    await win.waitForTimeout(300)
    check('输入框里的选区不出条', !(await barState(win)))
    await input.fill('')

    // ── 「引用」照旧:挂成输入框上方的引用卡,条收起、选区清掉 ──
    await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    await win.locator('[data-testid="selection-quote"]').click()
    await win.locator('.quote-reply-input').waitFor({ timeout: 5000 }) // 先弹就地回复框;空着回车 = 只挂引用
    await win.keyboard.press('Enter')
    await win.locator('[data-chat-surface="chat"] .t2c-tilerow .att-tile--quote .att-tile-head', { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 5000 })
    const quoted = { bar: await barState(win), collapsed: await win.evaluate(() => window.getSelection().isCollapsed) }
    check('「引用」挂卡后条收起、选区清掉', !quoted.bar && quoted.collapsed, JSON.stringify(quoted))
    await win.locator('[data-chat-surface="chat"] .t2c-tilerow .att-tile--quote .att-tile-x').first().click()

    // ── 翻译:只读结果卡;目标语言 = 界面语言之外的那种;缺省走目录里的机器翻译模型 ──
    const sel2 = await dragSelect(win, CHAT, '重构解析器的词法阶段')
    await win.locator('[data-testid="selection-translate"]').click()
    const c1 = await cardDone(win)
    const req1 = inline.at(-1)
    check('翻译请求:action=translate、选中的文字、中文界面下中文译成英文', req1?.action === 'translate' && req1.selection === '重构解析器的词法阶段' && req1.language === 'English', JSON.stringify(req1))
    check('没在设置里选过翻译模型 → 自动用目录里的机器翻译模型', req1?.model_id === 'qwen-mt', `model_id=${req1?.model_id}`)
    check('结果卡是只读的:复制 / 重试 / 关闭,没有「替换」「插入下方」', !!c1 && c1.readonly && c1.phase === 'done' && c1.acts.join(',') === 'copy,retry,discard' && c1.preview === '译文（English）:重构解析器的词法', JSON.stringify(c1))
    check('卡头:目标语言下拉 + 写明是机器翻译', c1.lang === 'English' && /机器翻译.*Qwen MT Flash/.test(c1.hint || '') && c1.title === '翻译', JSON.stringify(c1))
    check('卡贴着选区(下面放不下才翻到上面)、不越出视口;条已收起、选区还在', ((c1.top >= sel2.bottom - 1 && c1.top - sel2.bottom < 16) || (c1.bottom <= sel2.top + 1 && sel2.top - c1.bottom < 16)) && c1.left >= 0 && c1.right <= (await win.evaluate(() => innerWidth)) && !(await barState(win)) && !(await win.evaluate(() => window.getSelection().isCollapsed)), JSON.stringify({ c1, sel2 }))
    await settle(win)
    const look = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="inline-ai-panel"]')
      const cs = getComputedStyle(el)
      return { opacity: cs.opacity, bg: cs.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor), inBody: el.parentElement === document.body, region: cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region') || '' }
    })
    check('卡挂在 body 下;入场动效放完后不透明、有底色', look.inBody && look.opacity === '1' && look.bg, JSON.stringify(look))
    if (region.strip === 'drag') check('卡也不算窗口拖拽区', look.region === 'no-drag', JSON.stringify(look))
    await shot(win, path.join(shots, 'chat-translate-card.png'))
    await win.locator('[data-testid="inline-ai-lang"]').selectOption('Japanese')
    await until(async () => inline.length >= 2 && inline.at(-1).language === 'Japanese', 5000)
    const c2 = await cardDone(win)
    check('卡头换语言 = 重译一次', inline.at(-1)?.language === 'Japanese' && c2?.lang === 'Japanese' && c2.preview === '译文（Japanese）:重构解析器的词法', JSON.stringify({ last: inline.at(-1), c2 }))
    await input.click()
    check('点卡外面卡就收', (await until(async () => !(await card(win)), 3000)) === true)

    // 英文选区 → 界面语言
    await dragSelect(win, CHAT, 'pure function of its input')
    await win.locator('[data-testid="selection-translate"]').click()
    await cardDone(win)
    check('英文选区译成界面语言(简体中文)', inline.at(-1)?.language === 'Chinese (Simplified)', JSON.stringify(inline.at(-1)))
    await win.keyboard.press('Escape')
    check('Esc 关卡', (await until(async () => !(await card(win)), 3000)) === true)

    // 自动选上的机器翻译模型失败 → 落回聊天模型再来一次
    failMt = true
    const before = inline.length
    await dragSelect(win, CHAT, '重构解析器的词法阶段')
    await win.locator('[data-testid="selection-translate"]').click()
    const c3 = await cardDone(win)
    failMt = false
    check('机器翻译模型失败 → 落回聊天模型,卡上写的是真正译的那个', inline.length === before + 2 && inline.at(-2).model_id === 'qwen-mt' && inline.at(-1).model_id === 'm1' && c3?.phase === 'done' && c3.hint === 'Stub Chat', JSON.stringify({ models: inline.slice(before).map((x) => x.model_id), c3 }))
    await win.keyboard.press('Escape')
    await until(async () => !(await card(win)), 3000)

    // ── 插件动作:scope / when;结果进只读卡 ──
    await dragSelect(win, CHAT, '已记下')
    const short = await pickMore(win)
    check('⋯ 里只列认聊天的动作(只在笔记 / 只在自己视图 / 字数不够的不列)', short.join(',') === 'plugin:selprobe:everywhere', short.join(','))
    await shot(win, path.join(shots, 'chat-more.png'))
    await input.click()
    await dragSelect(win, CHAT, '先把记号流和错误恢复拆开,再补一组边界用例')
    const longer = await pickMore(win, 'plugin:selprobe:everywhere')
    const c4 = await cardDone(win)
    check('when 按字数放行;run 拿到 view=chat、editable=false、没有 pagePath、带出处;结果进只读卡', longer.join(',') === 'plugin:selprobe:everywhere,plugin:selprobe:long' && c4?.readonly && c4.preview === 'E:chat:false:true:Parser 重构' && c4.lang === null && c4.title === '到处', JSON.stringify({ longer, c4 }))
    await win.keyboard.press('Escape')
    await until(async () => !(await card(win)), 3000)

    // ── 插件视图:ctx.ui.mountSelectionBar ──
    await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
    await until(() => barState(win), 5000)
    await win.evaluate(() => window.__selprobe.open())
    await win.locator('#selprobe-p').waitFor({ timeout: 10000 })
    check('切到别的视图(聊天被换到后台)→ 聊天那一条不留在屏上', (await until(async () => !(await barState(win)), 3000)) === true)
    check('插件视图挂上了宿主的划线条', await win.evaluate(() => !!window.__selprobe.bar && typeof window.__selprobe.bar.show === 'function'))
    const sel5 = await dragSelect(win, '.selprobe', 'paragraph for the selection')
    const bar5 = await barReady(win)
    check('插件视图里:自己的工具在前(颜色点、图标钮),竖线,再是问 Tangu / 翻译 / 朗读 / ⋯', !!bar5 && bar5.view === 'selprobe:reader' && bar5.row.join(',') === 'yellow,note,|,ask,translate,speak,more', JSON.stringify(bar5))
    check('位置同样在选区上方居中', bar5.bottom <= sel5.top + 1 && Math.abs((bar5.left + bar5.right) / 2 - (sel5.left + sel5.right) / 2) <= 2, JSON.stringify({ sel5, bar5 }))
    await shot(win, path.join(shots, 'plugin-bar.png'))
    await win.locator('[data-testid="selection-bar"] [data-act="yellow"]').click()
    check('点工具 → 调到插件的 run(带选中的文字);没清选区条就还在', (await win.evaluate(() => window.__selprobe.tools.join(','))) === 'yellow:paragraph for the selection' && !!(await barState(win)))
    const more5 = await pickMore(win, 'plugin:selprobe:own')
    await win.waitForTimeout(300)
    check("scope:'own' 的动作只在这里列;output:'none' 不出卡,run 拿到视图 id 和出处页码", more5.join(',') === 'plugin:selprobe:everywhere,plugin:selprobe:own' && (await win.evaluate(() => window.__selprobe.ran.join(','))) === 'paragraph for the selection|selprobe:reader|7' && !(await card(win)), `${more5.join(',')} ${await win.evaluate(() => window.__selprobe.ran.join(','))}`)
    await step('插件接管「问 Tangu」', async () => {
      await dragSelect(win, '.selprobe', 'paragraph for the selection')
      await win.locator('[data-testid="selection-ask"]').click({ timeout: 8000 })
      check('插件接管了「问 Tangu」:走它自己的回调,条收起', (await win.evaluate(() => window.__selprobe.asked.join(','))) === 'paragraph for the selection' && !(await barState(win)))
    })
    await step('工具自己清选区', async () => {
      await dragSelect(win, '.selprobe', 'paragraph for the selection')
      await win.locator('[data-testid="selection-bar"] [data-act="note"]').click({ timeout: 8000 })
      check('工具在 run 里清了选区 → 条跟着收', (await until(async () => !(await barState(win)), 3000)) === true && (await win.evaluate(() => window.__selprobe.tools.at(-1))) === 'note:paragraph for the selection')
    })
    await step('插件视图的输入框', async () => {
      await win.locator('#selprobe-in').click()
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
      await win.locator('#selprobe-in').dispatchEvent('mouseup')
      await win.waitForTimeout(300)
      check('插件视图的输入框里也不出条', !(await barState(win)))
    })

    // 插件视图里滚动同样跟着走;⋯ 展开时那一行不动(方案 B)
    await step('插件视图跟着走 + ⋯ 行不动', async () => {
      await win.evaluate(() => { document.querySelector('.selprobe').scrollTop = 0 })
      await dragSelect(win, '.selprobe', 'paragraph for the selection')
      const b0 = await barReady(win)
      const d1 = await scrollIn(win, '.selprobe', 50)
      await frames(win)
      const s1 = await selRect(win), b1 = await barState(win)
      check('插件视图滚动:条不收,跟着那段字走', !!b0 && d1 > 30 && !!b1 && !b1.hidden && hugs(b1, s1) && Math.abs((b0.top - b1.top) - d1 * ZOOM) <= 2, JSON.stringify({ d1, b0, b1, s1 }))
      const d2 = await scrollIn(win, '.selprobe', 900)
      await frames(win)
      const b2 = await barState(win)
      check('插件视图里那段字滚出去:条只藏不收', d2 > 200 && !!b2 && b2.hidden, JSON.stringify({ d2, b2 }))
      await scrollIn(win, '.selprobe', -(d1 + d2))
      await frames(win)
      const s3 = await selRect(win), b3 = await barReady(win)
      check('插件视图滚回来:条原样出现', !!b3 && !b3.hidden && hugs(b3, s3), JSON.stringify({ b3, s3 }))
      await win.locator('[data-testid="selection-bar"] [data-act="more"]').click()
      await win.locator('[data-testid="selbar-more"]').waitFor({ timeout: 3000 })
      await frames(win)
      const b4 = await barState(win)
      check('⋯ 展开:那一行不动(±1px),面板长在行上方(往远离选区的一侧)', !!b3?.rowBox && !!b4?.rowBox && !!b4.panelBox && Math.abs(b4.rowBox.top - b3.rowBox.top) <= 1 && b4.grow === 'up' && b4.panelBox.bottom <= b4.rowBox.top + 1, JSON.stringify({ before: b3?.rowBox, b4 }))
      await shot(win, path.join(shots, 'plugin-more-up.png'))
      await win.keyboard.press('Escape')
      await win.evaluate(() => window.getSelection().removeAllRanges())
      await until(async () => !(await barState(win)), 3000)
    })

    // 不经鼠标切标签(Agent / 命令面板开视图):结果卡藏起、切回来还在(方案 B §7)。用鼠标点标签那一下按「点外面」收,不在这里验。
    await step('切标签时结果卡藏起又回来', async () => {
      check('切回聊天标签', await switchTab(win, 'Parser 重构'))
      await win.locator(CHAT, { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 10000 })
      await dragSelect(win, CHAT, '重构解析器的词法阶段')
      await win.locator('[data-testid="selection-translate"]').click({ timeout: 8000 })
      await cardDone(win)
      await win.evaluate(() => window.__selprobe.open())
      await win.locator('#selprobe-p').waitFor({ timeout: 10000 })
      await frames(win)
      const away = await card(win)
      check('切到别的标签:结果卡藏起(还挂着、透明),不浮在别的视图上', !!away && away.hidden && away.opacity === '0', JSON.stringify(away))
      await switchTab(win, 'Parser 重构')
      await frames(win)
      const back = await card(win), t = await textRect(win, CHAT, '重构解析器的词法阶段')
      check('切回来:卡原样出现、贴着那段字', !!back && !back.hidden && back.opacity === '1' && !!t && ((back.top >= t.bottom - 1 && back.top - t.bottom < 16) || (back.bottom <= t.top + 1 && t.top - back.bottom < 16)), JSON.stringify({ back, t }))
      await win.keyboard.press('Escape')
      await until(async () => !(await card(win)), 3000)
      await win.evaluate(() => window.__selprobe.open())
      await win.locator('#selprobe-p').waitFor({ timeout: 10000 })
    })

    // 排法设置:动作在前
    await step('排法设置', async () => {
      await win.evaluate(() => localStorage.setItem('forsion_selection_bar_order', 'actions'))
      await dragSelect(win, '.selprobe', 'paragraph for the selection')
      const bar6 = await barReady(win)
      check('设置换成「动作在前」→ 问 Tangu / 翻译 / 朗读 / ⋯ 打头,工具在后', bar6?.row.join(',') === 'ask,translate,speak,more,|,yellow,note', bar6?.row.join(','))
      await shot(win, path.join(shots, 'plugin-bar-actions-first.png'))
    })
    await win.evaluate(() => { localStorage.removeItem('forsion_selection_bar_order'); window.getSelection().removeAllRanges() })
    await until(async () => !(await barState(win)), 3000)

    // show() / hide():自己报文字和位置
    await step('show / hide / dispose', async () => {
      await win.evaluate(() => window.__selprobe.bar.show({ text: 'manual text', rect: { left: 420, right: 620, top: 500, bottom: 520 } }))
      const bar7 = await barReady(win)
      check('show({ text, rect }) → 条按给的矩形落位(视口 px,缩放由宿主抵消)', !!bar7 && Math.abs((bar7.left + bar7.right) / 2 - 520) <= 2 && bar7.bottom <= 501 && 500 - bar7.bottom < 16, JSON.stringify(bar7))
      await win.locator('[data-testid="selection-translate"]').click({ timeout: 8000 })
      await cardDone(win)
      check('自己报的选区一样能翻译', inline.at(-1)?.selection === 'manual text' && inline.at(-1)?.language === 'Chinese (Simplified)', JSON.stringify(inline.at(-1)))
      await win.keyboard.press('Escape')
      await until(async () => !(await card(win)), 3000)
      await win.evaluate(() => window.__selprobe.bar.show({ text: 'manual text', rect: { left: 420, right: 620, top: 500, bottom: 520 } }))
      await until(() => barState(win), 5000)
      await win.evaluate(() => window.__selprobe.bar.hide())
      check('hide() 收条', (await until(async () => !(await barState(win)), 3000)) === true)
      // show({ getRect }):宿主每帧现量,自己报的选区也跟着走(方案 B 第四步)
      await win.evaluate(() => {
        document.querySelector('.selprobe').scrollTop = 0
        const p = document.getElementById('selprobe-p')
        const box = () => { const b = p.getBoundingClientRect(); return { left: b.left, right: b.left + 240, top: b.top, bottom: b.bottom } }
        window.__getRectCalls = 0
        window.__selprobe.bar.show({ text: 'live text', rect: box(), getRect: () => { window.__getRectCalls++; return box() } })
      })
      const g0 = await barReady(win)
      const gd = await scrollIn(win, '.selprobe', 40)
      await frames(win)
      const g1 = await barState(win)
      check('show({ getRect }):滚动时宿主现量,条跟着走、不收', !!g0 && gd > 20 && !!g1 && !g1.hidden && Math.abs((g0.top - g1.top) - gd * ZOOM) <= 2 && (await win.evaluate(() => window.__getRectCalls)) > 0, JSON.stringify({ gd, g0, g1 }))
      await win.evaluate(() => { window.__selprobe.bar.hide(); document.querySelector('.selprobe').scrollTop = 0 })
      await until(async () => !(await barState(win)), 3000)
      await win.evaluate(() => { window.__selprobe.bar.dispose(); window.__selprobe.bar.show({ text: 'after dispose', rect: { left: 420, right: 620, top: 500, bottom: 520 } }) })
      await win.waitForTimeout(300)
      check('dispose() 之后不再出条', !(await barState(win)))
    })

    // ── 观感自查(DESIGN §8):回聊天,深色 + 英文各截一张,人看 ──
    await step('深色 + 英文', async () => {
      await app.close().catch(() => {})
      const second = await launch(stub.url, { tangu_locale: 'en', forsion_theme_pref: 'dark', forsion_theme: 'dark' })
      app = second.app
      win = second.win
      check('深色 + 英文的实例离开首启引导', await skipOnboarding(win))
      await win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' })
      await ensureTangu(win, shots)
      const row = win.locator('.t2s-srow', { hasText: 'Parser 重构' }).first()
      await row.waitFor({ timeout: 30000 })
      await row.click()
      await win.locator(CHAT, { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 15000 })
      await dragSelect(win, CHAT, '重构解析器的词法阶段')
      const barEn = await barReady(win)
      const labels = await win.evaluate(() => [...document.querySelectorAll('[data-testid="selection-bar"] .selbar-row > button')].map((b) => b.textContent.trim()))
      check('英文界面:条上的字是英文(不是 key、不是中文)', !!barEn && labels.slice(0, 3).every((l) => /^[A-Za-z ]+$/.test(l)) && labels.includes('Translate'), labels.join(' | '))
      await shot(win, path.join(shots, 'chat-bar-dark-en.png'))
      await win.locator('[data-testid="selection-translate"]').click({ timeout: 8000 })
      const cEn = await cardDone(win)
      check('英文界面:中文选区译成英文;卡上的按钮是英文', inline.at(-1)?.language === 'English' && !!cEn && (await win.evaluate(() => [...document.querySelectorAll('[data-testid="inline-ai-panel"] button[data-act]')].map((b) => b.textContent.trim()).join('|'))) === 'Copy|Try again|Close', JSON.stringify(cEn))
      await shot(win, path.join(shots, 'chat-translate-card-dark-en.png'))
    })

    // ── 2026-11-21:插件常驻 / 朗读 / 自动 / 翻译归属(第三个实例,探针插件就是 translation)──
    await step('插件常驻 / 朗读 / 自动 / 翻译归属', async () => {
      await app.close().catch(() => {})
      const third = await launch(stub.url, { tangu_locale: 'zh' }, { pluginId: 'translation', pluginName: '翻译', pluginMain: PINS_MAIN, extraPlugins: [{ id: 'pinprobe', name: '划线探针', main: SLOTS_MAIN }] })
      app = third.app
      win = third.win
      check('第三个实例离开首启引导', await skipOnboarding(win))
      await win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' })
      await ensureTangu(win, shots)
      const row = win.locator('.t2s-srow', { hasText: 'Parser 重构' }).first()
      await row.waitFor({ timeout: 30000 })
      await row.click()
      await win.locator(CHAT, { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 15000 })
      check('探针插件(translation)已加载', (await until(() => win.evaluate(() => !!window.__pins), 15000)) === true)
      const K = (id) => `plugin:translation:${id}`
      const P = (id) => `plugin:pinprobe:${id}`

      // 放哪:宿主翻译让位、核心翻译插件站宿主那组;普通插件位 3 个;⋯ 顶上「还有 1 个放不下」、每行一颗钉
      await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
      const b = await barReady(win)
      check('装着 translation 插件:宿主自己的翻译不出(条上恰好一颗翻译 = 插件那颗)', !!b && !b.row.includes('translate') && b.row.filter((x) => /translate/.test(x)).length === 1, b?.row.join(','))
      check("核心翻译插件站在宿主那组(竖线前、朗读前),不占插件位;placement:'bar' 的普通插件三颗,第 4 个进 ⋯", b?.row.join(',') === `quote,btw,${K('translate')},speak,|,${P('b1')},${P('b2')},${P('b3')},more`, b?.row.join(','))
      const labels = await win.evaluate((t) => ({ plugin: [...document.querySelectorAll('[data-testid="selection-bar"] [data-group="plugin"]')].map((x) => ({ t: x.textContent.trim(), icon: !!x.querySelector('svg') })),
        tr: (() => { const x = document.querySelector(`[data-testid="selection-bar"] [data-act="${t}"]`); return x ? { t: x.textContent.trim(), icon: !!x.querySelector('svg') } : null })() }), K('translate'))
      check('条上插件按钮是「图标 + 字」;核心插件的字跟着界面语言({ zh, en } 的 title)', labels.plugin.length === 3 && labels.plugin.every((l) => l.icon) && labels.plugin[0].t === '摘录到今日笔记' && labels.tr?.icon && labels.tr?.t === '翻译', JSON.stringify(labels))
      await shot(win, path.join(shots, 'pins-bar.png'))
      await win.locator('[data-testid="selection-bar"] [data-act="more"]').click()
      await win.locator('[data-testid="selbar-more"]').waitFor({ timeout: 3000 })
      const more = await win.evaluate(() => ({
        notice: document.querySelector('[data-testid="selbar-overflow"]')?.textContent ?? null,
        items: [...document.querySelectorAll('[data-testid="selbar-more"] [data-ai]')].map((x) => x.getAttribute('data-ai')),
        pins: [...document.querySelectorAll('[data-testid="selbar-more"] [data-pin]')].map((x) => `${x.getAttribute('data-pin')}=${x.getAttribute('aria-pressed')}`),
      }))
      check('⋯:顶上「还有 1 个放不下 · 去管理」;放不下的那颗钉着、缺省进 ⋯ 的没钉', /还有 1 个放不下/.test(more.notice || '') && /去管理/.test(more.notice || '') && more.items.join(',') === `${P('b4')},${P('m1')}` && more.pins.join(',') === `${P('b4')}=true,${P('m1')}=false`, JSON.stringify(more))
      await shot(win, path.join(shots, 'pins-more.png'))
      await win.locator(`[data-testid="selbar-more"] [data-pin="${P('m1')}"]`).click()
      await frames(win)
      const b2 = await barState(win)
      check('⋯ 里钉上「搜索网页」:用户点名的先分到插件位(真的上条,先后照旧),缺省上条的挤下去进 ⋯', b2?.row.join(',') === `quote,btw,${K('translate')},speak,|,${P('b1')},${P('b2')},${P('m1')},more`, b2?.row.join(','))
      await win.locator(`[data-testid="selection-bar"] [data-act="${P('m1')}"]`).click({ button: 'right' })
      const menu = win.locator('.plugin-menu')
      await menu.waitFor({ timeout: 3000 })
      const menuText = await menu.textContent()
      check('条上插件按钮右键:「搜索网页 · 划线探针」+「收进 ⋯」+「管理划线菜单…」', /搜索网页 · 划线探针/.test(menuText) && /收进 ⋯/.test(menuText) && /管理划线菜单/.test(menuText), menuText)
      await shot(win, path.join(shots, 'pins-ctx.png'))
      await menu.locator('button', { hasText: '收进 ⋯' }).click()
      await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
      const b3 = await barReady(win)
      check('右键「收进 ⋯」之后它回到 ⋯,条上恢复原来三颗', b3?.row.join(',') === `quote,btw,${K('translate')},speak,|,${P('b1')},${P('b2')},${P('b3')},more`, b3?.row.join(','))
      const prefs = await win.evaluate(() => JSON.parse(localStorage.getItem('forsion_selection_actions') || 'null'))
      check('钉 / 收进 ⋯ 记进偏好(只记动过的那一项)', prefs?.placement?.[P('m1')] === 'more' && Object.keys(prefs.placement).length === 1, JSON.stringify(prefs))

      // 朗读:没配模型 → 选区下的提示卡(不回落系统声音);配了 → 合成中 → 播放中 → 点停;放完回静止
      const speakBtn = win.locator('[data-testid="selection-speak"]')
      const speakState = () => win.evaluate(() => {
        const el = document.querySelector('[data-testid="selection-speak"]')
        return el ? { pressed: el.getAttribute('aria-pressed'), spin: !!el.querySelector('[data-spin]'), label: el.textContent.trim() } : null
      })
      const ttsBefore = tts.calls
      await speakBtn.click()
      const setup = await until(() => win.evaluate(() => document.querySelector('[data-testid="tts-setup-card"]')?.textContent ?? null), 4000)
      check('没配朗读模型:点「朗读」出「还没选朗读模型 · 去设置」小卡,不去合成', /还没选朗读模型/.test(setup || '') && /去设置/.test(setup || '') && tts.calls === ttsBefore, setup)
      await shot(win, path.join(shots, 'speak-nomodel.png'))
      await win.locator('[data-testid="tts-setup-card"] [data-act="discard"]').click()
      await win.evaluate(() => window.tangu.setConfig({ ttsModelId: 'tts-stub' }))
      tts.delay = 900
      await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
      await barReady(win)
      await win.locator('[data-testid="selection-speak"]').click()
      const loading = await until(async () => { const st = await speakState(); return st?.spin ? st : null }, 2000)
      check('配了模型:点了先是「合成中」(转圈,按钮按下,字仍是「朗读」)', !!loading && loading.pressed === 'true' && loading.label === '朗读', JSON.stringify(loading))
      await shot(win, path.join(shots, 'speak-loading.png'))
      const playing = await until(async () => { const st = await speakState(); return st && !st.spin && st.pressed === 'true' ? st : null }, 4000)
      check('合成完:「播放中」(方块、按下);条一直在', !!playing && !!(await barState(win)) && tts.calls === ttsBefore + 1, JSON.stringify(playing))
      await win.locator('[data-testid="selection-speak"]').click()
      const stopped = await until(async () => { const st = await speakState(); return st?.pressed === 'false' ? st : null }, 2000)
      check('播放中再点一下 = 停,回静止', !!stopped, JSON.stringify(await speakState()))
      tts.delay = 0
      await win.locator('[data-testid="selection-speak"]').click()
      await until(async () => (await speakState())?.pressed === 'true', 3000)
      const ended = await until(async () => (await speakState())?.pressed === 'false', 6000)
      check('不去停它:放完自己回静止', ended === true, JSON.stringify(await speakState()))
      await win.evaluate(() => window.getSelection().removeAllRanges())

      // 插件结果卡:原文、两颗小喇叭、卡头语言(记住)、「划选后自动」开关(缺省关)
      await dragSelect(win, CHAT, '重构解析器的词法阶段')
      await barReady(win)
      await win.locator(`[data-testid="selection-bar"] [data-act="${K('translate')}"]`).click()
      const c1 = await cardDone(win)
      const extras = await win.evaluate(() => {
        const el = document.querySelector('[data-testid="inline-ai-panel"]:not([data-lcl-exit])')
        return {
          source: el?.querySelector('[data-testid="inline-ai-source"]')?.textContent ?? null,
          speakers: [...(el?.querySelectorAll('[data-speak]') ?? [])].map((x) => x.getAttribute('data-speak')),
          auto: el?.querySelector('[data-testid="inline-ai-auto"] [role="switch"]')?.getAttribute('aria-checked') ?? null,
        }
      })
      const r1 = await win.evaluate(() => window.__pins.runs.at(-1))
      check('插件卡:手点 = auto false;cx.language = 卡头初值(中文界面下中文 → English);卡里有原文、原文 / 结果各一颗喇叭、开关缺省关', !!c1 && c1.lang === 'English' && r1?.language === 'English' && r1.auto === false && c1.preview === 'T(English|manual):重构解析器的' && extras.source === '重构解析器的词法阶段' && extras.speakers.join(',') === 'source,result' && extras.auto === 'false', JSON.stringify({ c1, r1, extras }))
      await shot(win, path.join(shots, 'pins-card.png'))
      await win.locator(`${PANEL} [data-testid="inline-ai-lang"]`).selectOption('Japanese')
      await until(async () => (await win.evaluate(() => window.__pins.runs.at(-1)?.language)) === 'Japanese', 4000)
      await cardDone(win)
      await win.locator(`${PANEL} [data-testid="inline-ai-auto"] [role="switch"]`).click()
      await frames(win)
      const on = await win.evaluate(() => ({
        checked: document.querySelector('[data-testid="inline-ai-panel"]:not([data-lcl-exit]) [data-testid="inline-ai-auto"] [role="switch"]')?.getAttribute('aria-checked'),
        note: document.querySelector('[data-testid="inline-ai-panel"]:not([data-lcl-exit]) [data-testid="inline-ai-auto-note"]')?.textContent ?? null,
        prefs: JSON.parse(localStorage.getItem('forsion_selection_actions') || 'null'),
      }))
      check('卡头换语言记住;打开「划选后自动」:开关亮、下面写明「每次划选都会调用模型,计入额度」', on.checked === 'true' && /计入额度/.test(on.note || '') && on.prefs?.auto?.[K('translate')] === true && on.prefs?.language?.[K('translate')] === 'Japanese', JSON.stringify(on))
      await shot(win, path.join(shots, 'pins-card-auto-on.png'))
      await win.keyboard.press('Escape')
      await until(async () => !(await card(win)), 3000)

      // 自动:划选停 400ms 出卡,条留着;新划选在同一张卡里重跑(不卸载 = 不闪),中止旧请求;同段同语言不重复请求
      const runs0 = await win.evaluate(() => window.__pins.runs.length)
      await dragSelect(win, CHAT, '先把记号流和错误恢复拆开')
      const a1 = await cardDone(win)
      const ar = await win.evaluate(() => window.__pins.runs.at(-1))
      check('开了自动:划选后不点就出结果卡,run 拿到 auto: true 和记住的语言;条还在', !!a1 && a1.preview === 'T(Japanese|auto):先把记号流和' && ar?.auto === true && !!(await barState(win)) && (await win.evaluate(() => window.__pins.runs.length)) === runs0 + 1, JSON.stringify({ a1, ar }))
      const ov = { card: await card(win), bar: await barState(win) }
      check('自动卡和条同时在:卡不盖住条(下面放不下就摆到条的上面)', !!ov.card && !!ov.bar && (ov.card.bottom <= ov.bar.top + 0.5 || ov.card.top >= ov.bar.bottom - 0.5), JSON.stringify({ card: ov.card && [ov.card.top, ov.card.bottom], bar: ov.bar && [ov.bar.top, ov.bar.bottom] }))
      await shot(win, path.join(shots, 'pins-auto.png'))
      await win.evaluate(() => {
        const el = document.querySelector('[data-testid="inline-ai-panel"]:not([data-lcl-exit])')
        el.__mark = 'first'
        window.__panelRemoved = 0
        window.__panelObs = new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches?.('[data-testid="inline-ai-panel"]:not([data-lcl-exit])') || n.querySelector?.('[data-testid="inline-ai-panel"]:not([data-lcl-exit])'))) window.__panelRemoved++ })
        window.__panelObs.observe(document.body, { childList: true, subtree: true })
        window.__pins.delay = 2500
      })
      const aborted0 = await win.evaluate(() => window.__pins.aborted)
      await dragSelect(win, CHAT, '再补一组边界用例')
      await until(async () => (await win.evaluate(() => window.__pins.runs.at(-1)?.text)) === '再补一组边界用例', 3000)
      await win.evaluate(() => { window.__pins.delay = 0 })
      // 卡浮在上一段旁边,可能正好盖住同一条回复里的字(真人也划不到):换到屏上露着的一段历史(这次会话没自动跑过)
      const pick3 = await dragSelectAny(win, CHAT, ['第 50 条历史', '第 49 条历史', '第 48 条历史', '第 47 条历史', '第 46 条历史', '第 45 条历史'])
      // 松手就中止旧的(dragSelect 松手后只等了 250ms,还没到 400ms 的自动时机)
      const abortedEarly = await win.evaluate(() => window.__pins.aborted)
      const a2 = await until(async () => { const c = await card(win); return c?.phase === 'done' && c.preview === `T(Japanese|auto):${pick3.slice(0, 6)}` ? c : null }, 6000)
      const flash = await win.evaluate(() => ({ mark: document.querySelector('[data-testid="inline-ai-panel"]:not([data-lcl-exit])')?.__mark ?? null, removed: window.__panelRemoved, aborted: window.__pins.aborted }))
      check('新划选:松手就中止在飞的旧请求(不等 400ms),同一张卡跟到新那段重跑(没卸载过、不闪)', !!a2 && flash.mark === 'first' && flash.removed === 0 && flash.aborted === aborted0 + 1 && abortedEarly === aborted0 + 1, JSON.stringify({ pick3, abortedEarly, a2, flash, aborted0, now: a2 ? undefined : await card(win) }))
      const runs1 = await win.evaluate(() => window.__pins.runs.length)
      // 先点一下视图收掉这张卡(免得它盖住那段),再划回第一段:新开的卡直接用缓存
      const blank = await blankIn(win, CHAT)
      await win.mouse.click(blank.x, blank.y)
      await until(async () => !(await card(win)), 3000)
      await dragSelect(win, CHAT, '先把记号流和错误恢复拆开')
      const a3 = await until(async () => { const c = await card(win); return c?.phase === 'done' && /先把记号流/.test(c.preview || '') ? c : null }, 4000)
      check('同一段、同一个语言再划一次(卡收了再划):直接用这次会话里的结果,不再请求', !!a3 && (await win.evaluate(() => window.__pins.runs.length)) === runs1, JSON.stringify({ a3, runs1 }))
      await win.evaluate(() => window.__panelObs.disconnect())
      const empty = await blankIn(win, CHAT)
      await win.mouse.click(empty.x, empty.y)
      check('在视图里点一下(没划出东西):自动卡收起', (await until(async () => !(await card(win)), 3000)) === true)

      // 设置 → 外观里的管理表:列出宿主那组和这几个插件动作;开着自动的那个挂「先跑」
      await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'theme', n: Date.now() } }))
      let fl
      await until(async () => { fl = app.windows().filter((w) => !w.isClosed() && w.url().includes('window=floating')).pop(); return !!fl && (await fl.locator('[data-testid="selection-actions-table"]').count()) > 0 }, 30000)
      if (!fl) throw new Error('settings floating window missing')
      await fl.locator('[data-testid="selection-actions-table"]').scrollIntoViewIfNeeded()
      const table = await fl.evaluate(() => ({
        rows: [...document.querySelectorAll('[data-selaction]')].map((r) => `${r.getAttribute('data-selaction')}:${r.querySelector('[data-place][aria-checked="true"]')?.getAttribute('data-place')}`),
        first: [...document.querySelectorAll('.selactions-first')].map((x) => x.closest('[data-selaction]')?.getAttribute('data-selaction')),
        autos: [...document.querySelectorAll('[data-auto]')].map((x) => x.getAttribute('data-auto')),
      }))
      check('管理表:宿主那组(没有宿主翻译)+ 插件动作按条上的次序,放哪如实;只有支持的那个有自动开关并挂「先跑」',
        table.rows.join(',') === `host:ask:bar,${K('translate')}:bar,host:speak:bar,${P('b1')}:bar,${P('b2')}:bar,${P('b3')}:bar,${P('b4')}:bar,${P('m1')}:more` && table.first.join(',') === K('translate') && table.autos.join(',') === K('translate'), JSON.stringify(table))
      await fl.locator('[data-testid="selection-actions-table"]').screenshot({ path: path.join(shots, 'pins-settings-table.png') })
      await fl.locator(`[data-selaction="${P('b2')}"] [data-place="hidden"]`).click()
      await fl.close().catch(() => {})
      await dragSelect(win, CHAT, 'AZURE-FALCON 已记下')
      const b4 = await barReady(win)
      check('管理表里设成「不显示」:条上没有它,下一个放得下的补上', b4?.row.join(',') === `quote,btw,${K('translate')},speak,|,${P('b1')},${P('b3')},${P('b4')},more`, b4?.row.join(','))
    })

    // ── 2026-11-22:真的随包 @forsion/translation(播种进来的那份,不是探针):聊天与笔记各点一次「翻译」──
    // 证的是装出去的产品那条路:条上恰好一颗翻译、在宿主那组;请求照旧走宿主翻译管线(机器翻译模型);卡头写明谁译的;
    // 笔记里插件接管后请求仍带前后文与页面说明(宿主侧上下文 selectionRun.ts,插件看不到这些字段)。
    await step('随包翻译插件:聊天与笔记', async () => {
      await app.close().catch(() => {})
      const NOTE = ['# 词汇表', '', '```forsion-instructions', 'Translate 记号 as token.', '```', '', '词法阶段先切分记号。', '', '解析器再把记号拼成语法树。', '', '最后检查边界用例。', ''].join('\n')
      const BT = "window.__bt = { note: () => ctx.app.openNote('Glossary.md') }"
      const fourth = await launch(stub.url, { tangu_locale: 'zh' }, { pluginId: 'btprobe', pluginMain: BT, keepBundledTranslation: true, notes: { 'Glossary.md': NOTE } })
      app = fourth.app
      win = fourth.win
      check('第四个实例离开首启引导', await skipOnboarding(win))
      await win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' })
      await ensureTangu(win, shots)
      check('随包的翻译插件已播种(plugins/translation 是 npm 包那份)', JSON.parse(fs.readFileSync(path.join(fourth.home, 'plugins', 'translation', 'manifest.json'), 'utf8')).id === 'translation'
        && fs.existsSync(path.join(fourth.home, 'plugins', 'translation', 'main.js')))
      const row = win.locator('.t2s-srow', { hasText: 'Parser 重构' }).first()
      await row.waitFor({ timeout: 30000 })
      await row.click()
      await win.locator(CHAT, { hasText: 'AZURE-FALCON' }).first().waitFor({ timeout: 15000 })
      const T = 'plugin:translation:translate'
      await until(async () => { await dragSelect(win, CHAT, '重构解析器的词法阶段'); const b = await barReady(win); return !!b && b.row.includes(T) }, 20000)
      const b = await barState(win)
      check('聊天:条上恰好一颗翻译 = 随包插件那颗,站在宿主那组(朗读前),宿主自己的不出', !!b && !b.row.includes('translate') && b.row.filter((x) => /translat/.test(x)).length === 1
        && b.row.indexOf(T) >= 0 && b.row.indexOf(T) < b.row.indexOf('speak') && !b.row.includes('|'), b?.row.join(','))
      const before = inline.length
      await win.locator(`[data-testid="selection-bar"] [data-act="${T}"]`).click()
      const c = await cardDone(win)
      const req = inline.at(-1)
      check('聊天:请求照旧走宿主翻译管线(action=translate、选中的字、中文译成英文、目录里的机器翻译模型)', inline.length === before + 1 && req?.action === 'translate'
        && req.selection === '重构解析器的词法阶段' && req.language === 'English' && req.model_id === 'qwen-mt', JSON.stringify(req))
      // 插件 0.2.0(2026-11-24)起登记 card.service:卡头那句「机器翻译 · 模型」换成服务按钮,没选翻译服务时写「Forsion 模型」
      check('聊天:卡头的服务按钮写明这次走 Forsion 模型(没选翻译服务)', c?.service === 'Forsion 模型' && c?.serviceEngine === '', JSON.stringify(c))
      await shot(win, path.join(shots, 'bundled-chat.png'))
      await win.keyboard.press('Escape')

      await win.evaluate(() => window.__bt.note())
      const PM = '.unified-body .ProseMirror'
      await win.locator(PM, { hasText: '解析器再把记号拼成语法树' }).first().waitFor({ timeout: 30000 })
      await dragSelect(win, PM, '解析器再把记号拼成语法树')
      const tb = win.locator('[data-testid="inline-toolbar"]')
      await tb.waitFor({ timeout: 5000 })
      const acts = await tb.evaluate((el) => [...el.querySelectorAll('[data-act]')].map((x) => x.getAttribute('data-act')))
      const mine = acts.filter((a) => /translat/.test(a))
      check('笔记:工具条上恰好一颗翻译,是插件那颗(宿主的 translate 不出)', mine.length === 1 && mine[0] !== 'translate', acts.join(','))
      const n0 = inline.length
      await tb.locator(`[data-act="${mine[0]}"]`).click()
      const nc = await cardDone(win)
      const nreq = inline.at(-1)
      check('笔记:插件接管后请求仍带前后文与页面说明(术语表)、标题与路径', inline.length === n0 + 1 && nreq?.action === 'translate' && nreq.selection === '解析器再把记号拼成语法树'
        && /词法阶段先切分记号/.test(nreq.before || '') && /最后检查边界用例/.test(nreq.after || '') && /Translate 记号 as token/.test(nreq.page_instructions || nreq.pageInstructions || '')
        && /Glossary\.md$/.test(nreq.page_path || nreq.pagePath || ''), JSON.stringify(nreq))
      check('笔记:卡头的服务按钮写明走 Forsion 模型;只是预览,没写盘', nc?.service === 'Forsion 模型' && fs.readFileSync(path.join(fourth.home, 'vault', 'Glossary.md'), 'utf8') === NOTE, JSON.stringify(nc))
      await shot(win, path.join(shots, 'bundled-note.png'))
    })

    console.log(`\n${checks} checks passed, ${failed.length} failed${ZOOM !== 1 ? ` (ZOOM=${ZOOM})` : ''}`)
    console.log(`SCREENSHOTS ${shots}`)
    if (failed.length) process.exitCode = 1
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
}

module.exports = { launch, dragSelect, barReady, cardDone, shot, until, pickMore }
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1) })
