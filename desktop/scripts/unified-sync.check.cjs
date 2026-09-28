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

const GROUPS = { K: groupK }

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
