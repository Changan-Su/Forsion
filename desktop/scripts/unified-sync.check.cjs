// v4 统一编辑器的**回灌 / 改名链**仪器(评审 2026-09-27 波次 0b「sync」包:K-05 / D-08 / D-17 / G1-05 / G2-03)。
//
//  K 组(K-05,外部回灌不进撤销栈,拍板 #7):
//   K1 本地打字落盘后外部改了另一段 → Cmd+Z 只撤本地那次、外部那段还在,盘上不回滚外部改动
//   K2 没有本地编辑时外部写入 → Cmd+Z 什么都不撤、零写盘
//  D 组(D-08,回灌 = 顶层块级多段最小替换,光标 / 选区 / 折叠跟得住):
//   D1 大列表:光标在第 10 项,外部改第 1 项 → 光标原地,接着打的字落在第 10 项
//   D2 表格第 3 行 / D3 引用第 3 段 / D4 同一段光标前的字被改 → 光标都不被甩到块尾
//   D5 带标题的文档里只改一处(标题 id 由插件回填,解析出来是空串)→ 光标不被甩走
//   D6 折叠了一个小节,外部改文末 → 折叠还在
//   D7 两处不相邻的改动 → 两处都进来、中间那段的光标不动
//  F 组(G1-05,外科写 frontmatter × 打开着的 v4 实例):
//   F1 笔记开着时 store 改 icon / 笔记视图改属性 → 走实例的 fm 写口:盘上、实例里都是新值,零冲突副本
//   F2 接着在正文打一个字 → 新 fm 不被旧 fm 写回
//   F3 打字中(防抖窗内)外科写 fm → 本地的字与新 fm 都在盘上,零冲突副本零提示
//  R 组(G2-03,别处改名后本端开着旧路径的实例):
//   R1 退休时给了新路径且有未落盘的字 → 草稿记在**新路径**上,新实例挂载出「恢复草稿」条;旧路径零写
//   R2 没有未落盘的字 → 不留草稿,新实例干净打开
//   R3(评审 G1-08)防抖窗内被别的窗口**删除**(没有新路径可交接)→ 旧路径不复活、不留孤儿草稿,出 warning 提示,
//      「复制内容」把全文(含刚打的字)交给剪贴板;R4 已落盘后被删 → 零提示
//  E 组(D-17,标题回车改名 × 马上打正文):改名 IPC 延迟 300 / 800ms,回车后打不打字两档 ——
//   「进入正文」只执行一次:顶部只一个空段、字序不乱、改名后接着打的字接在原处
//
// 用法:npm run check:unifiedsync(= node scripts/e2e-editor.cjs --check=unified-sync;worktree 里设 HARNESS_URL)
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
const only = (process.env.ONLY || '').split(',').filter(Boolean) // ONLY=K,D 只跑这几组(调试用)
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(browser, seed, flags = '') {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 1100 } })
  p.errs = []
  p.on('pageerror', (e) => { p.errs.push(e.message); console.log('[pageerror]', e.message) })
  await p.addInitScript(() => {
    window.__toasts = []
    window.addEventListener('amadeus:toast', (e) => window.__toasts.push({ text: e.detail.text, level: e.detail.level }))
  })
  await p.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 60000 })
  await p.waitForFunction(() => !!window.__upage.lifecycle, null, { timeout: 20000 })
  await p.waitForTimeout(500)
  return p
}

/** 光标放到 text 之后(第 nth 处)并聚焦(直驱 PM 选区,不靠坐标)。 */
async function caretAfter(p, text, nth = 0) {
  const ok = await p.evaluate(([text, nth]) => {
    const view = window.__upage.probe.view()
    let found = -1
    let k = 0
    view.state.doc.descendants((node, pos) => {
      if (found >= 0) return false
      if (node.isText) {
        const i = node.text.indexOf(text)
        if (i >= 0 && k++ === nth) { found = pos + i + text.length; return false }
      }
      return true
    })
    if (found < 0) return false
    let proto = Object.getPrototypeOf(view.state.selection)
    while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    view.focus()
    view.dispatch(view.state.tr.setSelection(proto.constructor.near(view.state.doc.resolve(found))))
    return true
  }, [text, nth])
  if (!ok) throw new Error(`caretAfter: 找不到「${text}」`)
}
/** 光标所在文本块的全文 + 块内偏移。 */
const caret = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const $f = v.state.selection.$from
  return { text: $f.parent.textContent, off: $f.parentOffset, empty: v.state.selection.empty }
})
const disk = (p, file = 'Unified.md') => p.evaluate((f) => window.__upage.vault.get(f) ?? null, file)
const copies = (p) => p.evaluate(() => [...window.__upage.vault.keys()].filter((k) => / \(conflict \d{4}-\d{2}-\d{2} \d{4}\)(-\d+)?\.md$/.test(k)))
const toasts = (p) => p.evaluate(() => window.__toasts)
const writeCount = (p) => p.evaluate(() => window.__upage.writes.length)
const fire = (p, text, file = 'Unified.md') => p.evaluate(([f, t]) => window.__upage.fire(f, t), [file, text])
const undoDepth = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const pl = v.state.plugins.find((x) => x.key.startsWith('history$'))
  return pl ? pl.getState(v.state).done.eventCount : -1
})

// ─────────────────────────────── K-05 ───────────────────────────────
async function groupK(browser) {
  {
    const p = await open(browser, '甲段。\n\n乙段。\n')
    await caretAfter(p, '甲段。')
    await p.keyboard.type('本地')
    await wait(1600)
    const base = await disk(p)
    await fire(p, base.replace('乙段。', '乙段。外部改动'))
    await wait(1500)
    const depth = await undoDepth(p)
    await p.keyboard.press('Meta+z')
    await wait(1600)
    const d = await disk(p)
    record('K1 本地落盘后外部改另一段 → Cmd+Z 只撤本地、外部那段留在编辑器与盘上(撤销栈深度不因回灌增加)',
      depth === 1 && d.includes('乙段。外部改动') && !d.includes('本地'), JSON.stringify({ depth, d }))
    await p.close()
  }
  {
    const p = await open(browser, '甲段。\n\n乙段。\n')
    await caretAfter(p, '甲段。')
    await fire(p, '甲段。\n\n乙段。外部改动\n')
    await wait(1500)
    const n0 = await writeCount(p)
    await p.keyboard.press('Meta+z')
    await wait(1600)
    const d = await disk(p)
    const n1 = await writeCount(p)
    const dom = await p.evaluate((s) => document.querySelector(s).innerText, PM)
    record('K2 没有本地编辑时外部写入 → Cmd+Z 不回滚它、零写盘', d.includes('外部改动') && dom.includes('外部改动') && n1 === n0, JSON.stringify({ d, writes: n1 - n0 }))
    await p.close()
  }
}

// ─────────────────────────────── D-08 ───────────────────────────────
async function groupD(browser) {
  const items = Array.from({ length: 12 }, (_, i) => `- item${i + 1} text`)
  const md1 = '# Outline\n\n' + items.join('\n') + '\n'
  const cases = [
    ['D1 大列表:光标在第 10 项,外部改第 1 项 → 光标原地', md1, 'item10 te', md1.replace('item1 text', 'item1 text CHANGED'), (l) => l.includes('item10 teQxt')],
    ['D2 表格:光标在第 3 行,外部改第 1 行 → 光标原地', '# T\n\n| a | b |\n| --- | --- |\n| r1c1 | r1c2 |\n| r2c1 | r2c2 |\n| r3c1 | r3c2 |\n', 'r3c', null, (l) => /\| r3cQ1\s*\|/.test(l)],
    ['D3 引用:光标在第 3 段,外部改第 1 段 → 光标原地', '# T\n\n> quote one\n>\n> quote two\n>\n> quote three here\n', 'quote three', null, (l) => l.includes('quote threeQ here')],
    ['D4 同一段:光标前的字被外部改 → 光标跟着字走、不甩到段尾', '# T\n\nalpha beta gamma delta epsilon\n', 'gamma', null, (l) => l.includes('gammaQ delta')],
  ]
  const exts = [null, (m) => m.replace('r1c1', 'r1c1 CHANGED'), (m) => m.replace('quote one', 'quote one CHANGED'), (m) => m.replace('alpha', 'ALPHA-EXT')]
  for (let i = 0; i < cases.length; i++) {
    const [name, md, caretText, ext0, want] = cases[i]
    const ext = ext0 ?? exts[i](md)
    const p = await open(browser, md)
    await caretAfter(p, caretText)
    const before = await caret(p)
    await fire(p, ext)
    await wait(1500)
    const after = await caret(p)
    await p.keyboard.type('Q')
    await wait(1600)
    const line = (await disk(p)).split('\n').find((l) => l.includes('Q')) ?? ''
    record(name, want(line), JSON.stringify({ before, after, line }))
    await p.close()
  }
  // D5:带标题的长文档只改一处(标题 id 解析出来是空串,活文档里由插件回填)
  const N = 40
  const mk = (edit) => {
    const out = ['# 文档']
    for (let i = 1; i <= N; i++) {
      if (i === 10 || i === 25) out.push(`## 小节${i}`)
      out.push(edit && edit[i] ? edit[i] : `段落${i} 原文内容。`)
    }
    return out.join('\n\n') + '\n'
  }
  {
    const p = await open(browser, mk(null))
    await caretAfter(p, '段落20 原文')
    const before = await caret(p)
    await fire(p, mk({ 5: '段落5 AGENT。' }))
    await wait(1500)
    const after = await caret(p)
    await p.keyboard.type('Z')
    await wait(1600)
    const line = (await disk(p)).split('\n').find((l) => l.includes('Z')) ?? ''
    record('D5 带标题的文档只改一处 → 光标不被甩走(标题 id 回填不算改动)', line === '段落20 原文Z内容。', JSON.stringify({ before, after, line }))
    await p.close()
  }
  // D6:折叠一个小节,外部改文末 → 折叠还在
  {
    const p = await open(browser, mk(null))
    const folded = () => p.evaluate(() => {
      const v = window.__upage.probe.view()
      const pl = v.state.plugins.find((x) => x.key === 'AMX_HEADING_FOLD$')
      return (pl.getState(v.state).folded || []).map((pos) => v.state.doc.nodeAt(pos)?.textContent ?? '?')
    })
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      const key = v.state.plugins.find((x) => x.key === 'AMX_HEADING_FOLD$').spec.key
      let pos = -1
      v.state.doc.forEach((n, off) => { if (pos < 0 && n.type.name === 'heading' && n.textContent === '小节10') pos = off })
      v.dispatch(v.state.tr.setMeta(key, { toggle: pos }))
    })
    const f0 = await folded()
    await fire(p, mk({ 40: '段落40 AGENT。' }))
    await wait(1500)
    const f1 = await folded()
    record('D6 折叠了「小节10」,外部改文末 → 折叠还在', JSON.stringify(f0) === '["小节10"]' && JSON.stringify(f1) === '["小节10"]', JSON.stringify({ f0, f1 }))
    await p.close()
  }
  // D7:两处不相邻的改动 → 都进来,中间的光标不动;回灌只重建被改的那两块 DOM
  {
    const p = await open(browser, mk(null))
    await caretAfter(p, '段落20 原文')
    // 标记用 expando 而不是 data-* 属性:属性改动会被 PM 的 DOMObserver 当脏数据、整块重绘(假红)。
    await p.evaluate((s) => { document.querySelectorAll(`${s} > *`).forEach((el) => { el.__amxKeep = true }) }, PM)
    await fire(p, mk({ 3: '段落3 EXT。', 37: '段落37 EXT。' }))
    await wait(1500)
    const after = await caret(p)
    const dom = await p.evaluate((s) => [...document.querySelectorAll(`${s} > *`)].filter((el) => !el.__amxKeep).map((el) => el.textContent), PM)
    const text = await p.evaluate((s) => document.querySelector(s).innerText, PM)
    record('D7 两处不相邻的外部改动 → 两处都进来、中间光标不动、别的块 DOM 一个不重建', after.text === '段落20 原文内容。' && after.off === 7 && text.includes('段落3 EXT。') && text.includes('段落37 EXT。') && dom.every((x) => x.includes('EXT')), JSON.stringify({ after, rebuilt: dom }))
    await p.close()
  }
}

// ─────────────────────────────── G1-05 ───────────────────────────────
const errToasts = (p) => p.evaluate(() => window.__toasts.filter((t) => t.level === 'error' || t.level === 'warning'))
const fmNow = (p) => p.evaluate(() => window.__upage.probe.fmState().fm)
async function groupF(browser) {
  const seed = '---\nstatus: todo\n---\n\n# 标题\n\n第一段。\n'
  {
    const p = await open(browser, seed)
    await p.evaluate(() => window.__upage.pageStore.getState().setPageIcon('Unified.md', '🔥'))
    await wait(600)
    const d1 = await disk(p)
    const fm1 = await fmNow(p)
    record('F1 笔记开着时改图标(store 的 fm 写口)→ 实例接手:盘上与实例 fm 都是新值、零冲突副本',
      /icon: 🔥/.test(d1) && /icon: 🔥/.test(fm1) && d1.includes('status: todo') && (await copies(p)).length === 0, JSON.stringify({ d1, fm1 }))
    await p.evaluate(() => window.__upage.pageStore.getState().setPageCoverY('Unified.md', 30))
    await wait(400)
    await caretAfter(p, '第一段。')
    await p.keyboard.type('x')
    await wait(1600)
    const d2 = await disk(p)
    record('F2 接着在正文打一个字 → 新 fm(icon / cover_y)不被旧 fm 写回,零副本零提示',
      /icon: 🔥/.test(d2) && /cover_y: 30/.test(d2) && d2.includes('第一段。x') && (await copies(p)).length === 0 && (await errToasts(p)).length === 0, JSON.stringify({ d2, toasts: await errToasts(p) }))
    await p.close()
  }
  {
    const p = await open(browser, seed)
    await caretAfter(p, '第一段。')
    await p.keyboard.type('abc')
    await p.evaluate(() => window.__upage.pageStore.getState().setPageIcon('Unified.md', '🌊')) // 防抖窗内
    await p.keyboard.type('def')
    await wait(1800)
    const d = await disk(p)
    record('F3 打字中外科写 fm → 本地的字与新 fm 都在盘上,零冲突副本零提示',
      /icon: 🌊/.test(d) && d.includes('第一段。abcdef') && (await copies(p)).length === 0 && (await errToasts(p)).length === 0, JSON.stringify({ d, copies: await copies(p), toasts: await errToasts(p) }))
    await p.close()
  }
}

// ─────────────────────────────── G2-03 ───────────────────────────────
/** 别处把 Unified.md 改名成 Moved.md:盘上挪走 → 生产收尾 remapScopePaths(onPathGone 的落点)→ 标签改指新路径。 */
async function remoteMove(p) {
  await p.evaluate(() => {
    const u = window.__upage
    u.vault.set('Moved.md', u.vault.get('Unified.md'))
    u.vault.delete('Unified.md')
    u.remapScopePaths('Unified.md', 'Moved.md', 'file')
    u.switchFile('Moved.md')
  })
  await p.waitForFunction(() => document.querySelector('[data-unified-path]')?.getAttribute('data-unified-path') === 'Moved.md', null, { timeout: 20000 })
  await wait(800)
}
const draftFor = (p, file) => p.evaluate((f) => Object.keys(localStorage).filter((k) => k.startsWith('amadeus.unsavedDraft:') && k.endsWith(`:${f}`)), file)
async function groupR(browser) {
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await caretAfter(p, '第一段。')
    await p.keyboard.type('未落盘')
    await remoteMove(p) // 防抖窗内(800ms)就被别处改名
    await wait(1200)
    const old = await disk(p, 'Unified.md')
    const drafts = await draftFor(p, 'Moved.md')
    const bar = await p.evaluate(() => !!document.querySelector('[data-save="draft"]'))
    await p.click('[data-save="draft"] .btn.primary').catch(() => {})
    await wait(1500)
    const moved = await disk(p, 'Moved.md')
    record('R1 改名时有未落盘的字 → 旧路径不复活、草稿记在新路径、新实例出恢复条,点恢复后字落到新路径',
      old == null && drafts.length === 1 && bar && moved.includes('第一段。未落盘') && (await copies(p)).length === 0,
      JSON.stringify({ old, drafts, bar, moved }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await caretAfter(p, '第一段。')
    await p.keyboard.type('已落盘')
    await wait(1600)
    await remoteMove(p)
    const drafts = await draftFor(p, 'Moved.md')
    const bar = await p.evaluate(() => !!document.querySelector('[data-save="draft"]'))
    await caretAfter(p, '已落盘')
    await p.keyboard.type('+')
    await wait(1600)
    const moved = await disk(p, 'Moved.md')
    record('R2 没有未落盘的字 → 不留草稿、新实例干净打开,接着打的字落在新路径、旧路径不复活',
      drafts.length === 0 && !bar && moved.includes('第一段。已落盘+') && (await disk(p, 'Unified.md')) == null, JSON.stringify({ drafts, bar, moved }))
    await p.close()
  }
}

/** 别的窗口删了 Unified.md:盘上没了 → 生产收尾(pageStore.onPathGone 的 to=null 分支:retireUnifiedPath)→ 标签改指别处。 */
async function remoteDelete(p) {
  await p.evaluate(() => {
    const u = window.__upage
    window.__goneToasts = []
    window.addEventListener('amadeus:toast', (e) => window.__goneToasts.push(e.detail))
    navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve() }
    u.vault.delete('Unified.md')
    u.lifecycle.retireUnifiedPath('Unified.md')
    u.switchFile('Other.md', '# 其它\n\n其它正文。\n')
  })
  await wait(1500)
}
async function groupR2(browser) {
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await caretAfter(p, '第一段。')
    await p.keyboard.type('删前打的')
    await remoteDelete(p)
    const t = await p.evaluate(() => window.__goneToasts.filter((x) => x.level === 'warning' && x.action).map((x) => ({ text: x.text, label: x.action.label })))
    await p.evaluate(() => { const x = window.__goneToasts.find((y) => y.action && y.level === 'warning'); x?.action.run() })
    await wait(200)
    const copied = await p.evaluate(() => window.__copied ?? null)
    const old = await disk(p, 'Unified.md')
    const drafts = await draftFor(p, 'Unified.md')
    record('R3 防抖窗内被别处删除 → 旧路径不复活、不留孤儿草稿,出提示;「复制内容」交出全文(含刚打的字)',
      old == null && drafts.length === 0 && t.length === 1 && /Unified/.test(t[0].text) && typeof copied === 'string' && copied.includes('第一段。删前打的'),
      JSON.stringify({ old, drafts, t, copied }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await caretAfter(p, '第一段。')
    await p.keyboard.type('已落盘')
    await wait(1600)
    await remoteDelete(p)
    const t = await p.evaluate(() => window.__goneToasts.filter((x) => x.level === 'warning'))
    record('R4 已落盘后被别处删除 → 零提示', t.length === 0 && (await disk(p, 'Unified.md')) == null, JSON.stringify(t))
    await p.close()
  }
}

// ─────────────────────────────── D-17 ───────────────────────────────
/** 标题改名 + 回车;改名 IPC 人为延迟 delay ms(真机要走全智库重写,很容易 >120ms;内存库 0ms 测不出)。 */
async function titleEnter(p, delay) {
  await p.evaluate((d) => {
    const o = window.amadeus.renamePageFile
    window.amadeus.renamePageFile = (path, n) => new Promise((r) => setTimeout(r, d)).then(() => o(path, n))
  }, delay)
  const title = await p.$('.amx-title-input')
  await title.click()
  await p.keyboard.press('Meta+a')
  await p.keyboard.type('Meeting')
  await p.keyboard.press('Enter')
  await wait(120) // 人的反应时间:回车后 ~120ms 开始打正文
}
/** a 是 b 的子序列(按原顺序,允许中间缺字)。 */
const isSubseq = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i++; return i === a.length }
async function groupE(browser) {
  const seed = '# heading\n\nbody para\n'
  for (const delay of [300, 800]) {
    for (const typeEarly of [false, true]) {
      const p = await open(browser, seed)
      await titleEnter(p, delay)
      if (typeEarly) await p.keyboard.type('first', { delay: 40 })
      await wait(delay + 1500)
      await p.keyboard.type('SECOND')
      await wait(1500)
      const d = (await disk(p, 'Meeting.md')) ?? ''
      // 顶部只有**一个**段、先打的字在前:body-enter 重做一次就会变成 `SECOND\n\nfirst`。
      // 重建窗口里吞掉的键(评审另列的「重建期间吞键」)只记在明细里,不算本条红 —— 机器忙时这扇窗会变大。
      const m = /^([a-z]*)SECOND\n\n# heading\n\nbody para\n$/.exec(d)
      const ok = !!m && (typeEarly ? m[1].length > 0 && isSubseq(m[1], 'first') : m[1] === '')
      record(`E${delay}${typeEarly ? 'b' : 'a'} 标题回车改名(IPC ${delay}ms)${typeEarly ? '、改名返回前已打字' : ''} → 「进入正文」只一次,接着打的字接在原处`,
        ok, JSON.stringify({ d, lost: typeEarly && m ? 5 - m[1].length : 0 }))
      await p.close()
    }
  }
  for (const delay of [300, 800]) {
    const p = await open(browser, seed)
    await titleEnter(p, delay)
    const S = 'abcdefghijklmnopqrstuvwxyz0123456789'
    await p.keyboard.type(S, { delay: 40 }) // 连续打字,跨过改名重建
    await wait(delay + 1800)
    const d = (await disk(p, 'Meeting.md')) ?? ''
    const m = /^([a-z0-9]*)\n\n# heading\n\nbody para\n$/.exec(d)
    record(`E${delay}c 连续打字跨过改名重建(IPC ${delay}ms)→ 字序不乱、顶部只一个段`, !!m && m[1].length > 0 && isSubseq(m[1], S),
      JSON.stringify({ d, lost: m ? S.length - m[1].length : null }))
    await p.close()
  }
}

const GROUPS = { K: groupK, D: groupD, F: groupF, R: async (b) => { await groupR(b); await groupR2(b) }, E: groupE }

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    for (const [k, fn] of Object.entries(GROUPS)) {
      if (only.length && !only.includes(k)) continue
      await fn(browser)
    }
  } finally {
    await browser.close()
  }
  const failed = results.filter((x) => !x).length
  console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nall ${results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('CHECK CRASHED', e); process.exit(2) })
