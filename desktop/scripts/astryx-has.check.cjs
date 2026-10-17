// astryx 的「祖先 :has」改写前后行为一致(2026-10-16;改写在 frontend/astryxHasPlugin.ts)。
//   npm run check:astryxhas    —— 裸 Chromium,不起 Electron,几秒钟
// 同一份合成 DOM(CheckboxInput / Switch 的焦点环、Layout 头尾无分隔线时收内边距 —— 被改写的 6 条规则全部),
// 分别挂原版 astryx.css 与改写后的,逐状态比计算样式:必须全等;原版下焦点环 / 内边距确实在变(否则比对看不见差别)。
// 应用里真 CheckboxInput 的焦点环见 check:astryxscope 的 G 段;插入代价见 scripts/insert-restyle.probe.cjs。
const fs = require('node:fs')
const { chromium } = require('playwright-core')
const { findChromium } = require('./lib/find-chromium.cjs')
const { loadTs } = require('./lib/load-ts.cjs')
const { rewriteAstryxHas } = loadTs(require.resolve('../frontend/astryxHasPlugin.ts'))

const ORIGINAL = fs.readFileSync(require.resolve('@astryxdesign/core/astryx.css'), 'utf8')
const DOM = `
<div class="x1tspnpo"><div><input type="checkbox"><div id="cb" class="x1a2a7pz xkri23q x81n7kt"></div></div><span>label</span></div>
<div class="x1iwu4tg"><div><input type="checkbox"><div id="sw" class="x1a2a7pz x1gj1ihy x1edzap1"></div></div></div>
<div class="x-default-marker"><div class="astryx-layout-header"></div><div><div id="lc" class="xqty4a x1ioh5az xg476vw xsg11nj"></div></div><div class="astryx-layout-footer"></div></div>
<div><div id="bare" class="xqty4a x1ioh5az xg476vw xsg11nj"></div></div>
<style>body { --layout-padding-inner-y: 8px }</style>`

const STATE = `(() => { const o = (id) => { const cs = getComputedStyle(document.getElementById(id)); return id === 'lc' || id === 'bare' ? cs.paddingTop + ' ' + cs.paddingBottom : cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineOffset }
  return ['cb', 'sw', 'lc', 'bare'].map(o).join(' | ') })()`

async function run(page, css) {
  await page.setContent(`<style>${css}</style>${DOM}`)
  const out = {}
  const at = async (name, act) => { await act(); out[name] = await page.evaluate(STATE) }
  await at('idle', async () => {})
  await at('tab → checkbox', () => page.keyboard.press('Tab'))
  await at('tab → switch', () => page.keyboard.press('Tab'))
  await at('blur', () => page.evaluate(() => document.activeElement.blur()))
  await at('header divider', () => page.evaluate(() => document.querySelector('.astryx-layout-header').setAttribute('data-divider', 'true')))
  await at('both dividers', () => page.evaluate(() => document.querySelector('.astryx-layout-footer').setAttribute('data-divider', 'true')))
  await at('header back, footer divider', () => page.evaluate(() => document.querySelector('.astryx-layout-header').removeAttribute('data-divider')))
  return out
}

async function main() {
  const rewritten = rewriteAstryxHas(ORIGINAL)
  const browser = await chromium.launch({ executablePath: findChromium() })
  let fail = 0
  try {
    const page = await browser.newPage()
    const a = await run(page, ORIGINAL), b = await run(page, rewritten)
    for (const k of Object.keys(a)) {
      const ok = a[k] === b[k]
      if (!ok) fail++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(28)} ${a[k]}${ok ? '' : `   ≠ rewritten: ${b[k]}`}`)
    }
    // 比对得看得见差别:原版下每一步都改变了点什么(焦点环出现 / 换人 / 消失,内边距随分隔线变),没挂 marker 的那份始终 8px 8px。
    const v = Object.values(a)
    const sees = v.every((x, i) => i === 0 || x !== v[i - 1]) && v.every((x) => x.endsWith('| 8px 8px'))
    console.log(`${sees ? 'PASS' : 'FAIL'}  original CSS shows every effect (the comparison can see a difference)`)
    if (!sees) fail++
    const left = (rewritten.match(/:where\([^{}]*:has\(/g) || []).length, done = (rewritten.match(/@container style\(--astryx-has-/g) || []).length
    console.log(`${left === 0 && done === 6 ? 'PASS' : 'FAIL'}  rewritten ${done} rules (expect 6), ancestor-:has left ${left}`)
    if (left || done !== 6) fail++
  } finally { await browser.close() }
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
