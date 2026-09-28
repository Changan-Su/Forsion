// [[ / @ 补全面板的回归仪器(npm run check:wikisuggest;真 Chromium × 生产 UnifiedPage 台架)。
// 由来:2026-09-27 编辑器评审 L-02/L-03/L-04/L-08,四条都只在真浏览器里量得出来:
//   L-02 在已闭合的 [[链接]] 里改目标名,选中候选后变成 `[[新名]]旧尾]]` —— 须只替换目标名,保留 #锚点/|别名;
//   L-03 代码块 / 行内代码里的 [[ 与 @ 照样弹面板、劫持 Enter/Tab —— 代码里须恒字面;
//   L-04 编辑器失焦后面板不关、继续在 window 捕获阶段劫持 ↑↓/Enter —— 失焦即关,按键只在编辑器持焦时拦;
//   L-08 输入法组字时 ↓/Enter 被面板抢走(拼音选词回车直接插入候选)—— 组字一律放行。
//        合成 KeyboardEvent 的 isComposing 到不了页面,必须走 CDP Input.imeSetComposition 起真组合。
// 用法:npm run check:wikisuggest(自带起停 vite);或已起 vite 后 HARNESS_URL=… node scripts/wiki-suggest.check.cjs
//       ONLY=L-04 只跑某一节。
const fs = require('fs')
const os = require('os')
const path = require('path')
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

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
// ONLY=L-04 只跑一节(逗号分隔多节),负对照时省时间。
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
const tryTest = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return
  try {
    await fn()
  } catch (e) {
    check(`${name}(异常)`, false, String((e && e.message) || e).slice(0, 160))
  }
}

async function open(browser, md, pages) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${BASE}?upage&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(400)
  // 走 harness 挂的 window.__pageStore:`import('/src/…/pageStore.ts')` 在 vite HMR 之后会拿到
  // 不带 `?t=` 的另一份模块实例,候选池静默为空(自己踩过)。
  await page.evaluate((pages) => window.__pageStore.setState({ pages, files: [] }), pages)
  return page
}
/** 真鼠标点到第 n 个顶层段落的行尾(编辑器真持焦)。 */
async function clickEnd(page, sel) {
  const c = await page.evaluate((s) => {
    const el = document.querySelector(s)
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    return { x: b.right - 1, y: b.top + b.height / 2 }
  }, sel)
  await page.mouse.click(c.x, c.y)
  await page.waitForTimeout(150)
}
const items = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.wiki-suggest .wiki-item')].map((e) => (e.dataset.active !== undefined ? '*' : '') + e.textContent))
const popupCount = (page) => page.locator('.wiki-suggest').count()
/** 落盘文本(防抖 ~800ms 后)。 */
async function saved(page) {
  await page.waitForTimeout(1300)
  return page.evaluate(() => {
    const w = window.__upage.writes
    return w.length ? w[w.length - 1].text : null
  })
}
const docText = (page) => page.evaluate(() => window.__upage.probe.view().state.doc.textContent)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const PAGES = ['Alpha.md', 'Beta.md', 'Unified.md']

  // ── L-02:已闭合链接里改目标名 → 只替换目标名这一段 ──
  // 光标进链接 = 行首 Meta+← 再 → 若干格(`see [[` 共 6 格);在里面打字才弹(T38 契约)。
  const editLink = async (md, rightN, act) => {
    const page = await open(browser, md, PAGES)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.press('Meta+ArrowLeft')
    for (let i = 0; i < rightN; i++) await page.keyboard.press('ArrowRight')
    await act(page)
    await page.keyboard.type('Be', { delay: 30 })
    await page.waitForTimeout(250)
    const shown = await items(page)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    await page.keyboard.type('Z', { delay: 30 }) // 光标应落在 `]]` 之后
    const out = await saved(page)
    await page.close()
    return { shown, out }
  }
  await tryTest('L-02', async () => {
    let r = await editLink('# T\n\nsee [[Alpha]] end\n', 6, async () => {})
    check('L-02a 旧名前打字弹候选', r.shown[0] === '*Beta', JSON.stringify(r.shown))
    check('L-02a 旧名被整段替换,不留 `Alpha]]` 尾巴', r.out === '# T\n\nsee [[Beta]]Z end\n', JSON.stringify(r.out))
    r = await editLink('# T\n\nsee [[Alpha]] end\n', 11, async (p) => {
      for (let i = 0; i < 5; i++) await p.keyboard.press('Backspace')
    })
    check('L-02b 删光旧名重打 → 不叠第二个 `]]`', r.out === '# T\n\nsee [[Beta]]Z end\n', JSON.stringify(r.out))
    r = await editLink('# T\n\nsee [[Alpha|al]] end\n', 6, async (p) => {
      for (let i = 0; i < 5; i++) await p.keyboard.press('Shift+ArrowRight')
    })
    check('L-02c 带别名:只换目标名,别名保留', r.out === '# T\n\nsee [[Beta|al]]Z end\n', JSON.stringify(r.out))
    r = await editLink('# T\n\nsee [[Alpha#Sec|al]] end\n', 6, async () => {})
    check('L-02d 带锚点+别名:锚点与别名都保留', r.out === '# T\n\nsee [[Beta#Sec|al]]Z end\n', JSON.stringify(r.out))
    // 光标在别名里打字 = 在改别名,不是改目标 → 不给目标候选
    const page = await open(browser, '# T\n\nsee [[Alpha|al]] end\n', PAGES)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.press('Meta+ArrowLeft')
    for (let i = 0; i < 14; i++) await page.keyboard.press('ArrowRight') // `see [[Alpha|al` 之后
    await page.keyboard.type('x', { delay: 30 })
    await page.waitForTimeout(250)
    check('L-02e 在 |别名 里打字不弹目标候选', (await popupCount(page)) === 0, JSON.stringify(await items(page)))
    await page.close()
  })

  // ── L-03:代码块 / 行内代码里 [[ 与 @ 恒字面,不弹面板、不劫持 Enter/Tab ──
  await tryTest('L-03', async () => {
    const PAGES3 = ['Alpha.md', 'Beta.md', 'Test plan.md']
    const codeText = (p) => p.evaluate(() => {
      let t = null
      window.__upage.probe.view().state.doc.descendants((n) => { if (n.type.name === 'code_block') t = n.textContent })
      return t
    })
    let page = await open(browser, '# T\n\n```bash\necho hi\n```\n\npara\n', PAGES3)
    const c = await page.evaluate((PM) => {
      const e = document.querySelector(PM + ' pre code') || document.querySelector(PM + ' pre')
      const r = document.createRange()
      r.selectNodeContents(e)
      const rects = r.getClientRects()
      const b = rects[rects.length - 1]
      return { x: b.right - 1, y: b.top + b.height / 2 }
    }, PM)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(150)
    await page.keyboard.press('Enter')
    await page.keyboard.type('if [[ -f x', { delay: 20 })
    await page.waitForTimeout(200)
    check('L-03a 代码块里 `[[` 不弹面板', (await popupCount(page)) === 0, JSON.stringify(await items(page)))
    await page.keyboard.press('Enter')
    await page.keyboard.type('x=[[ab', { delay: 20 })
    await page.waitForTimeout(150)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await page.keyboard.type('@Test', { delay: 20 })
    await page.waitForTimeout(200)
    check('L-03b 代码块里 `@Test` 不弹提及面板', (await popupCount(page)) === 0, JSON.stringify(await items(page)))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    const code = await codeText(page)
    check('L-03c 代码块里 Enter/Tab 照常落进代码(不被补全吞成 [[…]])',
      typeof code === 'string' && code.startsWith('echo hi\nif [[ -f x\nx=[[ab') && code.includes('@Test\n') && !code.includes(']]'),
      JSON.stringify(code))
    await page.close()

    page = await open(browser, '# T\n\nuse `x` here\n', PAGES3)
    const ic = await page.evaluate((PM) => {
      const e = document.querySelector(PM + ' code')
      const r = document.createRange()
      r.selectNodeContents(e)
      const b = r.getBoundingClientRect()
      return { x: b.right - 1, y: b.top + b.height / 2 }
    }, PM)
    await page.mouse.click(ic.x, ic.y)
    await page.waitForTimeout(100)
    const inCodeMark = await page.evaluate(() => window.__upage.probe.view().state.selection.$head.marks().some((m) => m.type.spec.code))
    await page.keyboard.type('[[al', { delay: 20 })
    await page.waitForTimeout(200)
    check('L-03d 行内代码里 `[[` 不弹面板', inCodeMark && (await popupCount(page)) === 0, `inCode=${inCodeMark} ${JSON.stringify(await items(page))}`)
    await page.keyboard.type(' @Al', { delay: 20 })
    await page.waitForTimeout(200)
    check('L-03e 行内代码里 `@` 不弹提及面板', (await popupCount(page)) === 0, JSON.stringify(await items(page)))
    await page.keyboard.press('Enter')
    const out = await saved(page)
    check('L-03f 行内代码原样落盘(未被改写成双链)', typeof out === 'string' && out.includes('`x[[al @Al`') && !out.includes(']]'), JSON.stringify(out))
    await page.close()

    // slash 同一根因:行内代码里 ` /h` 不弹命令菜单(对照:正文里照弹)
    page = await open(browser, '# T\n\nuse `x` here\n', PAGES3)
    await page.mouse.click(ic.x, ic.y)
    await page.waitForTimeout(100)
    await page.keyboard.type(' /h', { delay: 20 })
    await page.waitForTimeout(200)
    check('L-03g 行内代码里 ` /h` 不弹 slash 菜单', (await page.locator('.slash-menu').count()) === 0)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/h', { delay: 20 })
    await page.waitForTimeout(200)
    check('L-03g 对照:正文行首 `/h` 照弹 slash 菜单', (await page.locator('.slash-menu').count()) === 1)
    await page.close()
  })

  // ── L-04:编辑器失焦即关,按键不再被全局劫持;Esc 闩锁不因失焦而清 ──
  await tryTest('L-04', async () => {
    const bodyText = (p) => p.evaluate(() => window.__upage.probe.view().state.doc.textContent)
    const recordTitleKeys = (p) => p.evaluate(() => {
      window.__titleKeys = []
      document.querySelector('.amx-title-input').addEventListener('keydown', (e) => window.__titleKeys.push(e.key))
    })
    // a:点空白处失焦 → 面板关,Enter 不再往正文插链接
    let page = await open(browser, '# T\n\nx\n', PAGES)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.type(' [[Al', { delay: 20 })
    await page.waitForTimeout(200)
    const before = await popupCount(page)
    await page.mouse.click(5, 880)
    await page.waitForTimeout(300)
    check('L-04a 点空白失焦 → [[ 面板关', before === 1 && (await popupCount(page)) === 0, `before=${before} after=${await popupCount(page)}`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    check('L-04a 失焦后 Enter 不再往正文插链接', !(await bodyText(page)).includes('[[Alpha]]'), JSON.stringify(await bodyText(page)))
    // 回到编辑器接着写:面板照常回来(闸只管失焦,不把补全一起废掉)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.type('p', { delay: 20 })
    await page.waitForTimeout(250)
    check('L-04a 回到编辑器接着打字 → 面板照常回来', (await items(page))[0] === '*Alpha', JSON.stringify(await items(page)))
    await page.close()

    // b:点标题框 → 面板关,Enter 落进标题框(↓ 在标题框里本身会走进正文,单测 Enter;↓ 见 c)
    page = await open(browser, '# T\n\nx\n', PAGES)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.type(' [[Al', { delay: 20 })
    await page.waitForTimeout(200)
    await page.click('.amx-title-input')
    await page.waitForTimeout(300)
    check('L-04b 点标题框 → [[ 面板关', (await popupCount(page)) === 0)
    await recordTitleKeys(page)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const keys = await page.evaluate(() => window.__titleKeys)
    check('L-04b Enter 落进标题框(不被面板吞)', keys.includes('Enter'), JSON.stringify(keys))
    check('L-04b 标题框里的 Enter 不往正文插链接', !(await bodyText(page)).includes('[[Alpha]]'), JSON.stringify(await bodyText(page)))
    await page.close()

    // c:slash 菜单同一根因
    page = await open(browser, '# T\n\nx\n', PAGES)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.type(' /h', { delay: 20 })
    await page.waitForTimeout(200)
    const sBefore = await page.locator('.slash-menu').count()
    await page.click('.amx-title-input')
    await page.waitForTimeout(300)
    check('L-04c 点标题框 → slash 菜单关', sBefore === 1 && (await page.locator('.slash-menu').count()) === 0, `before=${sBefore}`)
    await recordTitleKeys(page)
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(150)
    check('L-04c ↓ 落进标题框(不被 slash 菜单吞)', (await page.evaluate(() => window.__titleKeys)).includes('ArrowDown'))
    await page.close()

    // d:@ 面板 Esc 掉 → 失焦 → 点回同一处:被 Esc 的同一个 @ 不重弹(失焦不清闩锁)
    page = await open(browser, '# T\n\nx\n', PAGES)
    await clickEnd(page, `${PM} > p`)
    await page.keyboard.type(' @Al', { delay: 20 })
    await page.waitForTimeout(200)
    const mBefore = await popupCount(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    await page.click('.amx-title-input')
    await page.waitForTimeout(250)
    await clickEnd(page, `${PM} > p`)
    await page.waitForTimeout(250)
    check('L-04d Esc 掉的 @ 面板失焦再回来不重弹', mBefore === 1 && (await popupCount(page)) === 0, `before=${mBefore} after=${await popupCount(page)}`)
    await page.close()
  })

  // ── L-08:输入法组字中 ↓ / Enter 放行给输入法,不被面板抢走 ──
  // 合成键的 isComposing 到不了页面:CDP imeSetComposition 起真组合,再派 keyCode 229 的 ↓ / Enter。
  await tryTest('L-08', async () => {
    const PAGES8 = ['Alpha.md', 'Alpine.md', 'Unified.md']
    const imeRun = async (trigger) => {
      const page = await open(browser, '# T\n\nx\n', PAGES8)
      await clickEnd(page, `${PM} > p`)
      await page.keyboard.type(trigger, { delay: 20 })
      await page.waitForTimeout(250)
      const opened = await popupCount(page)
      const s = await page.context().newCDPSession(page)
      await s.send('Input.imeSetComposition', { text: 'ha', selectionStart: 2, selectionEnd: 2 })
      await page.waitForTimeout(250)
      const k = async (key) => {
        await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: 229 })
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: 229 })
        await page.waitForTimeout(150)
      }
      const composing = await items(page)
      await k('ArrowDown')
      const afterDown = await items(page)
      await k('Enter')
      await page.waitForTimeout(150)
      const doc = await docText(page)
      await page.close()
      return { opened, composing, afterDown, doc }
    }
    let r = await imeRun(' [[Al')
    check('L-08a [[ 组字中 ↓ 不移动面板高亮', r.opened === 1 && r.afterDown.length > 0 && r.afterDown[0].startsWith('*'), `${JSON.stringify(r.composing)} → ${JSON.stringify(r.afterDown)}`)
    check('L-08a [[ 组字中 Enter 不插入候选', !r.doc.includes(']]'), JSON.stringify(r.doc))
    r = await imeRun(' @Al')
    check('L-08b @ 组字中 Enter 不插入候选', r.opened === 1 && !r.doc.includes('[['), JSON.stringify(r.doc))
  })

  const fails = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  await browser.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
