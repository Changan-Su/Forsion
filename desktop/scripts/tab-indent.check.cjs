// Amadeus Tab:任务列表首项、标题、引用/callout 的结构缩进与落盘往返。
// 用法: npm run check:tabindent (e2e-editor.cjs 自起/复用本地 harness)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function chromiumExe() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) {
    const exe = path.join(root, dir, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 Chromium；可设置 CHROMIUM_EXE')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` | ${detail}`}`)
  if (!ok) failures++
}

async function main() {
  const browser = await chromium.launch({ executablePath: chromiumExe(), headless: true })
  const cases = [
    ['待办首项', '- [ ] first', 'li', 'UL'],
    ['有序列表首项', '1. first', 'li', 'OL'],
    ['标题', '# heading', 'h1', 'H1'],
    ['引用', '> quote', 'blockquote p', 'BLOCKQUOTE'],
    ['callout', '> [!note] title', 'blockquote p', 'BLOCKQUOTE'],
    ['折叠块', '> [!fold]- title', 'blockquote p', 'BLOCKQUOTE'],
  ]
  for (const unified of [false, true]) {
    const mode = unified ? 'v4' : 'v3'
    const root = unified ? '.unified-body .ProseMirror' : '.md-block .ProseMirror'
    const open = async (seed) => {
      const page = await browser.newPage({ locale: 'zh-CN' })
      const query = unified ? `upage&useed=${encodeURIComponent(seed)}` : `seed=${encodeURIComponent(seed)}`
      await page.goto(`${URL}?${query}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(root, { timeout: 20000 })
      return page
    }
    const stored = async (page) => {
      if (unified) {
        return page.evaluate(() => {
          window.__upage.probe.flush?.()
          return window.__upage.probe.fmState?.().body ?? ''
        })
      }
      await page.waitForTimeout(420)
      return page.evaluate(() => window.__harness.blocks[0].content)
    }
    for (const [name, seed, target, tag] of cases) {
      const page = await open(seed)
      await page.locator(`${root} ${target}`).first().click()
      await page.keyboard.press('Tab')
      const first = await page.evaluate((selector) => {
        const el = document.querySelector(`${selector} [data-indent]`)
        return { tag: el?.tagName, indent: el?.getAttribute('data-indent'), margin: el ? parseFloat(getComputedStyle(el).marginLeft) : 0, focused: !!document.activeElement?.closest?.('.ProseMirror') }
      }, root)
      const md = await stored(page)
      check(`${mode} ${name} Tab 缩进并落盘`, first.tag === tag && first.indent === '1' && first.margin > 0 && first.focused && md.includes('<!-- amadeus-indent:1 -->'), JSON.stringify({ first, md }))

      const reopened = await open(md)
      const roundtrip = await reopened.evaluate((selector) => ({ indent: document.querySelector(`${selector} [data-indent]`)?.getAttribute('data-indent'), markers: document.querySelector(`${selector}`)?.textContent?.includes('amadeus-indent') }), root)
      check(`${mode} ${name} 重开恢复缩进且不露标记`, roundtrip.indent === '1' && !roundtrip.markers, JSON.stringify(roundtrip))
      await reopened.close()

      await page.keyboard.press('Tab')
      const second = await page.locator(`${root} [data-indent]`).first().getAttribute('data-indent')
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Shift+Tab')
      const zero = await stored(page)
      const restored = await page.locator(`${root} ${tag.toLowerCase()}`).count()
      check(`${mode} ${name} 多档 Tab/Shift+Tab 对称且保留块类型`, second === '2' && restored > 0 && !zero.includes('amadeus-indent'), JSON.stringify({ second, zero, restored }))
      await page.close()
    }

    const nested = await open('- [ ] first\n\n- [x] second')
    await nested.locator(`${root} li`).nth(1).click()
    await nested.keyboard.press('Tab')
    const nestedState = await nested.evaluate((selector) => ({ inner: document.querySelectorAll(`${selector} ul ul li[data-item-type="task"]`).length, marker: document.querySelector(`${selector} [data-indent]`) != null }), root)
    check(`${mode} 非首待办继续使用原生嵌套列表`, nestedState.inner === 1 && !nestedState.marker, JSON.stringify(nestedState))
    await nested.close()

    const mixed = await open('plain\n\n# heading\n\n- [ ] task\n\n> quote')
    await mixed.evaluate((selector) => {
      const pm = document.querySelector(selector)
      const first = pm.querySelector(':scope > p').firstChild
      const last = pm.querySelector(':scope > blockquote p').firstChild
      const range = document.createRange()
      range.setStart(first, 0)
      range.setEnd(last, last.textContent.length)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    }, root)
    await mixed.waitForTimeout(150)
    await mixed.keyboard.press('Tab')
    const moved = await mixed.locator(root).evaluate((pm) => [...pm.children].map((node) => [node.tagName, node.getAttribute('data-indent')]))
    await mixed.keyboard.press('Shift+Tab')
    const restored = await mixed.locator(root).evaluate((pm) => [...pm.children].map((node) => [node.tagName, node.getAttribute('data-indent')]))
    check(`${mode} 混合多块选区逐块缩进并整体退回`, moved.length === 4 && moved.every(([, indent]) => indent === '1') && restored.every(([, indent]) => indent == null), JSON.stringify({ moved, restored }))
    await mixed.close()

    if (unified) {
      for (const [name, seed] of [['Markdown 图片', '![alt](x.png)'], ['双链图片', '![[x.png]]'], ['数据库嵌入', '![[a.db]]']]) {
        const page = await open(seed)
        await page.locator(root).click({ position: { x: 5, y: 5 }, force: true })
        await page.keyboard.press('Tab')
        const para = await page.locator(`${root} > p[data-indent="1"]`).count()
        const md = await stored(page)
        check(`v4 ${name} 所在段落可缩进且保留引用`, para === 1 && md.startsWith('\t') && md.includes(seed), JSON.stringify({ para, md }))
        await page.close()
      }
    }
  }
  await browser.close()
  console.log(`tab-indent: ${failures ? `${failures} failed` : 'all passed'}`)
  if (failures) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
