#!/usr/bin/env node
// Real Electron: block containment must preserve Markdown geometry, TOC navigation,
// code copy, user-message folding and the scroll anchor. Build first; run under devlock.
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const U = require('./lib/uiux-electron.cjs')
const reportPath = path.resolve(process.argv.find((a) => a.startsWith('--json='))?.slice(7) || path.join(os.tmpdir(), 'forsion-chat-block-layout.json'))
const code = (i) => Array.from({ length: 8 }, (_, j) => `const value${i}_${j} = input.map(x => x + ${j});`).join('\n')
const section = (i) => [
  `## Layout section ${i}`, `Paragraph **${i}** with $a^2+b^2=c^2$ and more text. `.repeat(4),
  '> Quote first paragraph.\n>\n> Quote second paragraph.',
  '- First item\n\n- Second item\n  - Nested item',
  '```typescript\n' + code(i) + '\n```',
  '| A | B |\n|---|---|\n| one | two |',
  '$$\nx = \\frac{a+b}{c}\n$$', '```\none line\n```',
].join('\n\n')
const question = Array.from({ length: 80 }, (_, i) => `Question line ${i}: keep all original text.`).join('\n')
const messages = [
  { id: 'fold-question', role: 'user', content: question, timestamp: 1 },
  { id: 'layout-answer', role: 'model', content: Array.from({ length: 30 }, (_, i) => section(i)).join('\n\n'), timestamp: 2 },
]

;(async () => {
  const { app, win, stub, close } = await U.launch({ tag: 'chat-block-layout', messages })
  const report = { checks: [], errors: [] }
  win.on('pageerror', (e) => report.errors.push(String(e)))
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  const pass = (name) => { report.checks.push(name); console.log('PASS ' + name) }
  const gap = () => win.locator('.t2-stream').first().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click()
    await win.waitForFunction(() => document.querySelectorAll('#tocmsg-layout-answer h2').length === 30)
    await U.sleep(600)
    assert((await gap()) < 40, 'initial long answer must land at the bottom')
    pass('initial bottom position')

    const user = win.locator('#tocmsg-fold-question')
    await user.scrollIntoViewIfNeeded()
    await win.waitForFunction(() => document.querySelector('#tocmsg-fold-question .t2-user-fold')?.hasAttribute('data-folded'))
    const fold = user.locator('.t2-user-fold')
    assert((await fold.boundingBox()).height <= 301, 'long user message must fold to 300px')
    await user.locator('.t2-user-more').click()
    assert((await fold.boundingBox()).height > 1000, 'expansion must reveal the full question')
    assert((await user.innerText()).includes('Question line 79:'), 'folding must preserve the last line')
    await user.locator('.t2-user-more').click()
    await U.sleep(100)
    assert((await fold.boundingBox()).height <= 301)
    pass('fold, expand and collapse the long question')

    await win.locator('.lcl-ftoc').first().hover()
    const item = win.locator('.lcl-ftoc-item[title="Layout section 18"]')
    await item.waitFor({ state: 'visible' })
    await item.click()
    await win.mouse.move(900, 450)
    await U.sleep(1600)
    const heading = win.locator('#tocmsg-layout-answer h2').filter({ hasText: 'Layout section 18' })
    report.targetPosition = await heading.evaluate((h) => {
      const scroll = h.closest('.t2-stream')
      return { top: h.getBoundingClientRect().top - scroll.getBoundingClientRect().top, gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight }
    })
    assert(report.targetPosition.top >= -2 && report.targetPosition.top < 100, 'TOC must settle on the requested section')
    assert(report.targetPosition.gap > 1000, 'TOC must not be pulled back to the bottom')
    pass('TOC reaches a section inside a long answer')

    const measure = () => heading.evaluate((h) => {
      const nodes = []
      for (let el = h.nextElementSibling; el && el.tagName !== 'H2'; el = el.nextElementSibling) {
        // Request actual descendant geometry, not an offscreen intrinsic-size estimate.
        el.firstElementChild?.getBoundingClientRect()
        nodes.push(el)
      }
      const top = h.getBoundingClientRect().top
      return nodes.map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, top: r.top - top, height: r.height, width: r.width } })
    })
    report.contained = await measure()
    const reference = await win.addStyleTag({ content: '.t2-stream-inner .t2-content > * { content-visibility: visible !important; contain-intrinsic-block-size: none !important; }' })
    report.reference = await measure()
    assert.equal(report.contained.length, report.reference.length)
    report.contained.forEach((r, i) => {
      for (const key of ['top', 'height', 'width']) assert(Math.abs(r[key] - report.reference[i][key]) <= 1, `${r.tag} ${key} must match the original uncontained Markdown layout`)
    })
    await reference.evaluate((el) => el.remove())
    pass('paragraphs, quotes, lists, math, tables and code retain their geometry')

    const copyBox = win.locator('#tocmsg-layout-answer .code-box[data-code-head]').nth(18)
    await copyBox.scrollIntoViewIfNeeded()
    await win.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__layoutCopied = text } } }))
    await copyBox.locator('.code-head-btn').last().click()
    assert.equal((await win.evaluate(() => window.__layoutCopied)).trim(), code(18))
    pass('visible code copy retains every line')
    await win.screenshot({ path: reportPath + '.png' })
    await win.locator('.t2-jump').first().click()
    await win.waitForFunction(() => { const s = document.querySelector('.t2-stream'); return s && s.scrollHeight - s.scrollTop - s.clientHeight < 40 })
    await U.sleep(400)
    assert((await gap()) < 40)
    assert.equal(report.errors.length, 0)
    pass('return to bottom stays anchored without renderer errors')
    // Tools split one assistant reply into many Markdown containers. Only the latest
    // text segment may exempt its growing tail from containment.
    stub.script([
      ...Array.from({ length: 18 }, (_, i) => [
        { type: 'token', payload: { delta: section(i) + '\n\n' } },
        { type: 'tool_call', payload: { id: `layout-tool-${i}`, name: 'read_file', arguments: JSON.stringify({ path: `file${i}.ts` }) } },
        { type: 'tool_result', payload: { id: `layout-tool-${i}`, result: `File ${i} inspected.`, elapsedMs: 2 } },
      ]).flat(),
      { type: 'token', payload: { delta: 'LAYOUT_SEGMENT_TAIL' } },
      { type: 'token', delay: 6000, payload: { delta: '\n\nLAYOUT_SEGMENT_DONE' } },
    ])
    const ta = win.locator('.t2c-ta').first()
    await ta.fill('Check interleaved text and tools'); await ta.press('Enter')
    await win.waitForFunction(() => document.querySelector('.t2-asst[data-streaming]')?.textContent.includes('LAYOUT_SEGMENT_TAIL'))
    report.segmentLayout = await win.locator('.t2-asst[data-streaming]').evaluate((el) => {
      const bodies = [...el.querySelectorAll('.t2-content')]
      return { count: bodies.length, tails: bodies.filter((b) => b.hasAttribute('data-streaming-tail')).length,
        stable: getComputedStyle(bodies[0].querySelector('p')).contentVisibility,
        tail: getComputedStyle(bodies.at(-1).querySelector('p')).contentVisibility }
    })
    assert.equal(report.segmentLayout.count, 19)
    assert.equal(report.segmentLayout.tails, 1)
    assert.equal(report.segmentLayout.stable, 'auto')
    assert.equal(report.segmentLayout.tail, 'visible')
    await win.waitForFunction(() => !document.querySelector('.t2-asst[data-streaming]') && document.querySelector('.t2-stream').textContent.includes('LAYOUT_SEGMENT_DONE'))
    pass('tool-interleaved replies contain stable segments and preserve one growing tail')
    report.passed = true
  } catch (e) {
    report.passed = false; report.failure = String(e.stack || e)
    await win.screenshot({ path: reportPath + '.failure.png' }).catch(() => {})
    throw e
  } finally {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    await close()
  }
})().catch((e) => { console.error(e); process.exitCode = 1 })
