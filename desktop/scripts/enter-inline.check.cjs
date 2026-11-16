// 回车口径开关(frontend/src/amadeus/blocks/markdown/enterMode.ts)打开时的常驻检查:回车一次 = 文件里只多一个换行。
// 每个页面都带 `amxEnter=inline` 打开(开关只在页面加载时读一次),开头先核对开关确实开着,没开就整份判红。
//
//  A  按键:回车 / 连按两次 / 标题末尾 / Shift+回车 / 行首退格(第二行、隔空行)→ 存盘逐字
//  R  保存再重开:一组口径样本当新笔记打开 → 不编辑取一次 = 原文;每块换成新对象(逐字层认不出,整篇重新生成)
//     再取一次 = 原文,且重开结构不变
//  M  搬块:Mod+Shift+↓/↑ 与真鼠标拖 ⠿ 把手,存盘、重开后内容与结构都对;紧贴记号不跟着块跑到新邻居身上
//  X  正在编辑时外部改动:没有未存改动 → 外部内容进来;打了字还没落盘 → 两边都在
//     (「刚回车停在新起的空行上」那一格只记录不判:外部回灌丢掉刚按的换行是现有回灌策略,开关关着一样)
//  U  撤销分组:第二行敲 `# ` / `#`+回车 触发标题 → 撤销一下回到「一段两行、第二行是字面触发符」
//     (存盘时第二行行首的 `#` 被转义成 `\#`:不转义重开就成了标题)
//  P  复用同一个编辑器的地方:插件卡片 / 记录页的小编辑器(PlainMarkdownEditor)开关开 / 关两页同样操作,存盘逐字相同;
//     源码模式切过去再切回来存盘逐字相同;手机软键盘的回车(Android UA + execCommand 走 DOM 变更 → 合成 Enter)
//
// 用法:node scripts/e2e-editor.cjs --check=enter-inline(或 npm run check:enterinline)
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null }
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const out = []
const record = (name, ok, detail) => { ok ? pass++ : fail++; const l = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`; out.push(l); console.log(l) }
const note = (name, detail) => { const l = `INFO  ${name}${detail ? '  | ' + detail : ''}`; out.push(l); console.log(l) }

async function open(browser, md, { on = true, ua, query, storage } = {}) {
  const ctx = ua || storage ? await browser.newContext({ locale: 'zh-CN', viewport: { width: 1180, height: 860 }, ...(ua ? { userAgent: ua } : {}) }) : null
  if (storage) await ctx.addInitScript((kv) => { try { localStorage.setItem(kv[0], kv[1]) } catch { /* 没有存储 */ } }, storage)
  const p = ctx ? await ctx.newPage() : await browser.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 860 } })
  p.errs = []
  p.on('pageerror', (e) => p.errs.push(e.message))
  const q = query ?? (on ? '&amxEnter=inline' : '')
  await p.goto(`${URL}?upage${q}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector(PM, { timeout: 180000 })
  await sleep(400)
  p.closeAll = async () => { await p.close(); if (ctx) await ctx.close() }
  return p
}
const switchOn = (p) => p.evaluate(() => import('/src/amadeus/blocks/markdown/enterMode.ts').then((m) => m.enterInline()))
const saved = (p) => p.evaluate(() => window.__upage.probe.serializeNow())
const disk = (p) => p.evaluate(() => window.__upage.vault.get('Unified.md') ?? null)
const shape = (p) => p.evaluate(() => {
  const doc = window.__upage.probe.view().state.doc, o = []
  doc.forEach((n) => {
    let t = ''
    n.descendants((c) => { if (c.isText) t += c.text; else if (c.type.name === 'hardbreak') t += c.attrs.isInline ? '⏎' : '↵'; return true })
    o.push(`${n.type.name}${n.attrs.amxTight ? '+t' : ''}${n.attrs.amxTightBefore ? '+tb' : ''}:${t}`)
  })
  return o.join(' | ')
})
/** 每个顶层块换成内容相同的新对象:逐字回填按对象身份认来源,认不出就整篇纯序列化。 */
const plainSaved = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view(), st = v.state, kids = []
  st.doc.forEach((n) => kids.push(n.type.create(n.attrs, n.content, n.marks)))
  v.dispatch(st.tr.replaceWith(0, st.doc.content.size, kids).setMeta('addToHistory', false))
  return window.__upage.probe.serializeNow()
})
/** 光标放到第一次出现的 text 之后(atStart = 放到它之前)。 */
const caretAt = (p, text, atStart = false) => p.evaluate(([k, s]) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor
  let hit = null
  st.doc.descendants((n, pos) => {
    if (hit != null || !n.isTextblock) return hit == null
    n.forEach((c, cOff) => { if (hit != null) return; if (c.isText) { const i = c.text.indexOf(k); if (i >= 0) hit = pos + 1 + cOff + i + (s ? 0 : k.length) } })
    return false
  })
  if (hit == null) throw new Error('锚点没找到 ' + k)
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit)))
}, [text, atStart])

// ── A 按键 ─────────────────────────────────────────────────────────────────────
async function keys(browser) {
  const cases = [
    { name: 'A1 段尾回车一次 = 一个换行', seed: 'one\n', at: 'one', keys: ['Enter'], type: 'two', want: 'one\ntwo\n' },
    { name: 'A2 回车两次 = 分段', seed: 'one\n', at: 'one', keys: ['Enter', 'Enter'], type: 'two', want: 'one\n\ntwo\n' },
    { name: 'A3 标题末尾回车 = 正文紧跟标题', seed: '## Title\n', at: 'Title', keys: ['Enter'], type: 'x', want: '## Title\nx\n' },
    { name: 'A4 Shift+回车 = 段内换行', seed: 'a\n', at: 'a', keys: ['Shift+Enter'], type: 'b', want: 'a\nb\n' },
    { name: 'A5 第二行行首退格 = 并回上一行', seed: 'one\ntwo\n', at: 'two', start: true, keys: ['Backspace'], want: 'onetwo\n' },
    { name: 'A6 隔一条空行的段首退格 = 去掉一个换行', seed: 'one\n\ntwo\n', at: 'two', start: true, keys: ['Backspace'], want: 'one\ntwo\n' },
    { name: 'A7 空行上回车 = 从这里分段(中间一条空行的位置多一条空行)', seed: 'one\n\ntwo\n', at: 'one', keys: ['Enter', 'Enter', 'Enter'], type: 'x', want: 'one\n\n\nx\n\ntwo\n' },
  ]
  for (const c of cases) {
    const p = await open(browser, c.seed)
    await caretAt(p, c.at, !!c.start)
    for (const k of c.keys) { await p.keyboard.press(k); await sleep(60) }
    if (c.type) await p.keyboard.type(c.type)
    await sleep(150)
    const md = await saved(p)
    const p2 = await open(browser, md)
    const md2 = await saved(p2)
    record(c.name, md === c.want && md2 === md && !p.errs.length, JSON.stringify({ seed: c.seed, saved: md, want: c.want, reopened: md2, errs: p.errs }))
    await p.closeAll(); await p2.closeAll()
  }
}

// ── R 保存再重开 ───────────────────────────────────────────────────────────────
const SAMPLES = [
  'one\ntwo\n', 'one\ntwo\n\nthree\n', 'a\nb\n', '- c\n  d\n', '> quote\n> more\n', '## Title\nx\n',
  'line one\nline two\n\nline four\n', 'a tailZ\n\n\nb\n', 'a\n\n\n\nb\n', '\n\nhead\n\nbody\n\n\n',
  '# H\n\npara a\npara b\n\n\n- l1\n- l2\n\n> q\n\n```\ncode\n```\nafter code\n',
  '# Title\nbody right after\n\n## Sub\nmore\n', 'alpha\n- item\n\n## Next\n', 'start\n\n# T\n',
]
async function reopen(browser) {
  for (const M of SAMPLES) {
    const p = await open(browser, M)
    const s0 = await shape(p)
    const a = await saved(p)
    const b = await plainSaved(p)
    const p2 = await open(browser, b)
    const s1 = await shape(p2)
    record(`R ${JSON.stringify(M)} 重开不编辑 = 原文`, a === M, a === M ? '' : JSON.stringify({ M, a }))
    record(`R ${JSON.stringify(M)} 整篇重新生成 = 原文、重开结构不变`, b === M && s0 === s1, b === M && s0 === s1 ? '' : JSON.stringify({ M, plain: b, s0, s1 }))
    await p.closeAll(); await p2.closeAll()
  }
}

// ── M 搬块 ─────────────────────────────────────────────────────────────────────
/** hover 到块 → 等 gutter 挂出 → ⠿ 中心(同 toplevel-realdrag.check)。 */
async function handleAt(p, x, y) {
  await p.mouse.move(x, y, { steps: 4 })
  await sleep(250)
  return p.evaluate(() => {
    const g = document.querySelector('.unified-gutter')
    const h = g?.querySelector('.drag-handle')
    if (!h || g.dataset.show !== 'true') return null
    const r = h.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + Math.min(10, r.height / 2) }
  })
}
const blockRect = (p, prefix) => p.evaluate(([s, pre]) => {
  const el = [...document.querySelectorAll(`${s} > *`)].find((x) => x.textContent.startsWith(pre))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom }
}, [PM, prefix])
const idle = async (p, x, y, ms = 240) => { for (let t = 0; t < ms; t += 15) { await p.mouse.move(x, y); await sleep(15) } }

async function moves(browser) {
  const kb = [
    { name: 'M1 Mod+Shift+↓ 多行段落整段下移', seed: 'alpha\nbeta\n\ngamma\n', at: 'alpha', want: 'gamma\n\nalpha\nbeta\n' },
    { name: 'M2 Mod+Shift+↓ 标题下紧贴的正文下移 → 标题不再紧贴(记号不跟到新邻居)', seed: '## T\nbody\n\nnext\n', at: 'body', want: '## T\n\nnext\n\nbody\n' },
    { name: 'M3 Mod+Shift+↑ 隔两条空行的段落上移,字不丢、重开一致', seed: 'one\n\n\ntwo\n', at: 'two', up: true },
  ]
  for (const c of kb) {
    const p = await open(browser, c.seed)
    await caretAt(p, c.at)
    await p.keyboard.press(`${MOD}+Shift+${c.up ? 'ArrowUp' : 'ArrowDown'}`)
    await sleep(250)
    const after = await shape(p)
    const md = await saved(p)
    const p2 = await open(browser, md)
    const again = await shape(p2)
    const md2 = await saved(p2)
    const ok = (c.want ? md === c.want : /one/.test(md) && /two/.test(md)) && md2 === md && again.replace(/\+t/g, '') === after.replace(/\+t/g, '') && !p.errs.length
    record(c.name, ok, JSON.stringify({ seed: c.seed, after, saved: md, want: c.want, reopened: again }))
    await p.closeAll(); await p2.closeAll()
  }
  // 真鼠标拖 ⠿:多行段落挪到另一块下面;紧贴标题的正文拖走
  const drags = [
    { name: 'M4 真鼠标拖 ⠿:多行段落拖到 gamma 下面', seed: 'alpha\nbeta\n\ngamma\n\ndelta\n', from: 'alpha', to: 'gamma', want: 'gamma\n\nalpha\nbeta\n\ndelta\n', wantShape: 'paragraph:gamma | paragraph:alpha⏎beta | paragraph:delta' },
    { name: 'M5 真鼠标拖 ⠿:标题下紧贴的正文拖到 next 下面 → 标题与 next 之间留空行', seed: '## T\nbody\n\nnext\n\nend\n', from: 'body', to: 'next', want: '## T\n\nnext\n\nbody\n\nend\n', wantShape: 'heading:T | paragraph:next | paragraph:body | paragraph:end' },
  ]
  for (const c of drags) {
    const p = await open(browser, c.seed)
    const src = await blockRect(p, c.from)
    const h = src ? await handleAt(p, src.x + 30, src.y + Math.min(12, src.h / 2)) : null
    const tgt = await blockRect(p, c.to)
    if (!h || !tgt) {
      record(c.name, false, JSON.stringify({ stuck: !src ? '找不到源块' : !h ? '把手没出来' : '找不到目标块' }))
      await p.closeAll()
      continue
    }
    await p.mouse.move(h.x, h.y)
    await p.mouse.down()
    await p.mouse.move(h.x + 5, h.y + 5, { steps: 2 })
    await p.mouse.move(tgt.x + 40, tgt.b - 3, { steps: 10 })
    await idle(p, tgt.x + 40, tgt.b - 3)
    await p.mouse.up()
    await sleep(500)
    const after = await shape(p)
    const md = await saved(p)
    await sleep(900)
    const d = await disk(p)
    const p2 = await open(browser, md)
    const again = await shape(p2)
    record(c.name, md === c.want && d === md && after === c.wantShape && again === after && !p.errs.length, JSON.stringify({ after, saved: md, disk: d, reopened: again, errs: p.errs }))
    await p.closeAll(); await p2.closeAll()
  }
}

// ── X 外部改动 ─────────────────────────────────────────────────────────────────
async function external(browser) {
  const fire = (p, t) => p.evaluate((t) => window.__upage.fire('Unified.md', t), t)
  {
    const seed = 'one\ntwo\n\nthree\n'
    const p = await open(browser, seed)
    const ext = 'one\ntwo EXT\n\nthree\n'
    await fire(p, ext)
    await sleep(800)
    const md = await saved(p)
    record('X1 没有未存改动 → 外部内容进来', md === ext && (await disk(p)) === ext, JSON.stringify({ md, disk: await disk(p) }))
    await p.closeAll()
  }
  {
    const p = await open(browser, 'one\ntwo\n\nthree\n')
    await caretAt(p, 'two')
    await p.keyboard.type('X')
    await fire(p, 'one\ntwo\n\nthree EXT\n')
    await sleep(1500)
    const md = await saved(p), d = await disk(p)
    const conflict = await p.evaluate(() => [...window.__upage.vault.keys()].filter((k) => /conflict/i.test(k)).map((k) => window.__upage.vault.get(k)))
    // 打的字留在正文;外部那版要么合进正文,要么另存进冲突副本 —— 两边都不丢
    record('X2 未存的字 + 外部改另一段 → 两边都不丢', md.includes('twoX') && d === md && (md.includes('three EXT') || conflict.some((t) => t.includes('three EXT'))), JSON.stringify({ md, disk: d, conflict }))
    await p.closeAll()
  }
  // X4 / X5 外部改了紧贴标题附近(回灌只换改了的块):编辑器跟上、不回写盘(紧贴记号不被当成过期清掉)
  for (const [name, seed, ext] of [
    ['X4 外部只改了紧贴标题下面的正文', '## T\nbody\n\nnext\n', '## T\nbody EXT\n\nnext\n'],
    ['X5 外部把标题后的空行去掉、改成紧贴', '## T\n\nbody\n\nnext\n', '## T\nbody\n\nnext\n'],
  ]) {
    const p = await open(browser, seed)
    const w0 = await p.evaluate(() => window.__upage.writes.length)
    await fire(p, ext)
    await sleep(1500)
    const md = await saved(p), d = await disk(p)
    const w1 = await p.evaluate(() => window.__upage.writes.length)
    record(`${name} → 编辑器存出来 = 盘上新内容,没有回写`, md === ext && d === ext && w1 === w0, JSON.stringify({ md, disk: d, writes: w1 - w0 }))
    await p.closeAll()
  }
  {
    const p = await open(browser, 'one\ntwo\n\nthree\n')
    await caretAt(p, 'two')
    await p.keyboard.press('Enter')
    await sleep(60)
    const mid = await saved(p)
    await fire(p, 'one\ntwo\n\nthree EXT\n')
    await sleep(1500)
    await p.keyboard.type('Y')
    await sleep(900)
    const md = await saved(p)
    note('X3 刚回车停在新起的空行上 + 外部改另一段 → 接着打字(回灌丢掉刚按的换行是现有策略,只记录)', JSON.stringify({ afterEnter: mid, md }))
    await p.closeAll()
  }
}

// ── U 撤销分组 ─────────────────────────────────────────────────────────────────
async function undoGroups(browser) {
  const cases = [
    { name: 'U1 第二行敲 `# ` 成标题 → 撤销一下回到一段两行、第二行是字面 `# `', key: ' ', literal: 'paragraph:a⏎# ', saved: 'a\n\\# \n' },
    { name: 'U2 第二行 `#`+回车 成标题 → 撤销一下回到一段两行、第二行是字面 `#`', key: 'Enter', literal: 'paragraph:a⏎#', saved: 'a\n\\#\n' },
  ]
  for (const c of cases) {
    const p = await open(browser, 'a\n')
    await caretAt(p, 'a')
    await p.keyboard.press('Enter')
    await p.keyboard.type('#')
    await p.keyboard.press(c.key === ' ' ? 'Space' : 'Enter')
    await sleep(120)
    const converted = await shape(p)
    await p.keyboard.type('T')
    await sleep(80)
    const typed = await saved(p)
    await p.keyboard.press(`${MOD}+z`) // 先撤掉打的 T
    await sleep(80)
    await p.keyboard.press(`${MOD}+z`) // 再撤转换(连同拆段)
    await sleep(120)
    const undone = await shape(p)
    const md = await saved(p)
    const p2 = await open(browser, md)
    const reopened = await shape(p2)
    await p2.closeAll()
    record(c.name, converted === 'paragraph+t:a | heading:' && typed === 'a\n# T\n' && undone === c.literal && md === c.saved && reopened === c.literal.trimEnd(), // 段末空格重开时照 Markdown 规矩去掉
      JSON.stringify({ converted, typed, undone, saved: md, reopened }))
    await p.closeAll()
  }
}

// ── P 复用同一个编辑器的地方 ─────────────────────────────────────────────────────
/** 插件卡片 / 记录页的小编辑器(PlainMarkdownEditor,v3 那条装配)。挂在台架页里,按同样的键序操作,返回 onChange 最后一次的值。 */
async function plainRun(browser, on, seed, steps) {
  const p = await open(browser, 'x\n', { on })
  await p.evaluate(async (seed) => {
    const { mountPluginMarkdownEditor } = await import('/src/amadeus/plugins/markdownEditorSurface.tsx')
    const el = document.createElement('div')
    el.id = 'plain-host'
    el.style.cssText = 'position:fixed;left:20px;top:20px;width:520px;z-index:9999;background:#fff'
    document.body.appendChild(el)
    window.__plainVals = []
    window.__plain = mountPluginMarkdownEditor(el, { value: seed, modes: false, onChange: (v) => window.__plainVals.push(v) })
  }, seed)
  await p.waitForSelector('#plain-host .ProseMirror', { timeout: 60000 })
  await sleep(400)
  const caretPlain = (k) => p.evaluate((k) => {
    const root = document.querySelector('#plain-host .ProseMirror')
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) { const i = n.data.indexOf(k); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + k.length); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); root.focus(); return true } }
    return false
  }, k)
  const untouched = await p.evaluate(() => window.__plain.getValue())
  for (const s of steps) {
    if (s.at) await caretPlain(s.at)
    if (s.key) await p.keyboard.press(s.key)
    if (s.type) await p.keyboard.type(s.type)
    await sleep(80)
  }
  await sleep(500)
  const value = await p.evaluate(() => window.__plain.getValue())
  await p.closeAll()
  return { untouched, value }
}

async function reuse(browser) {
  // P1 / P2 小编辑器:开关开 / 关两页同样的键序,结果逐字相同(开关只作用于 v4 整页编辑器)
  const seed = 'one\ntwo\n\n\nthree\n## H\nbody\n'
  const steps = [{ at: 'two', key: 'Enter' }, { type: 'X' }, { at: 'body', key: 'Shift+Enter' }, { type: 'Y' }, { at: 'three', type: 'Z' }]
  const offR = await plainRun(browser, false, seed, steps)
  const onR = await plainRun(browser, true, seed, steps)
  record('P1 小编辑器打开不编辑:开关开 / 关读到的值相同、等于原文', onR.untouched === offR.untouched && onR.untouched === seed, JSON.stringify({ on: onR.untouched, off: offR.untouched }))
  record('P2 小编辑器回车 / Shift+回车 / 打字:开关开 / 关存出来逐字相同', onR.value === offR.value && onR.value.includes('X') && onR.value.includes('Y') && onR.value.includes('Z'), JSON.stringify({ on: onR.value, off: offR.value }))

  // P3 源码模式切过去再切回来:存盘逐字相同(不编辑;可视里改一个字后再切)
  {
    const M = 'para one\npara two\n\n\nafter two blank\n\n## H\nbody\n'
    const p = await open(browser, M)
    await p.evaluate(() => window.__upage.setEditorMode('source'))
    await sleep(700)
    const inSource = await p.evaluate(() => document.querySelector('textarea.amx-source')?.value ?? null)
    await p.evaluate(() => window.__upage.setEditorMode('wysiwyg'))
    await p.waitForSelector(PM, { timeout: 60000 })
    await sleep(900)
    const back = await saved(p)
    const d1 = await disk(p)
    await caretAt(p, 'body')
    await p.keyboard.type('Z')
    await sleep(100)
    await p.evaluate(() => window.__upage.setEditorMode('source'))
    await sleep(700)
    await p.evaluate(() => window.__upage.setEditorMode('wysiwyg'))
    await p.waitForSelector(PM, { timeout: 60000 })
    await sleep(1200)
    const back2 = await saved(p)
    const d2 = await disk(p)
    const want2 = M.replace('body', 'bodyZ')
    record('P3 源码模式切过去再切回来:存盘逐字相同(含多行段落、空两行、标题后紧跟正文)', inSource === M && back === M && d1 === M && back2 === want2 && d2 === want2,
      JSON.stringify({ inSource, back, d1, back2, d2 }))
    await p.closeAll()
  }

  // P4 手机软键盘:Android UA 下软键盘回车不一定发 keydown,PM 从 DOM 变更里认出「拆了块」后合成一次 Enter 交给同一套按键处理。
  {
    const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    const p = await open(browser, 'one\n', { ua: UA })
    const android = await p.evaluate(() => /Android \d/.test(navigator.userAgent))
    await caretAt(p, 'one')
    await p.evaluate(() => document.execCommand('insertParagraph'))
    await sleep(300)
    await p.keyboard.insertText('two')
    await sleep(200)
    const viaPara = await saved(p)
    await p.closeAll()
    const lineBreak = async (on) => {
      const q = await open(browser, 'one\n', { ua: UA, on })
      await caretAt(q, 'one')
      await q.evaluate(() => document.execCommand('insertLineBreak'))
      await sleep(300)
      await q.keyboard.insertText('two')
      await sleep(200)
      const md = await saved(q)
      await q.closeAll()
      return md
    }
    const viaBr = await lineBreak(true)
    const viaBrOff = await lineBreak(false)
    record('P4 Android 软键盘回车(DOM 变更 insertParagraph → 合成 Enter)= 一个换行', android && viaPara === 'one\ntwo\n', JSON.stringify({ android, viaPara }))
    // insertLineBreak 不经按键链(PM 从 DOM 里读回 <br>),开关管不到;这一格只要求开 / 关一致(不是这次引入的)。
    record('P4b Android 软键盘换行(insertLineBreak):开关开 / 关存出来一样', viaBr === viaBrOff, JSON.stringify({ on: viaBr, off: viaBrOff }))
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const probe = await open(browser, 'x\n')
    const on = await switchOn(probe)
    await probe.closeAll()
    record('开关确实开着(amxEnter=inline)', on === true)
    if (on !== true) throw new Error('开关没开,后面的检查没有意义')
    // 真应用里的入口:localStorage 键;地址参数 amxEnter=off 压过它
    {
      const a = await open(browser, 'x\n', { query: '', storage: ['amadeus.enterMode', 'inline'] })
      const viaStorage = await switchOn(a)
      await a.closeAll()
      const b = await open(browser, 'x\n', { query: '&amxEnter=off', storage: ['amadeus.enterMode', 'inline'] })
      const forcedOff = await switchOn(b)
      await b.closeAll()
      const c = await open(browser, 'x\n', { query: '' })
      const plain = await switchOn(c)
      await c.closeAll()
      record('L1 localStorage amadeus.enterMode=inline 打开开关;amxEnter=off 压过它;都不设 = 关', viaStorage === true && forcedOff === false && plain === false, JSON.stringify({ viaStorage, forcedOff, plain }))
    }
    const only = (arg('only') || 'keys,reopen,moves,external,undo,reuse').split(',')
    if (only.includes('keys')) await keys(browser)
    if (only.includes('reopen')) await reopen(browser)
    if (only.includes('moves')) await moves(browser)
    if (only.includes('external')) await external(browser)
    if (only.includes('undo')) await undoGroups(browser)
    if (only.includes('reuse')) await reuse(browser)
  } finally { await browser.close() }
  console.log(`\n${pass} 过 / ${fail} 没过`)
  const o = arg('out'); if (o) fs.writeFileSync(o, out.join('\n') + `\n${pass} 过 / ${fail} 没过\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
