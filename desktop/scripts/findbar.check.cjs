// 页内查找的「接线」仪器(2026-09-03)。用法:npm run check:findbar(需先 npm run build)
//
// 为什么必须是真 Electron:另外两格(unified-page 的 P20、unified-canvas 的 C90)跑在 web 台架上,
// 那里没有 Shell、没有 installEngine —— 它们直接调 window.__openFind(),验的是**查找引擎**
// (扫描 / 跨行内标记 / 嵌入卡 / 不跨块 / 步进 / 定位)。把 bootstrapEngine 里那条 addCommand 删掉,
// 那两格照样全绿,而用户按 Cmd+F 什么都不会发生 —— 这一格专门堵这个假绿口。
//
// 钉四条:
//  F1 命令进了命令表(= 设置→快捷键那张表也有,它从 useCommandStore 派生);
//  F2 **非 Amadeus View** 里真按 Cmd/Ctrl+F 能开条并命中(用户实报的第一条:「没有适配大多数 view」);
//  F3 浮条贴的是活动 View 的右上角,不是窗口右上角(分栏时贴错栏就没意义了);
//  F4 Esc 收干净:条没了 + CSS.highlights 两格都清空(留着的话高亮会在整个应用上赖着)。
const { _electron: electron } = require('playwright-core')
const { mkdtempSync, existsSync } = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
if (!existsSync(path.join(ROOT, 'out/main/main.js'))) {
  console.error('缺 out/main/main.js —— 先 npm run build(量的是 out/ 里的产物,源码改了没 build 就是白测)')
  process.exit(1)
}

const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  const app = await electron.launch({
    args: [`--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'findbar-ud-'))}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: mkdtempSync(path.join(os.tmpdir(), 'findbar-home-')), TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30000 })
  await win.waitForTimeout(3000)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`button:has-text("${label}")`)
    if (await b.count()) { await b.first().click(); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30000 })
  // 启动缺省自 2026-08-28 起是主页 Space,钉回 tangu 才有稳定的正文可搜。
  await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
  await win.reload()
  await win.waitForSelector('.dv-groupview', { timeout: 30000 })
  await win.waitForTimeout(2500)

  // F1
  await win.keyboard.press('Meta+k')
  await win.waitForTimeout(500)
  await win.keyboard.type('页内查找')
  await win.waitForTimeout(700)
  const inPalette = await win.evaluate(() => document.body.innerText.includes('页内查找'))
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  record('F1 命令面板搜得到「页内查找」(同一数据源 = 设置→快捷键里也在,可改键)', inPalette, String(inPalette))

  // F2 / F3:主区是聊天 View(不是 Amadeus 编辑器)—— 老实现在这里完全没有反应。
  await win.locator('.wb-view--main').click({ position: { x: 300, y: 250 } }).catch(() => {})
  await win.waitForTimeout(300)
  await win.keyboard.press('Meta+f')
  await win.waitForTimeout(500)
  const barOpen = await win.evaluate(() => !!document.querySelector('.amx-findbar input'))
  await win.keyboard.type('Tangu')
  await win.waitForTimeout(800)
  const f2 = await win.evaluate(() => ({
    hits: [...(CSS.highlights.get('amx-find') ?? [])].length,
    count: document.querySelector('.amx-findbar-count')?.textContent ?? '',
  }))
  record('F2 非 Amadeus View(聊天)里 Cmd+F 开条并命中', barOpen && f2.hits > 0 && /^1\//.test(f2.count), JSON.stringify({ barOpen, ...f2 }))

  const f3 = await win.evaluate(() => {
    // 条没开时**大声返回 null**而不是让 evaluate 抛 —— 抛出去会把 F3/F4 一起带走,
    // 只剩一行堆栈,读的人看不出后面两条到底是过了还是没跑(F2 红的那次真踩到)。
    const barEl = document.querySelector('.amx-findbar')
    const viewEl = document.querySelector('.wb-view--main')
    if (!barEl || !viewEl) return null
    const bar = barEl.getBoundingClientRect()
    const view = viewEl.getBoundingClientRect()
    return {
      // 贴活动 View 的右上角:右边距与上边距都在 view 之内且是个小数值。
      dRight: Math.round(view.right - bar.right),
      dTop: Math.round(bar.top - view.top),
      winRight: Math.round(window.innerWidth - bar.right),
    }
  })
  record('F3 浮条贴活动 View 右上角(不是窗口右上角)',
    !!f3 && f3.dRight >= 0 && f3.dRight <= 24 && f3.dTop >= 0 && f3.dTop <= 24 && f3.winRight > f3.dRight,
    JSON.stringify(f3))

  // F4
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  const f4 = await win.evaluate(() => ({
    bar: !!document.querySelector('.amx-findbar'),
    hit: [...(CSS.highlights.get('amx-find') ?? [])].length,
    active: [...(CSS.highlights.get('amx-find-active') ?? [])].length,
  }))
  record('F4 Esc 收干净(条没了,两格高亮都清空)', !f4.bar && f4.hit === 0 && f4.active === 0, JSON.stringify(f4))

  // F5 —— `installHotkeys` 里那行 `if (e.defaultPrevented) return` 是**全局**语义改动,而且排在
  //  命令面板分支**之前**:任何抢先 preventDefault 的组件都能把 Cmd+K 吃掉。今天没人绑 Mod-k
  //  (Milkdown/PM 都不绑;CodeMirror 绑的是 Shift-Mod-k = 删行),但这是应用的头号入口,
  //  值得钉死 —— 将来谁在编辑器里加一条 Mod-k 键位,这一格会立刻红,而不是等用户报「⌘K 没了」。
  await win.keyboard.press('Meta+k')
  await win.waitForTimeout(600)
  const f5 = await win.evaluate(() => document.body.innerText.includes('页内查找'))
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
  record('F5 defaultPrevented 闸没吃掉 Cmd+K(命令面板仍开得出来)', f5, String(f5))

  // F6 —— 搜索根被摘掉时浮条自动收。dockview `onlyWhenVisible` 会把切走的 tab 整棵摘掉,
  //  而重扫用的 MutationObserver 只看 root 的**子树** —— 少了自动收,条会挂在半空:
  //  还在屏幕上、搜什么都是 0、只能按 Esc。这里直接把 root 从 DOM 摘掉模拟那一刻。
  await win.locator('.wb-view--main').click({ position: { x: 300, y: 250 } }).catch(() => {})
  await win.keyboard.press('Meta+f')
  await win.waitForTimeout(400)
  await win.keyboard.type('Tangu')
  await win.waitForTimeout(600)
  const openedF6 = await win.evaluate(() => !!document.querySelector('.amx-findbar'))
  await win.evaluate(() => document.querySelector('.wb-view--main')?.remove())
  await win.waitForTimeout(1600) // 轮询兜底是 1s
  const f6 = await win.evaluate(() => ({
    bar: !!document.querySelector('.amx-findbar'),
    hit: [...(CSS.highlights.get('amx-find') ?? [])].length,
  }))
  record('F6 活动 View 被摘掉 → 浮条自动收、高亮清零(不留半空的条)',
    openedF6 && !f6.bar && f6.hit === 0, JSON.stringify({ openedF6, ...f6 }))

  await app.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  // 明确未覆盖,别读成「测过了」:<webview> 客体(内置浏览器 / Code Studio 预览 / HTML 预览)的
  // 键盘事件根本不到宿主渲染层,要它们能查得走 guest.findInPage();Excalidraw 是 canvas2d 无文字 DOM;
  // xterm 只有视口那几行在 DOM 里;source 模式与聊天输入框是 <textarea>,值不是文本节点,TreeWalker 看不见。
  console.log('SKIP  <webview> 客体 / Excalidraw / xterm 回滚区 / <textarea> 的值:结构性够不着,记账在此')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
