// Record body × IME composition: node scripts/e2e-editor.cjs --check=db-record-ime (npm run check:dbrecordime)
// The record peek body (PlainMarkdownEditor immediate) hands every document transaction to the database
// store synchronously. An IME pause mid-composition must not put the uncommitted romanization into the
// store or onto disk; the committed text must follow promptly, earlier text must survive, and closing the
// record mid-composition must not lose what is on screen. CDP composition approximates a real IME.
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
function chromiumPath() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter(x => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app); if (fs.existsSync(p)) return p
    }
  throw Error('Chromium missing; set CHROMIUM_EXE')
}
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const DB = '任务.db'
// OBSERVE=1: log failures instead of stopping, so every phase runs (used to record the unfixed baseline).
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) return console.log(`PASS ${name}`)
  const msg = `${name}${detail ? ` — ${detail}` : ''}`
  if (!process.env.OBSERVE) throw Error(msg)
  failed++; console.log(`FAIL ${msg}`)
}
const PINYIN = 'zhongwen'

async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } })
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  try {
    await p.goto(`${URL}?dbdemo`, { waitUntil: 'domcontentloaded' }); await p.waitForSelector('[data-db-cell]')
    // In-memory disk: every writeDatabase lands here with a timestamp.
    await p.evaluate((db) => {
      const w = window
      w.__disk = []
      Object.assign(w.amadeus ?? (w.amadeus = {}), {
        writeDatabase: (path, data) => { w.__disk.push({ at: performance.now(), path, text: JSON.stringify(data) }); return Promise.resolve() },
      })
      w.__dbStore.getState().mutate(db, d => ({ ...d,
        columns: [{ id: 'name', name: '名称', type: 'text' }],
        rows: ['a', 'b', 'c'].map(id => ({ id, cells: { name: id.toUpperCase() }, body: '' })),
        views: [{ id: 'v1', name: '表格', type: 'table' }],
      }))
      // Every body value the store ever holds (a poll would miss a value overwritten within milliseconds).
      w.__bodies = []
      let prev = {}
      w.__dbStore.subscribe(s => {
        for (const r of s.entries[db]?.data?.rows ?? []) {
          if (prev[r.id] !== r.body) { prev[r.id] = r.body; w.__bodies.push({ at: performance.now(), row: r.id, body: r.body }) }
        }
      })
    }, DB)
    const everStored = (row, needle) => p.evaluate(({ row, needle }) => window.__bodies.some(b => b.row === row && (b.body ?? '').includes(needle)), { row, needle })
    const sample = (row) => p.evaluate(({ db, row }) => {
      const w = window
      const store = w.__dbStore.getState().entries[db].data.rows.find(r => r.id === row)?.body ?? ''
      const last = w.__disk.filter(x => x.path === db).pop()
      const disk = last ? (JSON.parse(last.text).rows.find(r => r.id === row)?.body ?? '') : null
      const everPinyin = w.__disk.some(x => x.path === db && x.text.includes('zhongwen'))
      return { t: Math.round(performance.now()), store, disk, writes: w.__disk.length, everPinyin }
    }, { db: DB, row })
    const fmt = (s, t0) => `+${String(s.t - t0).padStart(5)}ms store=${JSON.stringify(s.store)} disk=${JSON.stringify(s.disk)} writes=${s.writes}`
    const openPeek = async (row) => {
      const c = p.locator(`[data-row="${row}"] [data-db-cell="name"]`)
      await c.hover(); await c.locator('.amx-db-rowopen').click(); await p.waitForSelector('.amx-db-peek-body .ProseMirror')
      const pm = p.locator('.amx-db-peek-body .ProseMirror')
      await pm.click()
      return pm
    }
    const cdp = await p.context().newCDPSession(p)

    // ── 1. Type, then hold an IME composition for 3.5 s, sampling store + disk ──
    await openPeek('a')
    await p.keyboard.type('前')
    await p.waitForFunction((db) => window.__disk.some(x => x.path === db && x.text.includes('前')), DB, { timeout: 5000 })
    const t0 = (await sample('a')).t
    const timeline = []
    let sawPinyinStore = false, sawPinyinDisk = false
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await p.waitForTimeout(200)
    await cdp.send('Input.imeSetComposition', { text: PINYIN, selectionStart: 8, selectionEnd: 8 })
    for (let i = 0; i < 9; i++) {
      await p.waitForTimeout(400)
      const s = await sample('a'); timeline.push(fmt(s, t0))
      if (s.store.includes(PINYIN) || s.store.includes('zhong')) sawPinyinStore = true
      if (s.everPinyin || (s.disk ?? '').includes('zhong')) sawPinyinDisk = true
    }
    const onScreen = await p.locator('.amx-db-peek-body .ProseMirror').innerText()
    timeline.push(`  (editor DOM during composition: ${JSON.stringify(onScreen)})`)
    await cdp.send('Input.insertText', { text: '中文' })
    timeline.push('  -- commit 中文 --')
    const committed = await p.waitForFunction((db) => window.__disk.some(x => x.path === db && x.text.includes('前中文')), DB, { timeout: 10000 }).then(() => true, () => false)
    const after = await sample('a'); timeline.push(fmt(after, t0))
    console.log('Timeline (composition hold):\n' + timeline.join('\n'))
    check('Composition hold keeps romanization out of the store', !sawPinyinStore && !await everStored('a', 'zhong'))
    check('Composition hold keeps romanization off disk', !sawPinyinDisk && !after.everPinyin)
    check('Committed text reaches store with earlier text', after.store.includes('前中文') && !after.store.includes('zhong'), JSON.stringify(after.store))
    check('Committed text reaches disk', committed, JSON.stringify(after.disk))

    // ── 1b. A commit identical to the composition string leaves the document unchanged: still sent ──
    await cdp.send('Input.imeSetComposition', { text: 'ok', selectionStart: 2, selectionEnd: 2 })
    await p.waitForTimeout(700)
    check('Held composition string stays out of the store', !await everStored('a', '中文ok'))
    await cdp.send('Input.insertText', { text: 'ok' })
    check('Commit equal to the composition string still reaches the store and disk',
      await p.waitForFunction((db) => window.__disk.some(x => x.path === db && x.text.includes('前中文ok')), DB, { timeout: 10000 }).then(() => true, () => false),
      JSON.stringify(await sample('a')))

    // ── 2. Close the record while composing (no blur first): on-screen text must not be lost ──
    const closeMidComposition = async (row, typed, pinyin, realClick) => {
      await p.getByRole('button', { name: '关闭记录', exact: true }).click()
      await p.waitForSelector('.amx-db-peek', { state: 'detached' })
      await openPeek(row)
      await p.keyboard.type(typed)
      await p.waitForFunction(({ db, row, typed }) => window.__dbStore.getState().entries[db].data.rows.find(r => r.id === row).body.includes(typed), { db: DB, row, typed }, { timeout: 5000 })
      await cdp.send('Input.imeSetComposition', { text: pinyin, selectionStart: pinyin.length, selectionEnd: pinyin.length })
      await p.waitForTimeout(300)
      if (realClick) await p.getByRole('button', { name: '关闭记录', exact: true }).click() // blurs the editor first
      else await p.evaluate(() => document.querySelector('.amx-db-peek button[aria-label="关闭记录"]')?.click() ?? [...document.querySelectorAll('.amx-db-peek button')].find(b => b.textContent === '关闭记录' || b.title === '关闭记录')?.click())
      await p.waitForSelector('.amx-db-peek', { state: 'detached' })
      await p.waitForFunction(({ db, row, typed }) => {
        const last = window.__disk.filter(x => x.path === db).pop()
        return !!last && (JSON.parse(last.text).rows.find(r => r.id === row)?.body ?? '').includes(typed)
      }, { db: DB, row, typed }, { timeout: 10000 }).catch(() => {})
      await p.waitForTimeout(700)
      const s = await sample(row)
      console.log(`After closing mid-composition (${realClick ? 'real click' : 'programmatic click'}): ` + fmt(s, t0) + ` bodies=${JSON.stringify(await p.evaluate((row) => window.__bodies.filter(b => b.row === row).map(b => b.body), row))}`)
      return s
    }
    const b = await closeMidComposition('b', '后', 'pin', false)
    check('Programmatic close mid-composition keeps the text typed before it', b.store.includes('后') && (b.disk ?? '').includes('后'), JSON.stringify(b))
    check('Programmatic close mid-composition hands over what was on screen', b.store.includes('后pin') && (b.disk ?? '').includes('后pin'), JSON.stringify(b))
    await openPeek('a')
    const c = await closeMidComposition('c', '再', 'zai', true)
    check('Clicking close mid-composition keeps the text typed before it', c.store.includes('再') && (c.disk ?? '').includes('再'), JSON.stringify(c))
    check('Clicking close mid-composition keeps what was on screen', c.store.includes('再zai') && (c.disk ?? '').includes('再zai'), JSON.stringify(c))
    check(`No runtime errors (${errors.join('; ')})`, errors.length === 0)
    if (failed) throw Error(`${failed} check(s) failed`)
  } finally { await browser.close() }
}
main().catch(e => { console.error(e.stack || e); process.exit(1) })
