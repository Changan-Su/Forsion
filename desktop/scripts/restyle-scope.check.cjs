/**
 * 长笔记开着时,开合左栏 / 在左栏列表上移动指针不许整篇重算样式(check:restylescope):真 Electron + 桩引擎,隔离 HOME / 笔记库。
 *
 * 背景(10-16 实测,长笔记 3000 块 ≈ 3.4 万个元素):开合一次左栏原来叠出十来次大范围样式重算,展开最慢帧 ~1.2s。两类写法:
 *  ① `:has()` 不在最后一段、最后一段没有类可认(功能条淡出、列表行箭头、Astryx 的 6 条)→ 每次焦点 / DOM 变化整篇标脏,一次 ~180ms;
 *     修在分支 perf/insert-restyle-has(Astryx 由 frontend/astryxHasPlugin.ts 构建时改写),静态那半是 cssHasGuard.test.ts;
 *  ② `:nth-child()` 不在最后一段、最后一段只有标签(重置额度动画那两条 span / strong)→ 兄弟结构一变,兄弟底下所有 span / strong 重算,
 *     一次 1.5 万个元素;静态那半是 cssNthGuard.test.ts。
 * 这里量真的:Chromium 的 UpdateLayoutTree 波及元素数。
 *
 * 断言:A 开合左栏 6 次,B 指针扫过左栏 12 行,两段里波及超过全页 30% 元素的样式重算都是 0 次。
 * 负对照:`--neg` 往页面里插一条老写法(`… .rb-btn:not(.on) > *`),A 必红。量的是 out/ 产物 —— 改了源码先 `npx electron-vite build`。
 * 用法:npm run check:restylescope [-- --neg]
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, makeReporter, sleep } = require('./lib/uiux-electron.cjs')

const NEG = process.argv.includes('--neg')
const { check, note, summary } = makeReporter()
const sentence = (i) => `第 ${i} 段:这是一段把笔记撑长的正文,有 **粗体**、\`行内代码\`、[一个链接](https://forsion.net),还有一句足够长的话,让它折成两三行。`
const code = (i) => '```ts\n' + Array.from({ length: 18 }, (_, k) => `const v${k} = ${i} + ${k}`).join('\n') + '\n```'
const longNote = (n) => Array.from({ length: n }, (_, i) => i % 20 === 0 ? `## 第 ${i / 20 + 1} 节` : i % 15 === 7 ? code(i) : i % 6 === 3 ? `- 列表项 ${i}` : sentence(i)).join('\n\n') + '\n'

;(async () => {
  const { app, win, home, close } = await launch({ tag: 'restylescope' })
  const vault = path.join(home, 'vault')
  fs.writeFileSync(path.join(vault, '长笔记探针.md'), longNote(3000))
  for (let i = 1; i <= 12; i++) fs.writeFileSync(path.join(vault, `短笔记 ${i}.md`), `# 短笔记 ${i}\n\n一句话。\n`)
  try {
    await boot(app, win, { space: 'amadeus', width: 1440, height: 900 })
    await sleep(2500)
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: '长笔记探针' }).first()
    if (!(await row.count().catch(() => 0))) { await win.click('.dv-edge-left').catch(() => {}); await sleep(700) }
    await row.click({ timeout: 10_000 }); await sleep(6000)
    const total = await win.evaluate(() => document.querySelectorAll('*').length)
    note('页面元素', `${total}(笔记 ${await win.evaluate(() => document.querySelector('.page-view .ProseMirror')?.childElementCount || 0)} 个顶层块)`)
    if (NEG) await win.evaluate(() => { const s = document.createElement('style'); s.textContent = "html .rb:not(:hover, :has(:focus-visible)) .rb-btn:not(.on) > * { opacity: .42 }"; document.head.append(s) })

    /** 跑一段操作,数「波及超过全页 30%」的样式重算,顺带记样式总耗时与 rAF 最慢帧。 */
    const measure = async (act) => {
      await win.evaluate(() => { const s = (window.__rs = { max: 0, last: performance.now(), on: true }); const loop = (t) => { s.max = Math.max(s.max, t - s.last); s.last = t; if (s.on) requestAnimationFrame(loop) }; requestAnimationFrame(loop) })
      await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['devtools.timeline', 'blink'] }))
      await sleep(150)
      await act()
      const raf = await win.evaluate(() => { window.__rs.on = false; return Math.round(window.__rs.max) })
      const file = await app.evaluate(({ contentTracing }) => contentTracing.stopRecording())
      const ev = JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents.filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X')
      try { fs.rmSync(file) } catch { /* ignore */ }
      const els = ev.map((e) => (e.args?.elementCount ?? e.args?.data?.elementCount) || 0)
      return { full: els.filter((n) => n > total * 0.3).length, styleMs: Math.round(ev.reduce((a, e) => a + e.dur, 0) / 1000), raf }
    }

    await win.mouse.move(760, 420)
    const a = await measure(async () => { for (let k = 0; k < 6; k++) { await win.keyboard.press('Meta+Slash'); await sleep(900) } })
    check('A 长笔记开着,开合左栏 6 次:整篇样式重算 0 次', a.full === 0, `${a.full} 次 | 样式共 ${a.styleMs}ms | rAF 最慢 ${a.raf}ms`)

    const rows = await win.locator('.t2s-srow').filter({ hasText: '短笔记' }).all()
    const boxes = (await Promise.all(rows.slice(0, 12).map((r) => r.boundingBox()))).filter(Boolean)
    const b = await measure(async () => { for (const r of boxes) { await win.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 3 }); await sleep(60) } await sleep(300) })
    check(`B 指针扫过左栏 ${boxes.length} 行:整篇样式重算 0 次`, boxes.length >= 8 && b.full === 0, `${b.full} 次 | 样式共 ${b.styleMs}ms | rAF 最慢 ${b.raf}ms`)
  } finally { await close() }
  const failed = summary()
  if (NEG) console.log(failed ? '负对照:红了(符合预期)' : '⚠️ 负对照没红:这个检查看不见那类规则')
  process.exit(NEG ? (failed ? 0 : 1) : (failed ? 1 : 0))
})().catch((e) => { console.error(e); process.exit(1) })
