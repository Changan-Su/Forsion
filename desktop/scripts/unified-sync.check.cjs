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
//   R3(评审 G1-08 + 返修 P0)防抖窗内被别的窗口**删除**(没有新路径可交接)→ 旧路径不复活、不留孤儿草稿,
//      全文(含刚打的字)另存为冲突副本(持久文件,不是只在提示回调里),提示「已另存为 X」带「打开副本」;R4 已落盘后被删 → 零提示
//   R5(返修 P0)同篇双开、两边各有没落盘的字时被删 → 各存各的副本、各出一条提示,谁的字都没丢
//  X 组(评审 G1-06,插件编辑器扩展启停 = 原地重配,不重挂):
//   X1 打字后 50ms 内启用一个带编辑器扩展的插件 → 编辑器 DOM 还是同一个、扩展已生效、焦点还在、刚打的字在屏上也在盘上,
//      不点击接着打的字接在后面 · X2 停用 → 扩展摘掉、编辑器仍是同一个;空闲启停零写盘
//   X3 撤销栈跨启停保留:停用后 Cmd+Z 撤掉的是启停之前打的字 · X4 输入法组字中启停 → 推迟到上屏后,盘上是汉字不是拼音
//   X5 画布卡归属不随启停清零:启停后删掉一张卡,amadeus_canvas 照常跟着更新(清了归属 = 派生冻结)
//   X6 嵌入不随启停变空壳:重配会重建全部插件视图,嵌入层的 React 根不许被卸(widget DOM 还在用)
//   X7-X9(评审 G1-07,扩展异常隔离):X7 笔记开着时启用一个 state.init 抛错的扩展 → 正文照常、提示点名插件、打字照常落盘;
//   X8 spec.view 抛错 → 宿主插件视图不被打断(⠿ 把手、大纲、insertMarkdown 照常)、提示点名;
//   X9 init 只对某篇抛错(建编辑器那一刻才炸)→ 切到那篇正文照常渲染、提示点名
//  M 组(评审 C-08,源码 / 可视按 leaf 记):`&udual` 同窗两个标签 A / B ——
//   M1 A 切源码 → B 不跟着切、B 的编辑器不被动重建(DOM 还是同一个)、B 切换前打的字仍可 Cmd+Z 撤掉
//   M2 本机记忆:刷新后 A 仍是源码、B 仍是可视;M3 B 自己切源码只动 B
//  S 组(评审 C-06,源码 ↔ 可视切换保住滚动 / 光标 / 撤销;`&upane` 长文):
//   S1 可视 → 源码:textarea 光标落在同一处、焦点跟过去、光标在视口里的高度不变
//   S2 源码 → 可视:编辑器还是同一个(没重建)、光标回原处、滚动回原位,切换前打的字 Cmd+Z 撤得掉(屏上、盘上)
//   S3 源码里的改动回可视后是一步可撤的编辑:第一下 Cmd+Z 只撤源码里打的,第二下撤可视里打的
//   S4 切换前 200ms 内打的字不丢(listener 防抖窗)· S5 源码模式里外部改动照常回灌到 textarea,回可视后编辑器是新内容、零冲突副本
//  EC(Codex 复核返修 P0-4)改名后的补写带 CAS:改名 IPC 期间打了字、新路径随后被别处改过 → 不覆盖别处的改动,
//   本实例的字另存为冲突副本并提示;对照:新路径没被动过 → 补写照常落到新路径(E 组那几条)
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
    performance.setResourceTimingBufferSize(20000) // X 组按已加载模块的 URL 取生产模块实例(裸 /src 路径会另起一份)
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
    const t = await p.evaluate(() => window.__goneToasts.filter((x) => x.level === 'error' && x.action).map((x) => ({ text: x.text, label: x.action.label })))
    const old = await disk(p, 'Unified.md')
    const drafts = await draftFor(p, 'Unified.md')
    const cs = await p.evaluate(() => [...window.__upage.vault.entries()].filter(([k]) => /\(conflict /.test(k)))
    record('R3 防抖窗内被别处删除 → 旧路径不复活、不留孤儿草稿;全文(含刚打的字)另存为冲突副本,提示点名副本并带「打开副本」',
      old == null && drafts.length === 0 && cs.length === 1 && cs[0][1].includes('第一段。删前打的') &&
        t.length === 1 && t[0].text.includes(cs[0][0].replace(/\.md$/, '')) && t[0].label === '打开副本',
      JSON.stringify({ old, drafts, t, cs }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await caretAfter(p, '第一段。')
    await p.keyboard.type('已落盘')
    await wait(1600)
    await remoteDelete(p)
    const t = await p.evaluate(() => window.__goneToasts.filter((x) => x.level === 'warning' || x.level === 'error'))
    const cs = await p.evaluate(() => [...window.__upage.vault.keys()].filter((k) => /\(conflict /.test(k)))
    record('R4 已落盘后被别处删除 → 零提示、零副本', t.length === 0 && cs.length === 0 && (await disk(p, 'Unified.md')) == null, JSON.stringify({ t, cs }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n\n第二段。\n', '&udual')
    await p.waitForFunction((s) => document.querySelectorAll(s).length === 2, PM, { timeout: 60000 })
    await caretAfter(p, '第一段。')
    await p.keyboard.type('A的字')
    await p.evaluate(() => {
      const v = window.__upage.probe2.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('第二段。')) at = pos + n.text.indexOf('第二段。') + 4; return at < 0 })
      let proto = Object.getPrototypeOf(v.state.selection)
      while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
      v.focus()
      v.dispatch(v.state.tr.setSelection(proto.constructor.near(v.state.doc.resolve(at))))
    })
    await p.keyboard.type('B的字')
    await remoteDelete(p)
    const cs = await p.evaluate(() => [...window.__upage.vault.entries()].filter(([k]) => /\(conflict /.test(k)).map(([, v]) => v))
    const t = await p.evaluate(() => window.__goneToasts.filter((x) => x.level === 'error').map((x) => x.dedupeKey))
    record('R5 同篇双开、两边各有没落盘的字时被删 → 各存各的副本(A 的字、B 的字都在)、各出一条提示(去重键不同)',
      (await disk(p, 'Unified.md')) == null && cs.length === 2 && cs.some((x) => x.includes('第一段。A的字')) && cs.some((x) => x.includes('第二段。B的字')) &&
        t.length === 2 && t[0] !== t[1], JSON.stringify({ cs, t }))
    await p.close()
  }
}

// ─────────────────────────────── G1-06 ───────────────────────────────
const XPLUG = `ctx.registerEditorExtension((pm) => [new pm.Plugin({ props: { attributes: { 'data-xext': 'on' } } })])`
const pmTag = (p) => p.evaluate((s) => { const el = document.querySelector(s); if (!el.__xtag) el.__xtag = Math.random().toString(36).slice(2); return el.__xtag }, PM)
const extOn = (p) => p.evaluate((s) => document.querySelector(s)?.getAttribute('data-xext') === 'on', PM)
const pmFocused = (p) => p.evaluate((s) => { const el = document.querySelector(s); return !!el && (el === document.activeElement || el.contains(document.activeElement)) }, PM)
const setPlugin = (p, on) => p.evaluate(async (on) => {
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/src\/amadeus\/plugins\/pluginStore\.ts/.test(n))
  const m = await import(url)
  const st = m.usePluginStore.getState()
  if (on) st.enable('xext')
  else st.disable('xext')
}, on)
async function groupX(browser) {
  {
    const p = await open(browser, '# 标题\n\n第一段。\n\n第二段。\n')
    const tag = await pmTag(p)
    await caretAfter(p, '第一段。')
    await p.keyboard.type('RACE')
    await wait(50)
    await p.evaluate((code) => window.__ep.loadPlugin(code, { id: 'xext' }), XPLUG) // 真 setup 路径:registerEditorExtension
    await wait(400)
    const r = { same: (await pmTag(p)) === tag, on: await extOn(p), focus: await pmFocused(p) }
    await p.keyboard.type('y') // 不点击直接接着打
    await wait(1600)
    const d = await disk(p)
    record('X1 打字后 50ms 内启用编辑器扩展 → 不重挂、扩展生效、焦点还在、字不丢,接着打的字接在后面',
      r.same && r.on && r.focus && d.includes('第一段。RACEy'), JSON.stringify({ ...r, d }))
    const w0 = (await p.evaluate(() => window.__upage.writes.length))
    await setPlugin(p, false)
    await wait(400)
    const off = { same: (await pmTag(p)) === tag, on: await extOn(p) }
    await setPlugin(p, true)
    await wait(400)
    const on2 = await extOn(p)
    await wait(1200)
    const dw = (await p.evaluate(() => window.__upage.writes.length)) - w0
    record('X2 停用 → 扩展摘掉、编辑器仍是同一个;再启用又生效;空闲启停零写盘', off.same && !off.on && on2 && dw === 0, JSON.stringify({ ...off, on2, dw }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n\n第二段。\n')
    await p.evaluate((code) => window.__ep.loadPlugin(code, { id: 'xext' }), XPLUG)
    await wait(400)
    await caretAfter(p, '第一段。')
    await p.keyboard.type('UNDOME')
    await wait(1600)
    await setPlugin(p, false)
    await wait(400)
    await p.keyboard.press('Meta+z')
    await wait(1500)
    const txt = await p.evaluate((s) => document.querySelector(s).innerText, PM)
    const d = await disk(p)
    record('X3 撤销栈跨启停保留:停用扩展后 Cmd+Z 撤掉启停之前打的字(屏上、盘上都撤了)', !txt.includes('UNDOME') && !d.includes('UNDOME'), JSON.stringify({ txt, d }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n\n第二段。\n')
    await p.evaluate((code) => window.__ep.loadPlugin(code, { id: 'xext' }), XPLUG)
    await wait(400)
    await caretAfter(p, '第一段。')
    const cdp = await p.context().newCDPSession(p)
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    await wait(200)
    await setPlugin(p, false)
    await wait(300)
    await cdp.send('Input.insertText', { text: '你' })
    await wait(1800)
    const d = await disk(p)
    const txt = await p.evaluate((s) => document.querySelector(s).innerText, PM)
    record('X4 输入法组字中停用扩展 → 推迟到上屏后重配:屏上、盘上都是「你」,没有残留拼音、扩展已摘掉',
      d.includes('第一段。你\n') && !d.includes('ni') && txt.includes('第一段。你') && !(await extOn(p)), JSON.stringify({ d, txt }))
    await p.close()
  }
  {
    const seed = ['---', 'amadeus_schema: amadeus.page/4',
      'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":700,"y":40,"w":300},{"ref":"k2","x":700,"y":300,"w":300}]}',
      '---', '', '主卡正文。', '', '<!-- a k1 -->', '卡一甲。', '', '<!-- a k2 -->', '卡二乙。', ''].join('\n')
    const p = await open(browser, seed)
    await p.evaluate((code) => window.__ep.loadPlugin(code, { id: 'xext' }), XPLUG)
    await wait(300)
    await setPlugin(p, false)
    await wait(300)
    // 删掉卡二(直驱事务 = 与块菜单删卡同一类文档改动),派生应把 k2 从 cards 里剪掉
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let at = -1, size = 0
      v.state.doc.forEach((n, pos) => { if (n.type.name === 'amadeusCanvasCard' && n.attrs.anchor === 'k2') { at = pos; size = n.nodeSize } })
      if (at >= 0) v.dispatch(v.state.tr.delete(at, at + size))
    })
    await wait(1600)
    const d = await disk(p)
    const line = (/^amadeus_canvas:\s*(.*)$/m.exec(d) || [])[1] ?? ''
    record('X5 启停之后删掉一张卡 → amadeus_canvas 照常更新(k2 剪掉、k1 还在),归属集合没被清零冻结派生',
      line.includes('"k1"') && !line.includes('"k2"') && !d.includes('卡二乙'), JSON.stringify({ line }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n前一段。\n\n![[Embedded]]\n\n后一段。\n')
    await wait(800)
    const emb = () => p.evaluate(() => (document.querySelector('.unified-body')?.innerText ?? '').includes('被嵌入的第一段'))
    const before = await emb()
    await p.evaluate((code) => window.__ep.loadPlugin(code, { id: 'xext' }), XPLUG)
    await wait(300)
    await setPlugin(p, false)
    await wait(800)
    record('X6 启停之后嵌入仍有内容(重配重建插件视图不卸嵌入的 React 根)', before && (await emb()), JSON.stringify({ before, after: await emb() }))
    await p.close()
  }
}

const badToasts = (p) => p.evaluate(() => window.__toasts.filter((t) => t.level === 'error').map((t) => t.text))
async function groupXFault(browser) {
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await p.evaluate(() => window.__ep.loadPlugin(`ctx.registerEditorExtension((pm) => [new pm.Plugin({ state: { init: () => { throw new Error('init boom') }, apply: (t, v) => v } })])`, { id: 'badinit', name: '坏初始化' }))
    await wait(600)
    const body = await p.evaluate((s) => document.querySelector(s)?.innerText ?? null, PM)
    await caretAfter(p, '第一段。')
    await p.keyboard.type('照打')
    await wait(1600)
    const t = await badToasts(p)
    record('X7 启用 state.init 抛错的扩展 → 正文照常、提示点名插件、打字照常落盘',
      !!body && body.includes('第一段。') && t.some((x) => x.includes('坏初始化')) && (await disk(p)).includes('第一段。照打'), JSON.stringify({ body, t }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n\n## 小节\n')
    await p.evaluate(() => window.__ep.loadPlugin(`ctx.registerEditorExtension((pm) => [new pm.Plugin({ view: () => { throw new Error('view boom') } })])`, { id: 'badview', name: '坏视图', }))
    await wait(600)
    const r = await p.evaluate(() => {
      const box = document.querySelector('.unified-body .ProseMirror p').getBoundingClientRect()
      return { heads: window.__upage.lifecycle.unifiedHeadings('Unified.md')?.length ?? -1, box: { x: box.left + 10, y: box.top + box.height / 2 } }
    })
    await p.mouse.move(r.box.x, r.box.y)
    await wait(300)
    const handle = await p.evaluate(() => [...document.querySelectorAll('.unified-body *')].some((el) => el.textContent === '⠿' && el.getBoundingClientRect().width > 0))
    const ins = await p.evaluate(() => window.__upage.lifecycle.unifiedInsertMarkdown('Unified.md', '插入的段。', 'end'))
    await wait(1600)
    const t = await badToasts(p)
    record('X8 spec.view 抛错的扩展 → 宿主插件视图照常(⠿ 把手、大纲、insertMarkdown),提示点名插件',
      handle && r.heads === 2 && ins && (await disk(p)).includes('插入的段。') && t.some((x) => x.includes('坏视图')), JSON.stringify({ handle, heads: r.heads, ins, t }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n')
    await p.evaluate(() => window.__ep.loadPlugin(`ctx.registerEditorExtension((pm) => [new pm.Plugin({ state: { init: (c, st) => { if (st.doc.textContent.includes('BOOM')) throw new Error('doc boom'); return 0 }, apply: (t, v) => v } })])`, { id: 'baddoc', name: '挑文档' }))
    await wait(500)
    const t0 = await badToasts(p)
    await p.evaluate(() => window.__upage.switchFile('Boom.md', '# 炸\n\nBOOM 在这里。\n'))
    await wait(1200)
    const body = await p.evaluate((s) => document.querySelector(s)?.innerText ?? null, PM)
    const t = await badToasts(p)
    record('X9 init 只对某篇抛错 → 切到那篇正文照常渲染、提示点名插件(之前那篇不受影响、不提示)',
      t0.length === 0 && !!body && body.includes('BOOM 在这里') && t.some((x) => x.includes('挑文档')), JSON.stringify({ t0, body, t }))
    await p.close()
  }
}

// ─────────────────────────────── C-08 ───────────────────────────────
const taIn = (p, idx) => p.evaluate((idx) => !!document.querySelectorAll('.amadeus-root, #root')[0] && !!(idx ? document.querySelector('[data-instance="B"] textarea.amx-source') : document.querySelector('#root textarea.amx-source')), idx)
async function groupM(browser) {
  const seed = '# 标题\n\n第一段。\n\n第二段。\n'
  const p = await open(browser, seed, '&udual')
  await p.waitForFunction((s) => document.querySelectorAll(s).length === 2, PM, { timeout: 60000 })
  const tagB = await p.evaluate(() => { const el = document.querySelector('[data-instance="B"] .ProseMirror'); el.__mtag = 'B0'; return true })
  // 在 B 里打字(直驱 B 的选区)
  await p.evaluate(() => {
    const v = window.__upage.probe2.view()
    let at = -1
    v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('第二段。')) at = pos + n.text.indexOf('第二段。') + 4; return at < 0 })
    let proto = Object.getPrototypeOf(v.state.selection)
    while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    v.focus()
    v.dispatch(v.state.tr.setSelection(proto.constructor.near(v.state.doc.resolve(at))))
  })
  await p.keyboard.type('BB')
  await wait(1600)
  await p.evaluate(() => window.__upage.setEditorMode('source')) // 切 A(主实例)
  await wait(700)
  const m1 = {
    aSrc: await taIn(p, 0),
    bSrc: await taIn(p, 1),
    bSame: await p.evaluate(() => document.querySelector('[data-instance="B"] .ProseMirror')?.__mtag === 'B0'),
  }
  await p.evaluate(() => window.__upage.probe2.view()?.focus()) // B 被跟着切走(回退)时没有 view
  await p.keyboard.press('Meta+z')
  await wait(300)
  m1.bUndo = await p.evaluate(() => { const v = window.__upage.probe2.view(); return !!v && !v.state.doc.textContent.includes('BB') })
  record('M1 A 切源码 → B 不跟着切、不被动重建,B 之前打的字仍可 Cmd+Z', m1.aSrc && !m1.bSrc && m1.bSame && m1.bUndo, JSON.stringify(m1))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!document.querySelector('#root textarea.amx-source') && !!document.querySelector('[data-instance="B"] .ProseMirror'), null, { timeout: 60000 })
  const m2 = { aSrc: await taIn(p, 0), bSrc: await taIn(p, 1) }
  record('M2 本机记忆:刷新后 A 仍是源码、B 仍是可视', m2.aSrc && !m2.bSrc, JSON.stringify(m2))
  await p.evaluate(() => { window.__upage.setEditorMode('wysiwyg'); window.__upage.setEditorMode('source', 'harness-B') })
  await wait(700)
  const m3 = { aSrc: await taIn(p, 0), bSrc: await taIn(p, 1) }
  record('M3 B 自己切源码只动 B(A 切回可视)', !m3.aSrc && m3.bSrc, JSON.stringify(m3))
  await p.close()
}

// ─────────────────────────────── C-06 ───────────────────────────────
const LONG = '# 文首\n\n' + Array.from({ length: 80 }, (_, i) => `第 ${i} 段填充文字。`).join('\n\n') + '\n'
const para40 = (p) => p.evaluate(() => { const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent.startsWith('第 40 段')); return el ? el.textContent : null })
const modeTo = async (p, m) => {
  await p.evaluate((m) => window.__upage.setEditorMode(m), m)
  await p.waitForFunction((m) => (m === 'source') === !!document.querySelector('textarea.amx-source'), m, { timeout: 10000 })
  await wait(400)
}
const viewState = (p) => p.evaluate(() => {
  const pane = document.querySelector('.amx-pane')
  const ta = document.querySelector('textarea.amx-source')
  const v = window.__upage.probe.view()
  const out = { scroll: Math.round(pane.scrollTop), active: document.activeElement?.tagName }
  if (ta) {
    out.taLine = ta.value.slice(0, ta.selectionStart).split('\n').pop()
  } else if (v) {
    const $h = v.state.selection.$head
    out.pmPara = $h.parent.textContent
    out.pmOff = $h.parentOffset
    out.caretY = Math.round(v.coordsAtPos(v.state.selection.head).top - pane.getBoundingClientRect().top)
  }
  return out
})
async function openLong(browser) {
  const p = await open(browser, LONG, '&upane')
  await p.evaluate(() => { const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent.startsWith('第 40 段')); el.scrollIntoView({ block: 'center' }) })
  await wait(200)
  await caretAfter(p, '第 40 段填充文字。')
  return p
}
async function groupS(browser) {
  {
    const p = await openLong(browser)
    await p.keyboard.type('追加ABC')
    await wait(1300)
    await p.evaluate((s) => { document.querySelector(s).__stag = 'S0' }, PM)
    const v0 = await viewState(p)
    await modeTo(p, 'source')
    const s1 = await p.evaluate(() => {
      const ta = document.querySelector('textarea.amx-source')
      const pane = document.querySelector('.amx-pane')
      // 镜像量 textarea 光标高度(与生产 modeRelay 同法,独立实现)
      const cs = getComputedStyle(ta), d = document.createElement('div')
      for (const k of ['boxSizing', 'width', 'padding', 'border', 'font', 'letterSpacing', 'lineHeight', 'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize']) d.style[k] = cs[k]
      d.style.position = 'absolute'; d.style.visibility = 'hidden'; d.style.whiteSpace = 'pre-wrap'
      d.textContent = ta.value.slice(0, ta.selectionStart); const m = document.createElement('span'); m.textContent = '.'; d.appendChild(m); document.body.appendChild(d)
      const y = ta.getBoundingClientRect().top + m.offsetTop - pane.getBoundingClientRect().top; d.remove()
      return { line: ta.value.slice(0, ta.selectionStart).split('\n').pop(), focus: document.activeElement === ta, y: Math.round(y) }
    })
    record('S1 可视 → 源码:光标落在同一处、焦点跟过去、光标在视口里的高度不变(±40px)',
      s1.line === '第 40 段填充文字。追加ABC' && s1.focus && Math.abs(s1.y - v0.caretY) <= 40, JSON.stringify({ v0, s1 }))
    await modeTo(p, 'wysiwyg')
    const v2 = await viewState(p)
    const same = await p.evaluate((s) => document.querySelector(s).__stag === 'S0', PM)
    await p.keyboard.press('Meta+z')
    await wait(1300)
    const undone = { screen: await para40(p), disk: (await disk(p)).includes('追加ABC') }
    record('S2 源码 → 可视:没重建、光标回原处、滚动回原位,切换前打的字 Cmd+Z 撤得掉',
      same && v2.pmPara === '第 40 段填充文字。追加ABC' && v2.pmOff === v2.pmPara.length && Math.abs(v2.scroll - v0.scroll) <= 40 && v2.active === 'DIV' &&
        undone.screen === '第 40 段填充文字。' && !undone.disk, JSON.stringify({ v0, v2, same, undone }))
    await p.close()
  }
  {
    const p = await openLong(browser)
    await p.keyboard.type('可视打')
    await wait(1300)
    await modeTo(p, 'source')
    await p.keyboard.type('SRC') // 焦点已在 textarea、光标在「可视打」之后
    await wait(1300)
    await modeTo(p, 'wysiwyg')
    const a0 = await para40(p)
    await p.keyboard.press('Meta+z')
    await wait(200)
    const a1 = await para40(p)
    await p.keyboard.press('Meta+z')
    await wait(1300)
    const a2 = await para40(p)
    const d = await disk(p)
    record('S3 源码里的改动回可视后是一步可撤的编辑:第一下只撤源码里打的,第二下撤可视里打的',
      a0 === '第 40 段填充文字。可视打SRC' && a1 === '第 40 段填充文字。可视打' && a2 === '第 40 段填充文字。' && d.includes('第 40 段填充文字。\n'), JSON.stringify({ a0, a1, a2 }))
    await p.close()
  }
  {
    const p = await openLong(browser)
    await p.keyboard.type('QQ')
    await p.evaluate(() => window.__upage.setEditorMode('source')) // 不等防抖,当拍就切
    await p.waitForSelector('textarea.amx-source')
    await wait(300)
    const ta = await p.evaluate(() => document.querySelector('textarea.amx-source').value.includes('第 40 段填充文字。QQ'))
    await modeTo(p, 'wysiwyg')
    await wait(1200)
    record('S4 切换前 200ms 内打的字不丢:textarea 里有、回可视后盘上也有', ta && (await disk(p)).includes('第 40 段填充文字。QQ') && (await para40(p)) === '第 40 段填充文字。QQ', JSON.stringify({ ta }))
    await p.close()
  }
  {
    const p = await open(browser, '# 标题\n\n第一段。\n\n第二段。\n')
    await modeTo(p, 'source')
    await p.evaluate(() => window.__upage.fire('Unified.md', '# 标题\n\n第一段 外部改的。\n\n第二段。\n'))
    await wait(1200)
    const ta = await p.evaluate(() => document.querySelector('textarea.amx-source').value)
    await modeTo(p, 'wysiwyg')
    await wait(900)
    const txt = await p.evaluate((s) => document.querySelector(s).innerText, PM)
    record('S5 源码模式里外部改动照常回灌到 textarea,回可视后编辑器是新内容、零写盘零冲突副本',
      ta.includes('第一段 外部改的。') && txt.includes('第一段 外部改的。') && (await copies(p)).length === 0 && (await p.evaluate(() => window.__upage.writes.length)) === 0,
      JSON.stringify({ ta, txt }))
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

async function groupEC(browser) {
  const p = await open(browser, '# heading\n\nbody para\n')
  await p.evaluate(() => {
    window.__ecToasts = []
    window.addEventListener('amadeus:toast', (e) => window.__ecToasts.push({ text: e.detail.text, level: e.detail.level }))
    const o = window.amadeus.renamePageFile
    // 改名 IPC 300ms;搬完之后、本实例补写之前,别的窗口改了新路径
    window.amadeus.renamePageFile = (path, n) => new Promise((r) => setTimeout(r, 300)).then(() => o(path, n)).then((np) => {
      window.__upage.vault.set(np, window.__upage.vault.get(np) + '\n别处改的一行\n')
      return np
    })
  })
  const title = await p.$('.amx-title-input')
  await title.click()
  await p.keyboard.press('Meta+a')
  await p.keyboard.type('Meeting')
  await p.keyboard.press('Enter')
  await wait(60)
  await p.keyboard.type('IPCWIN', { delay: 20 }) // 改名 IPC 窗口里打的字
  await wait(2000)
  const d = await disk(p, 'Meeting.md')
  const cs = await p.evaluate(() => [...window.__upage.vault.entries()].filter(([k]) => /\(conflict /.test(k)))
  const t = await p.evaluate(() => window.__ecToasts.filter((x) => x.level === 'error').map((x) => x.text))
  record('EC 改名后补写带 CAS:新路径被别处改过 → 不覆盖(别处那行还在),改名期间打的字进了冲突副本、提示点名副本;旧名不复活',
    d != null && d.includes('别处改的一行') && cs.length === 1 && cs[0][1].includes('IPCWIN') && t.some((x) => x.includes(cs[0][0].replace(/\.md$/, ''))) &&
      (await disk(p, 'Unified.md')) == null,
    JSON.stringify({ d, cs, t }))
  await p.close()
}

const GROUPS = { K: groupK, D: groupD, F: groupF, R: async (b) => { await groupR(b); await groupR2(b) }, E: async (b) => { await groupE(b); await groupEC(b) }, X: async (b) => { await groupX(b); await groupXFault(b) }, M: groupM, S: groupS }

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
