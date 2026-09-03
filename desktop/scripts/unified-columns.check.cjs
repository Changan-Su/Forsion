// 分栏方案 Y(单实例列节点)go/no-go spike 仪器(2026-08-13 advisor 要求,长期保留):
//  C1 wrap 事务成行(两列上屏) + 落盘发射锚注释
//  C2 ⠿ 把手在 cell 内逐块锚定(plugin-block 三层嵌套命中)
//  C3 块拖拽 cell→cell 原生成立(同 doc NodeSelection 拖)
//  C4 撤销 wrap 一步还原线性文档(多实例方案的 B7 撤销撕裂在此为不可能)
// 用法:HARNESS_URL=http://localhost:5199/harness.html node scripts/unified-columns.check.cjs
const fs = require('fs'), os = require('os'), path = require('path')
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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const seed = '段甲。\n\n段乙。\n\n段丙。\n'
  const p = await browser.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)

  // C1:把前两个段落 wrap 成 row(cell(甲), cell(乙)),断言 DOM 两列 + 落盘锚注释。
  const c1 = await p.evaluate(() => {
    const view = window.__upage.probe.view()
    if (!view) return { err: 'no view' }
    const { state } = view
    const row = state.schema.nodes.amadeusColumnRow
    const cell = state.schema.nodes.amadeusColumnCell
    if (!row || !cell) return { err: 'no schema nodes' }
    const p1 = state.doc.child(0)
    const p2 = state.doc.child(1)
    const end2 = p1.nodeSize + p2.nodeSize
    const node = row.create(null, [
      cell.create({ anchor: 'ca01', width: 1 }, p1),
      cell.create({ anchor: 'ca02', width: 1 }, p2),
    ])
    view.dispatch(state.tr.replaceWith(0, end2, node))
    return { ok: true }
  })
  await p.waitForTimeout(1400) // 200ms listener + 800ms 防抖落盘
  const c1b = await p.evaluate((s) => {
    const rows = document.querySelectorAll(`${s} .amx-ucolrow`)
    const cells = document.querySelectorAll(`${s} .amx-ucolcell`)
    const w = window.__upage.writes
    const last = w[w.length - 1]?.text ?? ''
    return { rows: rows.length, cells: cells.length, last }
  }, PM)
  record(
    'C1 wrap 成两列 + 落盘发射锚注释',
    !c1.err && c1b.rows === 1 && c1b.cells === 2 && /<!--\s*a\s+ca01\s*-->/.test(c1b.last) && /<!--\s*a\s+ca02\s*-->/.test(c1b.last) && c1b.last.includes('段甲。') && c1b.last.includes('段乙。'),
    JSON.stringify({ c1, rows: c1b.rows, cells: c1b.cells, md: c1b.last.slice(0, 120).replace(/\n/g, '⏎') }),
  )

  // C2:hover cell 内的段落 → ⠿ 出现且锚定到该段(不是整行/整 cell)。
  const c2pos = await p.evaluate((s) => {
    const el = document.querySelector(`${s} .amx-ucolcell:nth-of-type(2) p`)
    const r = el.getBoundingClientRect()
    return { x: r.left + 20, y: r.top + r.height / 2, top: r.top }
  }, PM)
  await p.mouse.move(c2pos.x, c2pos.y)
  await p.waitForTimeout(350)
  const c2 = await p.evaluate((top) => {
    const g = document.querySelector('.unified-gutter')
    return { show: g?.dataset.show, dy: Math.abs((g?.getBoundingClientRect().y ?? -999) - top) }
  }, c2pos.top)
  record('C2 ⠿ 在 cell 内逐块锚定', c2.show === 'true' && c2.dy < 12, JSON.stringify(c2))

  // C3:把 cell2 的「段乙」拖到 cell1 的「段甲」下缘 → 同 doc 原生移动跨 cell 成立。
  // 走真实路径:hover 段乙 → ⠿ mousedown 设 NodeSelection → 合成 HTML5 拖到段甲下缘。
  const bPos = await p.evaluate((s) => {
    const el = [...document.querySelectorAll(`${s} .amx-ucolcell p`)].find((x) => x.textContent === '段乙。')
    const r = el.getBoundingClientRect()
    return { x: r.left + 20, y: r.top + r.height / 2 }
  }, PM)
  await p.mouse.move(bPos.x, bPos.y)
  await p.waitForTimeout(350)
  const c3r = await p.evaluate((s) => {
    const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
    const gutter = document.querySelector('.unified-gutter')
    const handle = gutter?.querySelector('.drag-handle')
    if (!handle || gutter.dataset.show !== 'true') return { err: 'no handle' }
    // plugin-block 的 mousedown 设 NodeSelection
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    const dt = new DataTransfer()
    md('dragstart', handle, { dataTransfer: dt })
    const pm = document.querySelector(s)
    const target = [...document.querySelectorAll(`${s} .amx-ucolcell p`)].find((x) => x.textContent === '段甲。')
    const r = target.getBoundingClientRect()
    const at = { clientX: r.left + 40, clientY: r.bottom - 2, dataTransfer: dt }
    md('dragover', pm, at)
    md('dragover', pm, at)
    const line = document.querySelector('.unified-drop-line')
    const lineShown = !!line && line.style.display !== 'none'
    md('drop', pm, at)
    md('dragend', handle, { dataTransfer: dt })
    return { lineShown }
  }, PM)
  await p.waitForTimeout(300)
  const c3b = await p.evaluate((s) => {
    const el = document.querySelector(s)
    return {
      rows: el.querySelectorAll('.amx-ucolrow').length,
      order: [...el.querySelectorAll('p')].map((x) => x.textContent).filter((t) => t?.includes('段')),
    }
  }, PM)
  // 拖空 cell2 → 结构性清列 → 单列行解散(Notion 语义,columnsNormalizer):内容回自然流零丢失。
  record(
    'C3 块拖拽 cell→cell + 拖空即解散',
    !c3r.err && c3r.lineShown && c3b.rows === 0 && c3b.order.join('|') === '段甲。|段乙。|段丙。',
    JSON.stringify({ c3r, ...c3b }),
  )

  // C4:连续撤销恢复线性文档(wrap 与拖动各一步;撤销后三段回到顶层、零列节点)。
  await p.keyboard.press('Meta+z')
  await p.waitForTimeout(150)
  await p.keyboard.press('Meta+z')
  await p.waitForTimeout(150)
  const c4 = await p.evaluate((s) => {
    const el = document.querySelector(s)
    return {
      rows: el.querySelectorAll('.amx-ucolrow').length,
      ps: [...el.querySelectorAll(':scope > p')].map((x) => x.textContent),
    }
  }, PM)
  record('C4 撤销逐步还原线性文档(单 history)', c4.rows === 0 && c4.ps.join('|') === '段甲。|段乙。|段丙。', JSON.stringify(c4))

  await p.close()

  // C5:读侧折叠 —— v4-structured(fm layout + 锚注释)打开即渲染成列;非法 layout fail-closed 回自然流。
  {
    const fm = '---\namadeus_schema: amadeus.page/4\namadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["a1"],"width":0.6},{"refs":["a2"],"width":0.4}]}]}\n---\n'
    // 手写行无 tail:末列辖域到文件尾(规范口径)→ 行放文件尾;行后有内容的场景由带 tail 的 C6 覆盖。
    const seed = fm + '开场段。\n\n<!-- a a1 -->\n\n左列内容。\n\n<!-- a a2 -->\n\n右列内容。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const c5 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const cells = [...el.querySelectorAll('.amx-ucolcell')]
      return {
        rows: el.querySelectorAll('.amx-ucolrow').length,
        cellTexts: cells.map((c) => c.textContent),
        grow: cells.map((c) => getComputedStyle(c).flexGrow),
        topPs: [...el.querySelectorAll(':scope > p')].map((x) => x.textContent),
      }
    }, PM)
    record(
      'C5a v4-structured 打开即成列(宽度上屏,行前自然流)',
      c5.rows === 1 && c5.cellTexts.join('|') === '左列内容。|右列内容。' && c5.grow.join('|') === '0.6|0.4' &&
        c5.topPs.includes('开场段。'),
      JSON.stringify(c5),
    )
    // 编辑一笔 → 落盘保持锚+layout(写侧派生回填)。
    await pg.evaluate((s) => {
      const el = document.querySelector(`${s} .amx-ucolcell p`)
      const r = el.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    }, PM).then((c) => pg.mouse.click(c.x, c.y))
    await pg.keyboard.type('改')
    await pg.waitForTimeout(1400)
    const c5b = await pg.evaluate(() => {
      const w = window.__upage.writes
      return w[w.length - 1]?.text ?? '(none)'
    })
    record(
      'C5b 列内编辑落盘:锚+layout+schema 全保持',
      /<!--\s*a\s+a1\s*-->/.test(c5b) && /<!--\s*a\s+a2\s*-->/.test(c5b) && c5b.includes('amadeus_layout') && c5b.includes('amadeus_schema') && c5b.includes('"width":0.6') && c5b.includes('左列内容。改'),
      JSON.stringify(c5b.slice(0, 160).replace(/\n/g, '⏎')),
    )
    await pg.close()

    const bad = await browser.newPage({ locale: 'zh-CN' })
    const badSeed = fm.replace('"refs":["a2"]', '"refs":["aX"]') + '<!-- a a1 -->\n\n甲。\n\n<!-- a a2 -->\n\n乙。\n'
    await bad.goto(`${URL}?upage&useed=${encodeURIComponent(badSeed)}`, { waitUntil: 'domcontentloaded' })
    await bad.waitForSelector(PM, { timeout: 20000 })
    await bad.waitForTimeout(400)
    const c5c = await bad.evaluate((s) => {
      const el = document.querySelector(s)
      return { rows: el.querySelectorAll('.amx-ucolrow').length, text: el.textContent?.includes('甲。') && el.textContent?.includes('乙。') }
    }, PM)
    record('C5c 非法 layout(refs 缺锚)fail-closed 回自然流', c5c.rows === 0 && c5c.text === true, JSON.stringify(c5c))
    await bad.close()
  }

  // C6:拖到块左缘 → 竖直指示线 + 成两列;落盘生出 fm layout。
  // C7:把列里的块拖出(拖到底部)→ 单列行解散;锚转惰性标记保留(永不回收)。
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent('段甲。\n\n段乙。\n\n段丙。\n')}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const hover = async (txt) => {
      const c = await pg.evaluate((t) => {
        const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent === t)
        const r = el.getBoundingClientRect()
        return { x: r.left + 20, y: r.top + r.height / 2 }
      }, txt)
      await pg.mouse.move(c.x, c.y)
      await pg.waitForTimeout(350)
    }
    await hover('段乙。')
    const c6 = await pg.evaluate((s) => {
      const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
      const gutter = document.querySelector('.unified-gutter')
      if (gutter?.dataset.show !== 'true') return { err: 'no gutter' }
      gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      const dt = new DataTransfer()
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const target = [...pm.querySelectorAll(':scope > p')].find((x) => x.textContent === '段甲。')
      const r = target.getBoundingClientRect()
      const at = { clientX: r.left + 8, clientY: r.top + r.height / 2, dataTransfer: dt }
      md('dragover', pm, at)
      md('dragover', pm, at)
      const vline = document.querySelector('.unified-drop-vline')
      const vShown = !!vline && vline.style.display !== 'none'
      md('drop', pm, at)
      md('dragend', gutter, { dataTransfer: dt })
      return { vShown }
    }, PM)
    await pg.waitForTimeout(1400)
    const c6b = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const cells = [...el.querySelectorAll('.amx-ucolcell')]
      const w = window.__upage.writes
      return { rows: el.querySelectorAll('.amx-ucolrow').length, cellTexts: cells.map((c) => c.textContent), last: w[w.length - 1]?.text ?? '' }
    }, PM)
    record(
      'C6 拖至左缘:竖线 + 成两列[乙|甲] + 落盘 layout(带 tail 封底)',
      !c6.err && c6.vShown && c6b.rows === 1 && c6b.cellTexts.join('|') === '段乙。|段甲。' && c6b.last.includes('amadeus_layout') && c6b.last.includes('"tail"') && /<!--\s*a\s+\w+\s*-->/.test(c6b.last),
      JSON.stringify({ c6, rows: c6b.rows, cells: c6b.cellTexts }),
    )

    // C7:把左列的「段乙」拖到「段丙」下缘 → 行只剩一列 → 解散;锚转惰性标记,layout 剥除。
    await hover('段乙。')
    await pg.evaluate((s) => {
      const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
      const gutter = document.querySelector('.unified-gutter')
      gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      const dt = new DataTransfer()
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const target = [...pm.querySelectorAll('p')].find((x) => x.textContent === '段丙。')
      const r = target.getBoundingClientRect()
      const at = { clientX: r.left + 60, clientY: r.bottom - 2, dataTransfer: dt }
      md('dragover', pm, at)
      md('dragover', pm, at)
      md('drop', pm, at)
      md('dragend', gutter, { dataTransfer: dt })
    }, PM)
    await pg.waitForTimeout(1400)
    const c7 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const w = window.__upage.writes
      const last = w[w.length - 1]?.text ?? ''
      return {
        rows: el.querySelectorAll('.amx-ucolrow').length,
        order: [...el.querySelectorAll('p')].map((x) => x.textContent).filter((t) => t?.includes('段')),
        anchorsKept: (last.match(/<!--\s*a\s+\w+\s*-->/g) ?? []).length,
        layoutGone: !last.includes('amadeus_layout'),
      }
    }, PM)
    record(
      'C7 拖出解散:行消失+顺序[甲丙乙]+锚转惰性保留+layout 剥除',
      c7.rows === 0 && c7.order.join('|') === '段甲。|段丙。|段乙。' && c7.anchorsKept >= 2 && c7.layoutGone,
      JSON.stringify(c7),
    )

    await pg.close()
  }

  // C8:**打开即拖散**(不做任何编辑)→ layout/schema 必须剥掉(sawRows 由 parse 折叠置位,
  // 不是只有编辑期 derive 会置;此前恒 false → layout 剥不掉 → 重开列复活,advisor 复核抓的雷)。
  {
    const fm = '---\namadeus_schema: amadeus.page/4\namadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["a1"],"width":0.5},{"refs":["a2"],"width":0.5}],"tail":"t9"}]}\n---\n'
    const seed = fm + '<!-- a a1 -->\n\n左块。\n\n<!-- a a2 -->\n\n右块。\n\n<!-- a t9 -->\n\n行后段。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const pre = await pg.evaluate((s) => document.querySelector(s).querySelectorAll('.amx-ucolrow').length, PM)
    // 直接把左块拖到「行后段」下缘(第一步操作就是拖散,中间零编辑)。
    const hov = await pg.evaluate((s) => {
      const el = [...document.querySelectorAll(`${s} .amx-ucolcell p`)].find((x) => x.textContent === '左块。')
      const r = el.getBoundingClientRect()
      return { x: r.left + 15, y: r.top + r.height / 2 }
    }, PM)
    await pg.mouse.move(hov.x, hov.y)
    await pg.waitForTimeout(350)
    await pg.evaluate((s) => {
      const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
      const gutter = document.querySelector('.unified-gutter')
      gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      const dt = new DataTransfer()
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const target = [...pm.querySelectorAll('p')].find((x) => x.textContent === '行后段。')
      const r = target.getBoundingClientRect()
      const at = { clientX: r.left + 60, clientY: r.bottom - 2, dataTransfer: dt }
      md('dragover', pm, at)
      md('dragover', pm, at)
      md('drop', pm, at)
      md('dragend', gutter, { dataTransfer: dt })
    }, PM)
    await pg.waitForTimeout(1400)
    const c8 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const w = window.__upage.writes
      const last = w[w.length - 1]?.text ?? '(no write)'
      return {
        rows: el.querySelectorAll('.amx-ucolrow').length,
        layoutGone: !last.includes('amadeus_layout') && !last.includes('amadeus_schema'),
        contentKept: last.includes('左块。') && last.includes('右块。') && last.includes('行后段。'),
        anchorsKept: (last.match(/<!--\s*a\s+\w+\s*-->/g) ?? []).length >= 2,
      }
    }, PM)
    record('C8 打开即拖散:layout/schema 剥除+内容与惰性锚全保', pre === 1 && c8.rows === 0 && c8.layoutGone && c8.contentKept && c8.anchorsKept, JSON.stringify({ pre, ...c8 }))
    await pg.close()
  }

  // C9:拖到分栏行**下方** → 整宽横线 + 落点=行后顶层(真机第5振:行是文末节点时,行内任何
  // 落点都被吸进最近 cell,块永远拖不出列/移不到「分栏的下一行」)。两幕:
  //  a) 行前的顶层段拖到行底以下 → 移到行后,行结构不动;
  //  b) 列内块拖到行底以下(用户原场景)→ 移出到行后顶层,行保持(cell 还有剩余块)。
  {
    const fm = '---\namadeus_schema: amadeus.page/4\namadeus_layout: {"v":4,"rows":[{"columns":[{"refs":["b1"],"width":0.5},{"refs":["b2"],"width":0.5}],"tail":"t1"}]}\n---\n'
    const seed = fm + '首段。\n\n<!-- a b1 -->\n\n左块一。\n\n左块二。\n\n<!-- a b2 -->\n\n右块。\n\n<!-- a t1 -->\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const hover = async (txt) => {
      const c = await pg.evaluate((t) => {
        const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent === t)
        const r = el.getBoundingClientRect()
        return { x: r.left + 15, y: r.top + r.height / 2 }
      }, txt)
      await pg.mouse.move(c.x, c.y)
      await pg.waitForTimeout(350)
    }
    // 事件打在**真实命中元素**上(elementFromPoint):行底以下 60px 在真机是 .page-tail /
    // pane 空白区(view.dom 之外)——直接打 pm 会绕过监听拓扑,测不出「dragover 到不了插件、
    // 浏览器不发 drop」这类真雷(P15 同款合成事件盲区)。
    const dragBelowRow = async () => pg.evaluate((s) => {
      const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
      const gutter = document.querySelector('.unified-gutter')
      if (gutter?.dataset.show !== 'true') return { err: 'no gutter' }
      gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      const dt = new DataTransfer()
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const row = pm.querySelector(':scope > .amx-ucolrow')
      const r = row.getBoundingClientRect()
      const at = { clientX: r.left + r.width / 2, clientY: r.bottom + 60, dataTransfer: dt }
      const hit = document.elementFromPoint(at.clientX, at.clientY) ?? pm
      const hitTag = hit.className || hit.tagName
      const inPm = pm.contains(hit)
      md('dragover', hit, at)
      md('dragover', hit, at)
      const lines = [...document.querySelectorAll('.unified-drop-line')]
      const hShown = lines.some((l) => l.style.display !== 'none' && parseFloat(l.style.width || '0') > r.width * 0.9)
      md('drop', hit, at)
      md('dragend', gutter, { dataTransfer: dt })
      return { hShown, hitTag: String(hitTag).slice(0, 30), inPm }
    }, PM)

    await hover('首段。')
    const a = await dragBelowRow()
    await pg.waitForTimeout(1400)
    const a2 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const last = window.__upage.writes.at(-1)?.text ?? ''
      return {
        rows: el.querySelectorAll('.amx-ucolrow').length,
        afterRow: [...el.children].map((x) => x.textContent).join('|'),
        tailBeforeShou: last.indexOf('<!-- a t1 -->') >= 0 && last.indexOf('<!-- a t1 -->') < last.indexOf('首段。'),
      }
    }, PM)
    record(
      'C9a 行前顶层段拖到行底以下:整宽横线+移到行后(行结构不动)',
      !a.err && a.hShown && a2.rows === 1 && /左块一。左块二。右块。\|首段。$/.test(a2.afterRow) && a2.tailBeforeShou,
      JSON.stringify({ a, ...a2 }),
    )

    // b) 重开同种子(行仍是文末节点),把**列内块**拖到行底以下(用户原场景)。
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    await hover('左块一。')
    const b = await dragBelowRow()
    await pg.waitForTimeout(1400)
    const b2 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const last = window.__upage.writes.at(-1)?.text ?? ''
      return {
        rows: el.querySelectorAll('.amx-ucolrow').length,
        cellTexts: [...el.querySelectorAll('.amx-ucolcell')].map((c) => c.textContent).join('|'),
        afterRow: [...el.children].map((x) => x.textContent).join('|'),
        outInTail: /<!--\s*a\s+t1\s*-->[\s\S]*左块一。/.test(last),
      }
    }, PM)
    record(
      'C9b 列内块拖到行底以下:移出到行后顶层,行保持',
      !b.err && b.hShown && b2.rows === 1 && b2.cellTexts === '左块二。|右块。' && /^首段。\|左块二。右块。\|左块一。$/.test(b2.afterRow) && b2.outInTail,
      JSON.stringify({ b, ...b2 }),
    )
    await pg.close()
  }

  // C10:Alt 拖 = 复制(mac;其余平台 Ctrl)。PM 自己的默认落点早就认这个修饰键,而我们的两条
  // 自定路由(成列 executePair / 行下方 executeMoveBelowRow)此前恒 move —— 同一个 Alt 在同一个
  // 编辑器里两种结果。判据与 prosemirror-view 的 dragCopyModifier 同源(blockLayer.dragCopies)。
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent('段甲。\n\n段乙。\n\n段丙。\n')}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const c = await pg.evaluate(() => {
      const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => x.textContent === '段乙。')
      const r = el.getBoundingClientRect()
      return { x: r.left + 20, y: r.top + r.height / 2 }
    })
    await pg.mouse.move(c.x, c.y)
    await pg.waitForTimeout(350)
    const a = await pg.evaluate((s) => {
      const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
      const gutter = document.querySelector('.unified-gutter')
      if (gutter?.dataset.show !== 'true') return { err: 'no gutter' }
      gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      const dt = new DataTransfer()
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const target = [...pm.querySelectorAll(':scope > p')].find((x) => x.textContent === '段甲。')
      const r = target.getBoundingClientRect()
      const at = { clientX: r.left + 8, clientY: r.top + r.height / 2, dataTransfer: dt, altKey: true, ctrlKey: true }
      md('dragover', pm, at)
      md('dragover', pm, at)
      md('drop', pm, at)
      md('dragend', gutter, { dataTransfer: dt })
      return {}
    }, PM)
    await pg.waitForTimeout(600)
    const b = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      return {
        rows: el.querySelectorAll('.amx-ucolrow').length,
        cellTexts: [...el.querySelectorAll('.amx-ucolcell')].map((x) => x.textContent).join('|'),
        topPs: [...el.querySelectorAll(':scope > p')].map((x) => x.textContent).join('|'),
      }
    }, PM)
    record(
      'C10 Alt 拖成列 = 复制(原块留在原地,不是搬走)',
      !a.err && b.rows === 1 && b.cellTexts === '段乙。|段甲。' && b.topPs === '段乙。|段丙。',
      JSON.stringify(b),
    )
    await pg.close()
  }

  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exit(results.every(Boolean) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
