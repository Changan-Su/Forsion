// 插件块表面(ctx.app 的页面 API)在**真 v4 统一编辑器**上的仪器。
// 单测(blockSurface.test.ts)拿假 store 钉的是派生逻辑;这里钉的是纸面推不出来的三件:
//   ① UnifiedPage 真的把 bodyNow/insertMarkdown 接上了(接缝挂错地方单测一律绿);
//   ② insertMarkdown('start') 在**首块是画布卡**的文档上照样落在卡之前,且不被 canvasIntegrityGuard
//      整笔拒掉(卡片文档是 v4 的常态,不是边角料);
//   ③ 落盘节拍:插完 ≤1.2s 内 getPage().text 跟上(v4 正文是「上次保存那一刻」的快照)。
//   ④ insertMarkdownAt(2026-11-16):'caret' 插在行内光标处;cursorMarker 落光标、一步撤销、标记(和占位字)从不落盘;
//      阅读模式 / 锁定页报 'read-only' 且一个字都不进;旧令牌报 'stale-token'(T9–T15)。
// 探针插件走真 setup 路径(new Function('ctx', code)),与外置插件同一条 —— 把 ctx.app 挂到
// window.__bs 上,后面全部断言都从插件视角发问。
//
// 用法:node scripts/e2e-editor.cjs --check=plugin-blocksurface  ｜  npm run check:bsurface
// 负对照:`BS_NC=token npm run check:bsurface` —— 不切 activeNotePath(模拟 08-20 之前
//        「v4 全程 activePage=null → 令牌恒等」)→ T4 必须变红。全绿说明这条断言没测到令牌。
//        ⚠️ 走**环境变量**不走 argv:e2e-editor.cjs 是 `spawn('node',[script])`,多余的命令行
//        参数根本传不进来(第一版写成 --nc= 时负对照静默不生效,照样报 8/8)。
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
const NC = process.env.BS_NC || ''

// 首块就是画布卡(闭合锚 2026-08-19 之后卡前后的顶层正文都合法 —— 'start' 必须落在卡**之前**)。
const CARD_SEED = [
  '---',
  'amadeus_schema: amadeus.page/4',
  'amadeus_canvas: {"v":1,"mode":"document","cards":[{"ref":"k1","x":700,"y":40,"w":300}]}',
  '---',
  '',
  '<!-- a k1 -->',
  '卡片正文。',
  '',
  '尾段。',
  '',
].join('\n')

const results = []
function check(name, ok, detail) {
  // ⚠️ 必须 `!!ok`:`a && a.b === x` 中途遇 null 会短路成 null,按 `=== false` 统计就漏掉了。
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 探针插件:把 ctx.app 摊到 window.__bs(裸 setup 体,顶层不许有 import/export)。 */
const PROBE = `
  window.__bs = {
    page: () => ctx.app.getPage(),
    insert: (md, where) => ctx.app.insertMarkdown(ctx.app.getPage().token, md, where),
    insertStale: (tok, md) => ctx.app.insertMarkdown(tok, md, 'start'),
    block: () => ctx.app.insertBlockAfter(ctx.app.getPage().token, null, '块口'),
    at: (md, opts) => ctx.app.insertMarkdownAt(ctx.app.getPage().token, md, opts),
    atStale: (tok, md) => ctx.app.insertMarkdownAt(tok, md, { where: 'end' }),
    text: () => ctx.app.getActivePageText(),
    path: () => ctx.app.getActivePage(),
    seen: [],
    off: ctx.app.subscribePage((pg) => window.__bs.seen.push(pg.text)),
  }
`

async function open(browser, seed, extra = '') {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane${extra}&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(500)
  await p.evaluate((code) => window.__ep.loadPlugin(code, { id: 'bsprobe' }), PROBE)
  await p.waitForTimeout(300)
  return p
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── T1-T3:v4 快照的形状(插件视角) ─────────────────────────────────────────────
  const p = await open(browser, '# 外来标题\n\n第一段。\n\n第二段。\n')
  const snap = await p.evaluate(() => {
    const pg = window.__bs.page()
    return { model: pg.model, path: pg.path, status: pg.status, text: pg.text, blocks: Object.keys(pg.blocks).length, order: pg.order.length, token: pg.token }
  })
  check('T1 v4 笔记自报 model:text,路径/状态是真的', snap.model === 'text' && snap.path === 'Unified.md' && snap.status === 'ready', JSON.stringify({ model: snap.model, path: snap.path, status: snap.status }))
  check('T2 正文拿得到,块表恒空(不给 v4 合成块 id)', snap.text.includes('外来标题') && snap.text.includes('第二段') && snap.blocks === 0 && snap.order === 0, JSON.stringify({ len: snap.text.length, blocks: snap.blocks, order: snap.order }))
  const legacy = await p.evaluate(() => ({ text: window.__bs.text(), path: window.__bs.path(), block: window.__bs.block() }))
  check('T3 老接口同源:getActivePageText/Page 不再恒空;块口诚实返回 null', legacy.text === snap.text && legacy.path === 'Unified.md' && legacy.block === null, JSON.stringify({ same: legacy.text === snap.text, path: legacy.path, block: legacy.block }))

  // ── T4:跨笔记令牌(P0)。换 activeNotePath = 换了一篇,旧令牌必须被拒。 ────────────
  const tok = await p.evaluate(() => window.__bs.page().token)
  if (NC !== 'token') await p.evaluate(() => window.__pageStore.getState().setActiveNotePath('别的.md'))
  await p.waitForTimeout(120)
  const cross = await p.evaluate((t) => ({ token: window.__bs.page().token, accepted: window.__bs.insertStale(t, '不该进来的引用') }), tok)
  check('T4 ⚠️P0 换笔记 → 令牌变;拿旧令牌提交被拒', cross.token !== tok && cross.accepted === false, JSON.stringify(cross))
  await p.evaluate(() => window.__pageStore.getState().setActiveNotePath('Unified.md'))
  await p.waitForTimeout(120)
  await p.close()

  // ── T5-T7:写口落在真文档里(首块是画布卡的文档) ────────────────────────────────
  const c = await open(browser, CARD_SEED)
  const before = await c.evaluate(() => window.__bs.page().text)
  const okStart = await c.evaluate(() => window.__bs.insert('> 插件插进来的引用', 'start'))
  await c.waitForTimeout(1200) // 防抖 800ms + 余量
  const after = await c.evaluate(() => ({
    text: window.__bs.page().text,
    disk: (window.__upage.writes[window.__upage.writes.length - 1] || {}).text || '',
    seen: window.__bs.seen.length,
  }))
  const iIns = after.disk.indexOf('插件插进来的引用')
  const iCard = after.disk.indexOf('<!-- a k1 -->')
  check('T5 insertMarkdown(start) 真落进文档并写盘', okStart === true && iIns >= 0, JSON.stringify({ ok: okStart, at: iIns }))
  check('T6 首块是画布卡时落在卡**之前**,且卡没被吞(filterTransaction 没拒整笔)', iIns >= 0 && iCard > iIns && after.disk.includes('卡片正文'), JSON.stringify({ ins: iIns, card: iCard }))
  check('T7 落盘后 ≤1.2s 内 page.text 跟上,且订阅收到通知', after.text.includes('插件插进来的引用') && !before.includes('插件插进来的引用') && after.seen > 0, JSON.stringify({ seen: after.seen }))

  // T8:'end' 档落在文末,且不抢焦点/不动选区(插件按钮不该把光标从用户手里夺走)。
  await c.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    const p1 = pm.querySelector(':scope > p')
    const r = document.createRange()
    r.selectNodeContents(p1)
    r.collapse(true)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
    pm.focus()
    window.__bs.anchorBefore = sel.anchorNode?.textContent || ''
  })
  await c.evaluate(() => window.__bs.insert('尾巴段落', 'end'))
  await c.waitForTimeout(1200)
  const tail = await c.evaluate(() => ({
    disk: (window.__upage.writes[window.__upage.writes.length - 1] || {}).text || '',
    anchorNow: getSelection().anchorNode?.textContent || '',
    anchorBefore: window.__bs.anchorBefore,
  }))
  const iTail = tail.disk.indexOf('尾巴段落')
  check('T8 end 档落在文末,且没把光标从用户手里夺走', iTail > tail.disk.indexOf('尾段') && tail.anchorNow === tail.anchorBefore, JSON.stringify({ at: iTail, caretKept: tail.anchorNow === tail.anchorBefore }))
  await c.close()

  // ── T9–T15:insertMarkdownAt(行内光标处 / 落光标 / 一步撤销 / 拒绝原因) ────────────────────
  const a = await open(browser, '# 标题\n\nHello world\n\n另一段。\n')
  /** 把光标放在含 `text` 的那个文字节点的第 `offset` 个字处(走 DOM 选区,与用户点进去同一条路),等 PM 认下。 */
  const caretAt = async (text, offset) => {
    await a.evaluate(({ text, offset }) => {
      const pm = document.querySelector('.unified-body .ProseMirror')
      const w = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
      let n
      while ((n = w.nextNode()) && !n.textContent.includes(text));
      const r = document.createRange()
      r.setStart(n, n.textContent.indexOf(text) + offset)
      r.collapse(true)
      pm.focus()
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
    }, { text, offset })
    await a.waitForTimeout(150)
  }
  /** PM 的光标:所在文本块的文字 + 块内偏移;另报整篇有几个段落、有没有标记 / 占位字残留。 */
  const pmState = () => a.evaluate(() => {
    const v = window.__upage.probe.view()
    const { $from } = v.state.selection
    const all = v.state.doc.textContent
    return { line: $from.parent.textContent, off: $from.parentOffset, paras: v.state.doc.childCount, all, leak: all.includes('{{c}}') || all.includes('\uFDD0') }
  })
  const disk = () => a.evaluate(() => window.__upage.vault.get('Unified.md') || '')

  await caretAt('Hello world', 5) // Hello|  world
  const before9 = await pmState()
  const r9 = await a.evaluate(() => window.__bs.at(', dear', { where: 'caret' }))
  const s9 = await pmState()
  check('T9 caret 档:单个段落插在行内光标处(不另起一段),光标落在插入内容末尾',
    r9 && r9.ok === true && s9.line === 'Hello, dear world' && s9.paras === before9.paras && s9.off === 'Hello, dear'.length,
    JSON.stringify({ r9, line: s9.line, off: s9.off, paras: [before9.paras, s9.paras] }))

  // T10:cursorMarker —— 标记里带 markdown 会吃掉的字也照样认(`$` 成公式、`{}`);落光标后接着打字就打在标记处。
  await a.waitForTimeout(700) // 与上一笔隔开撤销分组
  await caretAt('另一段。', 4)
  const r10 = await a.evaluate(() => window.__bs.at('Before $C$ after\n\nnext', { cursorMarker: '$C$' }))
  const s10 = await pmState()
  await a.keyboard.type('X')
  const s10b = await pmState()
  check('T10 cursorMarker:标记删掉、光标落在标记处,接着打字落在那里;文档里没有标记 / 占位字',
    r10 && r10.ok === true && s10.line === 'Before  after' && s10.off === 'Before '.length && s10b.line === 'Before X after' && !s10.leak,
    JSON.stringify({ r10, line: s10.line, off: s10.off, typed: s10b.line, leak: s10.leak }))

  // T11:一步撤销 —— 插入 + 删标记是同一事务:撤一次回到插入前,而不是停在「标记还在」的中间态。
  await a.waitForTimeout(700)
  await caretAt('Before X after', 14)
  const before11 = await pmState()
  const r11 = await a.evaluate(() => window.__bs.at('Mid {{c}} tail', { where: 'caret', cursorMarker: '{{c}}' }))
  const s11 = await pmState()
  await a.keyboard.press('Meta+z')
  await a.waitForTimeout(150)
  const s11b = await pmState()
  check('T11 cursorMarker + caret:光标落在标记处;撤销一次 = 回到插入前(没有标记残留的中间态)',
    r11 && r11.ok === true && s11.line === 'Before X afterMid  tail' && s11.off === 'Before X afterMid '.length && s11b.all === before11.all && !s11.leak && !s11b.leak,
    JSON.stringify({ r11, line: s11.line, off: s11.off, undone: s11b.all === before11.all }))
  await a.keyboard.press('Meta+Shift+z')
  await a.waitForTimeout(1300) // 防抖写盘
  const d11 = await disk()
  check('T12 落盘的正文里从来没有标记 / 占位字(重做后照样)', d11.includes('Before X afterMid  tail') && !d11.includes('{{c}}') && !d11.includes('$C$') && !d11.includes('\uFDD0'),
    JSON.stringify({ disk: d11.slice(0, 160) }))

  // T13:阅读模式 → read-only,一个字都不进(观察到的拒绝就发生在这里;旧接口仍只是 false)。
  await a.evaluate(() => window.__upage.probe.setReading(true))
  await a.waitForSelector('[data-reading-surface]', { timeout: 8000 }).catch(() => {})
  const w13 = await a.evaluate(() => window.__upage.writes.length)
  const r13 = await a.evaluate(() => ({
    at: window.__bs.at('不该进来', { where: 'end' }),
    caret: window.__bs.at('也不该进来', { where: 'caret', cursorMarker: '{{c}}' }),
    old: window.__bs.insert('旧接口也不该进来', 'end'),
  }))
  await a.waitForTimeout(1200)
  const s13 = await pmState()
  const w13b = await a.evaluate(() => window.__upage.writes.length)
  check('T13 阅读模式:报 read-only,内容一个字都没进、零写盘;旧 insertMarkdown 仍返回 false',
    r13.at && r13.at.ok === false && r13.at.reason === 'read-only' && r13.caret && r13.caret.reason === 'read-only' && r13.old === false && !s13.all.includes('进来') && w13b === w13,
    JSON.stringify({ r13, writes: [w13, w13b] }))
  await a.evaluate(() => window.__upage.probe.setReading(false))
  await a.waitForTimeout(300)

  // T14:旧令牌 → stale-token;解析成空 → empty。
  const tok14 = await a.evaluate(() => window.__bs.page().token)
  await a.evaluate(() => window.__pageStore.getState().setActiveNotePath('别的.md'))
  await a.waitForTimeout(120)
  const r14 = await a.evaluate((t) => window.__bs.atStale(t, '不该进来'), tok14)
  await a.evaluate(() => window.__pageStore.getState().setActiveNotePath('Unified.md'))
  await a.waitForTimeout(120)
  const e14 = await a.evaluate(() => window.__bs.at('   \n\n  ', { where: 'end' }))
  check('T14 旧令牌 → stale-token;只有空白 → empty', r14 && r14.reason === 'stale-token' && e14 && e14.reason === 'empty', JSON.stringify({ r14, e14 }))
  await a.close()

  // T15:锁定页(只读实例)同样 read-only、零写盘。
  const l = await open(browser, '第一段。\n', '&ulock')
  await l.evaluate(() => window.__upage.setLocked(true))
  await l.waitForSelector('[data-lock="on"]', { timeout: 5000 }).catch(() => {})
  await l.waitForTimeout(300)
  const w15 = await l.evaluate(() => window.__upage.writes.length)
  const r15 = await l.evaluate(() => window.__bs.at('锁着也不该进来', { where: 'end' }))
  await l.waitForTimeout(1200)
  const s15 = await l.evaluate(() => ({ text: document.querySelector('.unified-body .ProseMirror')?.textContent ?? '', writes: window.__upage.writes.length }))
  check('T15 锁定页:报 read-only,零写盘', r15 && r15.ok === false && r15.reason === 'read-only' && !s15.text.includes('锁着') && s15.writes === w15, JSON.stringify({ r15, s15, w15 }))
  await l.close()

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n块表面 v4:${results.length - failed}/${results.length} 通过${NC ? `(负对照 BS_NC=${NC})` : ''}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
