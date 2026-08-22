// Amadeus 结构源码 / Card 两入口 / 块高亮渐出的聚焦回归。
// 用生产 UnifiedPage 壳运行；用法：npm run check:amadeusinteractions
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const exe = path.join(root, dir, 'chrome-mac-arm64', app)
      if (fs.existsSync(exe)) return exe
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const SEED = '### 标题行\n\n- [ ] 待办行\n\nSlash 卡片行\n\n菜单卡片行\n'
const results = []
function check(name, ok, detail = '') {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function hoverText(page, text) {
  const at = await page.evaluate(({ selector, text }) => {
    const el = [...document.querySelector(selector).querySelectorAll('p,h1,h2,h3,h4,h5,h6')]
      .find((node) => (node.textContent ?? '').trim() === text)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }
  }, { selector: PM, text })
  if (!at) throw new Error(`找不到块：${text}`)
  await page.mouse.move(at.x, at.y)
  await page.waitForTimeout(260)
  return at
}

async function enterPrefix(page, selector) {
  await page.click(selector)
  // PM 的原生 click → selectionchange 是异步的；等选区落定再 Home/←，避免上一行的 input 吃键。
  await page.waitForTimeout(180)
  await page.keyboard.press('Home')
  await page.waitForTimeout(80)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(140)
  return page.evaluate(() => {
    const input = document.activeElement
    return input?.classList.contains('amx-struct-prefix') ? input.value : null
  })
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // 用户从普通段落输入触发符后的第一拍：必须已经是渲染态，而不是因为编辑器仍聚焦就把
  // Markdown 源码 input 常驻在行首。空列表项尤其能暴露光标是否被这个装饰挤偏。
  const triggerPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  triggerPage.on('pageerror', (error) => console.log('[pageerror:trigger]', error.message))
  await triggerPage.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent('触发行\n')}`, { waitUntil: 'domcontentloaded' })
  await triggerPage.waitForSelector(`${PM} > p`, { timeout: 20000 })
  await triggerPage.click(`${PM} > p`)
  await triggerPage.keyboard.press('Home')
  await triggerPage.keyboard.type('- ', { delay: 80 })
  await triggerPage.waitForTimeout(280)
  const bulletFirstFrame = await triggerPage.evaluate(() => {
    const li = document.querySelector('.unified-body .ProseMirror > ul > li')
    const p = li?.querySelector(':scope > p')
    const overlay = document.querySelector('.sc-caret')
    const or = overlay && getComputedStyle(overlay).display !== 'none' ? overlay.getBoundingClientRect() : null
    const pr = p?.getBoundingClientRect()
    return {
      list: !!li,
      listStyle: li ? getComputedStyle(li).listStyleType : null,
      sourceOpen: !!li?.classList.contains('amx-struct-source-open'),
      prefixInputs: document.querySelectorAll('.amx-struct-prefix').length,
      selectionOffset: getSelection()?.anchorOffset ?? null,
      paragraphLeft: pr?.left ?? null,
      overlay: or ? { left: or.left, top: or.top, height: or.height } : null,
    }
  })
  check(
    '文档模式输入 “- ” 后立即显示无序列表标记',
    bulletFirstFrame.list && bulletFirstFrame.listStyle !== 'none'
      && !bulletFirstFrame.sourceOpen && bulletFirstFrame.prefixInputs === 0,
    JSON.stringify(bulletFirstFrame),
  )
  check(
    '空列表项光标落在正文起点而非 Markdown 标记之后',
    bulletFirstFrame.selectionOffset === 0 && !!bulletFirstFrame.overlay
      && bulletFirstFrame.paragraphLeft != null
      && Math.abs(bulletFirstFrame.overlay.left - bulletFirstFrame.paragraphLeft) <= 2,
    JSON.stringify(bulletFirstFrame),
  )
  await triggerPage.keyboard.type('新项')
  await triggerPage.waitForTimeout(220)
  const typedBullet = await triggerPage.evaluate(() => {
    const p = document.querySelector('.unified-body .ProseMirror > ul > li > p')
    const sel = getSelection()
    const rr = sel?.rangeCount ? sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect() : null
    const overlay = document.querySelector('.sc-caret')
    const or = overlay && getComputedStyle(overlay).display !== 'none' ? overlay.getBoundingClientRect() : null
    return {
      text: p?.textContent ?? null,
      native: rr ? { left: rr.left, top: rr.top, height: rr.height } : null,
      overlay: or ? { left: or.left, top: or.top, height: or.height } : null,
    }
  })
  check(
    '列表转换后继续输入且丝滑光标与真实选区重合',
    typedBullet.text === '新项触发行' && !!typedBullet.native && !!typedBullet.overlay
      && Math.abs(typedBullet.native.left - typedBullet.overlay.left) <= 2
      && Math.abs(typedBullet.native.top - typedBullet.overlay.top) <= 2
      && Math.abs(typedBullet.native.height - typedBullet.overlay.height) <= 2,
    JSON.stringify(typedBullet),
  )
  await triggerPage.screenshot({ path: path.join(os.tmpdir(), 'amadeus-list-trigger.png'), fullPage: true })
  await triggerPage.close()

  // 精确复现用户截图：空列表本来带 slash 占位提示；进入 `- ` 字面源码后，提示不能压住连字符。
  const emptyListPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await emptyListPage.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent('\n')}`, { waitUntil: 'domcontentloaded' })
  await emptyListPage.waitForSelector(PM, { timeout: 20000 })
  await emptyListPage.click(PM)
  await emptyListPage.keyboard.type('- ', { delay: 60 })
  await emptyListPage.waitForTimeout(180)
  // 空块转列表时外层行壳可能按节点类型换壳；按真实动作点回这条空列表，再从正文起点向左。
  await emptyListPage.click(`${PM} li p`)
  await emptyListPage.waitForTimeout(120)
  await emptyListPage.keyboard.press('Home')
  await emptyListPage.keyboard.press('ArrowLeft')
  await emptyListPage.waitForTimeout(120)
  const emptyListPrefix = await emptyListPage.evaluate(() => {
    const input = document.activeElement
    const line = document.querySelector('.unified-body .ProseMirror li p')
    const rect = input?.getBoundingClientRect()
    const listRect = line?.closest('ul,ol')?.getBoundingClientRect()
    return {
      empty: line?.classList.contains('is-empty') ?? false,
      value: input?.classList.contains('amx-struct-prefix') ? input.value : null,
      offset: input?.selectionStart ?? null,
      placeholder: line ? getComputedStyle(line, '::before').content : null,
      width: rect?.width ?? 0,
      sourceLeft: rect?.left ?? null,
      listLeft: listRect?.left ?? null,
    }
  })
  check(
    '空列表第一下 ← 即显示字面 “- ”、越过唯一空格且不再被占位提示遮住',
    emptyListPrefix.empty && emptyListPrefix.value === '- ' && emptyListPrefix.offset === 1
      && emptyListPrefix.placeholder === 'none' && emptyListPrefix.width > 0
      && emptyListPrefix.sourceLeft != null && emptyListPrefix.listLeft != null
      && Math.abs(emptyListPrefix.sourceLeft - emptyListPrefix.listLeft) <= 2,
    JSON.stringify(emptyListPrefix),
  )
  await emptyListPage.screenshot({ path: path.join(os.tmpdir(), 'amadeus-empty-list-prefix.png'), fullPage: true })
  await emptyListPage.close()

  const orderedSourcePage = await browser.newPage({ viewport: { width: 1000, height: 500 } })
  await orderedSourcePage.goto(`${URL}?upage&upane&useed=${encodeURIComponent('1. 有序项\n')}`, { waitUntil: 'domcontentloaded' })
  await orderedSourcePage.waitForSelector(`${PM} li p`, { timeout: 20000 })
  await orderedSourcePage.click(`${PM} li p`)
  await orderedSourcePage.waitForTimeout(120)
  await orderedSourcePage.keyboard.press('Home')
  await orderedSourcePage.keyboard.press('ArrowLeft')
  await orderedSourcePage.waitForTimeout(100)
  const orderedSource = await orderedSourcePage.evaluate(() => {
    const input = document.activeElement
    const list = document.querySelector('.unified-body .ProseMirror > ol')
    const ir = input?.getBoundingClientRect()
    const lr = list?.getBoundingClientRect()
    return {
      value: input?.classList.contains('amx-struct-prefix') ? input.value : null,
      offset: input?.selectionStart ?? null,
      sourceLeft: ir?.left ?? null,
      listLeft: lr?.left ?? null,
    }
  })
  check(
    '有序列表第一下 ← 的 “1. ” 与普通正文同轴，不借 marker gutter 假缩进',
    orderedSource.value === '1. ' && orderedSource.offset === 2
      && orderedSource.sourceLeft != null && orderedSource.listLeft != null
      && Math.abs(orderedSource.sourceLeft - orderedSource.listLeft) <= 2,
    JSON.stringify(orderedSource),
  )
  await orderedSourcePage.close()

  // Home/原生方向移动后的 DOM Selection 与 EditorState 曾有一拍时差，导致标题第一下 Backspace
  // 偶发只同步选区、第二下才删边界空格。连续重开覆盖这条竞态，不能靠单次碰巧通过。
  const headingBackspaceRuns = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const p = await browser.newPage({ viewport: { width: 1000, height: 500 } })
    await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent('## 标题\n')}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector(`${PM} h2`, { timeout: 20000 })
    await p.click(`${PM} h2`)
    await p.waitForTimeout(160)
    await p.keyboard.press('Home')
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(90)
    headingBackspaceRuns.push(await p.evaluate(() => ({
      paragraph: document.querySelector('.unified-body .ProseMirror > p')?.textContent ?? null,
      offset: getSelection()?.anchorOffset ?? null,
    })))
    await p.close()
  }
  check(
    '标题正文起点第一下 Backspace 稳定删除唯一边界空格（无需第二下）',
    headingBackspaceRuns.every((run) => run.paragraph === '##标题' && run.offset === 2),
    JSON.stringify(headingBackspaceRuns),
  )

  // 空格是 Markdown 结构的渲染边界：`- ` 已成列表后在正文起点退格，第一下只删边界空格，
  // 但必须立刻退出结构并还原字面 `-`；光标不能继续困在一个已经无效的前缀 input 里。
  const unrenderPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await unrenderPage.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent('触发行\n')}`, { waitUntil: 'domcontentloaded' })
  await unrenderPage.waitForSelector(`${PM} > p`, { timeout: 20000 })
  await unrenderPage.click(`${PM} > p`)
  await unrenderPage.keyboard.press('Home')
  await unrenderPage.keyboard.type('- ', { delay: 60 })
  await unrenderPage.waitForTimeout(180)
  await unrenderPage.keyboard.press('Backspace')
  await unrenderPage.waitForTimeout(220)
  const afterBoundaryDelete = await unrenderPage.evaluate(() => {
    const pm = document.querySelector('.unified-body .ProseMirror')
    const p = pm?.querySelector(':scope > p')
    const sel = getSelection()
    const rr = sel?.rangeCount ? sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect() : null
    const overlay = document.querySelector('.sc-caret')
    const or = overlay && getComputedStyle(overlay).display !== 'none' ? overlay.getBoundingClientRect() : null
    return {
      paragraph: p?.textContent ?? null,
      lists: pm?.querySelectorAll(':scope > ul, :scope > ol').length ?? -1,
      prefixInputs: pm?.querySelectorAll('.amx-struct-prefix').length ?? -1,
      active: document.activeElement?.className ?? '',
      offset: sel?.anchorOffset ?? null,
      native: rr ? { left: rr.left, top: rr.top, height: rr.height } : null,
      overlay: or ? { left: or.left, top: or.top, height: or.height } : null,
    }
  })
  check(
    '列表边界空格退格后立即还原字面 “-” 并退出源码输入框',
    afterBoundaryDelete.paragraph === '-触发行' && afterBoundaryDelete.lists === 0
      && afterBoundaryDelete.prefixInputs === 0 && afterBoundaryDelete.offset === 1
      && String(afterBoundaryDelete.active).includes('ProseMirror'),
    JSON.stringify(afterBoundaryDelete),
  )
  check(
    '还原字面 “-” 后丝滑光标与真实选区重合',
    !!afterBoundaryDelete.native && !!afterBoundaryDelete.overlay
      && Math.abs(afterBoundaryDelete.native.left - afterBoundaryDelete.overlay.left) <= 2
      && Math.abs(afterBoundaryDelete.native.top - afterBoundaryDelete.overlay.top) <= 2
      && Math.abs(afterBoundaryDelete.native.height - afterBoundaryDelete.overlay.height) <= 2,
    JSON.stringify(afterBoundaryDelete),
  )
  await unrenderPage.screenshot({ path: path.join(os.tmpdir(), 'amadeus-list-unrender.png'), fullPage: true })
  await unrenderPage.keyboard.press('ArrowLeft')
  await unrenderPage.waitForTimeout(80)
  const leftOffset = await unrenderPage.evaluate(() => getSelection()?.anchorOffset ?? null)
  await unrenderPage.keyboard.press('ArrowRight')
  await unrenderPage.waitForTimeout(80)
  const rightOffset = await unrenderPage.evaluate(() => getSelection()?.anchorOffset ?? null)
  check('还原字面 “-” 后左右方向键可逐字符移动', leftOffset === 0 && rightOffset === 1, `left=${leftOffset},right=${rightOffset}`)
  await unrenderPage.keyboard.press('Backspace')
  await unrenderPage.waitForTimeout(160)
  const afterLiteralDelete = await unrenderPage.evaluate(() => ({
    text: document.querySelector('.unified-body .ProseMirror > p')?.textContent ?? null,
    offset: getSelection()?.anchorOffset ?? null,
  }))
  check('再次退格可真正删除字面 “-”', afterLiteralDelete.text === '触发行' && afterLiteralDelete.offset === 0, JSON.stringify(afterLiteralDelete))

  // 同一结果也必须覆盖用户截图里的另一条路径：向左进入 `- `，把光标移到空格前再按 Delete。
  await unrenderPage.keyboard.type('- ', { delay: 50 })
  await unrenderPage.waitForTimeout(160)
  await unrenderPage.keyboard.press('ArrowLeft') // 正文起点 → 一步跨过边界空格，光标落在 `-` 与空格之间
  await unrenderPage.waitForTimeout(100)
  const enteredListSource = await unrenderPage.evaluate(() => {
    const input = document.activeElement
    return {
      value: input?.classList.contains('amx-struct-prefix') ? input.value : null,
      offset: input?.selectionStart ?? null,
    }
  })
  check(
    '非空列表第一下 ← 同样直接越过唯一空格',
    enteredListSource.value === '- ' && enteredListSource.offset === 1,
    JSON.stringify(enteredListSource),
  )
  await unrenderPage.keyboard.press('Delete')
  await unrenderPage.waitForTimeout(180)
  const afterForwardDelete = await unrenderPage.evaluate(() => ({
    text: document.querySelector('.unified-body .ProseMirror > p')?.textContent ?? null,
    lists: document.querySelectorAll('.unified-body .ProseMirror > :is(ul,ol)').length,
    source: document.querySelectorAll('.amx-struct-prefix').length,
    offset: getSelection()?.anchorOffset ?? null,
    active: document.activeElement?.classList.contains('ProseMirror'),
  }))
  check(
    '向左进入列表源码后 Delete 边界空格同样还原字面 “-”',
    afterForwardDelete.text === '-触发行' && afterForwardDelete.lists === 0
      && afterForwardDelete.source === 0 && afterForwardDelete.offset === 1 && afterForwardDelete.active,
    JSON.stringify(afterForwardDelete),
  )
  await unrenderPage.close()

  // 同一源码插件覆盖标题 / 有序列表 / 待办 / 引用。标题在当前编辑行显示源码；其余结构只在
  // 从正文行首向左进入时显示，不能与原生 marker 叠一份。
  for (const probe of [
    { name: '标题', input: '### ', selector: `${PM} > h3`, marker: 'node', alwaysPrefix: '### ' },
    { name: '有序列表', input: '1. ', selector: `${PM} > ol > li`, marker: 'decimal' },
    { name: '待办', input: '[] ', selector: `${PM} > ul > li[data-item-type="task"]`, marker: 'task' },
    { name: '引用', input: '| ', selector: `${PM} > blockquote`, marker: 'quote' },
  ]) {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await p.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent('触发行\n')}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector(`${PM} > p`, { timeout: 20000 })
    await p.click(`${PM} > p`)
    await p.keyboard.press('Home')
    await p.keyboard.type(probe.input, { delay: 50 })
    await p.waitForTimeout(220)
    const state = await p.evaluate(({ selector, marker }) => {
      const node = document.querySelector(selector)
      const line = node?.querySelector(':scope > p') ?? node
      const lr = line?.getBoundingClientRect()
      const prefix = node?.querySelector('.amx-struct-prefix')
      const prefixRect = prefix?.getBoundingClientRect()
      const prefixStyle = prefix ? getComputedStyle(prefix) : null
      const overlay = document.querySelector('.sc-caret')
      const or = overlay && getComputedStyle(overlay).display !== 'none' ? overlay.getBoundingClientRect() : null
      let markerVisible = !!node
      if (node && marker === 'decimal') markerVisible = getComputedStyle(node).listStyleType === 'decimal'
      if (node && marker === 'task') markerVisible = getComputedStyle(node, '::before').content !== 'none'
      if (node && marker === 'quote') markerVisible = Number(getComputedStyle(node, '::before').opacity) > 0
      return {
        node: !!node,
        markerVisible,
        sourceOpen: !!document.querySelector('.amx-struct-source-open'),
        prefixInputs: document.querySelectorAll('.amx-struct-prefix').length,
        prefixValue: prefix?.value ?? null,
        prefixRect: prefixRect ? { left: prefixRect.left, right: prefixRect.right, width: prefixRect.width, height: prefixRect.height } : null,
        prefixStyle: prefixStyle ? { color: prefixStyle.color, opacity: prefixStyle.opacity, fontSize: prefixStyle.fontSize, lineHeight: prefixStyle.lineHeight } : null,
        lineLeft: lr?.left ?? null,
        overlayLeft: or?.left ?? null,
        selectionOffset: getSelection()?.anchorOffset ?? null,
      }
    }, { selector: probe.selector, marker: probe.marker })
    if (probe.alwaysPrefix) {
      check(
        '标题空格触发后保持标题样式、当前行显示井号且光标在正文起点',
        state.node && state.markerVisible && !state.sourceOpen && state.prefixInputs === 1
          && state.prefixValue === probe.alwaysPrefix && state.selectionOffset === 0
          && state.prefixRect?.right != null && state.prefixRect.height > 0 && state.overlayLeft != null
          && Math.abs(state.prefixRect.right - state.overlayLeft) <= 2,
        JSON.stringify(state),
      )
    } else {
      check(
        `${probe.name}空格触发后保持渲染态且光标在正文起点`,
        state.node && state.markerVisible && !state.sourceOpen && state.prefixInputs === 0
          && state.selectionOffset === 0 && state.lineLeft != null && state.overlayLeft != null
          && Math.abs(state.lineLeft - state.overlayLeft) <= 2,
        JSON.stringify(state),
      )
    }
    await p.close()
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (error) => console.log('[pageerror]', error.message))
  await page.goto(`${URL}?upage&upane&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector(`${PM} h3`, { timeout: 20000 })
  await page.waitForTimeout(500)
  const idleHeading = await page.evaluate(() => {
    const h = document.querySelector('.unified-body .ProseMirror h3')
    const input = h?.querySelector('.amx-struct-prefix')
    return {
      source: input?.value ?? null,
      inputs: document.querySelectorAll('.amx-struct-prefix').length,
      active: document.activeElement?.className ?? '',
    }
  })
  check(
    '未编辑的标题行不显示井号',
    idleHeading.source === null && idleHeading.inputs === 0,
    JSON.stringify(idleHeading),
  )
  await page.screenshot({ path: path.join(os.tmpdir(), 'amadeus-heading-prefix-inactive.png') })

  // 标题：仅当前编辑行显示井号；← 进入后，在边界空格前增删井号要实时切标题级别并保住 input 焦点。
  await page.click(`${PM} h3`)
  await page.waitForTimeout(220)
  const editingHeading = await page.evaluate(() => ({
    source: document.querySelector('.unified-body .ProseMirror h3 .amx-struct-prefix')?.value ?? null,
    active: document.activeElement?.className ?? '',
    parent: getSelection()?.anchorNode?.parentElement?.tagName ?? null,
  }))
  check(
    '光标进入标题行后显示井号',
    editingHeading.source === '### ' && String(editingHeading.active).includes('ProseMirror'),
    JSON.stringify(editingHeading),
  )
  await page.keyboard.press('Home')
  await page.waitForTimeout(80)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(140)
  const headingPrefixState = await page.evaluate(() => ({
    source: document.activeElement?.classList.contains('amx-struct-prefix') ? document.activeElement.value : null,
    inputOffset: document.activeElement?.selectionStart ?? null,
    active: document.activeElement?.className ?? '',
    inputs: document.querySelectorAll('.amx-struct-prefix').length,
    parent: getSelection()?.anchorNode?.parentElement?.tagName ?? null,
    offset: getSelection()?.anchorOffset ?? null,
  }))
  check(
    '当前标题行第一下 ← 即跨过唯一空格并进入井号区',
    headingPrefixState.source === '### ' && headingPrefixState.inputOffset === 3,
    JSON.stringify(headingPrefixState),
  )
  await page.screenshot({ path: path.join(os.tmpdir(), 'amadeus-heading-prefix-active.png') })
  const sourceCaretHidden = await page.evaluate(() => {
    const overlay = document.querySelector('.sc-caret')
    return document.activeElement?.classList.contains('amx-struct-prefix')
      && (!overlay || getComputedStyle(overlay).display === 'none')
  })
  check('结构源码输入框使用原生光标且收起旧丝滑覆盖层', sourceCaretHidden)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(180)
  const liveH2 = await page.evaluate(() => {
    const input = document.activeElement
    const heading = document.querySelector('.unified-body .ProseMirror h2')
    return {
      tag: heading?.tagName ?? null,
      source: input?.classList.contains('amx-struct-prefix') ? input.value : null,
      offset: input?.selectionStart ?? null,
    }
  })
  check(
    '删除一个井号实时从 H3 切为 H2，输入焦点与字符落点保持',
    liveH2.tag === 'H2' && liveH2.source === '## ' && liveH2.offset === 2,
    JSON.stringify(liveH2),
  )
  await page.keyboard.type('#')
  await page.waitForTimeout(180)
  const liveH3 = await page.evaluate(() => ({
    tag: document.querySelector('.unified-body .ProseMirror h3')?.tagName ?? null,
    source: document.activeElement?.classList.contains('amx-struct-prefix') ? document.activeElement.value : null,
    offset: document.activeElement?.selectionStart ?? null,
  }))
  check(
    '补回井号实时恢复 H3，仍可继续逐字符编辑',
    liveH3.tag === 'H3' && liveH3.source === '### ' && liveH3.offset === 3,
    JSON.stringify(liveH3),
  )
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  const headingEdited = await page.evaluate(() => ({
    text: [...document.querySelectorAll('.unified-body .ProseMirror p')]
      .find((node) => (node.textContent ?? '').includes('标题行'))?.textContent ?? null,
    offset: getSelection()?.anchorOffset ?? null,
    prefixInputs: document.querySelectorAll('.amx-struct-prefix').length,
  }))
  check(
    '标题边界空格删掉后退出渲染，后续 Backspace 继续逐字符删除',
    headingEdited.text === '##标题行' && headingEdited.offset === 2 && headingEdited.prefixInputs === 0,
    JSON.stringify(headingEdited),
  )
  await page.keyboard.type(' ')
  await page.waitForTimeout(250)
  check('字面 “##” 补回边界空格即重新渲染', await page.locator(`${PM} h2`, { hasText: '标题行' }).count() === 1)

  // 待办：进入 `- [ ] `，只改中间字符即可切换 checked，不需要整行删除重打。
  const taskSource = await enterPrefix(page, `${PM} li[data-item-type="task"] p`)
  check('待办行可进入完整 Markdown 标记', taskSource === '- [ ] ', `source=${JSON.stringify(taskSource)}`)
  check(
    '光标离开标题行后井号立即隐藏',
    await page.locator(`${PM} h2 .amx-struct-prefix`).count() === 0,
  )
  await page.screenshot({ path: path.join(os.tmpdir(), 'amadeus-structural-source.png'), fullPage: true })
  await page.evaluate(() => {
    const input = document.activeElement
    input.setSelectionRange(3, 4)
  })
  await page.keyboard.type('x')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(250)
  const task = await page.evaluate(() => {
    const li = document.querySelector(`${'.unified-body .ProseMirror'} li[data-item-type="task"]`)
    return li ? { checked: li.getAttribute('data-checked'), text: li.textContent } : null
  })
  check('待办标记按字符改为 [x] 后立即更新', task?.checked === 'true' && task.text === '待办行', JSON.stringify(task))

  // 已在井号与空格之间时按 Delete 删除标题渲染边界：剩余源码立刻回到普通文本。
  await enterPrefix(page, `${PM} h2`)
  await page.keyboard.press('Delete')
  await page.waitForTimeout(250)
  const literal = await page.evaluate((selector) => {
    const p = [...document.querySelector(selector).querySelectorAll(':scope > p')]
      .find((node) => (node.textContent ?? '').includes('标题行'))
    return p?.textContent ?? null
  }, PM)
  check('删掉边界空格后立即还原为可继续编辑的普通文本', literal === '##标题行', `text=${JSON.stringify(literal)}`)

  // /card：命令只消费查询，当前块原地成为 Canvas 卡片。
  const slashAt = await hoverText(page, 'Slash 卡片行')
  await page.mouse.click(slashAt.x, slashAt.y)
  await page.keyboard.press('Home')
  await page.keyboard.type('/card', { delay: 30 })
  await page.waitForSelector('.slash-menu', { timeout: 3000 })
  const slashItems = await page.locator('.slash-item').allTextContents()
  check('/card 出现在统一编辑器 slash 菜单', slashItems.some((text) => text.includes('卡片')), JSON.stringify(slashItems))
  await page.locator('.slash-item', { hasText: '卡片' }).first().click()
  await page.waitForTimeout(500)
  const afterSlash = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.amx-ucard')].map((card) => card.textContent.trim()),
    text: document.querySelector('.unified-body .ProseMirror')?.textContent ?? '',
  }))
  check('/card 转换当前块且不残留命令文本', afterSlash.cards.includes('Slash 卡片行') && !afterSlash.text.includes('/card'), JSON.stringify(afterSlash))

  // 高亮撤销渐出：transition 挂基态，选中类摘除后仍能跑完。
  await hoverText(page, '菜单卡片行')
  await page.click('.unified-gutter .drag-handle')
  await page.waitForSelector('.unified-block-menu', { timeout: 3000 })
  const selectedStyle = await page.evaluate(() => {
    const el = document.querySelector('.ProseMirror-selectednode')
    const cs = el && getComputedStyle(el)
    return cs ? { background: cs.backgroundColor, duration: cs.transitionDuration } : null
  })
  check('块选中高亮使用 250ms 渐出时长', selectedStyle?.duration.split(',').includes('0.25s'), JSON.stringify(selectedStyle))
  await page.click(`${PM} p`, { position: { x: 8, y: 8 } })
  await page.waitForTimeout(180)
  const faded = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror p')]
      .find((node) => (node.textContent ?? '').trim() === '菜单卡片行')
    return el ? getComputedStyle(el).backgroundColor : null
  })
  check('取消块选中后高亮渐出到透明', faded === 'rgba(0, 0, 0, 0)', `background=${faded}`)

  // “转换为”里的 Card 与 slash 共用入口，旧的冗余“放到画布”文案已移除。
  await hoverText(page, '菜单卡片行')
  await page.click('.unified-gutter .drag-handle')
  await page.waitForSelector('.unified-block-menu', { timeout: 3000 })
  const menu = await page.locator('.unified-block-menu').innerText()
  check('“转换为”菜单包含卡片且不再重复“放到画布”', menu.includes('转换为') && menu.includes('卡片') && !menu.includes('放到画布'), menu.replace(/\n/g, '|'))
  await page.locator('.unified-block-menu button', { hasText: '卡片' }).click()
  await page.waitForTimeout(500)
  const menuCards = await page.locator('.amx-ucard').allTextContents()
  check('“转换为 → 卡片”完成转换', menuCards.some((text) => text.trim() === '菜单卡片行'), JSON.stringify(menuCards))

  const fm = await page.evaluate(() => {
    window.__upage.probe.flush?.()
    return window.__upage.probe.fmState?.().fm ?? ''
  })
  check('两条 Card 入口均进入 canvas frontmatter', /amadeus_canvas:.*"cards":\[[^\]]+,[^\]]+\]/.test(fm), fm)

  await page.screenshot({ path: path.join(os.tmpdir(), 'amadeus-interactions.png'), fullPage: true })
  await browser.close()
  const passed = results.filter(Boolean).length
  console.log(`\n${passed}/${results.length} 通过`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
