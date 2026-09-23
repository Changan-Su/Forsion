// 嵌入体里住着**真表单控件**(多维表搜索框/公式框/单元格、插件表单…),它们与外层编辑器
// 撞过两次,都是 2026-09-01 用户实报:
//   ① 按键漏进 ProseMirror:公式框里按删除键,整张表变回 `![[任务.db|表格]]` 源码。
//      根因在 unified/embedLayer 的 widget 装饰没写 stopEvent —— PM 的 eventBelongsToView 一路走到
//      view.dom,baseKeymap 的 Backspace 拿**外层**选区跑 joinBackward,选区落进本节点 →
//      「光标在节点内 → 让位露源码」生效。
//   ② 丝滑光标把它们的原生 caret 一起藏了:`html.sc-on .milkdown .ProseMirror{caret-color:transparent}`
//      会继承进这些控件,而自绘覆盖层对 input/textarea 一律不画 → 一个光标都没有。
// K1 嵌入内按键不动文档 / K2 嵌入外按键照常生效(防修过头)/ K3 双击不进源码 / K4 丝滑光标下
// 嵌入内控件仍有原生 caret / K5 负对照:同一页的编辑器本体仍是 transparent(自绘覆盖层接管)。
// K6 切视图保住 React 实例/搜索 / K7 数据库只经显式入口编辑源码 / K8 v3 数据库不抢 Shift 选字。
// 用法:node scripts/e2e-editor.cjs --check=embed-inputs
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
const NOTE = 'DbEmbed.md'
// 嵌入前后各留一段:joinBackward 得有东西可合并,合没合并一眼看得出(段数 3 → 2)。
const MD = '前一段。\n\n![[任务.db|表格]]\n\n后一段。\n'
const DB = {
  version: 1, name: '任务',
  views: [{ id: 'v1', name: '表格', type: 'table' }, { id: 'v2', name: '第二视图', type: 'table' }],
  columns: [
    { id: 'c1', name: '任务', type: 'text' },
    { id: 'c3', name: '工时', type: 'number' },
    { id: 'c4', name: '单价', type: 'number' },
    { id: 'f1', name: '小计', type: 'formula', formula: '{工时}*{单价}' },
  ],
  rows: [
    { id: 't1', cells: { c1: '首页视觉稿', c3: 8, c4: 200 } },
    { id: 't2', cells: { c1: '接口联调', c3: 5, c4: 300 } },
  ],
}

const results = []
const record = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 每例一张干净的页:?upage 起 → 种 .db 与正文 → 等表格画出来。extra 追加查询串(如 '&caret')。 */
async function fresh(browser, extra = '', md = MD) {
  const p = await browser.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage${extra}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.evaluate(([note, md, db]) => {
    window.__upage.vault.set('任务.db', JSON.stringify(db))
    window.__upage.switchFile(note, md)
  }, [NOTE, md, DB])
  await p.waitForSelector('.amx-db', { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 文档现状:段落数 + 前后两段还在不在 + 这篇被写过几次。 */
const docState = (p) =>
  p.evaluate(([s, note]) => ({
    paras: document.querySelectorAll(`${s} > p`).length,
    head: document.body.innerText.includes('前一段。'),
    tail: document.body.innerText.includes('后一段。'),
    table: !!document.querySelector('.amx-db'),
    writes: window.__upage.writes.filter((w) => w.path === note).length,
  }), [PM, NOTE])

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── K1:公式框里连按删除键 —— 表还在、文档一个字没动、一次没落盘。
  if (!process.argv.includes('--lifecycle')) {
    const p = await fresh(browser)
    // ⚠️ 必须先把 PM 光标放到「嵌入后那段的段首」再去开列菜单:光标停在文档最开头时
    // baseKeymap 的 Backspace 本来就是 no-op —— 那样即使漏进来也**看不出**(本仪器第一版就是
    // 这么假绿的)。段首才触发 joinBackward:合并 → 选区落进嵌入所在段 → 表退化成源码。
    const head = await p.evaluate((s) => {
      const b = document.querySelector(s).querySelector(':scope > p:last-of-type').getBoundingClientRect()
      return { x: b.left + 2, y: b.top + b.height / 2 }
    }, PM)
    await p.mouse.click(head.x, head.y)
    await p.waitForTimeout(200)
    await p.click('.amx-db-thbtn:has-text("小计")')
    await p.waitForSelector('.amx-db-formula-in', { timeout: 5000 })
    await p.click('.amx-db-formula-in')
    await p.keyboard.type('2')
    for (let i = 0; i < 3; i++) await p.keyboard.press('Backspace')
    await p.waitForTimeout(1300) // 过防抖落盘窗
    const st = await docState(p)
    record('K1 公式框内 Backspace 不漏进文档(表仍在渲染态)',
      st.table && st.paras === 3 && st.head && st.tail && st.writes === 0, JSON.stringify(st))
    await p.close()
  }

  // ── K2:防修过头 —— 嵌入**外**的 Backspace 必须照常合并段落(否则这次修法把编辑器一起废了)。
  {
    const p = await fresh(browser)
    const at = await p.evaluate((s) => {
      const last = document.querySelector(s).querySelector(':scope > p:last-of-type')
      const b = last.getBoundingClientRect()
      return { x: b.right - 2, y: b.top + b.height / 2 }
    }, PM)
    await p.mouse.click(at.x, at.y) // 落在正文末尾:真点击才让 PM 认下选区
    await p.waitForTimeout(200)
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(300)
    const tail = await p.evaluate((s) => document.querySelector(s).querySelector(':scope > p:last-of-type').textContent, PM)
    record('K2 嵌入外 Backspace 照常生效(正文真删了一个字)', tail === '后一段', `tail=${tail}`)
    await p.close()
  }

  // ── K3:双击数据库不能拆成引用源码。源码有显式入口,内容区双击留给选词和控件。
  {
    const p = await fresh(browser)
    await p.dblclick('.unified-embed')
    await p.waitForTimeout(400)
    const src = await p.evaluate(() => ({
      table: !!document.querySelector('.amx-db'),
      raw: document.body.innerText.includes('![[任务.db'),
    }))
    record('K3 双击数据库保持渲染态', src.table && !src.raw, JSON.stringify(src))
    await p.close()
  }

  // ── K6:写回嵌入视图名不能重挂数据库,否则搜索、输入焦点及弹层状态全丢。
  {
    const p = await fresh(browser)
    await p.locator('.amx-db-search').click()
    await p.locator('.amx-db-search').fill('首页')
    await p.evaluate(() => { window.__dbBefore = document.querySelector('.amx-db') })
    await p.getByRole('tab', { name: '第二视图', exact: true }).click()
    await p.waitForTimeout(300)
    const st = await p.evaluate(() => ({
      same: window.__dbBefore === document.querySelector('.amx-db'),
      query: document.querySelector('.amx-db-search')?.value,
      view: document.querySelector('.amx-db-viewtab[aria-selected="true"]')?.textContent,
      source: window.__upage.probe.view().state.doc.textContent,
    }))
    record('K6 切换视图原地更新且保留搜索,引用正确回写', st.same && st.query === '首页' && st.view === '第二视图' && st.source.includes('![[任务.db|第二视图]]'), JSON.stringify(st))
    await p.getByRole('tab', { name: '表格', exact: true }).click()
    await p.waitForTimeout(150)
    record('K6 连续切回仍找到同一个嵌入并回写正确位置', await p.evaluate(() => window.__upage.probe.view().state.doc.textContent.includes('![[任务.db|表格]]')))
    // 模拟撤销/外部文档事务,不是 DbTable 自己的 pickView:初值 prop 更新必须同步到现有实例。
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      v.state.doc.descendants((n, pos) => {
        if (n.isTextblock && n.textContent === '![[任务.db|表格]]') {
          v.dispatch(v.state.tr.insertText('![[任务.db|第二视图]]', pos + 1, pos + n.nodeSize - 1))
          return false
        }
      })
    })
    await p.waitForTimeout(200)
    record('K6 外部引用视图变化同步 UI,实例与搜索不丢', await p.evaluate(() =>
      window.__dbBefore === document.querySelector('.amx-db') && document.querySelector('.amx-db-search')?.value === '首页' && document.querySelector('.amx-db-viewtab[aria-selected="true"]')?.textContent === '第二视图'))
    await p.close()
  }

  // ── K7:只有 </> 显式打开,离开源码复渲染。隐藏文本里的 PM 选区不应成为入口。
  {
    const p = await fresh(browser)
    await p.evaluate(() => {
      const v = window.__upage.probe.view()
      let pos = 0
      v.state.doc.descendants((n, at) => { if (n.isTextblock && n.textContent.startsWith('![[任务.db')) pos = at + 3 })
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, pos)))
      v.focus()
    })
    record('K7 光标进入数据库引用位置仍保持渲染', await p.locator('.amx-db').count() === 1)
    await p.hover('.unified-embed')
    await p.click('.unified-embed > .amx-src-btn')
    await p.waitForTimeout(200)
    record('K7 显式源码按钮仍能打开引用', await p.locator('.amx-db').count() === 0 && (await p.locator(PM).innerText()).includes('![[任务.db'))
    await p.locator(`${PM} > p`).last().click()
    await p.waitForTimeout(200)
    record('K7 离开引用后恢复数据库', await p.locator('.amx-db').count() === 1)
    await p.close()
  }

  // ── K8:旧块宿主仍用于仪表盘/插件,全局捕获监听不能抢数据库的 Shift+双击选词。
  {
    const p = await browser.newPage({ locale: 'zh-CN' })
    await p.goto(`${URL}?embed`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('[data-block-id="e1"]')
    await p.evaluate((db) => {
      window.__dbStore.setState({ entries: { '任务.db': { status: 'ok', path: '任务.db', data: db } } })
      const ps = window.__pageStore
      ps.setState({ blocks: { ...ps.getState().blocks, e1: { id: 'e1', type: 'markdown', content: '![[ 任务.db |表格]]' } } })
    }, DB)
    await p.waitForSelector('.amx-db')
    await p.locator('.amx-db-name').dblclick({ modifiers: ['Shift'] })
    await p.waitForTimeout(200)
    record('K8 旧块宿主数据库内 Shift+双击不进入源码', await p.locator('.embed-src-input').count() === 0)
    // 同一宿主显式按钮仍可用。
    await p.hover('[data-block-id="e1"]')
    await p.click('[data-block-id="e1"] > .amx-src-btn:not(.amx-open-btn)')
    record('K8 旧块宿主仍可显式查看源码', await p.locator('.embed-src-input').count() === 1)
    await p.keyboard.press('Escape')
    await p.evaluate(() => {
      document.activeElement?.blur()
      window.__dndSelect(['e1'])
    })
    record('K8 选中数据库整块不展示 Markdown 引用行', await p.locator('[data-block-id="e1"] .embed-src-line').count() === 0)
    await p.keyboard.press('Enter')
    record('K8 选中数据库 Enter 聚焦内容,不进入源码', await p.evaluate(() =>
      !document.querySelector('.embed-src-input') && !!document.activeElement?.closest('.amx-db')))
    await p.locator('.amx-db-rowopen').first().click()
    await p.waitForSelector('.amx-db-peek')
    await p.evaluate(() => {
      // Portal 的容器/按钮不是 input,捕获期的全局块快捷键也必须知道它属于数据库。
      document.querySelector('.amx-db-peek').focus()
      window.__peekKeyReached = false
      document.querySelector('.amx-db-peek').addEventListener('keydown', () => { window.__peekKeyReached = true }, { once: true })
      window.__dndSelect(['e1'])
    })
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(100)
    record('K8 详情 Portal 按键不删除外层已选数据库块', await p.evaluate(() =>
      window.__peekKeyReached && !!window.__pageStore.getState().blocks.e1 && !!document.querySelector('.amx-db-peek')))
    await p.keyboard.press('Escape')
    await p.close()
  }

  // ── K9:同一库两处不同视图也必须定位到自己,不能因稳定 key 合并实例或回写到另一处。
  {
    const p = await fresh(browser, '', '前一段。\n\n![[任务.db|表格]]\n\n中间一段。\n\n![[任务.db|第二视图]]\n\n后一段。\n')
    await p.waitForFunction(() => document.querySelectorAll('.amx-db').length === 2)
    await p.evaluate(() => { window.__dbBoth = [...document.querySelectorAll('.amx-db')] })
    await p.locator('.amx-db').nth(1).getByRole('tab', { name: '表格', exact: true }).click()
    await p.waitForTimeout(200)
    const st = await p.evaluate(() => ({
      identities: [...document.querySelectorAll('.amx-db')].every((el, i) => window.__dbBoth[i] === el),
      refs: Array.from(window.__upage.probe.view().state.doc.content.content).filter((n) => n.textContent.startsWith('![[任务.db')).map((n) => n.textContent),
      active: [...document.querySelectorAll('.amx-db-viewtab[aria-selected="true"]')].map((el) => el.textContent),
    }))
    record('K9 同库两处嵌入身份各自保留,只改目标引用', st.identities && st.refs.join('|') === '![[任务.db|表格]]|![[任务.db|表格]]' && st.active.join('|') === '表格|表格', JSON.stringify(st))
    await p.locator('.amx-db').nth(0).getByRole('tab', { name: '第二视图', exact: true }).click()
    await p.waitForTimeout(150)
    record('K9 同文后再切第一处也不会改到第二处', await p.evaluate(() => {
      const refs = window.__upage.probe.view().state.doc.content.content.filter((n) => n.textContent.startsWith('![[任务.db')).map((n) => n.textContent)
      return refs.join('|') === '![[任务.db|第二视图]]|![[任务.db|表格]]'
    }))
    await p.close()
  }

  // ── K4/K5:丝滑光标开着时,嵌入体里的真表单控件必须还有原生 caret;编辑器本体照旧 transparent。
  //    两条必须同页量:只量 K4 的话,万一 sc-on 压根没开,它恒绿(那正是这个 bug 的假绿形态)。
  if (!process.argv.includes('--lifecycle')) {
    const p = await fresh(browser, '&caret')
    await p.click('.amx-db-thbtn:has-text("小计")')
    await p.waitForSelector('.amx-db-formula-in', { timeout: 5000 })
    const c = await p.evaluate(() => {
      const cc = (sel) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el).caretColor : 'NO-ELEMENT'
      }
      return {
        scOn: document.documentElement.classList.contains('sc-on'),
        editor: cc('.unified-body .ProseMirror'),
        search: cc('.amx-db-search'),
        formula: cc('.amx-db-formula-in'),
      }
    })
    const transparent = (v) => v === 'transparent' || v === 'rgba(0, 0, 0, 0)'
    record('K4 丝滑光标下嵌入内控件仍有原生 caret',
      c.scOn && !transparent(c.search) && !transparent(c.formula), JSON.stringify(c))
    record('K5 负对照:同页编辑器本体仍是 transparent(自绘覆盖层接管)',
      c.scOn && transparent(c.editor), JSON.stringify({ scOn: c.scOn, editor: c.editor }))
    await p.close()
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
