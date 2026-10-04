// 页面排版选项(评审 C-21,拍板 #14):全宽 / 小字号 / 页面字体(默认 · 衬线 · 等宽),本机 viewMemory 按库 + 路径记。
// 台架 `?upage&upane`:壳 = 生产 EditorScope 的镜像(data-page-* 挂在 .amx-pane 上),顶栏 ⋯ 开的是生产同一个
// PageStyleMenuItems(入口集合 pageStyleEntries);`&umbar` 挂生产的移动端底栏胶囊 + ⋯ sheet。
// 钉:缺省 920 / 15px;菜单三项生效且菜单不关;重载仍在;行内改名跟着走;锁定页照样生效、照样能改;
// 画布模式不受影响;分享页形态(`&uro`、非 .amx-pane 壳)恒缺省;PDF 克隆带着字体 / 字号、纸面不溢出;移动 sheet 同一组入口。
// C24(评审 C-24):⋯「复制为 Markdown」= 落盘正文 —— 防抖窗里刚打的字也在(先冲洗)、不含 frontmatter(结构 JSON 不进剪贴板)。
// 用法:npm run check:pagestyle(由 e2e-editor 自起 / 复用 Vite);`--shot=<目录>` 留明暗 / 窄屏 / 菜单截图(DESIGN §8)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice('--shot='.length)
if (SHOT) fs.mkdirSync(SHOT, { recursive: true })
const shot = async (page, name, opts = {}) => { if (SHOT) await page.screenshot({ path: path.join(SHOT, `${name}.png`), ...opts }) }

const DOC_SEED = [
  '# 章节标题',
  '',
  '正文第一段:' + '阅读宽度与字号只作用于这一篇。The quick brown fox jumps over the lazy dog. '.repeat(8),
  '',
  '行内 `code` 保持等宽。',
  '',
  '| a | b | c | d | e | f |',
  '|---|---|---|---|---|---|',
  '| 1 | 2 | 3 | 4 | 5 | 6 |',
  '',
].join('\n')
const CANVAS_SEED = [
  '---',
  'amadeus_schema: amadeus.page/4',
  'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":700,"y":40,"w":300}]}',
  '---',
  '',
  '主卡正文。',
  '',
  '<!-- a k1 -->',
  '卡片正文。',
  '',
].join('\n')
const SERIF = /^ui-serif/
const MONO = /mono|Menlo|Monaco|monospace/i

const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

const measure = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const w = (s) => { const e = q(s); return e ? Math.round(e.getBoundingClientRect().width) : null }
  const pm = q('.unified-body .ProseMirror')
  const title = q('.amx-doc .amx-title-input')
  const code = q('.unified-body .ProseMirror p code')
  const pane = q('.amx-pane')
  return {
    attrs: pane ? [...pane.attributes].filter((a) => a.name.startsWith('data-page-')).map((a) => `${a.name}=${a.value}`) : [],
    doc: w('.amx-doc.unified-page'),
    body: w('.unified-body'),
    p: w('.unified-body .ProseMirror > p'),
    fs: pm ? getComputedStyle(pm).fontSize : null,
    ff: pm ? getComputedStyle(pm).fontFamily : null,
    h1: q('.unified-body .ProseMirror h1') ? getComputedStyle(q('.unified-body .ProseMirror h1')).fontSize : null,
    titleFs: title ? getComputedStyle(title).fontSize : null,
    titleFf: title ? getComputedStyle(title).fontFamily : null,
    codeFf: code ? getComputedStyle(code).fontFamily : null,
    editable: pm?.getAttribute('contenteditable') ?? null,
  }
})

async function open(page, flags, seed = DOC_SEED) {
  await page.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 30000 })
  await page.waitForTimeout(400)
}
const openMenu = async (page) => {
  if (!(await page.locator('[data-pagestyle-menu]').count())) await page.click('.amx-toolbar .amx-more-btn')
  await page.waitForSelector('[data-pagestyle-menu]', { timeout: 5000 })
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1900, height: 1000 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  // ── P0 缺省:920 纸面、15px、默认字体;壳上一个 data-page-* 都没有 ──
  await open(page, '&upane')
  const m0 = await measure(page)
  check('P0 缺省:阅读宽度 920、正文 15px、壳上无排版属性', m0.doc === 920 && m0.body === 920 && m0.fs === '15px' && m0.attrs.length === 0, JSON.stringify(m0))

  // ── P1 ⋯ 菜单:字体三格 + 全宽 + 小字号,中文文案、初始状态 ──
  await openMenu(page)
  const menu = await page.evaluate(() => {
    const root = document.querySelector('[data-pagestyle-menu]')
    const box = root.closest('.ctx-menu').getBoundingClientRect()
    return {
      text: root.innerText.replace(/\s+/g, ' ').trim(),
      radios: [...root.querySelectorAll('[role="menuitemradio"]')].map((b) => `${b.dataset.font}:${b.getAttribute('aria-checked')}`),
      toggles: [...root.querySelectorAll('[role="menuitemcheckbox"]')].map((b) => `${b.dataset.pagestyle}:${b.getAttribute('aria-checked')}`),
      menuW: Math.round(box.width),
      overflow: [...root.querySelectorAll('.amx-pagefont-opt')].some((b) => b.scrollWidth > b.clientWidth + 1),
    }
  })
  check('P1 菜单:页面字体(默认 / 衬线 / 等宽)+ 全宽 + 小字号', /页面字体/.test(menu.text) && /默认/.test(menu.text) && /衬线/.test(menu.text) && /等宽/.test(menu.text) && /全宽/.test(menu.text) && /小字号/.test(menu.text), menu.text)
  check('P1 初始状态:默认字体选中、两个开关关', menu.radios.join() === 'default:true,serif:false,mono:false' && menu.toggles.join() === 'wide:false,small:false', JSON.stringify(menu))
  check('P1 菜单几何:操作菜单宽度上限内、字体格不溢出', menu.menuW <= 200 && !menu.overflow, `menuW=${menu.menuW}`)

  // ── P2 全宽 ──
  await page.click('[data-pagestyle="wide"]')
  await page.waitForTimeout(200)
  const m2 = await measure(page)
  const stillOpen = await page.locator('[data-pagestyle-menu]').count()
  check('P2 全宽:正文与标题区脱出 920,两者同宽', m2.attrs.includes('data-page-wide=') && m2.body > 1500 && m2.doc === m2.body && m2.p > 920, JSON.stringify({ doc: m2.doc, body: m2.body, p: m2.p, attrs: m2.attrs }))
  check('P2 点选后菜单不关(边点边看)', stillOpen === 1)

  // ── P3 小字号:正文 13.5px、标题不变、标题块按 em 跟着缩 ──
  await page.click('[data-pagestyle="small"]')
  await page.waitForTimeout(200)
  const m3 = await measure(page)
  check('P3 小字号:正文 13.5px,页面标题字号不动,正文 h1 按 em 跟缩', m3.fs === '13.5px' && m3.titleFs === m0.titleFs && parseFloat(m3.h1) < parseFloat(m0.h1), JSON.stringify({ fs: m3.fs, title: [m0.titleFs, m3.titleFs], h1: [m0.h1, m3.h1] }))

  // ── P4 衬线:正文与标题换衬线栈,行内代码仍等宽 ──
  await page.click('.amx-pagefont-opt[data-font="serif"]')
  await page.waitForTimeout(200)
  const m4 = await measure(page)
  check('P4 衬线:正文 / 标题用衬线栈,行内代码仍等宽', SERIF.test(m4.ff) && SERIF.test(m4.titleFf) && MONO.test(m4.codeFf) && !SERIF.test(m4.codeFf), JSON.stringify({ ff: m4.ff, title: m4.titleFf, code: m4.codeFf }))
  const radios4 = await page.evaluate(() => [...document.querySelectorAll('[data-pagestyle-menu] [role="menuitemradio"]')].map((b) => `${b.dataset.font}:${b.getAttribute('aria-checked')}`).join())
  check('P4 菜单状态跟上(衬线选中、两个开关开)', radios4 === 'default:false,serif:true,mono:false'
    && (await page.locator('[data-pagestyle="wide"][aria-checked="true"]').count()) === 1
    && (await page.locator('[data-pagestyle="small"][aria-checked="true"]').count()) === 1, radios4)
  await page.waitForTimeout(300)
  await shot(page, 'pagestyle-menu-light', { clip: { x: 1900 - 520, y: 0, width: 520, height: 420 } })
  await shot(page, 'pagestyle-wide-light')
  await page.click('.amx-pagefont-opt[data-font="mono"]')
  await page.waitForTimeout(150)
  const mMono = await measure(page)
  check('P4b 等宽:正文用 --font-mono', MONO.test(mMono.ff) && !SERIF.test(mMono.ff), mMono.ff)
  await page.click('.amx-pagefont-opt[data-font="serif"]')
  await page.waitForTimeout(150)

  // ── P5 本机记忆:不写 md;重载后仍在 ──
  const store = await page.evaluate(() => ({
    keys: Object.keys(localStorage).filter((k) => k.startsWith('amx.notePage:')),
    writes: window.__upage.writes.filter((w) => /page|wide|serif/i.test(w.text.split('\n---')[0] || '')).length,
    fm: window.__upage.vault.get('Unified.md')?.startsWith('---') ?? false,
  }))
  check('P5 存本机 viewMemory(库 + 路径一个键),md 不带排版字段', store.keys.length === 1 && store.keys[0].includes('Unified.md') && !store.fm, JSON.stringify(store))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 30000 })
  await page.waitForTimeout(400)
  const m5 = await measure(page)
  check('P5 重载后仍全宽 + 小字号 + 衬线', m5.body > 1500 && m5.fs === '13.5px' && SERIF.test(m5.ff), JSON.stringify({ body: m5.body, fs: m5.fs, attrs: m5.attrs }))

  // ── P6 PDF 导出(printClone 克隆壳):字体 / 字号随克隆带进纸面,纸宽下不横向溢出 ──
  const pdf = await page.evaluate(async () => {
    const { printClone } = await import('/src/amadeus/lib/printClone.ts')
    const host = document.querySelector('.amx-pane')
    const wrap = document.createElement('div')
    wrap.id = 'amx-print-root'
    const clone = printClone(host)
    clone.removeAttribute('style') // 台架壳是 position:fixed 铺满;生产 EditorScope 没有这条内联样式
    clone.setAttribute('data-mode', 'light')
    wrap.appendChild(clone)
    document.body.appendChild(wrap)
    return [...clone.attributes].filter((a) => a.name.startsWith('data-page-')).length
  })
  await page.emulateMedia({ media: 'print' })
  await page.setViewportSize({ width: 794, height: 1000 })
  await page.waitForTimeout(200)
  const pm = await page.evaluate(() => {
    const root = document.getElementById('amx-print-root')
    const pmEl = root.querySelector('.unified-body .ProseMirror')
    const doc = root.querySelector('.amx-doc')
    return { fs: getComputedStyle(pmEl).fontSize, ff: getComputedStyle(pmEl).fontFamily, docW: Math.round(doc.getBoundingClientRect().width), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, toolbar: getComputedStyle(root.querySelector('.amx-toolbar')).display }
  })
  check('P6 PDF 克隆带着排版:13.5px 衬线、纸宽内不溢出、顶栏不进纸面', pdf === 3 && pm.fs === '13.5px' && SERIF.test(pm.ff) && pm.docW <= pm.vw && pm.sw <= pm.vw && pm.toolbar === 'none', JSON.stringify({ attrs: pdf, ...pm }))
  await shot(page, 'pagestyle-print')
  await page.emulateMedia({ media: null })
  await page.evaluate(() => document.getElementById('amx-print-root')?.remove())
  await page.setViewportSize({ width: 1900, height: 1000 })

  // ── P7 行内改名:排版选项跟着新路径走(remapNoteViewMemory),旧键不留 ──
  const title = page.locator('.amx-doc textarea.amx-title-input')
  await title.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('改名后')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('amx.notePage:') && k.includes('改名后.md')), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(500)
  const m7 = await measure(page)
  const keys7 = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('amx.notePage:')))
  check('P7 改名后排版选项跟到新路径、旧键删掉、页面照旧全宽 + 衬线', keys7.length === 1 && keys7[0].includes('改名后.md') && m7.body > 1500 && SERIF.test(m7.ff), JSON.stringify({ keys7, body: m7.body }))

  // ── P8 锁定页面:只读实例照样吃排版选项,⋯ 里照样能改(视图偏好,不写 md) ──
  await page.evaluate(() => {
    localStorage.setItem('amx.notePage:' + JSON.stringify(['', 'Unified.md']), JSON.stringify({ w: 1, s: 1, f: 'serif' }))
    localStorage.setItem('amx.noteLocked:' + JSON.stringify(['', 'Unified.md']), '1')
  })
  await open(page, '&upane&ulock')
  const m8 = await measure(page)
  check('P8 锁定页:只读实例照样全宽 + 小字号 + 衬线', m8.editable === 'false' && m8.body > 1500 && m8.fs === '13.5px' && SERIF.test(m8.ff), JSON.stringify({ editable: m8.editable, body: m8.body, fs: m8.fs }))
  await openMenu(page)
  await page.click('[data-pagestyle="wide"]')
  await page.waitForTimeout(200)
  const m8b = await measure(page)
  check('P8 锁定页里关掉全宽 → 回到 920、零写盘', m8b.body === 920 && (await page.evaluate(() => window.__upage.writes.length)) === 0, JSON.stringify({ body: m8b.body }))
  await page.click('[data-pagestyle="wide"]') // 还原成全宽,供下面几组
  await page.evaluate(() => localStorage.removeItem('amx.noteLocked:' + JSON.stringify(['', 'Unified.md'])))

  // ── P9 画布模式不受影响:壳上带着属性,画布里正文仍按缺省字号与字体排 ──
  await page.goto(`${URL}?upage&upane&useed=${encodeURIComponent(CANVAS_SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.amx-ucard[data-anchor="k1"] p', { timeout: 30000 })
  await page.waitForTimeout(500)
  const m9 = await page.evaluate(() => {
    const pmEl = document.querySelector('.unified-body.amx-canvas .ProseMirror')
    const pane = document.querySelector('.amx-pane')
    return { attrs: [...pane.attributes].filter((a) => a.name.startsWith('data-page-')).length, fs: pmEl && getComputedStyle(pmEl).fontSize, ff: pmEl && getComputedStyle(pmEl).fontFamily, full: !!document.querySelector('.unified-body.amx-canvas-full') }
  })
  check('P9 画布模式:壳上有属性,但画布正文仍 15px、非衬线', m9.attrs === 3 && m9.full && m9.fs === '15px' && !SERIF.test(m9.ff || ''), JSON.stringify(m9))

  // ── P10 分享页形态(只读 UnifiedPage、宿主不挂属性):同一篇的本机记忆不起作用 ──
  await open(page, '&uro')
  const m10 = await page.evaluate(() => {
    const pmEl = document.querySelector('.unified-body .ProseMirror')
    return { fs: getComputedStyle(pmEl).fontSize, ff: getComputedStyle(pmEl).fontFamily, max: getComputedStyle(document.querySelector('.unified-body')).maxWidth, pane: !!document.querySelector('.amx-pane') }
  })
  check('P10 分享页形态恒按缺省(15px、非衬线、920 上限)', !m10.pane && m10.fs === '15px' && !SERIF.test(m10.ff) && m10.max === '920px', JSON.stringify(m10))

  // ── P11 暗色 + 窄屏(390)+ 移动端 ⋯ sheet:同一组入口,开关不关 sheet、打勾 ──
  await open(page, '&upane&udark')
  await openMenu(page)
  await page.waitForTimeout(500) // 菜单入场动画走完再截
  await shot(page, 'pagestyle-menu-dark', { clip: { x: 1900 - 520, y: 0, width: 520, height: 420 } })
  await shot(page, 'pagestyle-wide-dark')
  const mob = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true })
  mob.on('pageerror', (e) => console.log('[pageerror/mobile]', e.message))
  await open(mob, '&upane&umbar')
  const m11 = await measure(mob)
  await shot(mob, 'pagestyle-narrow-390')
  await mob.click('.amx-mbar button[title="更多操作"]')
  await mob.waitForSelector('.mb-sheet', { timeout: 5000 })
  const sheet = await mob.evaluate(() => ({
    rows: [...document.querySelectorAll('.mb-sheet [data-action]')].map((r) => r.dataset.action),
    seg: [...document.querySelectorAll('.mb-sheet .amx-sheet-seg button')].map((b) => `${b.dataset.font}:${b.getAttribute('aria-checked')}`),
    over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))
  const narrow = await mob.evaluate(() => { const pane = document.querySelector('.amx-pane'); return { sw: pane.scrollWidth, cw: pane.clientWidth } })
  check('P11 窄屏(390)正文不横向溢出', narrow.sw <= narrow.cw && m11.body <= 390, JSON.stringify({ ...narrow, body: m11.body }))
  check('P11 移动端 sheet:页面字体一行三段 + 全宽 + 小字号(与桌面同一组入口)', sheet.rows.join() === 'page-font,page-wide,page-small' && sheet.seg.length === 3 && !sheet.over, JSON.stringify(sheet))
  await mob.click('.mb-sheet [data-action="page-small"]')
  await mob.waitForTimeout(200)
  const afterTap = await mob.evaluate(() => ({
    open: !!document.querySelector('.mb-sheet'),
    checked: document.querySelector('.mb-sheet [data-action="page-small"]')?.getAttribute('aria-checked'),
    tick: !!document.querySelector('.mb-sheet [data-action="page-small"] .amx-sheet-check'),
    fs: getComputedStyle(document.querySelector('.unified-body .ProseMirror')).fontSize,
  }))
  check('P11 sheet 里点开关:sheet 不关、打勾、正文跟着变', afterTap.open && afterTap.checked === 'true' && afterTap.tick && afterTap.fs === (m11.fs === '13.5px' ? '15px' : '13.5px'), JSON.stringify(afterTap))
  await shot(mob, 'pagestyle-sheet-390')
  await mob.close()
  if (SHOT) { // 暗色窄屏 sheet:只截图自查,不另设断言
    const mobDark = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true })
    await open(mobDark, '&upane&umbar&udark')
    await mobDark.click('.amx-mbar button[title="更多操作"]')
    await mobDark.waitForSelector('.mb-sheet', { timeout: 5000 })
    await mobDark.waitForTimeout(500)
    await shot(mobDark, 'pagestyle-sheet-390-dark')
    await mobDark.close()
  }

  // ── C24 复制为 Markdown:打完字立刻(800ms 防抖窗内)点 ⋯ 里那一项 —— 剪贴板 = 这一刻的正文,无 fm;盘上同步落成同一份 ──
  {
    const FM = '---\ntags: [周报]\namadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":600},"cards":[]}\n---\n'
    await open(page, '&upane', `${FM}# 周报\n\n正文段\n`)
    await page.evaluate(() => { window.__clip = null; navigator.clipboard.writeText = async (s) => { window.__clip = s } })
    await page.evaluate(() => {
      const view = window.__upage.probe.view()
      let at = -1
      view.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('正文段')) at = pos + n.text.indexOf('正文段') + 3; return at < 0 })
      view.focus()
      view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(at))))
    })
    await page.waitForTimeout(100)
    await page.keyboard.type('甲')
    await page.click('.amx-toolbar .amx-more-btn')
    await page.waitForSelector('[data-copymd]', { timeout: 5000 })
    if (SHOT) { await page.waitForTimeout(400); await shot(page, 'copymd-menu-light', { clip: { x: 1900 - 520, y: 0, width: 520, height: 460 } }) }
    await page.click('[data-copymd]')
    let clip = null
    for (let i = 0; i < 30 && clip == null; i++) { await page.waitForTimeout(100); clip = await page.evaluate(() => window.__clip) }
    const disk = await page.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
    check('C24 复制为 Markdown:剪贴板 = 正文(含防抖窗里刚打的字)、不含 frontmatter', clip === '# 周报\n\n正文段甲\n', JSON.stringify(clip))
    // fm 在盘上照旧(结构键会被派生规范化,不逐字比),正文 = 剪贴板那份
    check('C24 先冲洗:盘上正文 = 剪贴板那份,fm 留在盘上', !!disk && !!clip && disk.startsWith('---\n') && disk.endsWith(`\n---\n${clip}`) && /tags: \[周报\]/.test(disk), JSON.stringify(disk))
    if (SHOT) {
      await open(page, '&upane&udark')
      await page.click('.amx-toolbar .amx-more-btn')
      await page.waitForSelector('[data-copymd]', { timeout: 5000 })
      await page.waitForTimeout(500)
      await shot(page, 'copymd-menu-dark', { clip: { x: 1900 - 520, y: 0, width: 520, height: 460 } })
    }
  }

  await browser.close()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
