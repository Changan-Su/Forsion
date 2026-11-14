// 探针仪器:回车一次 = 文件里只多一个换行(开关见 frontend/src/amadeus/blocks/markdown/enterMode.ts)。
//
// 需要一个已经在跑的台架页(vite),开关由起 vite 时的 VITE_AMX_ENTER=inline|line 决定(不设 = off,即 main 的行为)。
//   HARNESS_URL=http://localhost:<port>/harness.html node scripts/enter-probe.check.cjs [--results=<对照台架 results.json>]
//
//  G2 保存再重开:对照台架每个快照的 Markdown M 当新笔记打开 → 不编辑取一次(逐字回填)= M;
//     再把每个顶层块换成副本(逐字层认不出 = 走纯序列化)取一次 = M,且重开结构不变(编码本身是不动点)。
//  G5 搬块:Mod+Shift+↓(与拖动 ⠿ 同一种「删 + 插顶层节点」事务)后落盘、重开,内容与结构都对;记下搬的单位。
//  G6 外部改动:没有未存改动时外部内容进来;有未存改动(含「刚回车、停在新起的空行上」)时不丢字。
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

async function open(browser, md) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 860 } })
  p.errs = []
  p.on('pageerror', (e) => p.errs.push(e.message))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await p.waitForSelector(PM, { timeout: 180000 })
  await sleep(400)
  return p
}
const mode = (p) => p.evaluate(() => import('/src/amadeus/blocks/markdown/enterMode.ts').then((m) => m.enterMode()))
const saved = (p) => p.evaluate(() => window.__upage.probe.serializeNow())
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
const caretAfter = (p, text) => p.evaluate((k) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor
  let hit = null
  st.doc.descendants((n, pos) => {
    if (hit || !n.isTextblock) return !hit
    let off = 0
    n.forEach((c, cOff) => { if (hit) return; if (c.isText) { const i = c.text.indexOf(k); if (i >= 0) hit = pos + 1 + cOff + i + k.length } off += c.nodeSize })
    return false
  })
  if (hit == null) throw new Error('锚点没找到 ' + k)
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, hit)))
}, text)

async function g2(browser, file) {
  const res = JSON.parse(fs.readFileSync(file, 'utf8'))
  const r = res.sides.forsion.results
  for (const [id, sc] of Object.entries(r)) {
    for (const n of sc.order || []) {
      const M = sc.snaps[n].md
      const p = await open(browser, M)
      const s0 = await shape(p)
      const a = await saved(p)
      const b = await plainSaved(p)
      const p2 = await open(browser, b)
      const s1 = await shape(p2)
      record(`G2 ${id}/${n} 重开不编辑 = 原文`, a === M, a === M ? '' : JSON.stringify({ M, a }))
      record(`G2 ${id}/${n} 纯序列化 = 原文、重开结构不变`, b === M && s0 === s1, b === M && s0 === s1 ? '' : JSON.stringify({ M, plain: b, s0, s1 }))
      await p.close(); await p2.close()
    }
  }
}

async function g5(browser) {
  const m = await (async () => { const p = await open(browser, 'x\n'); const v = await mode(p); await p.close(); return v })()
  const cases = [
    { name: '多行段落里的第一行下移', md: 'alpha\nbeta\n\ngamma\n', at: 'alpha' },
    { name: '标题后紧跟的正文下移', md: '## T\nbody\n\nnext\n', at: 'body' },
    { name: '隔两条空行的段落上移', md: 'one\n\n\ntwo\n', at: 'two', up: true },
  ]
  for (const c of cases) {
    const p = await open(browser, c.md)
    const before = await shape(p)
    await caretAfter(p, c.at)
    await p.keyboard.press(`${MOD}+Shift+${c.up ? 'ArrowUp' : 'ArrowDown'}`)
    await sleep(200)
    const after = await shape(p)
    const md = await saved(p)
    const p2 = await open(browser, md)
    const again = await shape(p2)
    const md2 = await saved(p2)
    record(`G5[${m}] ${c.name}`, md2 === md && again === after && !p.errs.length, JSON.stringify({ seed: c.md, before, after, saved: md, reopened: again }))
    await p.close(); await p2.close()
  }
}

async function g6(browser) {
  const disk = (p) => p.evaluate(() => window.__upage.vault.get('Unified.md') ?? null)
  const fire = (p, t) => p.evaluate((t) => window.__upage.fire('Unified.md', t), t)
  // a) 没有未存改动:外部内容进来
  {
    const seed = 'one\ntwo\n\nthree\n'
    const p = await open(browser, seed)
    const ext = 'one\ntwo EXT\n\nthree\n'
    await fire(p, ext)
    await sleep(800)
    const md = await saved(p)
    record('G6a 没有未存改动 → 外部内容进来', md === ext && (await disk(p)) === ext, JSON.stringify({ md, disk: await disk(p) }))
    await p.close()
  }
  // b) 打了字还没落盘(防抖窗内)→ 外部改了另一段
  {
    const seed = 'one\ntwo\n\nthree\n'
    const p = await open(browser, seed)
    await caretAfter(p, 'two')
    await p.keyboard.type('X')
    await fire(p, 'one\ntwo\n\nthree EXT\n')
    await sleep(1500)
    const md = await saved(p), d = await disk(p)
    record('G6b 未存的字 + 外部改另一段 → 两边都在', md.includes('twoX') && md.includes('three EXT') && d === md, JSON.stringify({ md, disk: d }))
    await p.close()
  }
  // c) 刚回车、停在新起的空行上(路线一 = 段末软换行;路线二 / off = 新空段)→ 外部改另一段 → 接着打字
  {
    const seed = 'one\ntwo\n\nthree\n'
    const p = await open(browser, seed)
    await caretAfter(p, 'two')
    await p.keyboard.press('Enter')
    await sleep(60)
    const mid = await saved(p)
    await fire(p, 'one\ntwo\n\nthree EXT\n')
    await sleep(1500)
    await p.keyboard.type('Y')
    await sleep(800)
    const md = await saved(p), d = await disk(p)
    record('G6c 回车停在空行 + 外部改另一段 → 接着打的字落在新行、外部改动在', /two\nY/.test(md) && md.includes('three EXT') && d === md, JSON.stringify({ afterEnter: mid, md, disk: d }))
    await p.close()
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const only = (arg('only') || 'g2,g5,g6').split(',')
    const file = arg('results')
    if (only.includes('g2') && file) await g2(browser, file)
    if (only.includes('g5')) await g5(browser)
    if (only.includes('g6')) await g6(browser)
  } finally { await browser.close() }
  console.log(`\n${pass} 过 / ${fail} 没过`)
  const o = arg('out'); if (o) fs.writeFileSync(o, out.join('\n') + `\n${pass} 过 / ${fail} 没过\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
