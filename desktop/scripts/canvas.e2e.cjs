// 画布插件实测(真浏览器 + 真 pageStore + 真插件宿主 + **外置插件的真产物**,harness.html?canvasplug)。
// 与 mindmap.e2e.cjs 同构。验:
//  1) 接缝链路 —— 装载 → registerFileType('.canvas.md') → 插件文件视图 → 块表面 → 卡片里是真块;
//  2) 双模式 —— 画布(卡片/连线/形状/框选/拖动/缩放)↔ 文档(线性块流),模式落 fm;
//  3) 几何持久化 —— 拖动/放置/连线/删形状全部单笔写进 fm 的 canvas 键(经 setFmExtra)。
// 用法:node scripts/canvas.e2e.cjs   插件产物:CANVAS_PLUGIN_MAIN 可覆盖路径
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const TARGET = `${BASE}?canvasplug`

const PLUGIN_MAIN =
  process.env.CANVAS_PLUGIN_MAIN ||
  path.resolve(__dirname, '../../../Forsion-Instrumentality-Project/forsion-plugin-canvas/main.js')

function readPluginCode() {
  if (!fs.existsSync(PLUGIN_MAIN)) {
    console.error(`找不到画布插件产物:${PLUGIN_MAIN}`)
    console.error('先在插件仓库跑 `npm run build`,或用 CANVAS_PLUGIN_MAIN 指到 main.js。')
    process.exit(1)
  }
  return fs.readFileSync(PLUGIN_MAIN, 'utf8')
}

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 读 harness pageStore 里 fm 的 canvas 键(已解析对象;没有则 null)。 */
async function readCv(page) {
  return page.evaluate(() => {
    const fm = window.__cv.store.getState().manifest?.fmExtra ?? ''
    // harness 的 fmExtra 是单行 YAML `canvas: '<json>'`;插件写回后仍是 YAML。手撕比引 yaml 稳。
    const m = /canvas:\s*['"]?(\{.*\})['"]?\s*$/m.exec(fm)
    if (!m) return null
    try { return JSON.parse(m[1].replace(/''/g, "'")) } catch { return null }
  })
}

async function boot(page) {
  await page.goto(TARGET)
  await page.waitForFunction(() => !!window.__cv, null, { timeout: 20000 })
  await page.evaluate((code) => window.__cv.loadPlugin(code), readPluginCode())
}

async function main() {
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) { console.error('vite 没起来(5173 被占用或 vite.config 有问题)'); vite.kill(); process.exit(1) }
  }
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await boot(page)
    await page.waitForSelector('.cvv-node', { timeout: 20000 })
    await page.waitForSelector('.cvv-node[data-id="b1"] [contenteditable="true"]', { timeout: 20000 })
    await page.waitForTimeout(600) // 量尺 + Milkdown 挂载稳定

    // 1) 三个块三张卡;b3 没有几何 → 未放置列(虚线卡)
    const nodes = await page.locator('.cvv-node').count()
    check('每块一张卡片 (3)', nodes === 3, `got ${nodes}`)
    const unplaced = await page.locator('.cvv-node.is-unplaced').count()
    check('未放置块落「收纳列」(b3)', unplaced === 1 && (await page.locator('.cvv-node.is-unplaced[data-id="b3"]').count()) === 1, `got ${unplaced}`)

    // 2) 卡内是真 BlockHost 渲染的块 markdown
    const text = await page.locator('.cvv-canvas').innerText()
    const hasText = ['中心卡片', '第二卡片', '游离卡片'].every((t) => text.includes(t))
    check('BlockHost 在卡片内真渲染块内容', hasText, text.replace(/\s+/g, ' ').slice(0, 100))

    // 3) 连线 + 标签、形状都渲染了
    const edgeLabel = await page.evaluate(() => document.querySelector('.cvv-edge-label')?.textContent ?? '')
    check('连线渲染 (1) 且带标签', (await page.locator('.cvv-edge').count()) === 1 && edgeLabel === '关联', `label=${JSON.stringify(edgeLabel)}`)
    check('矩形形状渲染 (1)', (await page.locator('.cvv-shape-rect').count()) === 1)

    // 4) 单击=选中(不进编辑、焦点不进卡);空格=进编辑(焦点落卡内)
    await page.locator('.cvv-node[data-id="b1"]').click()
    await page.waitForTimeout(200)
    let st = await page.evaluate(() => ({
      sel: !!document.querySelector('.cvv-node[data-id="b1"].is-sel'),
      edit: !!document.querySelector('.cvv-node.is-edit'),
      focusInCard: !!document.activeElement?.closest?.('.cvv-node'),
    }))
    check('单击=选中卡片(不进编辑)', st.sel && !st.edit && !st.focusInCard, JSON.stringify(st))
    await page.keyboard.press(' ')
    await page.waitForTimeout(300)
    st = await page.evaluate(() => ({
      edit: !!document.querySelector('.cvv-node[data-id="b1"].is-edit'),
      focusInB1: !!document.activeElement?.closest?.('.cvv-node[data-id="b1"]'),
    }))
    check('空格进编辑态(光标落本卡)', st.edit && st.focusInB1, JSON.stringify(st))

    // 5) 卡内编辑真写回块内容
    await page.keyboard.press('End')
    await page.keyboard.type('X改')
    await page.waitForTimeout(400)
    const b1 = await page.evaluate(() => window.__cv.store.getState().blocks.b1?.content ?? '')
    check('卡内编辑写回块 markdown', b1.includes('X改'), JSON.stringify(b1))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    check('Esc 退出编辑态', !(await page.locator('.cvv-node.is-edit').count()))

    // 6) 拖动卡片 → fm 的 canvas.n 单笔更新(负对照:拖前坐标)
    const before = await readCv(page)
    const b1box = await page.locator('.cvv-node[data-id="b1"]').boundingBox()
    await page.mouse.move(b1box.x + b1box.width / 2, b1box.y + 8)
    await page.mouse.down()
    await page.mouse.move(b1box.x + b1box.width / 2 + 120, b1box.y + 8 + 80, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    let cv = await readCv(page)
    const moved = cv && cv.n.b1.x === before.n.b1.x + 120 && cv.n.b1.y === before.n.b1.y + 80
    check('拖动卡片落盘 fm(+120,+80)', !!moved, `before=${JSON.stringify(before?.n?.b1)} after=${JSON.stringify(cv?.n?.b1)}`)

    // 7) 拖动未放置卡 = 物化坐标进 fm
    const b3box = await page.locator('.cvv-node[data-id="b3"]').boundingBox()
    await page.mouse.move(b3box.x + b3box.width / 2, b3box.y + 8)
    await page.mouse.down()
    await page.mouse.move(b3box.x + b3box.width / 2 + 300, b3box.y + 200, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    cv = await readCv(page)
    check('拖动未放置卡=物化坐标', !!cv?.n?.b3, JSON.stringify(cv?.n?.b3))
    check('物化后虚线态消失', !(await page.locator('.cvv-node.is-unplaced').count()))

    // 8) 空白框选:罩住 b1+s1 → 两个选中(卡 + 形状)
    await page.keyboard.press('Escape')
    const root = await page.locator('.cvv-canvas').boundingBox()
    const b1now = await page.locator('.cvv-node[data-id="b1"]').boundingBox()
    const s1now = await page.locator('.cvv-shape-rect').boundingBox()
    const x0 = Math.min(b1now.x, s1now.x) - 20
    const y0 = Math.min(b1now.y, s1now.y) - 20
    const x1 = Math.max(b1now.x + b1now.width, s1now.x + s1now.width) + 20
    const y1 = Math.max(b1now.y + s1now.height, s1now.y + s1now.height) + 20
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x1, y1, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const selCount = await page.evaluate(() => document.querySelectorAll('.cvv-node.is-sel, .cvv-shape.is-sel').length)
    check('框选同时命中卡片与形状 (≥2)', selCount >= 2, `got ${selCount}`)

    // 9) Alt 拖空白=平移(stage transform 变化)
    const t0 = await page.evaluate(() => document.querySelector('.cvv-stage').style.transform)
    await page.keyboard.press('Escape')
    await page.keyboard.down('Alt')
    await page.mouse.move(root.x + root.width - 80, root.y + root.height - 120)
    await page.mouse.down()
    await page.mouse.move(root.x + root.width - 160, root.y + root.height - 60, { steps: 5 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await page.waitForTimeout(150)
    const t1 = await page.evaluate(() => document.querySelector('.cvv-stage').style.transform)
    check('Alt 拖=平移画布', t0 !== t1, `${t0} → ${t1}`)

    // 10) 缩放按钮:百分比变化 + 定点缩放不炸
    const pct0 = await page.locator('.cvv-zoom-pct').innerText()
    await page.locator('.cvv-zoom button').first().click()
    await page.waitForTimeout(150)
    const pct1 = await page.locator('.cvv-zoom-pct').innerText()
    check('缩放条生效', pct0 !== pct1, `${pct0} → ${pct1}`)

    // 11) 右键卡片 → 连线到… → 点目标 → fm 里长出一条边(负对照:先数原有边)
    const eBefore = (await readCv(page))?.e?.length ?? 0
    await page.locator('.cvv-node[data-id="b3"]').click({ button: 'right' })
    await page.waitForTimeout(150)
    await page.locator('.ctx-menu button', { hasText: '连线到…' }).click()
    await page.waitForTimeout(100)
    check('连线模式提示条出现', !!(await page.locator('.cvv-hint').count()))
    await page.locator('.cvv-node[data-id="b2"]').click()
    await page.waitForTimeout(250)
    cv = await readCv(page)
    check('连线落盘 fm (+1)', (cv?.e?.length ?? 0) === eBefore + 1, JSON.stringify(cv?.e))

    // 12) 选中形状 Delete → fm 的 s 清空,断头线由 prune 顺手剪
    await page.locator('.cvv-shape-rect').click()
    await page.waitForTimeout(120)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(250)
    cv = await readCv(page)
    check('删形状落盘(s 空)', (cv?.s?.length ?? 0) === 0 && !(await page.locator('.cvv-shape-rect').count()), JSON.stringify(cv?.s))

    // 13) 双击空白=新建卡片(块数 +1,且新块有坐标)
    const nBlocks0 = await page.evaluate(() => Object.keys(window.__cv.store.getState().blocks).length)
    await page.mouse.dblclick(root.x + root.width * 0.7, root.y + root.height * 0.75)
    await page.waitForTimeout(400)
    const nBlocks1 = await page.evaluate(() => Object.keys(window.__cv.store.getState().blocks).length)
    cv = await readCv(page)
    const newId = await page.evaluate(() => {
      const s = window.__cv.store.getState()
      return Object.keys(s.blocks).find((id) => !['b1', 'b2', 'b3'].includes(id))
    })
    check('双击空白新建卡片(块+1 且有坐标)', nBlocks1 === nBlocks0 + 1 && !!cv?.n?.[newId], `blocks ${nBlocks0}→${nBlocks1}, n=${JSON.stringify(cv?.n?.[newId])}`)
    await page.keyboard.press('Escape')

    // 13.5) Tab=子卡+连线+进编辑(思维导图逻辑,2026-08-14);Enter=同级卡(继承父连线)。
    await page.locator('.cvv-node[data-id="b1"]').click()
    await page.waitForTimeout(150)
    const eBeforeTab = (await readCv(page))?.e?.length ?? 0
    await page.keyboard.press('Tab')
    await page.waitForTimeout(450)
    cv = await readCv(page)
    // 既有 b1 出边只有 →b2(种子);Tab 新增的那条 a=b1 且 b 是新块。
    const childId = (cv?.e ?? []).find((ed) => ed.a === 'b1' && ed.b !== 'b2')?.b ?? null
    check('Tab=建子卡并连线(a=b1)', !!childId && (cv?.e?.length ?? 0) === eBeforeTab + 1, `child=${childId}, e=${JSON.stringify(cv?.e)}`)
    check('子卡落在父卡右侧', !!childId && cv?.n?.[childId] && cv.n[childId].x > (cv?.n?.b1?.x ?? 0) + 100, JSON.stringify(childId ? cv?.n?.[childId] : null))
    check('Tab 后直接进编辑态', !!(await page.locator('.cvv-node.is-edit').count()))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
    // 选中子卡按 Enter → 同级卡:也连到 b1
    await page.locator(`.cvv-node[data-id="${childId}"]`).click()
    await page.waitForTimeout(150)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(450)
    cv = await readCv(page)
    // b1 出边:种子 →b2 + Tab 子卡 + Enter 同级卡 = 3 条。
    const sibEdges = (cv?.e ?? []).filter((ed) => ed.a === 'b1')
    check('Enter=同级卡继承父连线(b1 子边 +1)', sibEdges.length === 3, JSON.stringify(cv?.e))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    const nBlocks2 = await page.evaluate(() => Object.keys(window.__cv.store.getState().blocks).length)

    // 14) 切文档模式:**原生笔记表面**(mountNoteView seam:真 PageView,与普通笔记同一个身体)。
    await page.locator('.cvv-modes button', { hasText: '文档' }).click()
    await page.waitForTimeout(600)
    check('文档模式=原生笔记表面', !!(await page.locator('.cvv-doc-native .page-view').count()) && !(await page.locator('.cvv-node').count()))
    const hosts = await page.locator('.cvv-doc-native .block-host').count()
    check('原生表面列出全部块', hosts === nBlocks2, `got ${hosts}, want ${nBlocks2}`)
    // 用户实报「缺把手」的根治断言:⠿ 块把手在文档模式必须**在且可见**(canvas.css 只许对卡片藏 gutter)。
    const gutterVis = await page.evaluate(() => {
      const g = document.querySelector('.cvv-doc-native .block-gutter')
      return g ? getComputedStyle(g).display !== 'none' : false
    })
    check('文档模式有 ⠿ 块把手(display≠none)', gutterVis)
    check('点空白追加(.page-tail)在场', !!(await page.locator('.cvv-doc-native .page-tail').count()))

    // 14.5) 完整笔记面(2026-08-14 用户验收拍板「与普通 md 完全无差」,1.2.0):标题/图标封面
    //       入口/属性面板与普通笔记同一套三件套;标题口径剥**全**复合后缀;属性面板隐藏
    //       canvas 几何键(fmKeys 声明)但别的键照常展示。
    check('完整面:标题栏在', (await page.locator('.cvv-doc-native .amx-title-input').count()) === 1)
    const titleVal = await page.locator('.cvv-doc-native .amx-title-input').inputValue()
    // 台架 manifest.title 故意种成 'Harness.canvas'(真实导入形态):标题必须无条件走文件基名口径。
    check('标题=剥全后缀的基名(manifest.title 不许短路)', titleVal === 'Harness', titleVal)
    check('完整面:添加图标/封面入口在', (await page.locator('.cvv-doc-native .amx-title-actions button').count()) >= 1)
    // 14.6) 顶栏对位(实报「添加图标/封面按钮位置与普通 md 不齐」的根治):笔记面上方要有与
    //       普通编辑器同一条 .amx-toolbar(sticky 面包屑条),高度不塌(真顶栏靠动作钮撑 32px,
    //       这里靠 min-height),封面/标题从它下面开始排。只断「存在」会漏掉塌高/绝对定位两种假绿。
    const strip = await page.evaluate(() => {
      const bar = document.querySelector('.plugin-note-surface .amx-toolbar')
      const wrap = document.querySelector('.plugin-note-surface .amx-title-wrap')
      const crumb = document.querySelector('.plugin-note-surface .amx-crumb-leaf')
      if (!bar || !wrap) return null
      const b = bar.getBoundingClientRect()
      return { bh: b.height, below: wrap.getBoundingClientRect().top >= b.top + b.height - 1, crumb: crumb ? crumb.textContent : null }
    })
    check('顶栏条在且不塌高(≥30px)', !!strip && strip.bh >= 30, JSON.stringify(strip))
    check('标题排在顶栏之下', !!strip && strip.below)
    check('面包屑叶子=剥全后缀基名', !!strip && strip.crumb === 'Harness', strip ? String(strip.crumb) : 'no strip')
    await page.locator('.cvv-doc-native .amx-props-chip').click()
    await page.waitForTimeout(250)
    const propKeys = await page.evaluate(() => [...document.querySelectorAll('.cvv-doc-native .amx-prop-key')].map((i) => i.value))
    check('属性面板隐藏 canvas 键、保留用户键', !propKeys.includes('canvas') && propKeys.includes('custom_note'), JSON.stringify(propKeys))
    await page.locator('.cvv-doc-native .amx-props-chip').click() // 收起,别挡后面的点击
    await page.waitForTimeout(150)

    cv = await readCv(page)
    check('模式落盘 mode:doc', cv?.mode === 'doc', JSON.stringify(cv?.mode))

    // 15) 切回画布:卡片回来,fm 的 mode 键消失(缺省即画布,fm 体积纪律)
    await page.locator('.cvv-modes button', { hasText: '画布' }).click()
    await page.waitForTimeout(400)
    check('切回画布模式', !!(await page.locator('.cvv-canvas').count()) && (await page.locator('.cvv-node').count()) === nBlocks2)
    cv = await readCv(page)
    check('画布是缺省模式(fm 不写 mode)', cv != null && cv.mode === undefined, JSON.stringify(cv?.mode))

    // 15.5) 多文件并存(scope 化的根治目标):门面 scope 另开一篇普通笔记,画布纹丝不动 ——
    //       此前单活页模型下这一步会把画布顶成「点击加载」占位。
    const coexist = await page.evaluate(() => {
      const facade = window.__pageStore
      const iso = new Date().toISOString()
      facade.setState({
        activePage: 'Note.md',
        vaultRoot: '/harness',
        status: 'ready',
        manifest: { schema: 'amadeus.page/3', id: 'n', title: 'N', createdAt: iso, updatedAt: iso, compiler: { version: 'h' }, root: { type: 'stack', children: [{ type: 'row', id: 'r1', columns: [{ id: 'c1', width: 1, children: [{ ref: 'x1' }] }] }] }, blocks: { x1: { type: 'markdown' } }, fmExtra: '' },
        blocks: { x1: { id: 'x1', type: 'markdown', content: '别的笔记' } },
      })
      return { facadeActive: facade.getState().activePage, canvasActive: window.__cv.store.getState().activePage }
    })
    await page.waitForTimeout(300)
    check(
      '双文件并存:门面开别的笔记,画布 scope 不被顶掉',
      coexist.facadeActive === 'Note.md' && coexist.canvasActive === 'Harness.canvas.md' && !!(await page.locator('.cvv-canvas').count()) && !(await page.locator('.cvv-empty-btn').count()),
      JSON.stringify(coexist),
    )

    // 16) fm 公共空间:经历以上全部画布写入后,别人的键逐字幸存(哨兵防「整对象重写」类回归)
    const fmFinal = await page.evaluate(() => window.__cv.store.getState().manifest?.fmExtra ?? '')
    check(
      'fm 哨兵键幸存(用户手写 + 其它插件)',
      fmFinal.includes('custom_note: 用户手写的键要幸存') && fmFinal.includes(`other_plugin: '{"keep":1}'`),
      fmFinal.replace(/\n/g, ' ⏎ ').slice(0, 160),
    )

    // 16.5) 属性面板编辑别的键 → canvas 几何键幸存(评审 P0 的真面验证:隐藏≠可抹,
    //       模型持全量、commit 全量重建必须把几何键原值带回)。
    await page.locator('.cvv-modes button', { hasText: '文档' }).click()
    await page.waitForTimeout(500)
    await page.locator('.cvv-doc-native .amx-props-chip').click()
    await page.waitForTimeout(250)
    const noteRow = page.locator('.cvv-doc-native .amx-prop-row', { has: page.locator('input[value="custom_note"]') })
    await noteRow.locator('.amx-prop-input').fill('面板改过')
    await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur())
    await page.waitForTimeout(300)
    const fmAfterEdit = await page.evaluate(() => window.__cv.store.getState().manifest?.fmExtra ?? '')
    check(
      '属性编辑别的键后 canvas 几何键幸存',
      fmAfterEdit.includes('custom_note: 面板改过') && /canvas: /.test(fmAfterEdit) && fmAfterEdit.includes('"b1"'),
      fmAfterEdit.replace(/\n/g, ' ⏎ ').slice(0, 200),
    )

    // 17) 页面级错误兜底
    check('无未捕获页面错误', errors.length === 0, errors.join(' | ').slice(0, 200))
  } finally {
    await browser.close()
    vite?.kill()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
