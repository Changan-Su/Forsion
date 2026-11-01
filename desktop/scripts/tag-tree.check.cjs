// 标签树、tag: 行级搜索、ChatBox 插槽的回归仪器(npm run check:tagtree;真 Chromium × 生产组件)。
//   T 标签树:成树、计数含子标签、筛选自动展开、排序和展开状态、点名字跳 tag: 搜索。
//   S 逐行结果:文件名 + 处数、#标签 胶囊、点普通关键词不变。
//   R 定位:v4 笔记里逐字相同的两条闪念各落各的,按命中的全名回退。
//   C ChatBox:真键盘 + 真输入法组合,浮层贴光标、样式不丢、Enter 选中不提交、toolbar / modelPicker / insertText。
// 用法:npm run check:tagtree(自带起停 vite);已起 vite 后 HARNESS_URL=… node scripts/tag-tree.check.cjs。
// SHOTS=<目录> 留截图。
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
const SHOTS = process.env.SHOTS
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
// 等入场动效放完再拍:半途的浮层是半透明的,看着像压在卡片底下
const shot = async (page, name, clip) => { if (SHOTS) { await page.waitForTimeout(350); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip }) } }

const newPage = async (browser) => {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 720 } })
  page.on('pageerror', (e) => check(`pageerror: ${e.message}`, false))
  return page
}

const treeRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-panel="tags"] .amx-tagtree-row')].map((r) => {
  const depth = getComputedStyle(r).getPropertyValue('--amx-tag-depth').trim()
  return `${depth}:${r.querySelector('.amx-tag-name').textContent}:${r.querySelector('.amx-tag-count').textContent}`
}))

async function panels(browser) {
  const page = await newPage(browser)
  await page.goto(`${BASE}?tagpanels`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.amx-tagtree-row', { timeout: 120000 })
  const rows = await treeRows(page)
  check('T1 顶层成组,父级计数含子标签(只作父级的 产品、Forsion 也在)',
    JSON.stringify(rows) === JSON.stringify(['0:产品:2', '0:设计:2', '0:读书:1', '0:Forsion:1']), rows.join(' '))
  const openChev = page.locator('[data-panel="tags"] .amx-tagtree-row', { hasText: '产品' }).locator('.amx-tagtree-chev')
  await openChev.click()
  await page.waitForTimeout(400)
  check('T2 点箭头展开子标签,不跳搜索', (await treeRows(page)).includes('1:路线图:2') && (await page.locator('[data-panel="search"] input').inputValue()) === '')
  await shot(page, 'tree', { x: 0, y: 0, width: 300, height: 400 })
  await page.getByRole('button', { name: '按名称', exact: true }).click()
  const byName = (await treeRows(page)).filter((r) => r.startsWith('0:')).map((r) => r.split(':')[1])
  check('T3 按名称排序', byName.join(' ') === '产品 读书 设计 Forsion', byName.join(' ')) // zh-CN 下 localeCompare 中文排前
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('amadeus_prefs:')).map((k) => localStorage.getItem(k)).join(''))
  check('T4 排序与展开写进 prefs', /"tagSort":"name"/.test(stored) && /"tagExpanded":\["产品"\]/.test(stored), stored.slice(0, 120))
  await page.locator('[data-panel="tags"] input').fill('闪念')
  await page.waitForTimeout(400)
  const filtered = await treeRows(page)
  check('T5 筛选只留命中与祖先,祖先自动展开', filtered.join(',') === '0:Forsion:1,1:闪念盒:1', filtered.join(' '))
  await page.locator('[data-panel="tags"] input').fill('')
  await page.waitForTimeout(300)
  check('T6 清掉筛选回到自己的展开状态', !(await treeRows(page)).some((r) => r.includes('闪念盒')))

  await page.locator('[data-panel="tags"] .amx-tagtree-row', { hasText: '路线图' }).locator('.amx-list-item').click()
  await page.waitForSelector('.amx-taghit-line')
  check('S1 点名字把全名种进搜索', (await page.locator('[data-panel="search"] input').inputValue()) === 'tag:#产品/路线图')
  const files = await page.locator('.amx-taghit-file').allTextContents()
  check('S2 文件名 + 处数', files.join('|') === '2026-102|Plan2', files.join('|'))
  check('S3 头部总数', (await page.locator('.amx-taghit-cap').textContent()) === '2 个文件 · 4 处')
  const pill = await page.locator('.amx-taghit-pill').first().evaluate((el) => {
    const c = getComputedStyle(el)
    return { bg: c.backgroundColor, border: c.borderTopStyle, radius: c.borderTopLeftRadius }
  })
  check('S4 胶囊有底色、无描边', pill.bg !== 'rgba(0, 0, 0, 0)' && pill.border === 'none', JSON.stringify(pill))
  check('S5 frontmatter 行', (await page.locator('.amx-taghit-line').allTextContents()).includes('tags: #产品/路线图'))
  await shot(page, 'search', { x: 280, y: 0, width: 330, height: 420 })
  await page.locator('[data-panel="search"] input').fill('卡片')
  await page.waitForSelector('.amx-taghit-line', { state: 'detached' })
  check('S6 普通查询不画逐行结果', (await page.locator('[data-panel="search"] .amx-list-item').count()) === 1 && (await page.locator('.amx-taghit-cap').count()) === 0)
  await page.close()

  const dark = await newPage(browser)
  await dark.goto(`${BASE}?tagpanels&dark`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await dark.waitForSelector('.amx-tagtree-row', { timeout: 120000 })
  await dark.locator('[data-panel="tags"] .amx-tagtree-row', { hasText: '设计' }).locator('.amx-list-item').click()
  await dark.waitForSelector('.amx-taghit-line')
  await shot(dark, 'panels-dark', { x: 0, y: 0, width: 620, height: 400 })
  await dark.close()
}

async function reveal(browser) {
  const md = '### 2026-10-29\n\n买牛奶 #待办\n\n### 2026-10-28\n\n买牛奶 #待办\n\n### 2026-10-27\n\n看 [[Target|目标]] 这篇 #待办/读\n'
  const page = await newPage(browser)
  await page.goto(`${BASE}?upage&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
  await page.waitForFunction(() => !!window.__upage?.lifecycle)
  const hitAt = (needles, opts) => page.evaluate(([n, o]) => {
    const ok = window.__upage.lifecycle.unifiedRevealText('Unified.md', n, o)
    const sel = getSelection()
    const block = sel.anchorNode?.parentElement?.closest('p, li')
    const blocks = [...document.querySelectorAll('.unified-body .ProseMirror p')]
    return { ok, text: sel.toString(), at: blocks.indexOf(block) }
  }, [needles, opts])
  const first = await hitAt(['买牛奶 #待办'], { nth: 0 })
  const second = await hitAt(['买牛奶 #待办'], { nth: 1 })
  check('R1 逐字相同的两条各落各的', first.ok && second.ok && first.at === 0 && second.at === 1, JSON.stringify([first, second]))
  const over = await hitAt(['买牛奶 #待办'], { nth: 2 })
  check('R2 nth 超过实际处数算没命中', over.ok === false)
  const viaTag = await hitAt(['#待办/读'], { tag: true })
  check('R3 含链接的行按实际标签回退到那一条', viaTag.ok && viaTag.at === 2, JSON.stringify(viaTag))
  const prefix = await hitAt(['#待办'], { tag: true, nth: 2 })
  check('R4 用查询前缀回退会落空,所以要用这行的全名', prefix.ok === false)
  await page.close()
}

const PLUGIN = `
  const probe = window.__chatProbe = { submitted: [], cleaned: 0, requested: [] }
  const tags = ['产品', '产品/路线图', '设计', 'alpha', 'alpine']
  ctx.registerView({ id: 'memo', title: 'Memo', mount(el) {
    el.style.padding = '60px 40px'
    const hostEl = el.appendChild(document.createElement('div'))
    hostEl.style.maxWidth = '520px'
    const box = probe.box = ctx.ui.mountChatBox(hostEl, {
      modelPicker: false, submitOn: 'enter', placeholder: 'Memo',
      toolbar(slot) {
        const b = slot.appendChild(document.createElement('button'))
        b.className = 'btn sm'; b.textContent = '#'; b.dataset.probe = 'hash'
        b.addEventListener('click', () => box.insertText('#'))
        return () => { probe.cleaned++ }
      },
      suggest: { trigger: '#', items: async (q) => {
        probe.requested.push(q)
        return tags.filter((t) => t.startsWith(q)).map((t) => ({ label: '#' + t, hint: '3', value: '#' + t }))
      } },
      onSubmit(draft) { probe.submitted.push(draft); return true },
    })
    return () => box.dispose()
  } })
`

async function chatBox(browser) {
  const page = await newPage(browser)
  await page.goto(`${BASE}?plugview`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => !!window.__pv?.loadPlugin, null, { timeout: 120000 })
  await page.evaluate((code) => window.__pv.loadPlugin(code, { id: 'chat-probe', name: 'Chat probe' }), PLUGIN)
  await page.waitForFunction(() => !!window.__chatProbe)
  await page.evaluate(() => window.__pv.open(window.__pv.contributions().views[0]?.id ?? 'memo')).catch(() => {})
  const ta = page.locator('[data-ui-component="chat-box"] textarea')
  await ta.waitFor({ timeout: 30000 })
  check('C1 modelPicker:false 不画药丸', (await page.locator('.model-pill-btn').count()) === 0)
  check('C2 toolbar 在底排', (await page.locator('.t2c-row .t2c-plugin-toolbar [data-probe="hash"]').count()) === 1)
  await page.locator('[data-probe="hash"]').click()
  check('C3 insertText 落到输入框且聚焦', (await ta.inputValue()) === '#' && await ta.evaluate((el) => document.activeElement === el))
  await page.keyboard.type('al')
  await page.waitForSelector('.chat-box-suggest')
  const box = await page.evaluate(() => {
    const m = document.querySelector('.chat-box-suggest')
    const r = m.getBoundingClientRect()
    const c = getComputedStyle(m)
    const t = document.querySelector('[data-ui-component="chat-box"] textarea').getBoundingClientRect()
    return { pos: c.position, bg: c.backgroundColor, left: r.left, top: r.top, tLeft: t.left, tTop: t.top, inBody: !m.closest('.t2c-card'), font: getComputedStyle(m.querySelector('.wiki-item')).fontSize }
  })
  check('C4 浮层 fixed、有底色、贴着光标、不在卡片里', box.pos === 'fixed' && box.bg !== 'rgba(0, 0, 0, 0)' && box.inBody && box.left - box.tLeft > 5 && box.left - box.tLeft < 40 && box.top > box.tTop, JSON.stringify(box))
  await shot(page, 'chatbox-suggest')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  check('C5 Enter 选中不提交,补一个空格', (await ta.inputValue()) === '#alpine ' && (await page.evaluate(() => window.__chatProbe.submitted.length)) === 0, await ta.inputValue())
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  check('C6 浮层关了再按 Enter 才提交,draft 不带模型', await page.evaluate(() => {
    const s = window.__chatProbe.submitted
    return s.length === 1 && s[0].text === '#alpine ' && s[0].modelId === ''
  }))

  // 真输入法组合:合成键的 isComposing 到不了页面
  const cdp = await page.context().newCDPSession(page)
  await ta.click()
  await page.keyboard.type('#')
  await cdp.send('Input.imeSetComposition', { text: 'chan', selectionStart: 4, selectionEnd: 4 })
  await page.waitForTimeout(250)
  check('C7 组字中不弹,也不向插件要候选', (await page.locator('.chat-box-suggest').count()) === 0 && !(await page.evaluate(() => window.__chatProbe.requested.includes('chan'))))
  await cdp.send('Input.insertText', { text: '产' })
  await page.waitForSelector('.chat-box-suggest', { timeout: 2000 }).catch(() => {})
  check('C8 组字结束后按定稿的字弹', (await page.locator('.chat-box-suggest .wiki-item').count()) === 2, await ta.inputValue())
  await page.keyboard.press('Escape')
  await page.keyboard.type('品')
  await page.waitForTimeout(200)
  check('C9 Esc 后同一个词继续打字不再弹', (await page.locator('.chat-box-suggest').count()) === 0)
  await ta.fill('')
  await page.evaluate(() => window.__chatProbe.box.dispose())
  await page.waitForTimeout(50)
  check('C10 dispose 调到 toolbar 的清理函数', (await page.evaluate(() => window.__chatProbe.cleaned)) === 1)
  await page.close()
}

;(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    for (const run of [panels, reveal, chatBox]) {
      try { await run(browser) } catch (e) { check(`${run.name}(异常)`, false, String(e?.message || e).slice(0, 300)) }
    }
  } finally {
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})()
