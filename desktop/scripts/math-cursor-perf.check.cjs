// Run this same driver against each revision's isolated harness:
// HARNESS_URL=http://127.0.0.1:5199/harness.html MATH_PERF_OUTPUT=run.json node scripts/math-cursor-perf.check.cjs
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')

function fixture() {
  const paragraphs = []
  let length = 0
  while (length < 500_000) {
    const line = 'Paragraph ' + paragraphs.length + ' ordinary words and plain prose with sample numbers 1234567890. Formula $x_i + \\frac{a}{b}$.\n\n'
    paragraphs.push(line)
    length += line.length
  }
  return { md: paragraphs.join(''), count: paragraphs.length }
}

async function measure(page, count) {
  return page.evaluate(async ({ count }) => {
    const view = window.__upage.probe.view()
    view.focus()
    const { doc, schema } = view.state
    const math = view.state.plugins.find(p => p.key.startsWith('amadeus-math-live-preview'))
    const focus = view.state.plugins.find(p => p.key.startsWith('amx-editor-focus'))
    if (!math || !focus?.getState(view.state)) throw new Error('Focused math editor required')
    const Selection = view.state.selection.constructor
    const paragraphs = []
    doc.forEach((node, pos) => {
      const dollar = node.textContent.indexOf('$')
      if (dollar >= 0) paragraphs.push({ plain: pos + 3, formula: pos + 1 + dollar + 3 })
    })
    if (paragraphs.length !== count) throw new Error('Fixture paragraph count differs')
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve))
    // Each cycle crosses two formula boundaries, moves inside one formula, then jumps to another paragraph.
    const routes = Array.from({ length: 40 }, (_, i) => {
      const row = paragraphs[(Math.floor(i / 4) * 463) % count]
      return [row.plain, row.formula, row.formula + 1, row.plain + 1][i % 4]
    })
    const get = state => math.props.decorations.call(math, state)
    const makeSelection = at => Selection.create(doc, at)
    let state = view.state.constructor.create({ schema, doc, plugins: [focus, math] })
    state = state.apply(state.tr.setMeta(focus, true))
    get(state)
    const mathMs = []
    for (const [i, at] of routes.entries()) {
      const start = performance.now()
      state = state.apply(state.tr.setSelection(makeSelection(at)))
      const decorations = get(state)
      const elapsed = performance.now() - start
      const sourceHere = decorations.find(at, at).some(d => d.type.attrs?.class === 'math-source')
      if (sourceHere !== (i % 4 === 1 || i % 4 === 2)) throw new Error('Wrong formula source at ' + at)
      if (i >= 8) mathMs.push(elapsed)
    }
    const dispatchMs = [], toRafMs = []
    const lastParagraph = view.nodeDOM(paragraphs[count - 1].plain - 3)
    const expectedWidget = lastParagraph.querySelector('.math-rendered')
    if (!expectedWidget) throw new Error('Fixture did not render its last equation')
    for (const [i, at] of routes.entries()) {
      await nextFrame()
      const start = performance.now()
      view.dispatch(view.state.tr.setSelection(makeSelection(at)))
      const end = performance.now()
      await nextFrame()
      const frame = performance.now()
      if (view.state.selection.head !== at || view.state.doc !== doc) throw new Error('Invalid cursor or modified text')
      if (lastParagraph.querySelector('.math-rendered') !== expectedWidget || !expectedWidget.isConnected) throw new Error('Unrelated formula widget was replaced')
      if (i >= 8) {
        dispatchMs.push(end - start)
        toRafMs.push(frame - start)
      }
    }
    return { mathMs, dispatchMs, toRafMs, unchangedDoc: view.state.doc === doc, warmup: 8, samples: mathMs.length }
  }, { count })
}

async function main() {
  const url = new URL(process.env.HARNESS_URL || 'http://127.0.0.1:5173/harness.html')
  url.searchParams.set('upage', '')
  url.searchParams.set('useed', 'Starting note')
  const { md, count } = fixture()
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForSelector('.unified-body .ProseMirror', { timeout: 120_000 })
    await page.evaluate(md => window.__upage.switchFile('Formula-long.md', md), md)
    await page.waitForFunction(count => window.__upage.probe.view()?.state.doc.childCount >= count, count, { timeout: 180_000 })
    const result = await measure(page, count)
    assert.equal(result.samples, 32)
    const summary = {}
    for (const key of ['mathMs', 'dispatchMs', 'toRafMs']) {
      const sorted = [...result[key]].sort((a, b) => a - b)
      summary[key] = { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)] }
    }
    const record = { source: process.env.MATH_PERF_REVISION, chars: md.length, formulas: count, sha256: createHash('sha256').update(md).digest('hex'), cpu: os.cpus()[0].model, os: os.release(), browser: browser.version(), node: process.version, viewport: page.viewportSize(), ...result, summary }
    console.log(JSON.stringify({ chars: md.length, formulas: count, sha256: record.sha256, summary }))
    if (process.env.MATH_PERF_OUTPUT) fs.writeFileSync(process.env.MATH_PERF_OUTPUT, JSON.stringify(record, null, 2) + '\n')
  } finally { await browser.close() }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
