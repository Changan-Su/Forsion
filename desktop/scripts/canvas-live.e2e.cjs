/**
 * 画布模式的**真 Electron × 真落盘** e2e(2026-08-18)。
 *
 * 为什么另起一层 —— 前面两层都证不到这一条:
 *  - `check:canvas`(chromium + harness)跑的是同一份组件代码,但断言止于**内存里的 fm**:
 *    真正的保存管线(setAmadeusStructure → composeFm → 写盘 → 重开 → 分类 → 折叠)一步没走。
 *    而本轮修的那条 P0 的症状恰恰是**文件里冒出锚代号**,不看文件就等于没验到要害。
 *  - codex 的 computer use 那轮 A1/A2/A3 未验:它的坐标拖拽只拉得出文本选区(原生 HTML5 拖拽
 *    这一步分不清是工具限制还是真缺陷),所以那条 P0 在真机上仍是空白。
 *
 * ⚠️ 这一层同样**不验「真人按住鼠标拖」** —— Playwright 造不出原生 HTML5 DnD,仓里所有拖拽脚本
 *    一律合成 DragEvent(与 check:canvas 同一条驱动)。它验的是**这条链路端到端落在磁盘上对不对**。
 *    真手势那一格只有 computer use 答得了,别把这里的绿读成那一格也过了。
 *
 * ⚠️ **非密闭**:Amadeus 库仍是本机的 dev 库(`~/Forsion-Dev/Amadeus`)—— 与 chat-sidepanel.check.cjs 同一条
 *    已知边界(TANGU_HOME 只隔离 tangu 侧)。所以本脚本只碰自己造的 `ZZ-e2e-canvas-*.md`,跑完删掉。
 *
 * 需先 `npm run build`。用法:npm run e2e:canvaslive
 * 报「启动失败」= dev 版 Electron 占着单实例锁,先 pkill -f "node_modules/electron/dist/Electron.app"。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const VAULT = path.join(os.homedir(), 'Forsion-Dev', 'Amadeus')
const NAME = `ZZ-e2e-canvas-${Date.now()}`
const FILE = path.join(VAULT, `${NAME}.md`)

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 磁盘上那篇笔记的 fm 里的 canvas 行(读文件,不读内存)。 */
function diskCanvasLine() {
  const raw = fs.readFileSync(FILE, 'utf8')
  const m = /^amadeus_canvas:\s*(.*)$/m.exec(raw)
  return m ? m[1] : null
}
function diskBody() {
  const raw = fs.readFileSync(FILE, 'utf8')
  const i = raw.indexOf('\n---', 3)
  return i < 0 ? raw : raw.slice(i + 4)
}

/** ⠿ 把某个顶层块拖到舞台空白 → 成卡(与 check:canvas 同一条真实链路:mousedown 设 NodeSelection
 *  → dragstart 挂 view.dragging → 舞台 drop 接管)。 */
async function dragToStage(win, text, at) {
  const box = await win.evaluate(({ text }) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror > *')].find((x) => (x.textContent ?? '').includes(text))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, { text })
  if (!box) return 'no-source'
  await win.mouse.move(box.x, box.y)
  await win.waitForTimeout(260)
  return win.evaluate(({ at }) => {
    const gutter = document.querySelector('.unified-gutter')
    const drag = gutter?.querySelector('.drag-handle')
    const stage = document.querySelector('.amx-stage')
    if (!gutter || !drag || !stage) return 'no-handle'
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt })
    const o = { clientX: at.x, clientY: at.y, dataTransfer: dt }
    fire('dragover', stage, o)
    fire('drop', stage, o)
    fire('dragend', gutter, { dataTransfer: dt })
    return 'ok'
  }, { at })
}

/** ⠿ 把块拖到**另一个块上**(落点在编辑器之内 → 归 blockLayer 捕获期路由)。 */
async function dragOnto(win, text, targetText, frac) {
  const box = await win.evaluate(({ text }) => {
    const el = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => (x.textContent ?? '').trim() === text)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, { text })
  if (!box) return 'no-source'
  await win.mouse.move(box.x, box.y)
  await win.waitForTimeout(260)
  return win.evaluate(({ targetText, frac }) => {
    const gutter = document.querySelector('.unified-gutter')
    const drag = gutter?.querySelector('.drag-handle')
    if (!gutter || !drag) return 'no-handle'
    const tgt = [...document.querySelectorAll('.unified-body .ProseMirror p')].find((x) => (x.textContent ?? '').trim() === targetText)
    if (!tgt) return 'no-target'
    const r = tgt.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height * frac }
    const fire = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
    drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const dt = new DataTransfer()
    fire('dragstart', gutter, { dataTransfer: dt })
    const el = document.elementFromPoint(at.clientX, at.clientY) ?? tgt
    fire('dragover', el, { ...at, dataTransfer: dt })
    fire('drop', el, { ...at, dataTransfer: dt })
    fire('dragend', gutter, { dataTransfer: dt })
    return 'ok'
  }, { targetText, frac })
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('没有构建产物,先 npm run build')
    process.exit(1)
  }
  if (!fs.existsSync(VAULT)) {
    console.error(`找不到 dev 库 ${VAULT} —— 先在 dev 版里建一次库`)
    process.exit(1)
  }
  // 造一篇 v4 笔记(直接写盘:让「打开 → 编辑 → 保存 → 重开」整条链都被验到)
  fs.writeFileSync(FILE, ['---', 'amadeus_schema: amadeus.page/4', '---', '', '甲段一', '', '甲段二', '', '乙段一', ''].join('\n'), 'utf8')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-canvaslive-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home },
  })
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForTimeout(1500)

    // ── 打开那篇笔记(先进 Amadeus 空间,再从侧栏文件行点开 —— 与 chat-sidepanel.check 同一条路)──
    await win.locator('.rb-space[title="Amadeus"], .rb-space:has-text("Amadeus")').first()
      .click({ timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(2500)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }
    const box = win.locator('.t2s-search input').first()
    await box.click().catch(() => {})
    await box.fill(NAME).catch(() => {})
    await win.waitForTimeout(1500)
    const row = win.locator('.t2s-srow', { hasText: NAME }).first()
    if (await row.count().catch(() => 0)) await row.click().catch(() => {})
    else await win.locator(`text=${NAME}`).first().click({ timeout: 8_000 }).catch(() => {})
    let opened = true
    try {
      await win.waitForSelector('.unified-body .ProseMirror', { timeout: 20_000 })
    } catch {
      opened = false
      // 打不开就把现场留下来 —— 「找不到元素」这种失败不留现场等于没报
      const shot = path.join(os.tmpdir(), `canvaslive-open-fail-${Date.now()}.png`)
      await win.screenshot({ path: shot }).catch(() => {})
      const dump = await win.evaluate(() => ({
        url: location.href,
        spaces: [...document.querySelectorAll('[class*=space], [class*=Space]')].slice(0, 5).map((e) => e.className),
        searchRows: [...document.querySelectorAll('.t2s-search-row, [class*=search-row], [class*=result]')].slice(0, 8).map((e) => (e.textContent ?? '').slice(0, 40)),
        panels: [...document.querySelectorAll('.dv-groupview .dv-view')].length,
        bodies: document.querySelectorAll('.unified-body').length,
        pm: document.querySelectorAll('.ProseMirror').length,
        text: (document.body.textContent ?? '').slice(0, 300),
      })).catch((e) => ({ err: String(e) }))
      console.log('[open-fail] 截图', shot)
      console.log('[open-fail]', JSON.stringify(dump))
    }
    check('L1 真 Electron 里打开这篇 v4 笔记(统一编辑器接管)', opened, NAME)
    if (!opened) throw new Error('笔记没打开,后面全部跳过(现场见上面的截图与 dump)')
    await win.waitForTimeout(1200)

    // ── 切画布 ────────────────────────────────────────────────────────────────
    const seg = win.locator('.amx-modeseg button', { hasText: '画布' }).first()
    const hasSeg = await seg.count().catch(() => 0)
    if (hasSeg) await seg.click()
    await win.waitForTimeout(1200)
    const onCanvas = await win.evaluate(() => {
      const s = document.querySelector('.amx-stage')
      return !!s && !s.classList.contains('amx-stage-off')
    })
    check('L2 顶栏胶囊在场且能切进画布模式(真 app 壳,不是台架的仿壳)', !!hasSeg && onCanvas, JSON.stringify({ seg: !!hasSeg, onCanvas }))

    // ── L3 拖两个块到空白 → 两张卡,且**落盘**后文件里有 canvas 键 ────────────────────
    const p1 = await win.evaluate(() => {
      const r = document.querySelector('.amx-stage').getBoundingClientRect()
      return { x: r.right - 220, y: r.top + 160 }
    })
    const d1 = await dragToStage(win, '甲段一', p1)
    await win.waitForTimeout(1600)
    const p2 = await win.evaluate(() => {
      const r = document.querySelector('.amx-stage').getBoundingClientRect()
      return { x: r.right - 220, y: r.bottom - 200 }
    })
    const d2 = await dragToStage(win, '乙段一', p2)
    await win.waitForTimeout(2200)
    const cards = await win.evaluate(() => [...document.querySelectorAll('.amx-ucard')].map((c) => c.dataset.anchor))
    let line = null
    try { line = diskCanvasLine() } catch { /* 文件还没落 */ }
    let refs = null
    try { refs = JSON.parse(line).cards.map((c) => c.ref) } catch { /* null */ }
    check('L3 ⠿ 拖到画布空白 = 成卡,且 canvas 键**真的落到磁盘上**',
      d1 === 'ok' && d2 === 'ok' && cards.length === 2 && !!refs && refs.length === 2,
      JSON.stringify({ d1, d2, cards, refs }))

    // ── L4 P0:跨卡拖块 → 磁盘文件里**不许**出现锚字面,卡一张不少 ─────────────────────
    const before = (() => { try { return diskCanvasLine() } catch { return null } })()
    const d3 = await dragOnto(win, '甲段一', '乙段一', 0.9)
    await win.waitForTimeout(2400)
    const after = (() => { try { return diskCanvasLine() } catch { return null } })()
    const body = (() => { try { return diskBody() } catch { return '' } })()
    let refs2 = null
    try { refs2 = JSON.parse(after).cards.map((c) => c.ref) } catch { /* null */ }
    // 判据全部读**文件**:锚只允许出现在卡片区(每张卡一行),正文里不许有游离锚。
    const markers = (body.match(/^<!--\s*a\s+[A-Za-z0-9_-]+\s*-->\s*$/gm) ?? []).length
    const domCards = await win.evaluate(() => document.querySelectorAll('.amx-ucard').length)
    check('L4 P0:跨卡拖块后,磁盘文件里锚数 == 卡数(没有多出来的游离锚),两张卡都还在',
      d3 === 'ok' && !!before && !!after && domCards === 2
        && JSON.stringify(refs2) === JSON.stringify(JSON.parse(before).cards.map((c) => c.ref))
        && markers === 2,
      JSON.stringify({ d3, refs2, markers, domCards }))

    // ── L5 磁盘往返:关掉重开这篇笔记 → 卡片折得回来,正文里仍看不到锚字面 ─────────────
    await box.click().catch(() => {})
    await box.fill('').catch(() => {})
    await win.waitForTimeout(400)
    await box.fill(NAME).catch(() => {})
    await win.waitForTimeout(1500)
    const row2 = win.locator('.t2s-srow', { hasText: NAME }).first()
    if (await row2.count().catch(() => 0)) await row2.click().catch(() => {})
    await win.waitForTimeout(2000)
    const back = await win.evaluate(() => ({
      cards: document.querySelectorAll('.amx-ucard').length,
      // 用户肉眼判据:界面上任何地方都不该出现 `<!-- a ` 这样的字面
      raw: (document.querySelector('.unified-body .ProseMirror')?.textContent ?? '').includes('<!-- a '),
    }))
    check('L5 重开这篇笔记:卡片从磁盘折得回来,界面上没有锚字面', back.cards === 2 && !back.raw, JSON.stringify(back))
  } finally {
    await app.close().catch(() => {})
    try { fs.unlinkSync(FILE) } catch { /* 已经没了 */ }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  console.log('SKIP  真人按住鼠标的原生 HTML5 拖拽:Playwright 造不出来,只有 computer use 答得了(记账在此)')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  try { fs.unlinkSync(FILE) } catch { /* 已经没了 */ }
  process.exit(1)
})
