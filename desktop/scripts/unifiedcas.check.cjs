// v4 统一编辑器的**写盘安全**仪器(评审 2026-09-27 波次 0a:D-03)。
//
//  D 组(D-03 打字中外部改动):100ms / 600ms / 连续打字中 fire → 本地胜 + 冲突副本 = 外部那版 + error 提示带「打开副本」;
//   负对照:已落盘后 fire / 没改动时 fire → 照常回灌、零副本零提示
//
// 用法:npm run check:unifiedcas(= node scripts/e2e-editor.cjs --check=unifiedcas;worktree 里设 HARNESS_URL)
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
const only = (process.env.ONLY || '').split(',').filter(Boolean) // ONLY=G,C 只跑这几组(调试用)
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
  // 从第一帧就收 toast(挂载补读、首次失败都可能很早)
  await p.addInitScript(() => {
    window.__toasts = []
    window.addEventListener('amadeus:toast', (e) => window.__toasts.push({ ...e.detail, action: e.detail.action ? { label: e.detail.action.label } : undefined, run: e.detail.action?.run }))
  })
  await p.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 60000 })
  await p.waitForFunction(() => !!window.__upage.lifecycle, null, { timeout: 20000 })
  await p.waitForTimeout(500)
  return p
}

/** 在第 idx 个实例里把光标放到 text 之后并聚焦(直驱 PM 选区,不靠坐标)。 */
async function caretAfter(p, idx, text) {
  const ok = await p.evaluate(([idx, text]) => {
    const view = (idx ? window.__upage.probe2 : window.__upage.probe).view()
    let found = -1
    view.state.doc.descendants((node, pos) => {
      if (found >= 0) return false
      if (node.isText) { const i = node.text.indexOf(text); if (i >= 0) { found = pos + i + text.length; return false } }
      return true
    })
    if (found < 0) return false
    let proto = Object.getPrototypeOf(view.state.selection)
    while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    view.focus()
    view.dispatch(view.state.tr.setSelection(proto.constructor.near(view.state.doc.resolve(found))))
    return true
  }, [idx, text])
  if (!ok) throw new Error(`caretAfter: 实例 ${idx} 里找不到「${text}」`)
}
async function typeIn(p, idx, after, str) {
  await caretAfter(p, idx, after)
  await p.keyboard.type(str)
}
const disk = (p) => p.evaluate(() => window.__upage.vault.get('Unified.md'))
const copies = (p) => p.evaluate(() => [...window.__upage.vault.entries()].filter(([k]) => / \(conflict \d{4}-\d{2}-\d{2} \d{4}\)(-\d+)?\.md$/.test(k)))
const toasts = (p) => p.evaluate(() => window.__toasts.map(({ run, ...t }) => t))
const domText = (p, idx) => p.evaluate(([s, idx]) => document.querySelectorAll(s)[idx]?.innerText ?? '', [PM, idx])

async function groupD(browser) {
  const MD = '# T\n\npara1 AAA\n\npara2 BBB\n\npara3 CCC\n'
  const EXT = '# T\n\npara1 AAA AGENT-WROTE-THIS\n\npara2 BBB\n\npara3 CCC\n'
  const cases = [
    { label: 'D1 fire 于打字后 100ms', type: true, delay: 100 },
    { label: 'D2 fire 于打字后 600ms(防抖写之前)', type: true, delay: 600 },
    { label: 'D3 fire 于连续打字中', type: true, delay: 100, continuous: true },
  ]
  for (const k of cases) {
    const p = await open(browser, MD)
    await typeIn(p, 0, 'CCC', ' local')
    await wait(k.delay)
    await p.evaluate((t) => window.__upage.fire('Unified.md', t), EXT)
    if (k.continuous) for (let i = 0; i < 6; i++) { await p.keyboard.type('x'); await wait(250) }
    await wait(3000)
    const d = await disk(p)
    const c = await copies(p)
    const t = await toasts(p)
    const err = t.find((x) => x.level === 'error')
    record(`${k.label}:本地胜 + 冲突副本 = 外部那版 + error 提示「打开副本」`,
      d.includes('CCC local') && !d.includes('AGENT-WROTE-THIS') && c.length === 1 && c[0][1] === EXT && !!err && !!err.action?.label && err.text.includes(c[0][0].replace(/\.md$/, '')),
      JSON.stringify({ d, copies: c.map(([k2]) => k2), toast: err?.text }))
    if (k.label.startsWith('D1')) {
      // 「打开副本」= 导航门面事件(amadeusOverlays → openNote),路径正是副本
      const nav = await p.evaluate(() => new Promise((resolve) => {
        const on = (e) => { window.removeEventListener('amadeus:navigate-note', on); resolve(e.detail?.path ?? null) }
        window.addEventListener('amadeus:navigate-note', on)
        const t = window.__toasts.find((x) => x.level === 'error')
        if (!t?.run) return resolve('no-toast')
        t.run()
        setTimeout(() => resolve('timeout'), 1000)
      }))
      record('D1b 「打开副本」动作 = 导航到副本路径', nav === c[0]?.[0], JSON.stringify(nav))
    }
    await p.close()
  }
  for (const k of [{ label: 'D4 负对照:已落盘后 fire', type: true, delay: 2500 }, { label: 'D5 负对照:没有本地改动时 fire', type: false, delay: 500 }]) {
    const p = await open(browser, MD)
    if (k.type) await typeIn(p, 0, 'CCC', ' local')
    await wait(k.delay)
    await p.evaluate((t) => window.__upage.fire('Unified.md', t), EXT)
    await wait(2500)
    const d = await disk(p)
    record(`${k.label} → 照常回灌、零副本零提示`, d === EXT && (await copies(p)).length === 0 && (await toasts(p)).length === 0 && (await domText(p, 0)).includes('AGENT-WROTE-THIS'), JSON.stringify(d))
    await p.close()
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const groups = { D: groupD }
    for (const [k, fn] of Object.entries(groups)) if (!only.length || only.includes(k)) await fn(browser)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
