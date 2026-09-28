// 嵌入挪位不空白(评审 2026-09-27 P-02)。
//
//  嵌入 widget 的 React 根按**内容身份**(dkey = 类别:全文#出现序号)复用。嵌入在文档里挪了位置
//  —— 上方删一段、Mod+Shift+↓ 把段落挪过它、外部回灌换了顺序 —— PM 会新建一个 widget 视图
//  (toDOM 取回同一个 dom),再销毁旧视图;旧版 destroy 无条件 unmount,于是新位置上是一个根已卸的
//  空壳:高 0、完全看不见,之后打字也不自愈(md 完好,撤销/重开才回来)。修法见 embedLayer.tsx 的
//  WidgetEntry.refs(持有计数归零才卸)。
//
//  K1 嵌入正上方 Enter 再 Backspace(删掉刚插的空段)→ 嵌入照常渲染;之后在别处打字仍在
//  K2 Mod+Shift+↓ 把上一段挪到嵌入下面 → 照常渲染;Mod+Z 撤回 → 照常渲染
//  K3 外部回灌把嵌入提到最前(__upage.fire)→ 照常渲染
//  K4 对照:嵌入上方插一段 → 照常渲染(这一路旧版就没坏)
//  K5 拆除仍然生效:整段删掉嵌入 → 嵌入 DOM 归零且旧根真的卸了;撤销 → 新根重新渲染出内容(持有计数不许把根「钉死」)
//
// 用法:npm run check:embedkeep(= node scripts/e2e-editor.cjs --check=embed-keep;worktree 里设 HARNESS_URL)
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
const EMBED_TEXT = '被嵌入的第一段' // 台架 Embedded.md 的正文(harness.tsx EMBED_MD)
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(browser, seed) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.waitForFunction((t) => [...document.querySelectorAll('.unified-embed')].some((e) => e.textContent.includes(t)), EMBED_TEXT, { timeout: 20000 })
  await p.waitForTimeout(300)
  return p
}

/** 每个嵌入的渲染状态:body 里有没有 React 子树、可见高度、正文在不在。 */
const embeds = (p) => p.evaluate((t) => [...document.querySelectorAll('.unified-embed')].map((e) => {
  const b = e.querySelector('.unified-embed-body')
  return { kids: b ? b.childElementCount : -1, h: Math.round(e.getBoundingClientRect().height), text: e.textContent.includes(t) }
}), EMBED_TEXT)
const alive = (list) => list.length === 1 && list[0].kids > 0 && list[0].h > 20 && list[0].text
const order = (p) => p.evaluate(() => { const o = []; window.__upage.probe.view().state.doc.forEach((n) => o.push(n.textContent.slice(0, 4) || '∅')); return o.join('|') })
/** 光标放到内容恰为 t 的顶层块末尾并聚焦(直驱 PM 选区,不靠坐标)。 */
const caretEnd = (p, t) => p.evaluate((t) => {
  const v = window.__upage.probe.view()
  let at = -1
  v.state.doc.forEach((n, off) => { if (n.textContent === t) at = off + n.nodeSize - 1 })
  const TS = v.state.selection.constructor
  v.focus()
  v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, at)))
}, t)
/** 等到嵌入重新渲染(或确认它坏了):挪位后的新 widget 视图在同一拍拿到 dom,卸载在微任务里。 */
const settle = async (p) => { await p.waitForTimeout(500) }

const SEED = '# T\n\n段甲。\n\n段乙。\n\n![[Embedded]]\n\n段丙。\n'

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // K1
    let p = await open(browser, SEED)
    await caretEnd(p, '段乙。')
    await p.keyboard.press('Enter'); await settle(p)
    await p.keyboard.press('Backspace'); await settle(p)
    let e = await embeds(p)
    record('K1 嵌入正上方 Enter+Backspace → 嵌入照常渲染', alive(e), `${await order(p)} ${JSON.stringify(e)}`)
    await caretEnd(p, '段丙。')
    await p.keyboard.type('x'); await settle(p)
    e = await embeds(p)
    record('K1b 之后在别处打字 → 嵌入仍在', alive(e), JSON.stringify(e))
    await p.close()

    // K2
    p = await open(browser, '# T\n\n段甲。\n\n![[Embedded]]\n\n段乙。\n')
    await caretEnd(p, '段甲。')
    await p.keyboard.press('Meta+Shift+ArrowDown'); await settle(p)
    const o2 = await order(p)
    e = await embeds(p)
    record('K2 Mod+Shift+↓ 把段甲挪过嵌入 → 嵌入照常渲染', o2.startsWith('T|![[E') && alive(e), `${o2} ${JSON.stringify(e)}`)
    await p.keyboard.press('Meta+z'); await settle(p)
    e = await embeds(p)
    record('K2b Mod+Z 撤回挪块 → 嵌入照常渲染', (await order(p)).startsWith('T|段甲') && alive(e), `${await order(p)} ${JSON.stringify(e)}`)
    await p.close()

    // K3
    p = await open(browser, SEED)
    await p.evaluate(() => window.__upage.fire('Unified.md', '# T\n\n![[Embedded]]\n\n段甲。\n\n段乙。\n\n段丙。\n'))
    await p.waitForTimeout(1000)
    const o3 = await order(p)
    e = await embeds(p)
    record('K3 外部回灌把嵌入提到最前 → 嵌入照常渲染', o3.startsWith('T|![[E') && alive(e), `${o3} ${JSON.stringify(e)}`)
    await p.close()

    // K4 对照
    p = await open(browser, SEED)
    await caretEnd(p, '段甲。')
    await p.keyboard.press('Enter'); await p.keyboard.type('新'); await settle(p)
    e = await embeds(p)
    record('K4 对照:嵌入上方插一段 → 嵌入照常渲染', alive(e), `${await order(p)} ${JSON.stringify(e)}`)
    await p.close()

    // K5 拆除
    p = await open(browser, SEED)
    await p.evaluate(() => {
      window.__oldEmbed = document.querySelector('.unified-embed')
      window.__oldBody = window.__oldEmbed.querySelector('.unified-embed-body')
      const v = window.__upage.probe.view()
      let from = -1, size = 0
      v.state.doc.forEach((n, off) => { if (n.textContent === '![[Embedded]]') { from = off; size = n.nodeSize } })
      v.focus()
      v.dispatch(v.state.tr.delete(from, from + size))
    })
    await settle(p)
    const gone = await embeds(p)
    // 旧根真的卸了(React 卸载会清空容器)—— 持有计数漏减会让根永远活着、泄漏在 roots 里。
    const oldBodyKids = await p.evaluate(() => window.__oldBody.childElementCount)
    await p.keyboard.press('Meta+z'); await settle(p)
    e = await embeds(p)
    const fresh = await p.evaluate(() => { const d = document.querySelector('.unified-embed'); return !!d && d !== window.__oldEmbed })
    record('K5 整段删掉嵌入 → 嵌入 DOM 归零、旧根已卸;撤销 → 新根重新渲染', gone.length === 0 && oldBodyKids === 0 && fresh && alive(e),
      `after-delete=${JSON.stringify(gone)} oldBodyKids=${oldBodyKids} fresh=${fresh} after-undo=${JSON.stringify(e)}`)
    await p.close()
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
