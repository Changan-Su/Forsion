// 自动识别、手动优先、纯文本、动态编辑、折叠块与原生 Markdown 保存。
// npm run check:codelanguage -- --shot=/tmp/amadeus-code-language
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')
const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = [], errors = []
const shotDir = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice(7)
function check(name, ok, detail) {
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
const seed = (code, lang = '') => `开头段落\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n末尾段落`
const read = (p) => p.evaluate(() => {
  const v = window.__upage.probe.view()
  const pre = v.dom.querySelector('pre')
  const sel = pre?.querySelector('select')
  let node
  v.state.doc.descendants((n) => { if (!node && n.type.name === 'code_block') node = n; return !node })
  return { requested: node?.attrs.language, text: node?.textContent, detected: pre?.dataset.detectedLanguage || '',
    option: sel?.value, label: sel?.selectedOptions[0]?.textContent, highlighted: pre?.querySelectorAll('code [class*="hljs-"]').length,
    md: window.__upage.probe.serializeNow(), writes: window.__upage.writes.length }
})
async function replaceCode(p, text) {
  await p.evaluate(() => {
    const v = window.__upage.probe.view()
    let node, at
    v.state.doc.descendants((n, pos) => { if (!node && n.type.name === 'code_block') { node = n; at = pos } return !node })
    v.focus()
    v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at + 1, at + node.nodeSize - 1)))
  })
  await p.evaluate((text) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    window.__upage.probe.view().dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
  await p.waitForTimeout(250)
}
async function main() {
  const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true })
  const fresh = async (md, locale = 'zh-CN', width = 1100) => {
    const p = await browser.newPage({ locale, viewport: { width, height: 800 } })
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(md)}`)
    await p.waitForSelector(`${PM} pre`)
    await p.waitForTimeout(400)
    return p
  }
  try {
    let p = await fresh(seed('const answer = 42;'))
    let r = await read(p)
    check('无语言 fence 自动识别并显示 JavaScript 高亮', r.detected === 'javascript' && r.highlighted > 0 && r.label === '自动 · JS', r)
    check('自动识别不写入语言标记、不触发保存', !r.requested && !r.md.includes('```javascript') && r.writes === 0, r)
    await replaceCode(p, 'def greet(name):\n    print(f"Hello, {name}")\n\ngreet("Forsion")')
    r = await read(p)
    check('替换代码后识别结果和高亮同步更新', r.detected === 'python' && r.highlighted > 0 && r.label === '自动 · python', r)
    await p.locator(`${PM} select.amx-code-lang`).selectOption('javascript')
    await replaceCode(p, 'def hello():\n    return "Hello"')
    r = await read(p)
    check('手动指定语言始终优先，继续输入不覆盖', r.requested === 'javascript' && r.option === 'javascript' && !r.detected && r.md.includes('```javascript'), r)
    await p.locator(`${PM} select.amx-code-lang`).selectOption('plaintext')
    r = await read(p)
    check('纯文本关闭高亮并保存原生 plaintext 标记', r.requested === 'plaintext' && !r.highlighted && !r.detected && r.md.includes('```plaintext'), r)
    await p.waitForTimeout(1200)
    const saved = await p.evaluate(() => window.__upage.writes.at(-1)?.text)
    await p.close()
    p = await fresh(saved)
    r = await read(p)
    check('保存重开保留纯文本选择', r.option === 'plaintext' && r.label === '纯文本' && !r.highlighted, r)
    await p.locator(`${PM} select.amx-code-lang`).selectOption('')
    r = await read(p)
    check('可切回自动并重新识别，移除显式标记', !r.requested && r.detected === 'python' && !r.md.includes('```plaintext'), r)
    await p.evaluate(() => window.__upage.probe.view().focus())
    await p.keyboard.press('Meta+z')
    r = await read(p)
    check('撤销语言选择恢复纯文本且移除高亮', r.requested === 'plaintext' && !r.highlighted && !r.detected, r)
    await p.close()

    p = await fresh(seed('hello world'))
    r = await read(p)
    check('短句无法可靠识别时保留自动且不乱上色', !r.detected && !r.highlighted && r.label === '自动', r)
    await replaceCode(p, 'const typed = 1;')
    check('从未识别内容继续输入可进入自动高亮', (await read(p)).detected === 'javascript')
    const runs = () => p.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/amadeus\/blocks\/markdown\/codeBlock\.ts(\?|$)/.test(n))
      return (await import(url)).codeHighlightRuns()
    })
    const before = await runs()
    await p.locator(`${PM} > p`).first().click()
    await p.keyboard.press('End')
    await p.keyboard.type(' abc')
    await p.keyboard.press('ArrowLeft')
    await p.keyboard.press('ArrowRight')
    const after = await runs()
    check('块外输入和选区变化不重复识别', before === after, { before, after })
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let at
      v.state.doc.descendants((n, pos) => { if (at === undefined && n.type.name === 'code_block') at = pos + 1 + n.textContent.length; return at === undefined })
      v.focus()
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
    })
    const beforeInside = await runs()
    await p.keyboard.type('x')
    const afterInside = await runs()
    check('块内真实键盘输入每键只重算一次', afterInside - beforeInside === 1, { beforeInside, afterInside })
    await p.close()

    for (const lang of ['text', 'txt', 'plaintext', 'custom-language']) {
      p = await fresh(seed('const answer = 42;', lang))
      r = await read(p)
      check(`已有 ${lang} 标记保留且不转自动`, r.requested === lang && r.option === lang && !r.detected && !r.highlighted, r)
      await p.close()
    }
    p = await fresh('> [!fold]+ 自动语言\n>\n> ```\n> {"name": "Forsion", "enabled": true, "count": 42}\n> ```\n\n外部段落')
    r = await read(p)
    check('折叠块内无语言代码自动识别 JSON', r.detected === 'json' && r.highlighted > 0 && await p.locator(`${PM} blockquote > pre`).count() === 1, r)
    await p.locator(`${PM} blockquote > p`).first().click()
    await p.locator(`${PM} .callout-chevron`).click()
    check('收起折叠块仍保留隐藏代码内容', (await read(p)).text.includes('Forsion') && await p.locator(`${PM} .callout-collapsed`).count() === 1)
    await p.locator(`${PM} .callout-chevron`).click()
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true })
      await p.locator(`${PM} pre`).hover()
      await p.waitForTimeout(250)
      await p.screenshot({ path: path.join(shotDir, 'fold-json.png') })
    }
    await p.close()
    p = await fresh(seed('const answer = 42;'), 'en-US', 560)
    r = await read(p)
    check('英文界面显示 Auto 及 Plain text 选项', r.label === 'Auto · JS' && await p.locator(`${PM} option[value="plaintext"]`).textContent() === 'Plain text', r)
    await p.locator(`${PM} pre`).hover()
    await p.waitForTimeout(250)
    const over = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    check('窄窗口语言识别工具条无页面横向溢出', !over)
    if (shotDir) await p.screenshot({ path: path.join(shotDir, 'narrow-en.png') })
    await p.close()
    check('无浏览器运行错误', !errors.length, errors)
  } finally { await browser.close() }
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
  process.exitCode = results.every(Boolean) ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
