// 多维表「拖表头调列顺序」(2026-09-02 用户实报:列/表头拖不动 —— 查下来是从来没做)。
// 列序 = db.columns 的数组序(没有每视图列序),所以与行拖拽共用 rowOrder 的 moveRow。
//
// ⚠️ 首列是**标题列**:dbRowTitle 恒取 columns[0],看板/日历/画廊卡片标题、以及**别的表 rowlink
//    芯片上的文字**全从它来。所以首列既不能被拖走、别的列也不能落到它前面 —— C2/C3 钉的就是这条。
// ⚠️ 列拖拽**不受行的排序/筛选/分组影响**(台架这张表恰好带分组+多列排序,C1 顺带钉住这点)。
// 用法:node scripts/e2e-editor.cjs --check=db-colorder
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
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function fresh(browser) {
  const p = await browser.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?dbdemo`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.amx-db-hrow .amx-db-th', { timeout: 20000 })
  await p.waitForTimeout(300)
  return p
}

/** 表头列名(= 可见列序)。 */
const heads = (p) => p.evaluate(() => [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent))

/**
 * 合成一次 HTML5 列拖拽:在源列表头按钮上 dragstart,在目标列表头格上 dragover+drop。
 * side='left'|'right' 决定落点在目标格的哪一半(组件按 dropAfterX 判定)。
 * 仓里既有的合成手法同 block-file-ops.check.cjs —— 真 DataTransfer + 冒泡 DragEvent。
 */
const dragCol = async (p, fromName, toName, side, dropSide = side) => {
  // ⚠️ dragstart 与 dragover/drop **必须分两个 tick**:组件在 onDragStart 里 setState 记下拖的是谁,
  //    React 要重渲染一轮之后 onDragOver 才看得见它。同一个 evaluate 里连发三个事件 → 组件全程
  //    colDrag=null → 一律早退,顺序纹丝不动,而断言会以为「拖了但没生效」。真浏览器里两者天然隔着
  //    用户移动鼠标的时间,所以这是**仪器的失真**,不是组件的 bug(行拖拽同款写法早已在线上跑着)。
  const started = await p.evaluate((from) => {
    const th = (n) => [...document.querySelectorAll('.amx-db-hrow .amx-db-th')]
      .find((e) => e.querySelector('.amx-db-th-name')?.textContent === n)
    const src = th(from)
    if (!src) return `找不到列 ${from}`
    const btn = src.querySelector('.amx-db-thbtn')
    if (btn.getAttribute('draggable') !== 'true') return 'NOT-DRAGGABLE'
    window.__dt = new DataTransfer()
    btn.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    return 'OK'
  }, fromName)
  if (started !== 'OK') return started
  await p.waitForTimeout(80) // 让 React 把 colDrag 提交上去
  return p.evaluate(([to, sd, ds]) => {
    const th = (n) => [...document.querySelectorAll('.amx-db-hrow .amx-db-th')]
      .find((e) => e.querySelector('.amx-db-th-name')?.textContent === n)
    const dst = th(to)
    if (!dst) return `找不到列 ${to}`
    const r = dst.getBoundingClientRect()
    const x = sd === 'right' ? r.left + r.width * 0.8 : r.left + r.width * 0.2
    const y = r.top + r.height / 2
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: window.__dt }))
    // drop 可以落在与最后一次 dragover **不同的半边**:真实操作里「快速掠过中线后立刻松手」就是这样,
    // 中间来不及再发一次 dragover。组件若拿 state 里的 after 落盘,这里就会用错值。
    const x2 = ds === 'right' ? r.left + r.width * 0.8 : r.left + r.width * 0.2
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x2, clientY: y, dataTransfer: window.__dt }))
    return 'OK'
  }, [toName, side, dropSide])
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── C1:把「工时」拖到「状态」左边。台架这张表带分组+多列排序(行不可手排),列照样能动。
  {
    const p = await fresh(browser)
    const before = await heads(p)
    const r = await dragCol(p, '工时', '状态', 'left')
    await p.waitForTimeout(200)
    const after = await heads(p)
    record('C1 拖表头改列序(分组+排序下照样生效)',
      r === 'OK' && after.join('|') !== before.join('|') && after.indexOf('工时') < after.indexOf('状态'),
      `${r} ${before.join(',')} → ${after.join(',')}`)
    await p.close()
  }

  // ── C2:数据格跟着列走 —— 只有表头动 = 假绿(那是把列名挪了、数据还在原位)。
  //    口径:记下移动前首个数据行「单价」格里的值,移动后该列新下标上必须还是同一个值。
  {
    const p = await fresh(browser)
    const snap = () => p.evaluate(() => {
      const names = [...document.querySelectorAll('.amx-db-hrow .amx-db-th-name')].map((e) => e.textContent)
      const row = document.querySelector('.amx-db-row:not(.amx-db-hrow)')
      // 数字/文本格是真 <input>,值在 .value 上,textContent 恒空 —— 只读 textContent 会拿到一排空串,
      // 断言「前后相等」于是恒真:那是本仪器第一版的假绿形态。
      const cells = [...(row?.querySelectorAll('.amx-db-cell') ?? [])]
        .map((c) => c.querySelector('input, textarea')?.value ?? c.textContent.trim())
      return { i: names.indexOf('单价'), names, cells }
    })
    const before = await snap()
    await dragCol(p, '单价', '状态', 'left')
    await p.waitForTimeout(200)
    const after = await snap()
    record('C2 数据格跟着列一起挪(不是只挪了表头)',
      after.i >= 0 && after.i !== before.i && after.cells[after.i] === before.cells[before.i] && before.cells[before.i] !== '',
      `单价 ${before.i}→${after.i} 值 "${before.cells[before.i]}"→"${after.cells[after.i]}"`)
    await p.close()
  }

  // ── C3:首列(标题列)不给拖 —— draggable 就不该是 true。
  {
    const p = await fresh(browser)
    const r = await dragCol(p, '任务', '工时', 'right')
    const after = await heads(p)
    record('C3 首列(标题列)不可拖走', r === 'NOT-DRAGGABLE' && after[0] === '任务', `${r} head0=${after[0]}`)
    await p.close()
  }

  // ── C4:别的列拖到首列**左半**,也只能落到它右边 —— 否则标题列易主,全库 rowlink 芯片集体改名。
  {
    const p = await fresh(browser)
    const r = await dragCol(p, '工时', '任务', 'left')
    await p.waitForTimeout(200)
    const after = await heads(p)
    record('C4 拖到首列左半也进不去 0 位(标题列不易主)',
      r === 'OK' && after[0] === '任务' && after[1] === '工时', `${r} ${after.join(',')}`)
    await p.close()
  }

  // ── C5:列菜单的「← 左移 / 右移 →」(拖拽之外的入口:触屏拖不动、键盘也用得上)。
  {
    const p = await fresh(browser)
    await p.click('.amx-db-thbtn:has-text("工时")')
    await p.waitForSelector('.amx-db-pop', { timeout: 5000 })
    await p.click('.amx-db-opt:has-text("左移")')
    await p.waitForTimeout(250)
    const moved = await heads(p)
    record('C5 列菜单「左移」把列挪到前一格', moved.indexOf('工时') === 1, moved.join(','))
    await p.close()
  }

  // ── C6:首列的菜单里不该出现这对按钮(它位置固定;UI 与上面那道权威闸同口径)。
  //    另开一页而不是关弹层再点 —— .amx-db-popwrap 是全屏遮罩,同页连点会被它吃掉。
  {
    const p = await fresh(browser)
    await p.click('.amx-db-thbtn:has-text("任务")')
    await p.waitForSelector('.amx-db-pop', { timeout: 5000 })
    const has = await p.evaluate(() =>
      [...document.querySelectorAll('.amx-db-pop .amx-db-opt')].some((b) => /左移|右移/.test(b.textContent || '')))
    record('C6 首列菜单没有左移/右移', !has, `hasMoveButtons=${has}`)
    await p.close()
  }

  // ── C7:落在普通目标列的**右半** → 插到它之后。
  //    Codex 抓的覆盖洞:C1/C2/C4 全是 left,唯一的 'right'(C3)在 NOT-DRAGGABLE 处就退出了 ——
  //    也就是说组件哪怕永远按 before 插,原来那套断言照样全绿。
  //    这一例也顺带钉住「落点按 drop 自己的坐标现算」:吃 state 的旧写法在快速掠过中线时会用旧值。
  {
    const p = await fresh(browser)
    const r = await dragCol(p, '工时', '小计', 'right')
    await p.waitForTimeout(200)
    const after = await heads(p)
    record('C7 落在目标列右半 → 插到它之后',
      r === 'OK' && after.indexOf('工时') === after.indexOf('小计') + 1, `${r} ${after.join(',')}`)
    await p.close()
  }

  // ── C8:视觉空操作(拖到紧邻列的同一侧)不改顺序 —— 这一手不该产生任何改动。
  {
    const p = await fresh(browser)
    const before = await heads(p)
    await dragCol(p, '工时', '单价', 'left') // 工时本来就紧邻在单价之前
    await p.waitForTimeout(200)
    const after = await heads(p)
    record('C8 拖到紧邻列同侧 = 空操作,顺序不变', before.join(',') === after.join(','), after.join(','))
    await p.close()
  }

  // ── C9:dragover 停在左半、**松手时人已划到右半** → 必须按 drop 的坐标插到目标之后。
  //    组件若拿上一次 dragover 异步写进 state 的 after 落盘,这里就会插错边(Codex 抓的竞态)。
  {
    const p = await fresh(browser)
    const r = await dragCol(p, '工时', '小计', 'left', 'right')
    await p.waitForTimeout(200)
    const after = await heads(p)
    record('C9 松手瞬间越过中线 → 按 drop 坐标判,不吃旧 state',
      r === 'OK' && after.indexOf('工时') === after.indexOf('小计') + 1, `${r} ${after.join(',')}`)
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
