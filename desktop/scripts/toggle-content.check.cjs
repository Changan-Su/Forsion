// 折叠块的特殊内容：内部新建、真实拖入、收起/展开、保存重开与撤销。
// node scripts/e2e-editor.cjs --check=toggle-content [--shot=/tmp/amadeus-toggle-content]
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const FOLD = `${PM} > blockquote.callout-fold`
const results = []
const shotDir = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice(7)
function check(name, ok, detail = '') {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`)
}
function chromiumPath() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing', 'Chromium']) {
      const p = path.join(root, dir, 'chrome-mac-arm64', `${app}.app/Contents/MacOS/${app}`)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 Chromium')
}
const tree = (p) => p.evaluate(() => window.__upage.probe.view().state.doc.toJSON())
const saved = async (p) => {
  await p.waitForTimeout(1200)
  return p.evaluate(() => window.__upage.writes.at(-1)?.text || '')
}
async function dragInto(p, source, target, copy = false) {
  const r = await p.locator(source).boundingBox()
  await p.mouse.move(r.x + 35, r.y + Math.min(10, r.height / 2), { steps: 4 })
  await p.waitForTimeout(300)
  await p.waitForFunction(() => document.querySelector('.unified-gutter')?.dataset.show === 'true')
  const h = await p.locator('.unified-gutter .drag-handle').boundingBox()
  const t = await p.locator(target).boundingBox()
  const x = t.x + t.width / 2, y = t.y + t.height - 3
  await p.mouse.move(h.x + h.width / 2, h.y + Math.min(10, h.height / 2))
  if (copy) await p.keyboard.down('Alt')
  await p.mouse.down()
  await p.mouse.move(h.x + h.width / 2 + 6, h.y + 15, { steps: 2 })
  await p.mouse.move(x, y, { steps: 12 })
  for (let i = 0; i < 12; i++) { await p.mouse.move(x, y); await p.waitForTimeout(20) }
  const lines = await p.evaluate(() => ({ lines: [...document.querySelectorAll('.unified-drop-line')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => ({ x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y })), dragging: !!window.__upage.probe.view().dragging, selection: window.__upage.probe.view().state.selection.toJSON() }))
  await p.mouse.up()
  if (copy) await p.keyboard.up('Alt')
  await p.waitForTimeout(450)
  return lines
}
async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  const errors = []
  const fresh = async (seed) => {
    const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`)
    await p.waitForSelector(FOLD)
    await p.waitForTimeout(350)
    return p
  }
  try {
    let p = await fresh('> [!fold]+ 收纳\n>\n> 正文\n\n外部段落')
    await p.locator(`${FOLD} > p`).nth(1).click()
    await p.keyboard.press('End')
    await p.keyboard.press('Enter')
    await p.keyboard.type('/')
    await p.locator('.slash-item').filter({ hasText: '代码块' }).first().click()
    await p.keyboard.type('const answer = 42;')
    check('折叠块内部 slash 新建代码块留在正文内', await p.locator(`${FOLD} > pre`).count() === 1, await tree(p))
    const md = await saved(p)
    check('新建代码块落盘仍属于折叠块', md.includes('> ```') && md.includes('> const answer = 42;'), md)
    await p.close()

    p = await fresh('> [!fold]+ 收纳\n>\n> 正文\n\n外部段落')
    await p.locator(`${FOLD} > p`).nth(1).click()
    await p.keyboard.press('End')
    await p.keyboard.press('Enter')
    await p.keyboard.type('```js')
    await p.keyboard.press('Enter')
    await p.keyboard.type('const typed = 2;')
    check('折叠正文键盘 fence 新建代码留在容器内', await p.locator(`${FOLD} > pre`).count() === 1, await tree(p))
    await p.close()

    p = await fresh('> [!fold]+ 收纳\n>\n> 正文\n\n外部段落')
    await p.locator(`${FOLD} > p`).nth(1).click()
    await p.keyboard.press('End')
    await p.keyboard.type(' /')
    await p.locator('.slash-item').filter({ hasText: '代码块' }).first().click()
    await p.keyboard.type('const inline = 3;')
    check('非空折叠正文 slash 新建代码也留在容器内', await p.locator(`${FOLD} > pre`).count() === 1, await tree(p))
    await p.close()

    p = await fresh('> [!fold]+ 收纳\n>\n> 正文\n\n```js\nconst dragged = 1;\n```\n\n外部段落')
    const lines = await dragInto(p, `${PM} > pre`, `${FOLD} > p:last-child`)
    check('真实拖动已有代码块进入折叠正文', await p.locator(`${FOLD} > pre`).count() === 1 && await p.locator(`${PM} > pre`).count() === 0, { lines, tree: await tree(p) })
    await p.close()

    p = await fresh('> [!fold]- 收纳\n>\n> 正文\n\n```js\nconst collapsed = 1;\n```\n\n外部段落')
    const collapsedLines = await dragInto(p, `${PM} > pre`, `${FOLD} > p:first-child`)
    check('拖入收起的折叠块会展开并收纳代码', await p.locator(`${FOLD} > pre`).count() === 1 && await p.locator(`${FOLD}.callout-collapsed`).count() === 0, { lines: collapsedLines, tree: await tree(p) })
    await p.keyboard.press('Meta+z')
    check('一次撤销拖入，代码归位且恢复收起状态', await p.locator(`${PM} > pre`).count() === 1 && await p.locator(`${FOLD}.callout-collapsed`).count() === 1, await tree(p))
    await p.keyboard.press('Meta+Shift+z')
    check('重做拖入同时展开折叠块', await p.locator(`${FOLD} > pre`).isVisible() && await p.locator(`${PM} > pre`).count() === 0)
    const dropMd = await saved(p)
    await p.locator(`${FOLD} > p:first-child > .callout-chevron`).click()
    await p.waitForTimeout(300)
    check('收纳代码后仍能完整收起', !await p.locator(`${FOLD} > pre`).isVisible())
    await p.locator(`${FOLD} > p:first-child > .callout-chevron`).click()
    await p.waitForTimeout(300)
    check('再次展开代码内容完整', await p.locator(`${FOLD} > pre`).isVisible() && (await p.locator(`${FOLD} > pre code`).innerText()).includes('const collapsed = 1;'))
    if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await p.screenshot({ path: path.join(shotDir, 'collapsed-drop.png') }) }
    await p.close()

    p = await fresh(dropMd)
    check('拖入代码保存重开后仍在折叠块内', await p.locator(`${FOLD} > pre`).isVisible() && await p.locator(`${PM} > pre`).count() === 0)
    await p.close()

    for (const [label, type, selector] of [['表格', 'table', 'table'], ['分割线', 'hr', 'hr'], ['数学公式', 'paragraph', '.math-preview'], ['按钮', 'code_block', '.unified-embed']]) {
      p = await fresh('> [!fold]+ 收纳\n>\n> 正文\n\n外部段落')
      await p.locator(`${FOLD} > p`).nth(1).click()
      await p.keyboard.press('End')
      await p.keyboard.type(' /')
      await p.locator('.slash-item').filter({ hasText: label }).first().click()
      if (label === '数学公式') { await p.keyboard.type('x^2'); await p.locator(`${PM} > p`).last().click() }
      await p.waitForTimeout(300)
      const doc = await tree(p)
      check(`非空折叠正文新建${label}留在容器内`, doc.content[0].content.slice(2).some((n) => n.type === type) && doc.content.length === 2, doc)
      if (label !== '数学公式') check(`折叠内${label}正常渲染`, await p.locator(`${FOLD} ${selector}`).isVisible())
      await p.close()
    }

    for (const [name, md, source, nested] of [
      ['表格', '| A | B |\n| --- | --- |\n| 1 | 2 |', `${PM} > table`, `${FOLD} table`],
      ['分隔线', '---', `${PM} > hr`, `${FOLD} > hr`],
    ]) {
      p = await fresh(`> [!fold]- 收纳\n>\n> 正文\n\n${md}\n\n外部段落`)
      const drop = await dragInto(p, source, `${FOLD} > p:first-child`)
      check(`真实拖入${name}并展开`, await p.locator(nested).isVisible() && await p.locator(`${FOLD}.callout-collapsed`).count() === 0, { drop, tree: await tree(p) })
      const movedMd = await saved(p)
      await p.close()
      p = await fresh(movedMd)
      check(`收纳${name}保存重开后结构完整`, await p.locator(nested).isVisible() && await p.locator(source).count() === 0, await tree(p))
      await p.close()
    }
    for (const blank of [true, false]) {
      p = await fresh('> [!fold]+ 收纳\n>\n> 正文\n\n外部段落')
      await p.locator(`${FOLD} > p`).nth(1).click()
      await p.keyboard.press('End')
      if (blank) await p.keyboard.press('Enter')
      await p.keyboard.type(blank ? '/' : ' /')
      await p.locator('.slash-item').filter({ hasText: '嵌入块引用' }).first().click()
      await p.locator('.dialog-input').fill('MissingNote')
      await p.locator('.dialog-input').press('Enter')
      await p.waitForTimeout(400)
      check(`${blank ? '空行' : '非空行'}异步嵌入块留在折叠正文`, await p.locator(`${FOLD} .unified-embed`).isVisible() && (await tree(p)).content.length === 2, await tree(p))
      await p.close()
    }

    p = await fresh('> [!fold]- 收纳\n>\n> 正文\n\n```js\nconst copied = 1;\n```\n\n外部段落')
    await dragInto(p, `${PM} > pre`, `${FOLD} > p:first-child`, true)
    check('Alt 拖入复制代码，原件与副本均完整', await p.locator(`${FOLD} > pre`).isVisible() && await p.locator(`${PM} > pre`).count() === 1, await tree(p))
    await p.close()

    p = await fresh('> [!fold]- 收纳\n>\n> 正文\n\n```js\nconst batch = 1;\n```\n\n一起收纳\n\n外部段落')
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let from, to
      v.state.doc.forEach((n, pos) => {
        if (n.type.name === 'code_block') from = pos + 1
        if (n.textContent === '一起收纳') to = pos + n.nodeSize - 1
      })
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.between(v.state.doc.resolve(from), v.state.doc.resolve(to))))
    })
    await dragInto(p, `${PM} > pre`, `${FOLD} > p:first-child`)
    check('多块拖入折叠正文按整块收纳', await p.locator(`${FOLD} > pre`).isVisible() && (await p.locator(`${FOLD} > p`).allTextContents()).includes('一起收纳') && await p.locator(`${PM} > pre`).count() === 0, await tree(p))
    await p.close()

    p = await fresh('> [!fold]+ 外层\n>\n> > [!fold]- 内层\n> >\n> > 正文\n\n```js\nconst nested = 1;\n```\n\n外部段落')
    await dragInto(p, `${PM} > pre`, `${FOLD} > blockquote > p:first-child`)
    check('拖入嵌套折叠块准确进入内层', await p.locator(`${FOLD} > blockquote > pre`).isVisible() && await p.locator(`${FOLD} > blockquote.callout-collapsed`).count() === 0, await tree(p))
    await p.close()

    p = await fresh('> [!fold]- 目标\n>\n> 目标正文\n\n> [!fold]- 搬动\n>\n> 保持隐藏\n\n外部段落')
    await dragInto(p, `${PM} > blockquote:nth-of-type(2)`, `${PM} > blockquote:first-of-type > p:first-child`)
    check('整只折叠块拖入后，外层展开而子折叠状态保留', await p.locator(`${FOLD} > blockquote.callout-collapsed`).count() === 1 && await p.locator(FOLD).count() === 1 && await p.locator(`${FOLD}.callout-collapsed`).count() === 0, await tree(p))
    await p.keyboard.press('Meta+z')
    check('嵌套搬动一次撤销完整恢复两只折叠块', await p.locator(`${FOLD}.callout-collapsed`).count() === 2 && await p.locator(`${FOLD} > blockquote`).count() === 0, await tree(p))
    await p.close()

    if (shotDir) {
      p = await fresh('> [!fold]+ 特殊内容\n>\n> ```js\n> const answer = 42;\n> ```\n>\n> | 项目 | 内容 |\n> | --- | --- |\n> | 代码 | 可收纳 |\n>\n> ---\n>\n> $$ x^2 $$\n\n外部段落')
      await p.waitForTimeout(700)
      await p.screenshot({ path: path.join(shotDir, 'light.png') })
      await p.setViewportSize({ width: 520, height: 900 })
      await p.screenshot({ path: path.join(shotDir, 'narrow.png') })
      check('窄窗口特殊内容无横向溢出', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await p.close()
    }
    check('页面无运行时错误', errors.length === 0, errors)
  } finally { await browser.close() }
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`)
  process.exitCode = failed ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
