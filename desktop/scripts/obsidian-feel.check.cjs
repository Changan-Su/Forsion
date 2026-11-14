// 和 Obsidian 的手感对照(check:obsfeel):同一串真按键在 v4 统一编辑器(台架 `?upage` = 生产 UnifiedPage 全链)上重放,
// 每个快照之后的 Markdown 和录好的 Obsidian 1.15.1 基线逐字节比,再按名单判红绿。说明、基线来历、名单三种状态:
// scripts/obsidian-feel/README.md。
//
// 判定(名单 scripts/obsidian-feel/status.json,每个场景的每个比较项一条):
//   same     名单记「相同」,现在不同了                    → 红(回归)
//   pending  名单记「待对齐」/ keep「刻意保留」,现在相同了 → 红,提示 --update(每次对齐都要落到名单上)
//   差异类型 只差文末换行个数(eol)和内容不同(content)分开记;类型变了也红,提示 --update
// 「重开稳定」:每个场景跑完,把编辑器给出的 Markdown 当一篇新笔记的内容打开,不编辑直接再取一次,两次必须逐字节相同;
//   结果记在名单的 reopen 字段,规则同上。
//
// 用法:npm run check:obsfeel(由 e2e-editor 自起 / 复用 Vite;worktree 里设 HARNESS_URL 指到自己的端口)
//   --only=K01,R,F12   只跑这些场景(单个大写字母 = 这一组全部)
//   --update           按这次的结果重写名单(带 --only 时只动这些场景;已有的「刻意保留」和理由留着)
//   --dump=<文件>      把这次 Forsion 一侧的结果写成 JSON(排查用)
// 跑一遍全套要几分钟,不进 PR 的 CI。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const DIR = path.join(__dirname, 'obsidian-feel')
const STATUS_FILE = path.join(DIR, 'status.json')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : '' }
const ONLY = arg('only').split(',').filter(Boolean)
const UPDATE = process.argv.includes('--update')
const DUMP = arg('dump')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const PM = '.unified-body .ProseMirror'

const BASE = JSON.parse(fs.readFileSync(path.join(DIR, 'baseline.json'), 'utf8'))
const SCENARIOS = require('./obsidian-feel/scenarios.cjs')
  .filter((s) => s.dim !== 'perf')
  .filter((s) => !ONLY.length || ONLY.some((o) => s.id === o || (/^[A-Z]$/.test(o) && s.id.startsWith(o))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = (k) => k.replace(/\bMod\b/g, MOD)

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

// ── 页面内的小函数 ───────────────────────────────────────────
const rectOfText = ([rootSel, text]) => {
  const root = document.querySelector(rootSel); if (!root) return null
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n
  while ((n = w.nextNode())) {
    const i = n.data.indexOf(text); if (i < 0) continue
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length)
    const b = r.getBoundingClientRect(); if (b.width > 0) return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  return null
}
const clipEvent = (type) => {
  const t = document.activeElement || document.body, dt = new DataTransfer()
  const ev = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(ev)
  const data = {}; for (const k of dt.types) data[k] = dt.getData(k)
  return { handled: ev.defaultPrevented, data }
}
const doPaste = (data) => {
  const t = document.activeElement || document.body, dt = new DataTransfer()
  for (const [k, v] of Object.entries(data)) dt.setData(k, v)
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); t.dispatchEvent(ev)
  return { handled: ev.defaultPrevented }
}
const caretTo = (spec) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  const find = (k, nth = 0) => {
    let hit = null, c = 0
    st.doc.descendants((node, pos) => {
      if (hit) return false
      if (!node.isTextblock) return true
      const text = node.textBetween(0, node.content.size, '', '￼'); let from = 0
      for (;;) { const i = text.indexOf(k, from); if (i < 0) break; if (c++ === nth) { hit = { start: pos + 1 + i, end: pos + 1 + i + k.length }; break } from = i + 1 }
      return false
    })
    return hit
  }
  let sel
  if (spec.end) sel = st.selection.constructor.atEnd(st.doc)
  else if (spec.start) sel = st.selection.constructor.atStart(st.doc)
  else { const k = spec.after ?? spec.before, hit = find(k, spec.nth || 0); if (!hit) throw new Error('锚点没找到: ' + k); sel = TS.create(st.doc, spec.after != null ? hit.end : hit.start) }
  v.focus(); v.dispatch(st.tr.setSelection(sel).scrollIntoView()); return sel.head
}
const selectText = (spec) => {
  const v = window.__upage.probe.view(), st = v.state, TS = st.selection.constructor.atStart(st.doc).constructor
  const find = (k) => {
    let hit = null
    st.doc.descendants((node, pos) => {
      if (hit) return false
      if (!node.isTextblock) return true
      const i = node.textBetween(0, node.content.size, '', '￼').indexOf(k); if (i >= 0) hit = { start: pos + 1 + i, end: pos + 1 + i + k.length }
      return false
    })
    return hit
  }
  const a = find(spec.text ?? spec.from), h = find(spec.text ?? spec.to); if (!a || !h) throw new Error('锚点没找到')
  v.focus(); v.dispatch(st.tr.setSelection(TS.create(st.doc, a.start, h.end)).scrollIntoView())
}
const serialize = () => { const md = window.__upage.probe.serializeNow(); if (typeof md !== 'string') throw new Error('serializeNow 没给出文本'); return md }

// ── 跑一个场景 ───────────────────────────────────────────────
async function runScenario(browser, s) {
  const res = { snaps: {}, traces: {}, clips: {}, pageErrors: [], reopen: null }
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 860 } })
  let loaded = false, reloaded = false
  page.on('pageerror', (e) => res.pageErrors.push(e.message.split('\n')[0]))
  page.on('framenavigated', (f) => { if (loaded && f === page.mainFrame()) reloaded = true })
  try {
    // 文末补一个换行:基线那侧的笔记文件也是 md + '\n'。
    await page.goto(`${URL}?upage&useed=${encodeURIComponent(s.md + '\n')}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
    await page.waitForSelector(PM, { timeout: 180000 })
    await page.waitForFunction(() => typeof window.__upage?.probe?.serializeNow === 'function' && !!window.__upage.probe.view?.(), null, { timeout: 60000 })
    loaded = true
    await sleep(500)
    const cdp = await page.context().newCDPSession(page)
    let i = 0
    for (const st of s.steps) {
      i++
      if (st.caret) await page.evaluate(caretTo, st.caret)
      else if (st.select) await page.evaluate(selectText, st.select)
      else if (st.press) {
        const trace = []
        for (let n = 0; n < (st.times || 1); n++) {
          await page.keyboard.press(key(st.press)); await sleep(45)
          // 和基线同一个口径:每按一次之后的全文,去掉文末换行。
          if (st.traceMd) { await sleep(60); trace.push((await page.evaluate(serialize)).replace(/\n+$/, '')) }
        }
        if (st.traceMd) res.traces[`${i}:${st.press}×${st.times}`] = trace
      } else if (st.type != null) { await page.keyboard.type(st.type, { delay: st.delay ?? 15 }); await sleep(80) }
      else if (st.ime) {
        for (const t of st.ime.steps) { await cdp.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length }); await sleep(70) }
        await cdp.send('Input.insertText', { text: st.ime.commit }); await sleep(150)
      } else if (st.copy) res.clips[`${i}`] = await page.evaluate(clipEvent, 'copy')
      else if (st.cut) { res.clips[`${i}`] = await page.evaluate(clipEvent, 'cut'); await sleep(150) }
      else if (st.paste) { await page.evaluate(doPaste, st.paste); await sleep(200) }
      else if (st.click || st.dblclick || st.tripleclick) {
        const t = (st.click || st.dblclick || st.tripleclick).text, r = await page.evaluate(rectOfText, [PM, t])
        if (!r) throw new Error('屏幕上没找到文字: ' + t)
        await page.mouse.click(r.x, r.y, { clickCount: st.tripleclick ? 3 : st.dblclick ? 2 : 1 }); await sleep(250)
      } else if (st.clickXY) {
        const r = await page.evaluate(rectOfText, [PM, st.clickXY.text])
        if (!r) throw new Error('屏幕上没找到文字: ' + st.clickXY.text)
        await page.mouse.click(r.x + (st.clickXY.dx || 0), r.y + (st.clickXY.dy || 0)); await sleep(250)
      } else if (st.external != null) await page.evaluate((text) => window.__upage.fire('Unified.md', text), st.external)
      else if (st.wait) await sleep(st.wait)
      else if (st.snap) { await sleep(180); res.snaps[st.snap] = await page.evaluate(serialize) }
      else throw new Error('不认识的步骤: ' + JSON.stringify(st))
    }
    // 重开稳定:编辑器给出的 Markdown 作为一篇新笔记的内容打开,不编辑,再取一次。
    // 换一个新路径(不和别的场景、别的笔记共用任何按路径记的状态),等探针换成新实例再取。
    const first = await page.evaluate(serialize)
    await page.evaluate(([p, md]) => { window.__ofOldView = window.__upage.probe.view(); window.__upage.switchFile(p, md) }, [`Reopen-${s.id}.md`, first])
    await page.waitForFunction(() => { const v = window.__upage.probe.view?.(); return !!v && v !== window.__ofOldView && typeof window.__upage.probe.serializeNow() === 'string' }, null, { timeout: 60000 })
    await sleep(400)
    res.reopen = { first, again: await page.evaluate(serialize) }
    if (reloaded) throw new Error('页面中途重载了(多半是 Vite 热更新:跑的时候有人写了 frontend/src)')
  } catch (e) {
    res.error = e.message.split('\n')[0]
    res.envReload = reloaded
  } finally {
    await page.close().catch(() => {})
  }
  return res
}

// ── 比较 ────────────────────────────────────────────────────
/** 逐字节比:same;只差文末换行个数 → eol;其余 → content。 */
function kindOf(a, b) {
  if (a === b) return 'same'
  if (typeof a === 'string' && typeof b === 'string' && a.replace(/\n+$/, '') === b.replace(/\n+$/, '')) return 'eol'
  return 'content'
}
/** 一个场景的全部比较项:snap:<快照名>、trace:<步骤>、clip:<步骤>(只比 text/plain;text/html 两边注定不同)。 */
function compare(s, r) {
  const b = BASE.scenarios[s.id]
  if (!b) throw new Error(`基线里没有 ${s.id}`)
  const items = {}
  for (const [n, md] of Object.entries(b.snaps)) items[`snap:${n}`] = { kind: kindOf(r.snaps[n], md), got: r.snaps[n], want: md }
  for (const [k, arr] of Object.entries(b.traces || {})) {
    const got = r.traces[k]
    items[`trace:${k}`] = { kind: JSON.stringify(got) === JSON.stringify(arr) ? 'same' : 'content', got, want: arr }
  }
  for (const [k, c] of Object.entries(b.clips || {})) {
    const got = r.clips[k]?.data?.['text/plain'] ?? null, want = c.data?.['text/plain'] ?? null
    items[`clip:${k}`] = { kind: kindOf(got, want), got, want }
  }
  return items
}

// ── 名单 ────────────────────────────────────────────────────
function loadStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT' && UPDATE) return { items: {}, reopen: {} }
    throw new Error(`读不了名单 ${path.relative(process.cwd(), STATUS_FILE)}:${e.message}`)
  }
}
const STATUS_ABOUT = [
  '和 Obsidian 的手感对照的名单,由 obsidian-feel.check.cjs --update 生成;说明见 README.md。',
  'items:每个场景的每个比较项一条。status = same(和基线逐字节相同)/ pending(待对齐)/ keep(刻意保留,带 reason)。',
  'diff:不同的那种是哪一类 —— eol = 只差文末换行个数,content = 内容不同。',
  'reopen:每个场景跑完后「把结果当新笔记重开、不编辑再取一次」是否逐字节相同,status 口径同上(same = 稳定)。',
]
/** 一项一行,方便看 diff。 */
function writeStatus(st) {
  const line = (k, v) => `   ${JSON.stringify(k)}: ${JSON.stringify(v)}`
  const ids = Object.keys(st.items).sort(byId)
  const L = ['{', ` "about": ${JSON.stringify(STATUS_ABOUT, null, 1).replace(/\n\s*/g, ' ')},`, ' "items": {']
  ids.forEach((id, i) => {
    const e = Object.entries(st.items[id])
    L.push(`  ${JSON.stringify(id)}: {`, e.map(([k, v]) => line(k, v)).join(',\n'), `  }${i < ids.length - 1 ? ',' : ''}`)
  })
  L.push(' },', ' "reopen": {')
  const rids = Object.keys(st.reopen).sort(byId)
  L.push(rids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(st.reopen[id])}`).join(',\n'))
  L.push(' }', '}', '')
  fs.writeFileSync(STATUS_FILE, L.join('\n'))
}
const ORDER = require('./obsidian-feel/scenarios.cjs').map((s) => s.id)
const byId = (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)

/** 现在的结果 + 名单里的旧条目 → 这一项该怎么判、--update 时写成什么。 */
function judge(kind, old) {
  const next = kind === 'same' ? { status: 'same' } : old && old.status === 'keep' ? { status: 'keep', diff: kind, reason: old.reason } : { status: 'pending', diff: kind }
  let verdict = 'ok', why = ''
  if (!old) { verdict = 'fail'; why = '名单里没有这一项,用 --update 补上' }
  else if (old.status === 'same' && kind !== 'same') { verdict = 'fail'; why = `回归:名单记相同,现在${kind === 'eol' ? '只差文末换行' : '不同'}` }
  else if (old.status !== 'same' && kind === 'same') { verdict = 'fail'; why = `名单记${old.status === 'keep' ? '刻意保留' : '待对齐'},现在和基线相同了:用 --update 把名单更新` }
  else if (old.status !== 'same' && old.diff !== kind) { verdict = 'fail'; why = `差异类型变了(${old.diff} → ${kind}):用 --update 把名单更新` }
  return { verdict, why, next }
}
const show = (x) => (x == null ? 'null' : JSON.stringify(x))

;(async () => {
  const status = loadStatus()
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const all = {}
  let fails = 0
  const changes = []
  const t0 = Date.now()
  for (const s of SCENARIOS) {
    const ts = Date.now()
    let r = await runScenario(browser, s)
    // 页面被热更新重载 = 环境问题(不是编辑器的结果):同一个场景重跑一次。
    if (r.error && r.envReload) { console.log(`  ${s.id} 页面中途重载,重跑一次`); r = await runScenario(browser, s) }
    all[s.id] = r
    const ms = Date.now() - ts
    if (r.error) {
      fails++
      console.log(`FAIL  ${s.id}  出错:${r.error}  (${ms}ms)`)
      continue
    }
    const items = compare(s, r)
    const oldItems = status.items[s.id] || {}
    const lines = []
    const nextItems = {}
    for (const [k, it] of Object.entries(items)) {
      const j = judge(it.kind, oldItems[k])
      nextItems[k] = j.next
      if (j.verdict === 'fail') lines.push(`      ${k}:${j.why}\n        Forsion ${show(it.got)}\n        基线    ${show(it.want)}`)
      if (show(oldItems[k]) !== show(j.next)) changes.push(`${s.id} ${k}:${show(oldItems[k])} → ${show(j.next)}`)
    }
    for (const k of Object.keys(oldItems)) if (!items[k]) { lines.push(`      ${k}:名单里有,这次没有这一项(场景改过?用 --update)`); changes.push(`${s.id} ${k}:删掉`) }
    const rk = r.reopen.first === r.reopen.again ? 'same' : kindOf(r.reopen.again, r.reopen.first)
    const rj = judge(rk, status.reopen[s.id])
    if (rj.verdict === 'fail') lines.push(`      重开稳定:${rj.why}\n        第一次 ${show(r.reopen.first)}\n        重开后 ${show(r.reopen.again)}`)
    if (show(status.reopen[s.id]) !== show(rj.next)) changes.push(`${s.id} reopen:${show(status.reopen[s.id])} → ${show(rj.next)}`)
    if (UPDATE) { status.items[s.id] = nextItems; status.reopen[s.id] = rj.next }
    const err = r.pageErrors.length ? `  [pageerror ×${r.pageErrors.length}:${r.pageErrors[0]}]` : ''
    // --update 时不算红,只报这个场景的名单有没有变(具体改了哪几条在结尾列)。
    if (UPDATE) console.log(`${lines.length ? 'UPD ' : 'PASS'}  ${s.id}  (${ms}ms)${err}`)
    else if (lines.length) { fails++; console.log(`FAIL  ${s.id}  (${ms}ms)${err}\n${lines.join('\n')}`) }
    else console.log(`PASS  ${s.id}  (${ms}ms)${err}`)
  }
  await browser.close()
  if (DUMP) fs.writeFileSync(path.resolve(DUMP), JSON.stringify(all, null, 1))

  // 名单里有、场景表里已经没有的(没带 --only 时才查)
  if (!ONLY.length) {
    const ids = new Set(SCENARIOS.map((s) => s.id))
    for (const id of Object.keys(status.items)) if (!ids.has(id)) { if (UPDATE) { delete status.items[id]; delete status.reopen[id]; changes.push(`${id}:场景表里没有了,删掉`) } else { fails++; console.log(`FAIL  ${id}  名单里有,场景表里没有了(用 --update)`) } }
  }

  // 汇总:只数这次跑到的场景
  const ran = SCENARIOS.filter((s) => !all[s.id].error).map((s) => s.id)
  const count = { same: 0, pending: 0, keep: 0 }, eol = { pending: 0, keep: 0 }, re = { same: 0, pending: 0, keep: 0 }
  for (const id of ran) {
    // 汇总按这次的实际结果算(--update 前后一致;不带 --update 时也反映现状)
    const s = SCENARIOS.find((x) => x.id === id), items = compare(s, all[id])
    for (const [k, it] of Object.entries(items)) {
      const st = judge(it.kind, (status.items[id] || {})[k]).next
      count[st.status]++; if (st.status !== 'same' && st.diff === 'eol') eol[st.status]++
    }
    const rr = all[id].reopen, rk = rr.first === rr.again ? 'same' : kindOf(rr.again, rr.first)
    re[judge(rk, status.reopen[id]).next.status]++
  }
  if (UPDATE) {
    writeStatus(status)
    console.log(`\n名单已更新(${path.relative(process.cwd(), STATUS_FILE)}),改动 ${changes.length} 条:`)
    for (const c of changes) console.log('  ' + c)
  }
  console.log(`\n场景 ${SCENARIOS.length} 个(出错 ${SCENARIOS.length - ran.length}),耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
  console.log(`比较项:相同 ${count.same} · 待对齐 ${count.pending}(其中只差文末换行 ${eol.pending})· 刻意保留 ${count.keep}(其中只差文末换行 ${eol.keep})`)
  console.log(`重开稳定:稳定 ${re.same} · 不稳定待对齐 ${re.pending} · 不稳定刻意保留 ${re.keep}`)
  if (UPDATE) {
    const bad = SCENARIOS.length - ran.length
    console.log(bad ? `\n有 ${bad} 个场景出错,它们的名单条目没动;exit 1` : '\n名单已按这次结果重写;exit 0')
    process.exit(bad ? 1 : 0)
  }
  console.log(fails ? `\n${fails} 个场景红` : '\n全绿')
  process.exit(fails ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
