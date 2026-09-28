// 编辑器内 AI(评审 2026-09-27 §3.12,波次 1 · 拍板 #13)的真浏览器仪器。一组一条:
//   A = G3-04「问 Tangu」:选区工具栏 / ⠿ 块菜单 → 选区文字 + 标题锚点交给侧栏对话;笔记零写入、不铸 ^id;
//       宿主没有侧栏对话(探针缺 askInChat)时两处入口都不出现。
//   B = G3-03 Agent 改了打开着的笔记:归属账本认出是 Tangu 写的 → 装饰 + 胶囊「修改了 N 处 · 逐处查看 · 全部撤回 · 保留」;
//       别人改的照旧静默回灌;装饰不落盘;「全部撤回」= 一次用户写入(走 CAS 保存、可 Cmd+Z)、跳过用户改过的那处;「保留」零写入。
// 宿主接缝用台架假探针顶替(tanguSeam.setTanguProbe;与生产同一模块实例)。
// 用法:npm run check:editorai(由 e2e-editor 自起/复用 Vite;worktree 里设 HARNESS_URL)。
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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function open(browser, md, flags = '') {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(400)
  return page
}

/** 装台架假探针(生产在 installEngine 里、早于任何渲染;这里装完补一次同路径 switchFile 让页面按新探针重渲)。
 *  ask=false 模拟「装了探针但没有侧栏对话」(automation-only 档案)。 */
async function installProbe(page, { ask = true } = {}) {
  await page.evaluate(async (ask) => {
    // ⚠️ 取页面实际加载的那个 URL:dev 期间改过的模块带 `?t=<HMR 时间戳>`,裸路径 import 会拿到**另一份**模块实例。
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/amadeus\/plugins\/tanguSeam\.ts(\?|$)/.test(n))
    const m = await import(url || '/src/amadeus/plugins/tanguSeam.ts')
    window.__asked = []
    m.setTanguProbe({
      activeModel: () => null,
      models: () => [],
      activeSpace: () => 'amadeus',
      subscribe: () => () => {},
      ...(ask ? { askInChat: (text) => window.__asked.push(text) } : {}),
    })
    window.__upage.switchFile('Unified.md')
  }, ask)
  await page.waitForTimeout(300)
}

/** 在第一处 text 上拖选出这段文字(真鼠标;工具栏在松手后才弹)。 */
async function selectText(page, text) {
  const r = await page.evaluate(({ PM, text }) => {
    const pm = document.querySelector(PM)
    const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const i = n.data.indexOf(text)
      if (i < 0) continue
      const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1)
      const b = document.createRange(); b.setStart(n, i + text.length - 1); b.setEnd(n, i + text.length)
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return { x0: ra.left + 1, y: ra.top + ra.height / 2, x1: rb.right - 1 }
    }
    return null
  }, { PM, text })
  if (!r) throw new Error('text not found: ' + text)
  await page.mouse.move(r.x0, r.y)
  await page.mouse.down()
  await page.mouse.move(r.x1, r.y, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(500)
}

async function openBlockMenu(page, text) {
  const at = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > *')].find((x) => (x.textContent ?? '').includes(t))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + 10 }
  }, text)
  if (!at) return false
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(150)
  await page.mouse.move(at.x + 2, at.y + 2)
  await page.waitForTimeout(260)
  const h = await page.evaluate(() => {
    const d = document.querySelector('.unified-gutter .drag-handle')
    if (!d) return null
    const r = d.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  if (!h) return false
  await page.mouse.click(h.x, h.y)
  await page.waitForTimeout(250)
  return true
}

const toolbarActs = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="inline-toolbar"] .itb-row > button')].map((b) => b.getAttribute('data-act') || ''))
const menuActs = (page) => page.evaluate(() => [...document.querySelectorAll('.unified-block-menu button')].map((b) => b.getAttribute('data-act') || b.textContent.trim()))

async function groupA(browser) {
  const md = '# 开头\n\n第一段。\n\n## 第二节\n\n这是一段需要润色的文字，写得不太好。\n\n第三段。\n'
  // A1 没有探针(纯 Amadeus 壳 / 台架缺省):两处入口都不出现
  {
    const page = await open(browser, md)
    await selectText(page, '需要润色的文字')
    const tb = await toolbarActs(page)
    await page.keyboard.press('Escape')
    await openBlockMenu(page, '需要润色的文字')
    const bm = await menuActs(page)
    check('A1 无侧栏对话的宿主:工具栏与块菜单都没有「问 Tangu」', tb.length > 3 && !tb.includes('ask') && bm.length > 3 && !bm.includes('ask'), `toolbar=${tb.join(',')} menu=${bm.length}项`)
    await page.close()
  }
  // A2 装了探针但缺 askInChat(automation-only 档案):同样不出现
  {
    const page = await open(browser, md)
    await installProbe(page, { ask: false })
    await selectText(page, '需要润色的文字')
    const tb = await toolbarActs(page)
    check('A2 探针缺 askInChat:工具栏无「问 Tangu」', tb.length > 3 && !tb.includes('ask'), tb.join(','))
    await page.close()
  }
  // A3 选区工具栏:按钮排首位,点了交出「选区 + 标题锚」,笔记零写入
  {
    const page = await open(browser, md)
    await installProbe(page)
    const before = await page.evaluate(() => window.__upage.probe.view().state.doc.toJSON())
    await selectText(page, '需要润色的文字')
    const tb = await toolbarActs(page)
    const btn = await page.$('[data-testid="inline-toolbar"] [data-act="ask"]')
    if (btn) {
      const b = await btn.boundingBox()
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
    }
    await page.waitForTimeout(1200)
    const st = await page.evaluate((before) => ({
      asked: window.__asked.slice(),
      writes: window.__upage.writes.length,
      same: JSON.stringify(window.__upage.probe.view().state.doc.toJSON()) === JSON.stringify(before),
      toolbar: !!document.querySelector('[data-testid="inline-toolbar"]'),
    }), before)
    check('A3a 选区工具栏首位是「问 Tangu」', tb[0] === 'ask', tb.join(','))
    check('A3b 交给侧栏的引用 = 选区文字 + [[Unified.md#第二节]]', st.asked.length === 1 && st.asked[0] === '需要润色的文字\n— [[Unified.md#第二节]]', JSON.stringify(st.asked))
    check('A3c 笔记零写入、文档未变、工具栏收起', st.writes === 0 && st.same && !st.toolbar, `writes=${st.writes} same=${st.same} toolbar=${st.toolbar}`)
    await page.close()
  }
  // A4 ⠿ 块菜单:首项「问 Tangu」,整块文字 + 锚点;不铸 ^id
  {
    const page = await open(browser, md)
    await installProbe(page)
    const opened = await openBlockMenu(page, '需要润色的文字')
    const bm = await menuActs(page)
    const item = await page.$('.unified-block-menu [data-act="ask"]')
    if (item) await item.click()
    await page.waitForTimeout(1200)
    const st = await page.evaluate(() => ({
      asked: window.__asked.slice(),
      writes: window.__upage.writes.length,
      menu: !!document.querySelector('.unified-block-menu'),
      caret: /\^[a-z0-9]{4,}/i.test(window.__upage.vault.get('Unified.md')),
    }))
    check('A4a 块菜单首项是「问 Tangu」', opened && bm[0] === 'ask', bm.slice(0, 3).join(','))
    check('A4b 整块文字 + 标题锚点', st.asked.length === 1 && st.asked[0] === '这是一段需要润色的文字，写得不太好。\n— [[Unified.md#第二节]]', JSON.stringify(st.asked))
    check('A4c 零写入、没铸 ^id、菜单收起', st.writes === 0 && !st.caret && !st.menu, `writes=${st.writes} menu=${st.menu}`)
    await page.close()
  }
}

/** 页面实际加载的某个源码模块(dev 期间改过的带 `?t=`,裸路径 import 会拿到另一份实例)。 */
const MOD = `async (re, fallback) => {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => new RegExp(re).test(n))
  return import(url || fallback)
}`

/** 在账本里记一笔「Tangu 正在写 Unified.md」(生产由 appStore 在写类工具的 tool_call 上记)。 */
async function noteAgentWrite(page, id = 'call-1') {
  await page.evaluate(async ({ MOD, id }) => {
    const load = eval(MOD)
    const m = await load('/src/stores/agentWriteLedger\\.ts(\\?|$)', '/src/stores/agentWriteLedger.ts')
    const root = window.__upage.pageStore.getState().vaultRoot
    m.noteAgentWriteStart(id, [root ? `${root.replace(/[\\/]+$/, '')}/Unified.md` : 'Unified.md'])
  }, { MOD, id })
}
const capsule = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="agent-change-capsule"]')
  return el ? el.textContent : null
})
const marks = (page) => page.evaluate((PM) => [...document.querySelectorAll(PM + ' .am-agent-change')].map((e) => e.textContent).join('|'), PM)
async function clickCapsule(page, act) {
  await page.click(`[data-testid="agent-change-capsule"] [data-act="${act}"]`)
  await page.waitForTimeout(200)
}

async function groupB(browser) {
  const base = '# 文档\n\n第一段原文。\n\n第二段原文。\n\n第三段原文。\n'
  const agentMd = '# 文档\n\n第一段 AGENT 改过。\n\n第二段原文。\n\n第三段 AGENT 也改了。\n'
  // B1 不是 Tangu 写的(账本里没有):照旧静默回灌,无胶囊无装饰
  {
    const page = await open(browser, base)
    await page.evaluate((t) => window.__upage.fire('Unified.md', t), agentMd)
    await page.waitForTimeout(900)
    const st = { cap: await capsule(page), marks: await marks(page), text: await page.evaluate((PM) => document.querySelector(PM).innerText, PM) }
    check('B1 非 Tangu 的外部改动:照旧回灌,无胶囊无装饰', st.cap == null && !st.marks && st.text.includes('第一段 AGENT 改过'), JSON.stringify(st))
    await page.close()
  }
  // B2-B4 Tangu 写的:装饰 + 胶囊;逐处查看;全部撤回 = 一次写入、盘上回到原文、可 Cmd+Z
  {
    const page = await open(browser, base)
    await noteAgentWrite(page)
    await page.evaluate((t) => window.__upage.fire('Unified.md', t), agentMd)
    await page.waitForTimeout(900)
    const cap = await capsule(page)
    const mk = await marks(page)
    const w0 = await page.evaluate(() => window.__upage.writes.length)
    check('B2a 胶囊出现且 N=2', cap != null && /2/.test(cap) && /Tangu/.test(cap), String(cap))
    check('B2b 两处改动都有装饰,只盖改过的字', mk === ' AGENT 改过| AGENT 也改了', mk)
    check('B2c 回灌本身零写入(装饰 / 旧片段不落盘)', w0 === 0, `writes=${w0}`)
    await clickCapsule(page, 'review')
    const cur = await page.evaluate((PM) => document.querySelector(PM + ' .am-agent-change.is-current')?.textContent ?? null, PM)
    const cap2 = await capsule(page)
    check('B3 逐处查看:停在第 1 处并加深,按钮变成 1/2', cur === ' AGENT 改过' && /1\/2/.test(cap2 || ''), `${cur} | ${cap2}`)
    await clickCapsule(page, 'revert')
    await page.waitForTimeout(1500)
    const st = await page.evaluate((PM) => ({
      writes: window.__upage.writes.length,
      disk: window.__upage.vault.get('Unified.md'),
      cas: window.__upage.casRejects.length,
      cap: !!document.querySelector('[data-testid="agent-change-capsule"]'),
      marks: document.querySelectorAll(PM + ' .am-agent-change').length,
    }), PM)
    check('B4a 全部撤回:恰好一次写入,盘上回到 Agent 改之前的原文', st.writes === 1 && st.disk === base && st.cas === 0, JSON.stringify({ writes: st.writes, cas: st.cas, disk: st.disk }))
    check('B4b 撤回后胶囊与装饰都收掉', !st.cap && st.marks === 0, JSON.stringify(st))
    // 撤回是一次普通用户编辑:Cmd+Z 撤掉撤回(回到 Agent 的版本)
    await page.click(PM)
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(1500)
    const disk2 = await page.evaluate(() => window.__upage.vault.get('Unified.md'))
    check('B4c 撤回进撤销栈:Cmd+Z 回到 Agent 版本并落盘', disk2 === agentMd, JSON.stringify(disk2))
    await page.close()
  }
  // B5 保留:只清标记,零写入
  {
    const page = await open(browser, base)
    await noteAgentWrite(page)
    await page.evaluate((t) => window.__upage.fire('Unified.md', t), agentMd)
    await page.waitForTimeout(900)
    const had = await capsule(page)
    await clickCapsule(page, 'keep')
    await page.waitForTimeout(1300)
    const st = await page.evaluate((PM) => ({ writes: window.__upage.writes.length, cap: !!document.querySelector('[data-testid="agent-change-capsule"]'), marks: document.querySelectorAll(PM + ' .am-agent-change').length, disk: window.__upage.vault.get('Unified.md') }), PM)
    check('B5 保留:标记全清、零写入、盘上仍是 Agent 版本', had != null && !st.cap && st.marks === 0 && st.writes === 0 && st.disk === agentMd, JSON.stringify(st))
    await page.close()
  }
  // B6 用户改过其中一处 → 全部撤回跳过它(不拿旧片段盖掉用户的字),另一处照撤,并提示跳过了几处
  {
    const page = await open(browser, base)
    await page.evaluate(() => { window.__toasts = []; window.addEventListener('amadeus:toast', (e) => window.__toasts.push(e.detail)) })
    await noteAgentWrite(page)
    await page.evaluate((t) => window.__upage.fire('Unified.md', t), agentMd)
    await page.waitForTimeout(900)
    // 光标放进第一处改动的中间(「AGENT」之后),打一个字
    await page.evaluate((PM) => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('AGENT 改过')) at = pos + n.text.indexOf('AGENT') + 5; return at < 0 })
      v.focus()
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
    }, PM)
    await page.waitForTimeout(100)
    await page.keyboard.type('X')
    await page.waitForTimeout(1400)
    await clickCapsule(page, 'revert')
    await page.waitForTimeout(1500)
    const st = await page.evaluate(() => ({ disk: window.__upage.vault.get('Unified.md'), toasts: window.__toasts.map((t) => t.text) }))
    check('B6 用户改过的那处不撤、另一处照撤、提示跳过 1 处',
      st.disk === '# 文档\n\n第一段 AGENTX 改过。\n\n第二段原文。\n\n第三段原文。\n' && st.toasts.some((t) => /1/.test(t)),
      JSON.stringify(st))
    await page.close()
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const only = (process.argv.find((a) => a.startsWith('--group=')) || '').slice('--group='.length).toUpperCase()
  try {
    if (!only || only.includes('A')) await groupA(browser)
    if (!only || only.includes('B')) await groupB(browser)
  } finally {
    await browser.close()
  }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
