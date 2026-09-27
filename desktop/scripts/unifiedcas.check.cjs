// v4 统一编辑器的**写盘安全**仪器(评审 2026-09-27 波次 0a:G1-01 / D-03)。
//
//  G 组(`?upage&udual`,同窗同一篇两个生产实例 A/B = 双标签 / 分屏 / Mini):
//   G1 A 打字 → B 回灌看得见 · G2 B 再打字 → A 的字没丢 · G3 再交替一轮零冲突零副本
//   G4 insertMarkdown 落进一个实例 → 另一个接着打字,两边内容都在盘上
//   G5 insertMarkdown 后**立刻**在另一个实例打字(真并发):要么都在盘上,要么被盖的那版进了冲突副本 + error 提示
//   G6 B 打一个字就关(卸载冲洗)→ 字落盘、A 回灌看得见、先前谁的字都没丢
//   G7 停手后 3s 写盘次数不再增长(两个实例互相规范化 = 乒乓写)
//  C 组(CAS,writeTextFile 带基线指纹):
//   C1 盘上被别的窗口悄悄改了(回灌通知还在路上)→ 本地有改动的写被拒 → 盘上那版进冲突副本 + 本地版落盘
//   C2 同上但本实例**没有用户改动**(只是编辑器规范化)→ 让位回灌,盘上那版原样保留、零副本
//   C3 陈旧且没改动的 B 被关掉 → 不许拿旧全文盖掉盘上新版(卸载冲洗的 isPristine 闸)
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
  if (flags.includes('udual')) await p.waitForFunction((s) => document.querySelectorAll(s).length === 2, PM, { timeout: 60000 })
  await p.waitForFunction(() => !!window.__upage.lifecycle, null, { timeout: 20000 })
  await p.waitForTimeout(500)
  return p
}

/** 在第 idx 个实例(0=A 主实例,1=B)里把光标放到 text 之后并聚焦(直驱 PM 选区,不靠坐标)。 */
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
const writeCount = (p) => p.evaluate(() => window.__upage.writes.length)

async function groupG(browser) {
  const p = await open(browser, '# 标题\n\n第一段。\n\n## 小节\n\n第二段。\n', '&udual')
  await typeIn(p, 0, '第一段。', 'AAA')
  await wait(1800)
  let d = await disk(p)
  record('G1 A 打字落盘 → B 回灌看得见(同窗同篇通知)', d.includes('AAA') && (await domText(p, 1)).includes('AAA'), JSON.stringify(d))

  await typeIn(p, 1, '第二段。', 'BBB')
  await wait(1800)
  d = await disk(p)
  record('G2 B 再打字:A 的字没被 B 的旧全文盖掉,A 也看得见 B 的字', d.includes('AAA') && d.includes('BBB') && (await domText(p, 0)).includes('BBB'), JSON.stringify(d))

  await typeIn(p, 0, 'AAA', 'CCC')
  await wait(1800)
  await typeIn(p, 1, 'BBB', 'DDD')
  await wait(1800)
  d = await disk(p)
  const c3 = await copies(p)
  const t3 = await toasts(p)
  record('G3 再交替一轮:全部在盘上,零冲突副本零提示', ['AAA', 'BBB', 'CCC', 'DDD'].every((x) => d.includes(x)) && c3.length === 0 && t3.length === 0, JSON.stringify({ d, copies: c3.length, toasts: t3.length }))

  // G4:插件块表面 / 模板的写口(按路径路由,落进哪个实例由 lifecycle 定 —— 那条路由是 G1-02,本组不管)
  const target = await p.evaluate(() => {
    window.__upage.lifecycle.unifiedInsertMarkdown('Unified.md', 'INSERTED', 'end')
    const eds = document.querySelectorAll('.unified-body .ProseMirror')
    return eds[0].innerText.includes('INSERTED') ? 0 : eds[1].innerText.includes('INSERTED') ? 1 : -1
  })
  await wait(1800)
  const other = target === 0 ? 1 : 0
  await typeIn(p, other, 'DDD', 'EEE')
  await wait(1800)
  d = await disk(p)
  record('G4 insertMarkdown 落进一个实例,另一个接着打字:两边内容都在盘上', target >= 0 && d.includes('INSERTED') && d.includes('EEE') && (await domText(p, target)).includes('EEE'), JSON.stringify({ target, d }))

  // G5:真并发 —— insertMarkdown 刚落进 X,100ms 内另一个实例就开始打字(X 的防抖写 800ms 后才落,那时对面正有未落盘编辑)
  const t5 = await p.evaluate(() => {
    window.__upage.lifecycle.unifiedInsertMarkdown('Unified.md', 'RACE1', 'end')
    const eds = document.querySelectorAll('.unified-body .ProseMirror')
    return eds[0].innerText.includes('RACE1') ? 0 : 1
  })
  await wait(100)
  await typeIn(p, t5 === 0 ? 1 : 0, 'EEE', 'FFF')
  await wait(3500)
  d = await disk(p)
  const c5 = await copies(p)
  const tt5 = await toasts(p)
  const bothOnDisk = d.includes('RACE1') && d.includes('FFF')
  const loserInCopy = d.includes('FFF') && c5.some(([, v]) => v.includes('RACE1')) && tt5.some((t) => t.level === 'error' && t.action)
  record('G5 真并发:两边都在盘上,或被盖的那版进了冲突副本 + error 提示(不静默丢)', bothOnDisk || loserInCopy, JSON.stringify({ bothOnDisk, loserInCopy, copies: c5.map(([k]) => k), toasts: tt5.length }))

  // G6:B 打一个字立刻关掉(卸载冲洗)
  await typeIn(p, 1, 'FFF', 'Z')
  await p.evaluate(() => window.__upage.unmountB())
  await wait(1800)
  d = await disk(p)
  const aText = await domText(p, 0)
  const allKept = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFFZ'].every((x) => d.includes(x))
  record('G6 B 带未落盘编辑被关:字落盘、A 回灌看得见、先前谁的字都没丢', allKept && aText.includes('FFFZ'), JSON.stringify({ d, aHasZ: aText.includes('FFFZ') }))

  const w0 = await writeCount(p)
  await wait(3000)
  const w1 = await writeCount(p)
  record('G7 停手 3s 写盘次数不再增长(无实例间乒乓写)', w1 === w0, JSON.stringify({ w0, w1 }))
  record('G8 全程无运行时异常', p.errs.length === 0, p.errs.slice(0, 2).join(' | '))
  await p.close()
}

async function groupC(browser) {
  // C1:本地有改动 + 盘上被悄悄改过(另一个窗口的写,externalChange 还在路上)
  {
    const p = await open(browser, '# T\n\n甲段。\n\n乙段。\n')
    await p.evaluate(() => window.__upage.vault.set('Unified.md', '# T\n\n甲段。别处写的\n\n乙段。\n'))
    await typeIn(p, 0, '乙段。', '本地')
    await wait(1800)
    const d = await disk(p)
    const c = await copies(p)
    const t = await toasts(p)
    const rejects = await p.evaluate(() => window.__upage.casRejects.length)
    record('C1 CAS 拒掉陈旧写 → 盘上那版进冲突副本 + error 提示,本地版随后落盘',
      rejects >= 1 && d.includes('乙段。本地') && c.length === 1 && c[0][1].includes('别处写的') && t.some((x) => x.level === 'error' && x.action?.label),
      JSON.stringify({ rejects, d, copies: c.map(([k, v]) => [k, v]), toasts: t.length }))
    await p.close()
  }
  // C2:本实例没有用户改动(只是编辑器把 __粗__ 规范化成 **粗**)
  {
    const p = await open(browser, '# T\n\n__粗__ 与 _斜_\n')
    const X = '# T\n\n__粗__ 与 _斜_ 别处追加\n'
    await p.evaluate((X) => window.__upage.vault.set('Unified.md', X), X)
    await p.evaluate(() => window.__upage.probe.flush()) // 规范化写:syncFromEditor 让 body ≠ 基线
    await wait(1500)
    const d = await disk(p)
    const c = await copies(p)
    // 回灌之后编辑器会把 `__粗__` 规范化写回(这是既有的回灌行为,不是本组要管的)—— 判据只看「别处那版的内容还在盘上」。
    record('C2 没有用户改动的 CAS 拒写 → 让位回灌:别处那版的内容留在盘上、零副本零提示、编辑器显示新内容',
      d.includes('别处追加') && c.length === 0 && (await toasts(p)).length === 0 && (await domText(p, 0)).includes('别处追加'), JSON.stringify({ d, copies: c.length }))
    await p.close()
  }
  // C3:陈旧且没改动的 B 被关掉
  {
    const p = await open(browser, '# T\n\n__粗__ 与 _斜_\n', '&udual')
    const X = '# T\n\n**粗** 与 *斜* 别的窗口写的\n'
    await p.evaluate((X) => window.__upage.vault.set('Unified.md', X), X)
    await p.evaluate(() => window.__upage.unmountB())
    await wait(1500)
    const d = await disk(p)
    const c = await copies(p)
    const w = await p.evaluate(() => window.__upage.writes.length)
    record('C3 陈旧且没改动的实例卸载:不写(不拿旧全文盖掉盘上新版)', d === X && c.length === 0 && w === 0, JSON.stringify({ d, copies: c.length, writes: w }))
    await p.close()
  }
}

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
    const groups = { G: groupG, C: groupC, D: groupD }
    for (const [k, fn] of Object.entries(groups)) if (!only.length || only.includes(k)) await fn(browser)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
