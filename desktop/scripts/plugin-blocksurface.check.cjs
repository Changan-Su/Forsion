// 插件块表面(ctx.app 的页面 API)在**真 v4 统一编辑器**上的仪器。
// 单测(blockSurface.test.ts)拿假 store 钉的是派生逻辑;这里钉的是纸面推不出来的三件:
//   ① UnifiedPage 真的把 bodyNow/insertMarkdown 接上了(接缝挂错地方单测一律绿);
//   ② insertMarkdown('start') 在**首块是画布卡**的文档上照样落在卡之前,且不被 canvasIntegrityGuard
//      整笔拒掉(卡片文档是 v4 的常态,不是边角料);
//   ③ 落盘节拍:插完 ≤1.2s 内 getPage().text 跟上(v4 正文是「上次保存那一刻」的快照)。
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
    text: () => ctx.app.getActivePageText(),
    path: () => ctx.app.getActivePage(),
    seen: [],
    off: ctx.app.subscribePage((pg) => window.__bs.seen.push(pg.text)),
  }
`

async function open(browser, seed) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
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

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n块表面 v4:${results.length - failed}/${results.length} 通过${NC ? `(负对照 BS_NC=${NC})` : ''}`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
