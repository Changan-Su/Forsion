// 思维导图实测(真浏览器 + 真 pageStore + 真插件宿主 + **外置插件的真产物**,harness.html?mindmap)。
// 验两件事:
//  1) 核心架构赌注 —— 每个节点 = 一个真 <BlockHost>,由**外置插件**经 ctx.app.mountBlocks 让宿主渲进
//     它自己的绝对定位卡片,能真渲染、真编辑、真嵌入(数据库)。2026-07-26 导图从内置搬成外置捆绑包后,
//     这条链路(装载 → registerFileType → 插件文件视图 → 块表面)就是它能不能工作的全部。
//  2) 导图交互模型 —— 选中优先(单击不进编辑)、空格进编辑、Esc 退出、Tab 子节点 / Enter 同级、折叠,
//     以及**浮层(slash 菜单)不被画布 transform 带偏**(fixed 的包含块陷阱,用户实报)。
// 无需 electron/IPC(save() 在 web 下 throw 被 catch,不碰渲染/编辑;同 block-dnd 的 ?dnd)。
// 用法:node scripts/mindmap.e2e.cjs   插件产物:MINDMAP_PLUGIN_MAIN 可覆盖路径
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
const TARGET = `${BASE}?mindmap`

// 插件产物。默认按仓库并排关系找(Forsion-Genesis/desktop → ../../Forsion-Instrumentality-Project/…);
// 刻意用**运行期读文件 + 注入**而不是让 harness import 它:harness 若在构建期依赖隔壁仓库,
// 只克隆了 Forsion-Genesis 的人连 dev server 都起不来。
const PLUGIN_MAIN =
  process.env.MINDMAP_PLUGIN_MAIN ||
  path.resolve(__dirname, '../../../Forsion-Instrumentality-Project/forsion-plugin-mindmap/main.js')

function readPluginCode() {
  if (!fs.existsSync(PLUGIN_MAIN)) {
    console.error(`找不到思维导图插件产物:${PLUGIN_MAIN}`)
    console.error('先在插件仓库跑 `npm run build`,或用 MINDMAP_PLUGIN_MAIN 指到 main.js。')
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

/** 打开 harness 并把插件产物注入进去(真 setup 路径),然后等第一张卡片出现。 */
async function boot(page) {
  await page.goto(TARGET)
  await page.waitForFunction(() => !!window.__mm, null, { timeout: 20000 })
  await page.evaluate((code) => window.__mm.loadPlugin(code), readPluginCode())
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
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
  const nodes = () => page.locator('.mmv-node').count()
  const edges = () => page.locator('.mmv-edge:not(.mmv-edge-preview)').count()
  try {
    await boot(page)
    await page.waitForSelector('.mmv-node', { timeout: 20000 })
    await page.waitForSelector('.mmv-node[data-id="b1"] [contenteditable="true"]', { timeout: 20000 })
    await page.waitForTimeout(600) // 量尺重排 + Milkdown 挂载稳定

    // 1) 每个块一张卡片(b1 根 + b2/b3 子)
    check('每块一张卡片 (3)', (await nodes()) === 3, `got ${await nodes()}`)

    // 2) 块内容经真 BlockHost/Milkdown 渲染(不是空壳卡)
    const text = await page.locator('.mmv-canvas').innerText()
    const hasText = ['中心节点', '子节点甲', '子节点乙'].every((t) => text.includes(t))
    check('BlockHost 在卡片内真渲染块 markdown', hasText, text.replace(/\s+/g, ' ').slice(0, 120))

    // 3) 关系连线:b2/b3 → b1 共 2 条
    check('每条父子关系一条连线 (2)', (await edges()) === 2, `got ${await edges()}`)

    // 4) 选中优先:单击卡片正文 = 选中整个节点,不进编辑、不把光标插进文字里
    await page.locator('.mmv-node[data-id="b1"]').click()
    await page.waitForTimeout(200)
    const selState = await page.evaluate(() => ({
      selected: !!document.querySelector('.mmv-node[data-id="b1"][data-selected]'),
      editing: !!document.querySelector('.mmv-node[data-editing]'),
      focusInCard: !!document.activeElement?.closest?.('.mmv-node'),
    }))
    check('单击=选中节点(不进编辑)', selState.selected && !selState.editing && !selState.focusInCard, JSON.stringify(selState))

    // 5) 空格进编辑 + 卡内编辑写回该块内容(证明卡内是真编辑面)
    await page.keyboard.press(' ')
    await page.waitForTimeout(300)
    const editing = await page.evaluate(() => ({
      editing: !!document.querySelector('.mmv-node[data-id="b1"][data-editing]'),
      caretInB1: !!document.activeElement?.closest?.('.mmv-node[data-id="b1"]'),
    }))
    check('空格进编辑态(光标落本节点)', editing.editing && editing.caretInB1, JSON.stringify(editing))
    await page.keyboard.press('End')
    await page.keyboard.type('X改')
    await page.waitForTimeout(400)
    const b1 = await page.evaluate(() => window.__mm.store.getState().blocks.b1.content)
    check('卡内编辑写回该块内容', typeof b1 === 'string' && b1.includes('X改'), JSON.stringify(b1))

    // 6) Esc 退出编辑 → 回选中态(状态机:文本编辑态 → 节点选中态)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    const afterEsc = await page.evaluate(() => ({
      editing: !!document.querySelector('.mmv-node[data-editing]'),
      selected: !!document.querySelector('.mmv-node[data-id="b1"][data-selected]'),
    }))
    check('Esc 退出编辑回到选中态', !afterEsc.editing && afterEsc.selected, JSON.stringify(afterEsc))

    // 7) H2 回归:编辑态里的 Enter 仍只是块内换行 —— 不新建游离块、不丢内容
    await page.keyboard.press(' ') // 重新进编辑
    await page.waitForTimeout(250)
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(350)
    const b1AfterEnter = await page.evaluate(() => window.__mm.store.getState().blocks.b1.content)
    check('编辑态 Enter 不新建游离块 (仍 3)', (await nodes()) === 3, `got ${await nodes()}`)
    check('编辑态 Enter 不丢块内容', typeof b1AfterEnter === 'string' && b1AfterEnter.replace(/\s/g, '').includes('中心节点'), JSON.stringify(b1AfterEnter))

    // 8) 浮层不被画布 transform 带偏(Bug2):先把画布缩放到 ≠1(此时 pan 也非零),再在卡内打 '/'。
    //    .mmv-canvas 有 transform ⇒ 它会成为 position:fixed 的包含块,菜单若留在卡片 DOM 里就会
    //    被 pan/zoom 二次变换(实测偏出上百 px)。修法是传送到最近的 .am-app。
    await page.locator('.mmv-zoom button[title="缩小"]').click()
    await page.locator('.mmv-zoom button[title="缩小"]').click()
    await page.waitForTimeout(200)
    await page.locator('.mmv-node[data-id="b1"]').click()
    await page.keyboard.press(' ')
    await page.waitForTimeout(250)
    await page.keyboard.press('End')
    await page.keyboard.type(' /')
    await page.waitForSelector('.slash-menu', { timeout: 5000 })
    const menuGeo = await page.evaluate(() => {
      const m = document.querySelector('.slash-menu')
      const card = document.querySelector('.mmv-node[data-id="b1"]')
      const mr = m.getBoundingClientRect()
      const cr = card.getBoundingClientRect()
      return {
        insideCanvas: !!m.closest('.mmv-canvas'),
        insideApp: !!m.closest('.am-app'),
        dx: Math.round(mr.left - cr.left),
        dy: Math.round(mr.top - cr.bottom),
      }
    })
    check('slash 浮层不在被 transform 的画布内', !menuGeo.insideCanvas && menuGeo.insideApp, JSON.stringify(menuGeo))
    check('slash 浮层贴着光标所在卡片(缩放后不跑偏)', Math.abs(menuGeo.dx) < 80 && Math.abs(menuGeo.dy) < 140, JSON.stringify(menuGeo))
    await page.keyboard.press('Escape') // 关菜单(留下字面 ' /')
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape') // 退出编辑

    // 8b) 行内工具栏走同一条传送通道:卡内选中文字 → 工具栏也必须落在画布之外(仍是缩放态)。
    //     换到 b2 做,免得 b1 里那个字面 '/' 又把 slash 菜单勾起来。
    await page.locator('.mmv-node[data-id="b2"]').click()
    await page.keyboard.press(' ')
    await page.waitForTimeout(250)
    await page.keyboard.press('End')
    await page.keyboard.down('Shift')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Shift')
    await page.waitForTimeout(500)
    const tb = await page.evaluate(() => {
      const t = document.querySelector('.inline-toolbar')
      if (!t) return null
      const r = t.getBoundingClientRect()
      const cr = document.querySelector('.mmv-node[data-id="b2"]').getBoundingClientRect()
      return { insideCanvas: !!t.closest('.mmv-canvas'), dx: Math.round(r.left - cr.left), dy: Math.round(r.top - cr.top) }
    })
    check('行内工具栏同样传送出画布且贴着选区', !!tb && !tb.insideCanvas && Math.abs(tb.dx) < 260 && Math.abs(tb.dy) < 260, JSON.stringify(tb))
    await page.keyboard.press('Escape') // 退出编辑
    await page.locator('.mmv-zoom .mmv-pct').click() // 复位 100%
    await page.waitForTimeout(250)

    // 9) 折叠/展开:折叠后子树不渲染(而不是变成一堆散根),头部显示隐藏后代数
    await page.locator('.mmv-node[data-id="b1"]').click()
    await page.locator('.mmv-node[data-id="b1"] .mmv-collapse').click()
    await page.waitForTimeout(300)
    const foldedCount = await page.locator('.mmv-node[data-id="b1"] .mmv-folded').innerText()
    check('折叠:只剩中心卡 + 隐藏计数 2', (await nodes()) === 1 && (await edges()) === 0 && foldedCount.trim() === '2', `cards=${await nodes()} edges=${await edges()} badge=${foldedCount}`)
    await page.locator('.mmv-node[data-id="b1"] .mmv-folded').click()
    await page.waitForTimeout(300)
    check('展开:恢复 3 卡 2 连线', (await nodes()) === 3 && (await edges()) === 2, `cards=${await nodes()} edges=${await edges()}`)

    // 10) 选中态 Tab = 新建子节点(卡片 +1、连线 +1),且新节点直接进编辑态(连续输入闭环)
    await page.locator('.mmv-node[data-id="b1"]').click()
    await page.keyboard.press('Tab')
    await page.waitForTimeout(400)
    const tabEditing = await page.evaluate(() => !!document.querySelector('.mmv-node[data-editing]'))
    check('Tab 建子节点 (4 卡 3 连线) 且进编辑', (await nodes()) === 4 && (await edges()) === 3 && tabEditing, `cards=${await nodes()} edges=${await edges()} editing=${tabEditing}`)

    // 11) Esc 回选中态后 Enter = 新建同级(同挂 b1 ⇒ 又多一条连线)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    check('Enter 建同级 (5 卡 4 连线)', (await nodes()) === 5 && (await edges()) === 4, `cards=${await nodes()} edges=${await edges()}`)

    // 12) Bug1 的机制:块内无法合并的内容(slash 的数据库/代码块脚手架、Shift+Enter)不再被丢掉,
    //     而是由宿主接管落成**子节点**。旧版把 onInsertAfter 中和成 noop —— /数据库 建了文件却什么也没出现。
    await page.keyboard.type('父')
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(400)
    // 注:这里走的是 content='' 的 Shift+Enter 分支。带内容的脚手架(/数据库)要建 .db 文件,harness
    // 没有 IPC 跑不到;但两者进的是同一个 surface.insertAfter,下面第 13 项再钉「![[x.db]] 在卡内渲染」。
    check('Shift+Enter(空内容)落成子节点 (6 卡 5 连线)', (await nodes()) === 6 && (await edges()) === 5, `cards=${await nodes()} edges=${await edges()}`)

    // 13) 数据库嵌入在卡片内渲染(内容 = `![[x.db]]` 的块 → DatabaseEmbed;harness 无 IPC,渲染到状态卡即证明链路对)
    await page.evaluate(() => window.__mm.store.getState().setBlockContent('b3', '![[任务.db]]'))
    await page.waitForTimeout(500)
    const dbBox = await page.locator('.mmv-node[data-id="b3"] .amx-db').count()
    check('数据库嵌入在节点卡片内渲染', dbBox > 0, `amx-db=${dbBox}`)

    // 14) 拖拽落点预览(连接效果):抓 b2 的头部拖到 b3 上 —— 松手前必须能看出「会挂到谁下面」
    //     (候选父级高亮 + 一条虚线预览连线),松手后结构真的照预览落下(原型文档 §4.5/§10.3)。
    const headBox = await page.locator('.mmv-node[data-id="b2"] .mmv-node-head').boundingBox()
    const dropBox = await page.locator('.mmv-node[data-id="b3"]').boundingBox()
    await page.mouse.move(headBox.x + 10, headBox.y + headBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(dropBox.x + dropBox.width / 2, dropBox.y + dropBox.height / 2, { steps: 12 })
    await page.waitForTimeout(250)
    const dragUi = await page.evaluate(() => ({
      preview: !!document.querySelector('.mmv-edge-preview'),
      drop: !!document.querySelector('.mmv-node[data-id="b3"][data-drop]'),
    }))
    await page.mouse.up()
    await page.waitForTimeout(400)
    const fm = await page.evaluate(() => window.__mm.store.getState().manifest.fmExtra)
    check('拖拽中显示落点高亮 + 预览连线', dragUi.preview && dragUi.drop, JSON.stringify(dragUi))
    check('松手后按预览改父级 (b2 → b3)', /"b2":\{"p":"b3"\}/.test(fm), String(fm).slice(0, 160))

    // ── 第二轮:回到干净的 3 节点状态,验多选/框选/兄弟排序/复制粘贴/撤销/关系线/边界/概要/大纲 ──
    await boot(page)
    await page.waitForSelector('.mmv-node[data-id="b1"] [contenteditable="true"]', { timeout: 20000 })
    await page.waitForTimeout(600)
    const box = (id) => page.locator(`.mmv-node[data-id="${id}"]`).boundingBox()
    const selCount = () => page.locator('.mmv-node[data-selected]').count()

    // 15) 多选:Shift 点第二个节点 = 加选(不清掉第一个)
    await page.locator('.mmv-node[data-id="b2"]').click()
    await page.locator('.mmv-node[data-id="b3"]').click({ modifiers: ['Shift'] })
    await page.waitForTimeout(200)
    check('Shift 点击 = 加选 (2)', (await selCount()) === 2, `selected=${await selCount()}`)

    // 16) 框选:空白左键拖出一个罩住 b2/b3 的矩形(不碰 b1)
    const b2 = await box('b2')
    const b3 = await box('b3')
    await page.locator('.mmv-node[data-id="b1"]').click() // 先只选 b1
    await page.mouse.move(b2.x - 24, b2.y - 16)
    await page.mouse.down()
    await page.mouse.move(b3.x + b3.width + 24, b3.y + b3.height + 16, { steps: 10 })
    const marqueeSeen = await page.locator('.mmv-marquee').count()
    await page.mouse.up()
    await page.waitForTimeout(250)
    const marqueeSel = await page.evaluate(() => [...document.querySelectorAll('.mmv-node[data-selected]')].map((n) => n.dataset.id).sort())
    check('框选:拖出矩形并选中被罩住的两个', marqueeSeen === 1 && JSON.stringify(marqueeSel) === '["b2","b3"]', `rect=${marqueeSeen} sel=${JSON.stringify(marqueeSel)}`)

    // 17) 兄弟顺序:把 b3 拖到 b2 的上缘 → 拖动中显示插入线,松手后 b3 排到 b2 前面
    const head3 = await page.locator('.mmv-node[data-id="b3"] .mmv-node-head').boundingBox()
    const t2 = await box('b2')
    await page.mouse.move(head3.x + 10, head3.y + head3.height / 2)
    await page.mouse.down()
    await page.mouse.move(t2.x + t2.width / 2, t2.y + 6, { steps: 12 })
    await page.waitForTimeout(200)
    const insertSeen = await page.locator('.mmv-insert').count()
    await page.mouse.up()
    await page.waitForTimeout(400)
    const after3 = await box('b3')
    const after2 = await box('b2')
    check('兄弟排序:插入线可见 + 松手后 b3 排到 b2 之前', insertSeen === 1 && after3.y < after2.y, `insert=${insertSeen} b3.y=${Math.round(after3.y)} b2.y=${Math.round(after2.y)}`)

    // 18) 复制 / 粘贴子树(内部剪贴板保全文;无剪贴板权限时自动回退到它)
    await page.locator('.mmv-node[data-id="b2"]').click()
    await page.keyboard.press('Meta+c')
    await page.waitForTimeout(150)
    await page.locator('.mmv-node[data-id="b1"]').click()
    await page.keyboard.press('Meta+v')
    await page.waitForTimeout(500)
    // 连线数一并断言:只数卡片的话,粘成一个游离的根(而不是挂到 b1 下)也会「通过」。
    check('⌘C/⌘V 把子树粘成选中节点的子级 (4 卡 3 连线)', (await nodes()) === 4 && (await edges()) === 3, `cards=${await nodes()} edges=${await edges()}`)

    // 19) 撤销:结构改动(块 + fmExtra 关系)是同一步,一次 ⌘Z 全回。
    //     必须连 fmExtra 一起断言 —— 只数卡片的话,「块回来了但关系图没回」照样通过。
    const fmBefore = await page.evaluate(() => window.__mm.store.getState().manifest.fmExtra)
    await page.keyboard.press('Meta+z')
    await page.waitForTimeout(400)
    const fmAfter = await page.evaluate(() => window.__mm.store.getState().manifest.fmExtra)
    check('⌘Z 撤销结构改动:块与关系图一起回到粘贴前 (3)', (await nodes()) === 3 && fmAfter !== fmBefore && (await edges()) === 2, `cards=${await nodes()} edges=${await edges()} fm=${String(fmAfter).slice(0, 90)}`)

    // 20) 关系线:右键 b2 →「关系线连到…」→ 点 b3;选中该线后 Delete 删除
    await page.locator('.mmv-node[data-id="b2"]').click({ button: 'right' })
    await page.locator('.mmv-menu button:has-text("关系线连到")').click()
    await page.locator('.mmv-node[data-id="b3"]').click()
    await page.waitForTimeout(300)
    const relCount = await page.locator('.mmv-rel').count()
    // 点线必须点在**线真的露在最上层**的地方:hit 区是加粗透明描边(非包围盒),而关系线画在卡片之下 ——
    // 曲线中点恰好压在卡片边缘时点下去选中的是卡片,再按 Delete 删掉的是节点(关系线只是被引用完整性
    // 顺带清掉),看起来像通过、其实测反了。所以沿曲线采样,找第一个命中测试确实返回这条线的点。
    const onCurve = await page.evaluate(() => {
      const p = document.querySelector('.mmv-rel .mmv-rel-hit')
      const L = p.getTotalLength()
      const m = p.getScreenCTM()
      for (let i = 1; i < 20; i++) {
        const q = p.getPointAtLength((L * i) / 20).matrixTransform(m)
        if (document.elementsFromPoint(q.x, q.y)[0] === p) return { x: q.x, y: q.y }
      }
      return null
    })
    if (onCurve) await page.mouse.click(onCurve.x, onCurve.y)
    await page.keyboard.press('Delete')
    await page.waitForTimeout(300)
    const relLeft = await page.locator('.mmv-rel').count()
    check('关系线:建得出、选得中、删得掉(且没误删节点)', relCount === 1 && !!onCurve && relLeft === 0 && (await nodes()) === 3, `built=${relCount} hit=${!!onCurve} left=${relLeft} cards=${await nodes()}`)

    // 21) 边界:给 b1 的子树套框
    await page.locator('.mmv-node[data-id="b1"]').click({ button: 'right' })
    await page.locator('.mmv-menu button:has-text("加边界")').click()
    await page.waitForTimeout(300)
    // 只数 <rect> 会漏掉「框存在但没罩住子树」;按屏幕坐标核对它确实把所有卡片包在里面。
    const bdOk = await page.evaluate(() => {
      const r = document.querySelector('.mmv-boundary')?.getBoundingClientRect()
      if (!r) return null
      const cards = [...document.querySelectorAll('.mmv-node')].map((n) => n.getBoundingClientRect())
      return { n: cards.length, covers: cards.every((c) => c.left >= r.left - 1 && c.right <= r.right + 1 && c.top >= r.top - 1 && c.bottom <= r.bottom + 1) }
    })
    check('边界框真的罩住整棵子树', !!bdOk && bdOk.covers && bdOk.n === 3, JSON.stringify(bdOk))

    // 22) 概要:把 b3 设为概要 → 画括号,且它不再画普通分支线
    const edgesBefore = await edges()
    await page.locator('.mmv-node[data-id="b3"]').click({ button: 'right' })
    await page.locator('.mmv-menu button:has-text("设为概要")').click()
    await page.waitForTimeout(400)
    const summaryOk = await page.evaluate(() => ({
      bracket: document.querySelectorAll('.mmv-bracket').length,
      tagged: !!document.querySelector('.mmv-node[data-id="b3"][data-summary]'),
    }))
    check('概要:画括号 + 不再画普通分支线', summaryOk.bracket === 1 && summaryOk.tagged && (await edges()) === edgesBefore - 1, `${JSON.stringify(summaryOk)} edges ${edgesBefore}→${await edges()}`)

    // 23) 大纲侧栏:同一份数据的投影,行数 = 节点数,点行即选中
    await page.locator('.mmv-zoom .mmv-outline-btn').click()
    await page.waitForTimeout(250)
    const rows = await page.locator('.mmv-outline-row').count()
    await page.locator('.mmv-outline-row').nth(1).click()
    await page.waitForTimeout(200)
    // 「有一个被选中」不够:要选中的正是点的那一行对应的节点(否则错位也能通过)。
    const rowLabel = (await page.locator('.mmv-outline-row').nth(1).locator('.mmv-outline-label').innerText()).trim()
    const selText = (await page.locator('.mmv-node[data-selected]').innerText()).replace(/\s+/g, ' ')
    check('大纲行数=节点数,点行选中的正是该节点', rows === (await nodes()) && (await selCount()) === 1 && selText.includes(rowLabel), `rows=${rows} cards=${await nodes()} row="${rowLabel}" sel="${selText.slice(0, 40)}"`)

    // 24) 全部折叠成环也不能整片消失:注入一张互为父子且都折叠的坏关系图(手改文件就会得到这种),
    //     画布必须仍然渲染出卡片 —— 「绝不让块隐身」比「尊重折叠」优先(Codex)。
    await page.evaluate(() => {
      const st = window.__mm.store.getState()
      st.setFmExtra(`mindmap: '${JSON.stringify({ b1: { p: 'b2', c: 1 }, b2: { p: 'b1', c: 1 } })}'`)
    })
    await page.waitForTimeout(400)
    check('坏关系图(互为父子且都折叠)不吞掉整张画布', (await nodes()) >= 2, `cards=${await nodes()}`)

    check('无未捕获页面异常', errors.length === 0, errors.slice(0, 3).join(' | '))
  } catch (e) {
    check('e2e 跑通', false, String(e))
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main()
