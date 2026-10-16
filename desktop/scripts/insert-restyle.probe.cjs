// 「页面上随便插入一个元素要重算多少样式」的真 Electron 探针(2026-10-16)。量 out/,先 `npx electron-vite build`;Electron 台架照例套 devlock。
//   node scripts/insert-restyle.probe.cjs
// 桩引擎开一段 60 条消息的对话(约 3600 个元素),在 <body> / 最后一条回答 / Ribbon 里各插入 + 移除一个 span,记中位数毫秒。
// 贵(> 阈值)就在 CSSOM 里把规则的 selectorText 换成永不匹配的,做 delta debugging:先找 `:has` 规则,不够再找全部规则;
// 打印「必须关掉才变便宜」的每一条(含依赖库生成的 CSS —— cssHasGuard.test.ts 只扫得到我们自己的源码)。
// 有元凶时退出码 1。机器负载 > ~6 时数会抖,先看 `uptime`。原理与改法见 frontend/src/cssHasGuard.test.ts 文件头。
const { sleep, launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const W = 1512, H = 950
const REPLY = (i) => `## Section ${i}\n\nA paragraph of ordinary prose with **bold**, *emphasis*, \`inline code\` and a [link](https://example.com). It runs long enough to wrap over several lines, the way a real answer does.\n\n- first point with some detail\n- second point\n  - a nested point\n- third point\n\n\`\`\`ts\nexport function sum(xs: number[]): number {\n  let total = 0\n  for (const x of xs) total += x\n  return total\n}\n\`\`\`\n\n| Name | Value | Note |\n|---|---|---|\n| alpha | 1 | first row |\n| beta | 2 | second row |\n\n1. step one\n2. step two\n\n> A quoted remark to close section ${i}.`
const MESSAGES = Array.from({ length: 60 }, (_, i) => ({ id: `pm${i}`, role: i % 2 ? 'model' : 'user', content: i % 2 ? REPLY(i) : `Question ${i}: please explain the thing in some detail.`, created_at: `2026-10-01 10:${String(i).padStart(2, '0')}:00` }))

const KIT = `(() => {
  const all = []
  const walk = (list, sheet) => { for (const r of list) { if (r.selectorText !== undefined) all.push({ r, sel: r.selectorText, sheet }); if (r.cssRules) walk(r.cssRules, sheet) } }
  for (const s of document.styleSheets) { try { walk(s.cssRules, (s.href || 'inline').split('/').pop()) } catch {} }
  const hosts = { body: () => document.body, chat: () => [...document.querySelectorAll('.t2-asst .t2-content')].at(-1), ribbon: () => document.querySelector('.rb') }
  const cost = (h = 'body', n = 30) => { const host = hosts[h](); if (!host) throw new Error('no host ' + h); void document.body.offsetHeight; const xs = []
    for (let i = 0; i < n; i++) { const t = performance.now(); const p = document.createElement('span'); host.appendChild(p); void document.body.offsetHeight; p.remove(); void document.body.offsetHeight; xs.push(performance.now() - t) }
    xs.sort((a, b) => a - b); return Math.round(xs[n >> 1] * 100) / 100 }
  const off = (idx) => { for (const i of idx) all[i].r.selectorText = ':not(*):not(*)' }
  const on = (idx) => { for (const i of idx) all[i].r.selectorText = all[i].sel }
  const costs = () => ({ body: cost('body'), chat: cost('chat'), ribbon: cost('ribbon') })
  // 候选全关;逐块打开,打开后仍便宜就留着开,变贵就关回去并拆半。最后关着的就是元凶(每一条单独都足以让插入变贵)。
  const bisect = (cand, th) => { off(cand); const floor = cost(); if (floor > th) { on(cand); return null }
    const stack = [cand], bad = []
    while (stack.length) { const c = stack.pop(); on(c); if (cost() <= th) continue; off(c); if (c.length === 1) bad.push(c[0]); else stack.push(c.slice(0, c.length >> 1), c.slice(c.length >> 1)) }
    return { floor, bad } }
  window.__ir = { all, costs, off, on, bisect }
  return { rules: all.length }
})()`

async function main() {
  const { app, win, close } = await launch({ tag: 'insertrestyle', messages: MESSAGES })
  try {
    await boot(app, win, { space: 'tangu', width: W, height: H })
    await enterSpace(win, 'tangu'); await sleep(800)
    await win.locator('.t2s-srow', { hasText: 'Probe session one' }).first().click()
    await win.waitForSelector('.t2-asst .t2-content h2', { timeout: 20_000 })
    let n = -1
    for (let i = 0; i < 30; i++) { const c = await win.evaluate(() => document.getElementsByTagName('*').length); if (c === n) break; n = c; await sleep(1000) }
    await win.mouse.move(Math.round(W * 0.6), Math.round(H * 0.5)); await sleep(800)
    const { rules } = await win.evaluate(KIT)
    const now = await win.evaluate(() => __ir.costs())
    const floor = await win.evaluate(() => { const i = __ir.all.map((_, k) => k); __ir.off(i); const c = __ir.costs(); __ir.on(i); return c })
    console.log(`elements ${n}, style rules ${rules}; ms per insert + remove (median):\n  as shipped     ${JSON.stringify(now)}\n  no CSS at all  ${JSON.stringify(floor)}`)
    const th = Math.max(3, floor.body * 4)
    if (now.body <= th) { console.log(`OK  insertion is cheap (threshold ${th} ms)`); return 0 }
    let res = await win.evaluate(([t]) => __ir.bisect(__ir.all.map((x, i) => (x.sel.includes(':has(') ? i : -1)).filter((i) => i >= 0), t), [th])
    if (!res) res = await win.evaluate(([t]) => __ir.bisect(__ir.all.map((_, i) => i), t), [th])
    if (!res) { console.log('FAIL  insertion is expensive but no set of style rules explains it'); return 1 }
    const after = await win.evaluate(() => __ir.costs())
    for (const i of res.bad) { const x = await win.evaluate((k) => ({ sheet: __ir.all[k].sheet, sel: __ir.all[k].sel }), i); console.log(`CULPRIT  ${x.sheet}  ${x.sel}`) }
    console.log(`with those ${res.bad.length} off: ${JSON.stringify(after)}`)
    return 1
  } finally { await close() }
}
main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2) })
