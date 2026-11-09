/**
 * 从收纳把瓷砖拖进主页(11-08 方案 B「原地淡出」,homeLibraryDrag.ts):真 Electron(out/ 构建)× 桩引擎 × 110% 缩放 × 1512×950,
 * 真鼠标拖。摆放用缺省那种「右栏满、下排被近况卡占满」(右栏换成三张内置卡,不用装日历插件),这个宽度下只有左栏接得住:
 *   1. 不在编辑态,右键空白 →「整理 Space」→「小组件」页,按住「最近笔记」拖到右栏:面板原地淡出、主页回来并进编辑态,
 *      小签说「右栏满了」、影子半透明、不画落点;松手 = 取消:摆放不变、面板淡回、编辑态回到拿起之前、不弹提示。
 *   2. 再拖到左栏空位:落点框与空位重合、小签提前说「点完成后左栏收成图标条」;松手放进左栏、面板收起、停在编辑态、右上角「撤销」。
 *   3. ⌘Z 撤掉这一下;没拖动的「点一下」照旧放进第一个空位且面板不收;拖到一半按 Esc = 取消。
 *   4. 「主页组件」页把拿掉的时钟拖回输入框上方。
 * 顺带量:栏里的空位不再被压成 19px;影子跟手(缩放补偿对);拖完那一下补发的 click 被吞掉(不会把面板收起 / 再放一张)。
 * 截图进 OUT(缺省 ../../outputs/home-library-drag)。
 *
 * 用法:先在本检出 npx electron-vite build;然后
 *   node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="主页拖放" --eta=3 -- node scripts/home-library-drag.check.cjs
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, sleep, makeReporter } = require('./lib/uiux-electron.cjs')

const OUT = path.resolve(process.env.OUT || path.join(__dirname, '../../outputs/home-library-drag'))
const KEY = 'forsion.homepage.widgets.desktop.v1'
const CENTER = ['clock', 'composer', 'row', 'dock']
const LAYOUT = { left: [], center: CENTER, row: [{ id: 'builtin:status', w: 4 }], right: ['builtin:inbox', 'builtin:sessions', 'builtin:muse'] }
const NOTES = 'builtin:notes'
const R = makeReporter()
const check = R.check

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const ctx = await launch({
    tag: 'home-lib-drag', fixtures: { agents: [], sessions: [] },
    stubOverride: async (req) => {
      if (req.path === '/agent/widgets' && req.method === 'GET') return { widgets: [] }
      if (/^\/agent\/widgets\//.test(req.path)) return { __code: 404, body: { error: 'WIDGET_NOT_FOUND' } }
    },
  })
  const { app, win } = ctx
  const errors = []
  // 资源 404(out/ 构建里缺的壁纸 / 字体)与本改动无关,不算
  win.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300)) })
  win.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  const layout = () => win.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), KEY)
  const setLayout = async (l) => { await win.evaluate(({ k, l }) => localStorage.setItem(k, JSON.stringify(l)), { k: KEY, l }); await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.hp-root', { timeout: 30_000 }); await sleep(1500) }
  const rect = (sel) => win.evaluate((s) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 } }, sel)
  const tileRect = (name) => win.evaluate((n) => {
    const t = [...document.querySelectorAll('.hp-organizer-pane .hp-lib-tile')].find((e) => e.querySelector('.hp-lib-name')?.textContent.trim() === n)
    if (!t) return null
    const r = t.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, disabled: t.disabled }
  }, name)
  const state = () => win.evaluate(() => {
    const root = document.querySelector('.hp-root')
    const stage = document.querySelector('.hp-organizer-stage')
    const note = document.querySelector('.hp-lib-note-pill')
    const ind = document.querySelector('.lcl-drop-ind.hp-drop-ind')
    const ghost = document.querySelector('.hp-lib-ghost')
    const panel = document.querySelector('.hp-organizer-panel')
    return {
      secondary: root.classList.contains('hp-secondary-open'), editing: root.classList.contains('hp-editing'),
      stage: !!stage, yield: stage?.dataset.yield ?? null, panelOpacity: panel ? Number(getComputedStyle(panel).opacity) : null,
      note: note?.classList.contains('on') ? note.textContent.trim() : null,
      ind: ind && getComputedStyle(ind).display !== 'none' ? (() => { const r = ind.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, zone: ind.classList.contains('lcl-drop-ind--zone') } })() : null,
      ghost: ghost ? (() => { const r = ghost.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, no: ghost.classList.contains('is-no') } })() : null,
      toast: [...document.querySelectorAll('.ntf, .mk-notice')].filter((e) => e.getClientRects().length).map((e) => e.textContent.trim()),
    }
  })
  const shot = (name) => win.screenshot({ path: path.join(OUT, `${name}.png`) })
  /** 按住 from,分几步挪到 to(停在那里,不松手)。 */
  const press = async (from, to, steps = 14) => {
    await win.mouse.move(from.cx, from.cy)
    await win.mouse.down()
    for (let i = 1; i <= steps; i++) { await win.mouse.move(from.cx + ((to.cx - from.cx) * i) / steps, from.cy + ((to.cy - from.cy) * i) / steps); await sleep(16) }
  }
  const openWidgets = async () => {
    await win.mouse.click(700, 120, { button: 'right' }); await sleep(400) // 时钟上方的空白
    await win.locator('.ctx-menu button, .ctx-menu [role="menuitem"]').filter({ hasText: /整理 Space/ }).first().click(); await sleep(700)
    await win.locator('.hp-organizer-tabs [data-tab="widgets"]').first().click(); await sleep(500)
  }
  try {
    await boot(app, win, { space: 'home', width: 1512, height: 950 })
    await win.evaluate(({ k, l }) => {
      localStorage.setItem('forsion_ui_zoom', '1.1')
      localStorage.setItem('forsion_ui_zoom_default_2_10_0', '1')
      localStorage.setItem(k, JSON.stringify(l))
    }, { k: KEY, l: LAYOUT })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.hp-root', { timeout: 30_000 })
    await win.evaluate(() => document.fonts.ready)
    await sleep(2000)
    check('缩放 110%', Math.abs((await win.evaluate(() => document.body.currentCSSZoom)) - 1.1) < 0.001)

    // ── 1. 拖到满了的右栏 = 放不下 ──
    await openWidgets()
    let s = await state()
    check('面板开着:主页藏在面板后面、不在编辑态', s.stage && s.secondary && !s.editing, JSON.stringify(s))
    const tile = await tileRect('最近笔记')
    check('「最近笔记」瓷砖在、能拖', !!tile && !tile.disabled)
    const rightRail = await rect('.hp-rail-right')
    check('右栏在(只是被面板藏着)', !!rightRail)
    await press(tile, rightRail)
    await sleep(450)
    s = await state()
    check('拿起:面板原地淡出(data-yield=out,透明)', s.yield === 'out' && s.panelOpacity < 0.05, `${s.yield} ${s.panelOpacity}`)
    check('拿起:主页回来(摘掉 hp-secondary-open)并进编辑态', !s.secondary && s.editing)
    check('右栏满:小签说「右栏满了 · 最多 3 张」', s.note === '右栏满了 · 最多 3 张', s.note)
    check('右栏满:影子半透明、不画落点', s.ghost?.no === true && !s.ind, JSON.stringify({ g: s.ghost, i: s.ind }))
    const pt = { cx: rightRail.cx, cy: rightRail.cy }
    check('影子跟手(110% 下指针在影子里)', s.ghost && pt.cx >= s.ghost.x && pt.cx <= s.ghost.x + s.ghost.w && pt.cy >= s.ghost.y && pt.cy <= s.ghost.y + s.ghost.h, JSON.stringify(s.ghost))
    await shot('1-reject-right')
    await win.mouse.up(); await sleep(500)
    s = await state()
    check('放不下松手 = 取消:摆放不变', JSON.stringify((await layout()).right) === JSON.stringify(LAYOUT.right) && (await layout()).left.length === 0)
    check('取消:面板淡回原处(data-yield=back)、主页重新藏回去', s.stage && s.yield === 'back' && s.secondary && s.panelOpacity > 0.95, JSON.stringify(s))
    check('取消:编辑态回到拿起之前(没在编辑)', !s.editing)
    check('取消:影子收掉、不弹提示', !s.ghost && s.toast.length === 0, JSON.stringify(s.toast))
    await shot('2-cancel-back')

    // ── 2. 拖到左栏空位 = 放进去 ──
    const t2 = await tileRect('最近笔记')
    await press(t2, { cx: t2.cx - 40, cy: t2.cy }, 4) // 先拿起,等主页回来再量左栏空位
    await sleep(450)
    const empty = await rect('.hp-rail-left .hp-slot-empty')
    check('左栏空位量得到', !!empty)
    check('栏里的空位不再被压成 19px(≥ 96 CSS px)', empty && empty.h >= 96 * 1.1 - 1, empty && `${empty.h}`)
    for (let i = 1; i <= 12; i++) { await win.mouse.move(t2.cx - 40 + ((empty.cx - t2.cx + 40) * i) / 12, t2.cy + ((empty.cy - t2.cy) * i) / 12); await sleep(16) }
    await sleep(250)
    s = await state()
    check('左栏空位:落点框画在空位上(LCL dropIndicator,110% 补偿对)', s.ind?.zone && Math.abs(s.ind.x - empty.x) < 2 && Math.abs(s.ind.y - empty.y) < 2 && Math.abs(s.ind.w - empty.w) < 2 && Math.abs(s.ind.h - empty.h) < 2, JSON.stringify({ ind: s.ind, empty }))
    check('左栏点完成后会收成图标条:悬停时提前说', s.note === '窗口不够宽：点完成后，左栏收成图标条', s.note)
    check('能放:影子不半透明', s.ghost && !s.ghost.no)
    await shot('3-hover-left')
    // 松手前装一个逐帧采样:新卡那一格的 transform(LCL land 从松手处滑进,160ms)
    await win.evaluate(() => {
      const out = (window.__landSamples = [])
      const t0 = performance.now()
      const tick = () => {
        const el = document.querySelector('[data-home-id="builtin:notes"]')
        out.push(el ? getComputedStyle(el).transform : 'missing')
        if (performance.now() - t0 < 600) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await win.mouse.up(); await sleep(120)
    await shot('4-landing')
    await sleep(500)
    const samples = await win.evaluate(() => window.__landSamples)
    const moving = samples.filter((x) => x !== 'none' && x !== 'missing' && x !== 'matrix(1, 0, 0, 1, 0, 0)')
    check('松手:新卡从松手处滑进(有过渡帧,最后归位)', moving.length >= 2 && samples[samples.length - 1] === 'none', `${moving.length} 帧在动 / 末帧 ${samples[samples.length - 1]}`)
    let l = await layout()
    s = await state()
    check('松手:放进左栏', JSON.stringify(l.left) === JSON.stringify([NOTES]), JSON.stringify(l))
    check('松手:面板收起、停在编辑态', !s.stage && s.editing && !s.secondary, JSON.stringify(s))
    check('松手:右上角「已放到左栏」+「撤销」', s.toast.some((x) => x.includes('已放到左栏') && x.includes('撤销')), JSON.stringify(s.toast))
    check('松手:补发的 click 被吞掉(没有再放一张)', l.right.length === 3 && l.row.length === 1)
    await shot('5-landed')

    // ── 3. ⌘Z 撤掉;点一下照旧;Esc 取消 ──
    await win.keyboard.press('Meta+z'); await sleep(400)
    l = await layout()
    check('编辑态里 ⌘Z 撤掉这一下', l.left.length === 0, JSON.stringify(l.left))
    await win.locator('.hp-edit-bar button').filter({ hasText: /添加组件/ }).first().click(); await sleep(700)
    const t3 = await tileRect('最近笔记')
    await win.mouse.click(t3.cx, t3.cy); await sleep(500)
    l = await layout()
    s = await state()
    check('没拖动的「点一下」照旧放进第一个空位(这里是左栏)', JSON.stringify(l.left) === JSON.stringify([NOTES]), JSON.stringify(l.left))
    check('点一下:面板不收', s.stage && s.yield !== 'out')
    await win.evaluate(({ k, l }) => localStorage.setItem(k, JSON.stringify(l)), { k: KEY, l: LAYOUT })
    await win.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'forsion.homepage.widgets.desktop.v1' }))); await sleep(400)
    const t4 = await tileRect('最近笔记')
    check('还原摆放后瓷砖又能拖', t4 && !t4.disabled)
    const leftRail = await rect('.hp-rail-left')
    await press(t4, leftRail || { cx: 150, cy: 300 }); await sleep(300)
    s = await state()
    check('Esc 之前:拖动进行中(面板让位)', s.yield === 'out' && !!s.ghost, JSON.stringify(s))
    await win.keyboard.press('Escape'); await sleep(500)
    await win.mouse.up(); await sleep(200)
    s = await state()
    l = await layout()
    check('拖到一半 Esc = 取消:摆放不变、面板回来、还在编辑态(从「添加组件」打开的)', l.left.length === 0 && s.stage && s.yield === 'back' && s.editing, JSON.stringify({ l: l.left, s }))

    // ── 4. 主页组件:把拿掉的时钟拖回输入框上方 ──
    await setLayout({ ...LAYOUT, center: ['composer', 'row', 'dock'] })
    await openWidgets()
    await win.locator('.hp-organizer-tabs [data-tab="parts"]').first().click(); await sleep(500)
    const clock = await tileRect('时钟')
    check('「主页组件」页:时钟瓷砖能拖', clock && !clock.disabled)
    await press(clock, { cx: clock.cx, cy: clock.cy + 40 }, 4); await sleep(450)
    const composer = await rect('.hp-stack > [data-home-part="composer"]')
    for (let i = 1; i <= 10; i++) { await win.mouse.move(clock.cx + ((composer.cx - clock.cx) * i) / 10, clock.cy + 40 + ((composer.y + 6 - clock.cy - 40) * i) / 10); await sleep(16) }
    await sleep(250)
    s = await state()
    check('中列:落点是一条横线(在输入框上沿之上)', s.ind && !s.ind.zone && s.ind.y < composer.y, JSON.stringify({ ind: s.ind, composer }))
    await shot('6-part-hover')
    await win.mouse.up(); await sleep(600)
    l = await layout()
    s = await state()
    check('时钟回到中列最上面', JSON.stringify(l.center) === JSON.stringify(CENTER), JSON.stringify(l.center))
    check('右上角「已放回中列：时钟」', s.toast.some((x) => x.includes('已放回中列：时钟')), JSON.stringify(s.toast))
    await shot('7-part-landed')

    // ── 5. 暗色 + 苔绿:影子、小签、落点框跟主题走 ──
    await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'dark'; r.classList.add('dark'); r.dataset.skin = 'sage' }); await sleep(400)
    await win.locator('.hp-edit-bar button').filter({ hasText: /添加组件/ }).first().click(); await sleep(700)
    await win.locator('.hp-organizer-tabs [data-tab="widgets"]').first().click(); await sleep(400)
    const t5 = await tileRect('最近笔记')
    await press(t5, { cx: t5.cx - 40, cy: t5.cy }, 4); await sleep(450)
    const empty5 = await rect('.hp-rail-left .hp-slot-empty')
    for (let i = 1; i <= 10; i++) { await win.mouse.move(t5.cx - 40 + ((empty5.cx - t5.cx + 40) * i) / 10, t5.cy + ((empty5.cy - t5.cy) * i) / 10); await sleep(16) }
    await sleep(250)
    await shot('8-dark-sage-hover')
    await win.keyboard.press('Escape'); await sleep(300); await win.mouse.up(); await sleep(300)
    check('暗色下 Esc 取消同样不收面板', (await state()).stage)

    check('渲染进程没有报错', errors.length === 0, errors.join('\n'))
  } finally {
    await ctx.close()
  }
  process.exitCode = R.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
