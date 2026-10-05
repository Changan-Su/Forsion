/**
 * 「整个 Space 开到新窗口」+「Ribbon 中间的最近使用」—— 真 Electron × 真主进程 × 真多窗口 IPC。
 *
 * 钉的都是台架外够不着的那一半:
 *  R  最近使用:切过的 Space 按「最近的在上」排进中间那段空当,**照字面列**(10-05 用户定:当前的、已经露在条上的也照列);
 *     个数跟设置走(设置浮窗里改 → 主窗靠 storage 事件跟上);窗口矮了就减到没有,回高了再出来;任何高度下都不压到上下两区。
 *  W  开窗三条路(⌘/Ctrl+点击、右键菜单、拖出条外)都开出 `?window=detached&space=<id>` 的窗;一个 Space 一扇(再触发 = 叫到前面);
 *     那扇窗没有 Ribbon、摆的是这个 Space 存着的布局(不是默认布局);主窗的活动 Space 与共用的活动键不被它改掉。
 *     拖动的三种不该开窗的收尾(贴着条边松手 / 条内松手 / Esc)不开窗;拖到窗口外面松手照样开。
 *  A  异步就位的用户 Space 也开得出来(窗口等它注册上来再挂界面),摆的是它自己的布局。
 *
 * 拖拽用合成的 DragEvent(同 ribbon-dnd.e2e):验的是「事件 → 判定 → IPC → 开窗」的接线。**真实 OS 拖拽下 dragend 坐标是否可信、
 * mac 拖窗区吞事件的范围,这里验不到** —— 那半只能人手拖一次。
 *
 *  H  主页开在自己的窗口里(主位槽右键也有这一项):点别的 Space 的磁贴 = 把那个 Space 开到它的窗口,主页不卡在退场动效里。
 *
 * 「Space 窗口锁在自己的 Space、不写共用键、第一次照存着的布局摆」的引擎半身另有单测 lcl/engine/spaceWindow.test.ts。
 * 需先 npm run build。用法:npm run e2e:spacewindow   (SPACEWIN_SHOTS=<目录> 顺手留截图)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const SHOTS = process.env.SPACEWIN_SHOTS || ''
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spacewin-'))

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  // A 的夹具:纯数据的用户 Space,配方走异步 loadUserSpaces —— 开在自己的窗口里时,窗口得等它注册上来。
  fs.mkdirSync(path.join(home, 'spaces', 'probe'), { recursive: true })
  fs.writeFileSync(path.join(home, 'spaces', 'probe', 'space.json'), JSON.stringify({
    id: 'probe-win', name: { zh: '探针空间', en: 'Probe space' }, icon: 'star', version: '1.0.0',
    layout: { main: [{ type: 'outline', pinned: true }], left: [], right: [] },
  }), 'utf8')

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.log('[pageerror main]', e.message))
    await win.waitForSelector('#root', { timeout: 30000 })
    await win.waitForTimeout(2000)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30000 })
    await win.waitForTimeout(2500) // 等用户 Space 的配方装载完

    const setMainSize = (w, h) => app.evaluate(({ BrowserWindow }, s) => {
      const m = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('window='))
      m.setSize(s.w, s.h)
    }, { w, h })
    await setMainSize(1200, 980)
    await win.waitForTimeout(500)

    const topSpaces = () => win.$$eval('.rb-top .rb-slot', (els) => els.map((e) => e.dataset.id).filter((id) => id && id.startsWith('space:')))
    const recents = () => win.$$eval('.rb-recent .rb-recent-slot', (els) => els.map((e) => e.dataset.recentId))
    const activeKey = (page) => page.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))
    const clickSpace = async (rid, mods) => {
      await win.locator(`.rb-top .rb-slot[data-id="${rid}"] .rb-btn`).click(mods ? { modifiers: mods } : undefined)
      await win.waitForTimeout(900)
    }
    const spaceWindows = () => app.windows().filter((p) => /[?&]space=/.test(p.url()))
    const spaceOf = (p) => new URL(p.url()).searchParams.get('space')
    /** 做一件事并等它开出一扇新窗;没开 = null(给足时间,别把「开得慢」读成「没开」)。 */
    const expectWindow = async (act, ms = 8000) => {
      const opened = app.waitForEvent('window', { timeout: ms }).catch(() => null)
      await act()
      const p = await opened
      if (p) { p.on('pageerror', (e) => console.log('[pageerror sat]', e.message)); await p.waitForLoadState('domcontentloaded').catch(() => {}) }
      return p
    }
    /** 布局键 / 命名槽里的面板类型(panel 的 __type 随 dockview JSON 原样往返),排序后当集合比。 */
    const panelsOf = (blob) => {
      try { return Object.values(blob.dockview.panels).map((p) => (p.params || {}).__type || p.contentComponent).sort() } catch { return null }
    }
    const namedSlot = (page, id) => page.evaluate((n) => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || !k.includes('tangu2_named_layouts')) continue
        try { const v = JSON.parse(localStorage.getItem(k))[n]; if (v) return v } catch { /* next */ }
      }
      return null
    }, `space:${id}`)
    const ownLayout = (page, id) => page.evaluate((key) => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.includes(key)) { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }
      }
      return null
    }, `tangu2_layout_detached_sp_${id}`)

    const ids = await topSpaces()
    console.log('上区露出的 Space:', ids.join(' '))
    if (ids.length < 3) { console.error(`上区只有 ${ids.length} 个 Space,不够验`); process.exit(1) }
    const [A, B, C] = ids
    const sid = (rid) => rid.slice('space:'.length)

    // ───────── R 最近使用 ─────────
    check('R1 没切过 Space:中间不露东西', (await recents()).length === 0, await recents())
    await clickSpace(A)
    await win.locator('.dv-new-tab').first().click().catch(() => {}) // A 里多开一张:它的布局从此 ≠ 默认(W2 靠这个分辨「照存的摆」与「重建默认」)
    await win.waitForTimeout(800)
    await clickSpace(B)
    await clickSpace(C)
    check('R2 切过条上露着的 A → B → C:中间照字面列 = C、B、A(最近的在上,当前的也列)', (await recents()).join() === [C, B, A].join(), await recents())
    check('R2a 当前 Space 在条上、中间各亮一处', (await win.locator('.rb-space.on').count()) === 2 && (await win.locator(`.rb-recent-slot[data-recent-id="${C}"] .rb-space.on`).count()) === 1)
    // 排在「…」里的:展开上区挨个进一遍(点条上的按钮不收起),再收回
    await win.locator('.rb-top .rb-more').click()
    await win.waitForTimeout(500)
    const hidden = (await topSpaces()).filter((id) => !ids.includes(id) && id !== 'space:probe-win').slice(0, 5)
    if (hidden.length < 5) { console.error(`「…」里只有 ${hidden.length} 个 Space,不够验上限 5`); process.exit(1) }
    for (const h of hidden) await clickSpace(h)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
    const H = [...hidden].reverse() // 最近的在前
    let rc = await recents()
    check('R2b 进过「…」里的 5 个之后:中间 = 最近的 3 个,最近的在上', rc.join() === H.slice(0, 3).join(), { got: rc, want: H.slice(0, 3) })
    check('R2c 当前 Space 不在条上露着 → 它在中间亮着(唯一一处)', (await win.locator('.rb-space.on').count()) === 1 && (await win.locator(`.rb-recent-slot[data-recent-id="${H[0]}"] .rb-space.on`).count()) === 1)
    await clickSpace(C)
    rc = await recents()
    const M = [C, ...H] // 此刻的「最近使用」:C 最近,后面是「…」里进过的那 5 个
    check('R2d 再切回条上露着的 C:它排到中间第一个,后面两个顺延', rc.join() === M.slice(0, 3).join() && (await win.locator('.rb-space.on').count()) === 2, rc)
    const boxes = () => win.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom } }
      const slots = Array.from(document.querySelectorAll('.rb-recent .rb-recent-slot')).map((e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom } })
      return { top: r('.rb-top'), bottom: r('.rb-bottom'), slots }
    })
    const clear = (b) => b.slots.every((s) => s.top >= b.top.bottom - 0.5 && s.bottom <= b.bottom.top + 0.5)
    let bx = await boxes()
    check('R3 最近使用的图标整个落在两区之间(不压上区、不压命令区)', bx.slots.length === 3 && clear(bx), bx)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ribbon-recent-tall.png') })

    // 窗口矮了 → 一个个减到没有;回高了再出来
    const seen = []
    for (const h of [820, 760, 700, 640, 600]) {
      await setMainSize(1200, h)
      await win.waitForTimeout(450)
      bx = await boxes()
      seen.push({ h, n: bx.slots.length, clear: clear(bx) })
    }
    const mono = seen.every((s, i) => i === 0 || s.n <= seen[i - 1].n)
    check('R4 窗口越矮露得越少(不增),每一档都不压到两区', mono && seen.every((s) => s.clear) && seen[0].n <= 3, seen)
    check('R5 矮到放不下 → 一个不露', seen[seen.length - 1].n === 0, seen[seen.length - 1])
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ribbon-recent-short.png') })
    await setMainSize(1200, 980)
    await win.waitForTimeout(500)
    check('R6 回高了 → 3 个都回来', (await recents()).length === 3, await recents())

    // ───────── W 开窗 ─────────
    const activeBefore = await activeKey(win)
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const wA = await expectWindow(() => clickSpace(A, [mod]))
    check('W1 ⌘/Ctrl+点击 Space 图标 → 开出这个 Space 的窗口', !!wA && spaceOf(wA) === sid(A) && new URL(wA.url()).searchParams.get('window') === 'detached', wA ? wA.url().replace(/^.*\?/, '?') : null)
    if (!wA) throw new Error('Space 窗口没开出来,后面无从验起')
    await wA.waitForSelector('.dv-groupview', { timeout: 20000 })
    await wA.waitForTimeout(1500)
    check('W1b 主窗没跟着切走(⌘ 点击不是切换)', sid(C) === await activeKey(win) && activeBefore === await activeKey(win), { before: activeBefore, after: await activeKey(win) })
    check('W2 Space 窗口没有 Ribbon', (await wA.locator('.rb').count()) === 0)
    const slotA = panelsOf(await namedSlot(win, sid(A)))
    const ownA = panelsOf(await ownLayout(wA, sid(A)))
    check('W2b 窗口摆的是这个 Space 存着的布局(含多开的那张),不是默认布局', !!slotA && !!ownA && ownA.join() === slotA.join() && ownA.includes('launcher'), { slot: slotA, own: ownA })
    check('W2c Space 窗口里记的活动 Space = 它自己', (await wA.evaluate(() => document.title)).length > 0 && spaceOf(wA) === sid(A))
    check('W2d 开窗没动共用的活动键', (await activeKey(wA)) === activeBefore, await activeKey(wA))
    if (SHOTS) await wA.screenshot({ path: path.join(SHOTS, 'space-window.png') })

    // 右键菜单
    await win.locator(`.rb-top .rb-slot[data-id="${A}"] .rb-btn`).click({ button: 'right' })
    const item = win.locator('.rb-menu button:text-is("在新窗口中打开")')
    check('W3 右键 Space 图标:菜单里有「在新窗口中打开」', (await item.count()) === 1, await win.locator('.rb-menu button').allTextContents())
    const again = await expectWindow(() => item.click(), 2500)
    check('W3b 已经开着的 Space 再开 = 叫到前面,不多开一扇', again === null && spaceWindows().length === 1, spaceWindows().map(spaceOf))
    await win.locator(`.rb-top .rb-slot[data-id="${B}"] .rb-btn`).click({ button: 'right' })
    const wB = await expectWindow(() => win.locator('.rb-menu button:text-is("在新窗口中打开")').click())
    check('W3c 右键另一个 Space → 开出它的窗口', !!wB && spaceOf(wB) === sid(B), wB ? spaceOf(wB) : null)

    // 中间的最近使用图标:右键同一项、⌘ 点击同一条路
    await win.locator(`.rb-recent .rb-recent-slot[data-recent-id="${H[0]}"] .rb-btn`).click({ button: 'right' })
    check('W3d 中间的最近使用图标右键也是这一项', (await win.locator('.rb-menu button:text-is("在新窗口中打开")').count()) === 1)
    await win.keyboard.press('Escape').catch(() => {})
    await win.locator('.rb-menu-backdrop').click({ position: { x: 600, y: 300 } }).catch(() => {})

    // 设置浮窗里改个数 → 主窗跟上(跨窗口 storage 事件)
    const sp = await expectWindow(() => win.keyboard.press(`${mod}+Comma`), 20000)
    if (sp) {
      await sp.waitForSelector('.settings-main', { timeout: 20000 }).catch(() => {})
      const nav = sp.locator('.settings-nav')
      await nav.getByRole('button', { name: '外观', exact: true }).first().click().catch(() => {})
      const row = sp.locator('[data-setting-anchor="ribbon-recent"]')
      await row.scrollIntoViewIfNeeded().catch(() => {})
      if (SHOTS) await sp.screenshot({ path: path.join(SHOTS, 'settings-ribbon-recent.png') })
      const labels = await row.locator('.seg button').allTextContents()
      check('S1 设置 → 外观:有「Ribbon 中间显示最近使用的 Space」,档位 = 不显示 / 1…5', labels.join() === '不显示,1,2,3,4,5', labels)
      await row.locator('.seg button:text-is("1")').click()
      await win.waitForTimeout(600)
      check('S2 设置里改成 1 → 主窗当场只露最近的 1 个', (await recents()).join() === M[0], await recents())
      await row.locator('.seg button:text-is("不显示")').click()
      await win.waitForTimeout(600)
      check('S3 改成不显示 → 中间一个不露', (await recents()).length === 0, await recents())
      await row.locator('.seg button:text-is("5")').click()
      await win.waitForTimeout(600)
      const five = await recents()
      check('S4 改成 5 → 露出 5 个(上限),顺序仍是最近的在上', five.join() === M.slice(0, 5).join(), { got: five, want: M.slice(0, 5) })
      await row.locator('.seg button:text-is("3")').click()
      await sp.close().catch(() => {})
      await win.waitForTimeout(500)
    } else check('S1 设置浮窗开得出来', false)

    // ───────── 拖出条外 ─────────
    const barRight = await win.evaluate(() => document.querySelector('.rb').getBoundingClientRect().right)
    /** 合成一次拖拽。over = 拖到哪(null = 不发 dragover);drop = 松手发不发 drop(false = Esc / 拖出了本文档);end = dragend 的坐标。 */
    const dragOut = async (rid, { over, drop, leaveAtEdge = false, end }) => {
      const sel = `.rb-top .rb-slot[data-id="${rid}"]`
      const dt = await win.evaluateHandle(() => new DataTransfer())
      const r = await win.locator(sel).boundingBox()
      await win.dispatchEvent(sel, 'dragstart', { dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })
      await win.waitForTimeout(80)
      if (over) {
        const target = over.onBar ? sel : '.dv-groupview >> nth=0'
        const ev = { dataTransfer: dt, clientX: over.x, clientY: over.y, screenX: 300, screenY: 200 }
        await win.dispatchEvent(target, 'dragover', ev)
        await win.waitForTimeout(60)
        if (drop) await win.dispatchEvent(target, 'drop', ev)
      }
      if (leaveAtEdge) await win.evaluate(() => document.documentElement.dispatchEvent(new DragEvent('dragleave', { bubbles: true, clientX: window.innerWidth, clientY: 300 })))
      await win.waitForTimeout(40)
      await win.dispatchEvent(sel, 'dragend', { dataTransfer: dt, clientX: end.x, clientY: end.y, screenX: 320, screenY: 220 })
      await win.waitForTimeout(150)
    }
    const D = C
    const orderBefore = await win.evaluate(() => localStorage.getItem('forsion_tangu_ribbon_order'))
    let none = await expectWindow(() => dragOut(D, { over: { x: barRight + 10, y: 300 }, drop: true, end: { x: barRight + 10, y: 300 } }), 2000)
    check('D1 贴着条边松手(24px 以内)不开窗', none === null)
    none = await expectWindow(() => dragOut(D, { over: { x: 600, y: 400 }, drop: false, end: { x: 600, y: 400 } }), 2000)
    check('D2 拖到条外按 Esc(没有 drop,松手点在本文档里)不开窗', none === null)
    check('D2b 条上的顺序没被这两次动过', orderBefore === await win.evaluate(() => localStorage.getItem('forsion_tangu_ribbon_order')))
    const wD = await expectWindow(() => dragOut(D, { over: { x: 600, y: 400 }, drop: true, end: { x: 600, y: 400 } }))
    check('D3 拖到条外松手 → 开出这个 Space 的窗口', !!wD && spaceOf(wD) === sid(D), wD ? spaceOf(wD) : null)
    check('D3b 拖出去不改条上的顺序、主窗也不切走', orderBefore === await win.evaluate(() => localStorage.getItem('forsion_tangu_ribbon_order')) && (await activeKey(win)) === activeBefore)
    // ───────── A 异步就位的用户 Space(排在「…」里:先把上区展开,再 ⌘ 点它) ─────────
    await win.locator('.rb-top .rb-more').click()
    await win.waitForTimeout(500)
    const P = 'space:probe-win'
    if ((await topSpaces()).includes(P)) {
      const wP = await expectWindow(() => clickSpace(P, [mod]))
      check('A1 「…」里的用户 Space ⌘ 点击 → 开出它的窗口', !!wP && spaceOf(wP) === sid(P), wP ? spaceOf(wP) : null)
      if (wP) {
        await wP.waitForSelector('.dv-groupview', { timeout: 20000 }).catch(() => {})
        await wP.waitForTimeout(1500)
        const own = panelsOf(await ownLayout(wP, sid(P)))
        check('A2 窗口等它注册上来才挂界面:里面是它自己的布局(固定的 outline),不是回落 Space 的', !!own && own.join() === 'outline', own)
        check('A2b 它的窗口同样没有 Ribbon、没动共用的活动键', (await wP.locator('.rb').count()) === 0 && (await activeKey(wP)) === activeBefore)
        await wP.close()
      }
    } else check('A1 展开上区后能看到探针 Space', false, await topSpaces())
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    // 拖到窗口外面松手:没有 drop,靠「从视口边上离开」+ dragend 判
    if (wD) { await wD.close(); await sleep(600) }
    const wOut = await expectWindow(() => dragOut(D, { over: { x: 600, y: 400 }, drop: false, leaveAtEdge: true, end: { x: 5000, y: 300 } }))
    check('D4 拖到窗口外面松手 → 照样开窗', !!wOut && spaceOf(wOut) === sid(D), wOut ? spaceOf(wOut) : null)

    // ───────── H 主页开在自己的窗口里 ─────────
    const homeBtn = win.locator('.rb-home .rb-btn').first()
    if (await homeBtn.count()) {
      await homeBtn.click({ button: 'right' })
      const hi = win.locator('.ctx-menu button:text-is("在新窗口中打开")')
      check('H1 主位槽右键:也有「在新窗口中打开」', (await hi.count()) === 1, await win.locator('.ctx-menu button').allTextContents())
      const wH = await expectWindow(() => hi.click())
      if (wH) {
        await wH.waitForSelector('.hp-tile', { timeout: 20000 }).catch(() => {})
        await wH.waitForTimeout(1200)
        const open = new Set(spaceWindows().map(spaceOf))
        // 找一块「它的 Space 还没开窗」的磁贴:点它应当开出一扇新窗
        const tiles = wH.locator('.hp-spaces .hp-tile:not(.hp-pinned-action):not(.hp-folder)')
        const names = await tiles.locator('.hp-tile-name').allTextContents()
        const before = spaceWindows().length
        let opened = null
        for (let i = 0; i < names.length && !opened; i++) {
          if (/全部|All/.test(names[i])) continue // 「全部 Spaces」是整理面板,不是某个 Space
          const p = await expectWindow(() => tiles.nth(i).click(), 2500)
          if (p && spaceOf(p) && !open.has(spaceOf(p))) opened = p
        }
        check('H2 主页窗口里点磁贴 → 那个 Space 开到它自己的窗口', !!opened && spaceWindows().length > before, { tiles: names, opened: opened ? spaceOf(opened) : null })
        await wH.waitForTimeout(600)
        check('H2b 主页没卡在退场动效里、主窗也没被切走', (await wH.locator('.hp-stack.leaving').count()) === 0 && (await wH.locator('.hp-tile').count()) > 0 && (await activeKey(win)) === activeBefore)
      } else check('H1b 主页的窗口开得出来', false)
    } else console.log('SKIP  H 这个产品档案没有主位槽')
    // ───────── X 等不到的 Space:一直等、把话说明白,不往布局键里写东西 ─────────
    const wX = await expectWindow(() => win.evaluate(() => { void window.tangu.openDetached([], undefined, { space: 'no-such-space' }) }))
    if (wX) {
      await wX.waitForSelector('.space-window-wait', { timeout: 15000 }).catch(() => {})
      const stuck = await wX.evaluate(() => ({
        msg: document.querySelector('.space-window-wait')?.textContent || '',
        shell: document.querySelectorAll('.dv-groupview, .wb-dockview').length,
        keys: Object.keys(localStorage).filter((k) => k.includes('sp_no-such-space')),
      }))
      check('X1 没这个 Space:窗口不挂界面、说明原因,本窗的布局键没被写过', /还没准备好/.test(stuck.msg) && stuck.shell === 0 && stuck.keys.length === 0, stuck)
      await wX.close().catch(() => {})
    } else check('X1 等不到的 Space 的窗口开得出来', false)
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
