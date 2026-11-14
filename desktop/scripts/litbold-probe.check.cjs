// Gate 3/4 probes on the real harness page (switch on): copy, paste, source toggle, external change, IME next to bold.
// PROBE inline-literal-bold. Usage: start vite on a free port, then
//   HARNESS_URL=http://localhost:<port>/harness.html node scripts/litbold-probe.check.cjs [<extra query, default &litbold=1>]
const path = require('path'), fs = require('fs'), os = require('os')
const GEN = process.env.GENESIS_DESKTOP || path.resolve(__dirname, '..')
const { chromium } = require(path.join(GEN, 'node_modules/playwright-core'))
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
let exe
for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse())
  for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
    const p = path.join(cache, d, 'chrome-mac-arm64', app); if (!exe && fs.existsSync(p)) exe = p
  }
const Q = process.argv[2] ?? '&litbold=1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PM = '.unified-body .ProseMirror'
const out = {}
async function open(b, md) {
  const p = await b.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 860 } })
  p.on('pageerror', (e) => (out.pageErrors = out.pageErrors || []).push(e.message))
  await p.goto(`${process.env.HARNESS_URL || 'http://localhost:5315/harness.html'}?upage${Q}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 300000 })
  await p.waitForSelector(PM, { timeout: 300000 })
  await sleep(600)
  return p
}
const st = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  return { md: window.__upage.probe.serializeNow(), doc: v.state.doc.textBetween(0, v.state.doc.content.size, '⏎', '￼'), visible: v.dom.innerText, bold: [...v.dom.querySelectorAll('.amx-lit-bold,strong')].map((e) => e.tagName + ':' + e.textContent) }
})
const caret = (p, k, after = true) => p.evaluate(([k, after]) => {
  const v = window.__upage.probe.view(), s = v.state, TS = s.selection.constructor.atStart(s.doc).constructor
  let hit = null
  s.doc.descendants((n, pos) => { if (hit || !n.isTextblock) return !hit; const i = n.textContent.indexOf(k); if (i >= 0) hit = pos + 1 + i + (after ? k.length : 0); return false })
  v.focus(); v.dispatch(s.tr.setSelection(TS.create(s.doc, hit))); return hit
}, [k, after])
const selectRange = (p, a, b) => p.evaluate(([a, b]) => {
  const v = window.__upage.probe.view(), s = v.state, TS = s.selection.constructor.atStart(s.doc).constructor
  const find = (k) => { let hit = null; s.doc.descendants((n, pos) => { if (hit || !n.isTextblock) return !hit; const i = n.textContent.indexOf(k); if (i >= 0) hit = pos + 1 + i; return false }); return hit }
  const x = find(a), y = find(b) + b.length
  v.focus(); v.dispatch(s.tr.setSelection(TS.create(s.doc, x, y)))
}, [a, b])
const copy = (p) => p.evaluate(() => {
  const t = document.activeElement || document.body, dt = new DataTransfer()
  const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(ev)
  const data = {}; for (const k of dt.types) data[k] = dt.getData(k); return { handled: ev.defaultPrevented, data }
})
const paste = (p, data) => p.evaluate((data) => {
  const t = document.activeElement || document.body, dt = new DataTransfer()
  for (const [k, v] of Object.entries(data)) dt.setData(k, v)
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(ev); return ev.defaultPrevented
}, data)
;(async () => {
  const b = await chromium.launch({ executablePath: exe, headless: true })
  const SEED = 'plain **bold** tail\n\nnext\n'
  // copy
  let p = await open(b, SEED)
  await selectRange(p, 'plain', 'tail')
  out.copyParagraph = await copy(p)
  await selectRange(p, 'bold', 'bold')
  out.copyInnerBold = await copy(p)
  // paste HTML bold + our own clipboard
  await caret(p, 'next')
  out.pasteHtmlHandled = await paste(p, { 'text/html': '<p> x <b>y</b> z</p>', 'text/plain': ' x y z' })
  await sleep(300)
  out.afterPasteHtml = await st(p)
  await caret(p, 'next')
  await paste(p, out.copyParagraph.data)
  await sleep(300)
  out.afterPasteOwn = await st(p)
  await p.close()
  // source toggle
  p = await open(b, SEED)
  await caret(p, 'next')
  out.before = await st(p)
  await p.evaluate(() => window.__upage.setEditorMode('source'))
  await sleep(1200)
  out.sourceText = await p.evaluate(() => { const t = document.querySelector('textarea.amx-source'); return t ? t.value : null })
  await p.evaluate(() => window.__upage.setEditorMode('wysiwyg'))
  await sleep(1500)
  await p.waitForSelector(PM)
  await caret(p, 'next')
  await sleep(300)
  out.afterSourceRoundTrip = await st(p)
  // external change
  await p.evaluate(() => window.__upage.fire('Unified.md', 'plain **bold** tail changed\n\nnext __two__\n'))
  await sleep(2000)
  await caret(p, 'next')
  await sleep(300)
  out.afterExternal = await st(p)
  await p.close()
  // typing by hand: `**cd**` must stay text (input rule off), and a line-start `* ` with the star auto-pair
  p = await open(b, 'x\n')
  await caret(p, 'x')
  await p.keyboard.type(' ab **cd** ef', { delay: 30 }); await sleep(300)
  out.typedBold = await st(p)
  await p.keyboard.press('Enter'); await p.keyboard.type('* item', { delay: 30 }); await sleep(300)
  out.typedBullet = await st(p)
  await p.close()
  // IME adjacent to the bold, left and right (and inside, with visible text sampled during composition)
  p = await open(b, SEED)
  const cdp = await p.context().newCDPSession(p)
  const ime = async (steps, commit) => {
    const seen = []
    for (const t of steps) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(90); seen.push(await p.evaluate(() => window.__upage.probe.view().dom.innerText.split('\n')[0])) }
    await cdp.send('Input.insertText', { text: commit }); await sleep(200)
    return seen
  }
  await caret(p, 'plain ')
  out.imeLeftSeen = await ime(['z', 'zh', 'zhong'], '中')
  out.imeLeft = await st(p)
  await caret(p, 'bold**')
  out.imeRightSeen = await ime(['w', 'wen'], '文')
  out.imeRight = await st(p)
  await caret(p, 'bo')
  out.imeInsideSeen = await ime(['z', 'zi'], '字')
  out.imeInside = await st(p)
  await caret(p, 'next')
  await sleep(200)
  out.imeFinal = await st(p)
  await p.close()
  await b.close()
  console.log(JSON.stringify(out, null, 1))
})().catch((e) => { console.error(e); console.log(JSON.stringify(out, null, 1)); process.exit(1) })
