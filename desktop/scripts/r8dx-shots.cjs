// 走查续八 PR4 的仪器:样例插件 v2(scripts/fixtures/r8dx-sample-v2,只用公开接口 + 2026-10-26 的新 ctx.ui 零件)装进隔离 home,
// 拍每个新零件(明 / 暗 / 现场切英文 / 窄窗格)并量几何:视图头仍是 32px、工具栏控件 28px、对话框居中、菜单带图标 / 小节 / 分隔、
// Space 图标不是回落的方块、列表源空时侧栏不写「暂无内容」、切语言后宿主画的部分跟着变。
// 跑法(先 npx electron-vite build):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="r8dx shots" --eta=6 -- node scripts/r8dx-shots.cjs
// 产物:$R8DX_OUT(缺省系统临时目录下 r8dx-shots/)里的 png + results.json;有断言不过时退出码 1。
const fs = require('fs'), os = require('os'), path = require('path')
const { launch, boot, sleep } = require('./lib/uiux-electron.cjs')

const PLUG = path.join(__dirname, 'fixtures', 'r8dx-sample-v2')
const OUT = process.env.R8DX_OUT || path.join(os.tmpdir(), 'r8dx-shots')
fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }

async function shot(app, win, name) {
  await win.evaluate(() => document.querySelectorAll('.lcl-tip').forEach((t) => t.remove())).catch(() => {})
  await sleep(150)
  const url = win.url()
  const b64 = await app.evaluate(async ({ BrowserWindow }, u) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === u)
    return w ? (await w.capturePage()).toPNG().toString('base64') : null
  }, url)
  if (b64) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'))
}
const size = (app, w, h) => app.evaluate(({ BrowserWindow }, s) => { const x = BrowserWindow.getAllWindows().filter((y) => !/window=/.test(y.webContents.getURL()))[0]; x.setContentSize(s.w - 1, s.h); x.setContentSize(s.w, s.h) }, { w, h })
async function prefs(app, win, o) {
  await win.evaluate((p) => { localStorage.setItem('tangu_locale', p.lang); localStorage.setItem('forsion_theme_pref', p.mode); localStorage.setItem('forsion_default_space', 'r8dx') }, o)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('[data-r8="main"]', { timeout: 30_000 })
  await sleep(1800)
  await size(app, o.w || 1512, o.h || 950); await sleep(500)
}
const rect = (win, sel) => win.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }, sel)
const esc = async (win) => { await win.keyboard.press('Escape'); await sleep(350) }

;(async () => {
  const ctx = await launch({ tag: 'r8dx2', overrideHome: true, beforeLaunch: ({ home }) => { fs.cpSync(PLUG, path.join(home, 'plugins', 'r8dx-sample'), { recursive: true }) } })
  const { app, win } = ctx
  let failed = false
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    for (const mode of ['light', 'dark']) {
      const tag = mode === 'dark' ? '-dark' : ''
      await prefs(app, win, { lang: 'zh', mode })
      await win.mouse.move(1500, 940)
      // 空态:主区宿主 EmptyState 一份,侧栏不写「暂无内容」
      const empty = await win.evaluate(() => ({
        main: !!document.querySelector('[data-r8="empty"] [data-empty-state]'),
        sideLine: [...document.querySelectorAll('.t2sw-empty')].map((e) => e.textContent),
        ribbon: (() => { const b = [...document.querySelectorAll('.rb-space')].find((x) => /DX/.test(x.getAttribute('aria-label') || x.getAttribute('title') || '')); return b ? b.querySelector('svg')?.getAttribute('class') ?? b.innerHTML.slice(0, 120) : null })(),
        icons: [...document.querySelectorAll('[data-r8="filterbtn"] svg, [data-r8="export"] svg, [data-r8="more"] svg, [data-r8="add"] svg')].map((e) => e.childElementCount),
      }))
      check(`empty${tag}: main area shows the host empty state`, empty.main)
      check(`empty${tag}: sidebar writes no "Nothing here yet"`, !empty.sideLine.length, empty.sideLine)
      check(`ribbon${tag}: Space icon is list-checks, not the boxes fallback`, /list-checks/.test(empty.ribbon || ''), empty.ribbon)
      check(`icons${tag}: ctx.ui.icon drawn inside a view mount (4 buttons, each with paths)`, empty.icons.length === 4 && empty.icons.every((n) => n > 0), empty.icons)
      await shot(app, win, `empty${tag}`)
      await win.evaluate(() => window.__r8dx.seed(6)); await sleep(600)
      const head = await rect(win, '.lcl-viewhead'), sel = await rect(win, '[data-r8="sel"] .plugin-tbsel'), seg = await rect(win, '[data-r8="seg"] .lcl-vmode-pill')
      check(`head${tag}: view head stays 32px with the controls in it`, head && head.h === 32, head)
      check(`head${tag}: toolbar select is 28px`, sel && sel.h === 28, sel)
      check(`head${tag}: segmented is the view-mode pill (24px)`, seg && seg.h === 24, seg)
      check(`head${tag}: title drawn`, await win.evaluate(() => document.querySelector('.lcl-viewhead-title')?.textContent === '样例'))
      await shot(app, win, `list${tag}`)
      // 下拉 listbox
      await win.click('[data-r8="sel"] .plugin-tbsel'); await sleep(400)
      check(`select${tag}: listbox in menu shell, current ticked`, await win.evaluate(() => { const m = document.querySelector('.ctx-menu.plugin-listbox'); return !!m && m.querySelector('[aria-selected="true"]')?.textContent === '最新' }))
      await shot(app, win, `select-open${tag}`)
      await esc(win)
      // 菜单:锚在「⋯」右缘,小节 / 图标 / 快捷键 / 分隔
      await win.click('[data-r8="more"]'); await sleep(450)
      const menu = await win.evaluate(() => {
        const m = document.querySelector('.ctx-menu.plugin-menu'); const more = document.querySelector('[data-r8="more"]')
        if (!m || !more) return null
        const r = m.getBoundingClientRect(), a = more.getBoundingClientRect()
        return { head: m.querySelector('.ctx-head')?.textContent, icons: m.querySelectorAll('svg.plugin-menu-ic').length, seps: m.querySelectorAll('.ctx-separator').length,
          keys: [...m.querySelectorAll('.ctx-shortcut')].map((k) => k.textContent), rightGap: Math.round(a.right - r.right), below: Math.round(r.top - a.bottom) }
      })
      check(`menu${tag}: section, icons, shortcuts, separator`, menu && menu.head === '条目' && menu.icons === 4 && menu.seps === 1 && menu.keys.join() === 'F2,⌘D', menu)
      check(`menu${tag}: anchored under the button, right edges aligned`, menu && Math.abs(menu.rightGap) <= 1 && menu.below >= 0 && menu.below <= 6, menu)
      await shot(app, win, `menu${tag}`)
      await esc(win)
      // 对话框:居中
      await win.click('[data-r8="export"]'); await sleep(500)
      const dlg = await win.evaluate(() => { const d = document.querySelector('dialog.plugin-dialog[open]'); if (!d) return null; const r = d.getBoundingClientRect(); return { dx: Math.round(r.left - (innerWidth - r.width) / 2), dy: Math.round(r.top - (innerHeight - r.height) / 2), w: Math.round(r.width), focus: document.activeElement?.textContent } })
      check(`dialog${tag}: centered, 420px, focus on the main button`, dlg && Math.abs(dlg.dx) <= 1 && Math.abs(dlg.dy) <= 1 && dlg.w === 420 && dlg.focus === '导出', dlg)
      await shot(app, win, `dialog${tag}`)
      await esc(win)
      check(`dialog${tag}: Escape closes`, await win.evaluate(() => !document.querySelector('dialog.plugin-dialog')))
      // 危险确认(菜单 → 删除)
      await win.click('[data-r8="more"]'); await sleep(400)
      await win.click('.ctx-menu.plugin-menu button.danger'); await sleep(500)
      check(`confirm${tag}: danger — red main button, focus on Cancel`, await win.evaluate(() => { const d = document.querySelector('dialog.plugin-dialog[open]'); return !!d && d.querySelector('.btn.primary[data-danger]') !== null && document.activeElement?.textContent === '取消' }))
      await shot(app, win, `confirm${tag}`)
      await esc(win)
      // 弹出层
      await win.click('[data-r8="filterbtn"]'); await sleep(450)
      const pop = await win.evaluate(() => { const p = document.querySelector('.ui-popover.plugin-popover'); const b = document.querySelector('[data-r8="filterbtn"]'); if (!p || !b) return null; const r = p.getBoundingClientRect(), a = b.getBoundingClientRect(); return { left: Math.round(r.left - a.left), below: Math.round(r.top - a.bottom), inView: r.right <= innerWidth && r.bottom <= innerHeight } })
      check(`popover${tag}: anchored under the button, on screen`, pop && pop.inView && pop.below >= 0 && pop.below <= 6, pop)
      await shot(app, win, `popover${tag}`)
      await esc(win)
      await win.evaluate(() => window.__r8dx.clear()); await sleep(300)
    }
    // 现场切英文(不重载):宿主替插件画的部分跟着变
    await prefs(app, win, { lang: 'zh', mode: 'light' })
    await win.evaluate(() => window.__r8dx.seed(4)); await sleep(500)
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ui:sync', { prefs: { tangu_locale: 'en' } }) })
    await sleep(900)
    const live = await win.evaluate(() => ({
      head: document.querySelector('.lcl-viewhead-title')?.textContent,
      seg: [...document.querySelectorAll('[data-r8="seg"] .lcl-vmode-pill .lcl-vmode-tx')].map((e) => e.textContent).join('/'),
      sel: document.querySelector('[data-r8="sel"] .plugin-tbsel')?.textContent,
      listBtn: [...document.querySelectorAll('.t2sw-plug-btn-label')].map((e) => e.textContent).join(','),
      lang: document.documentElement.lang,
    }))
    check('live switch to English: host-drawn parts follow', live.head === 'Sample' && live.seg === 'All/Open/Done' && live.sel === 'Newest' && /New item/.test(live.listBtn), live)
    await shot(app, win, 'list-en-live')
    // 窄窗格:主区窄到看法胶囊只留图标,头行仍是一行
    await size(app, 900, 760); await sleep(700)
    const narrow = await rect(win, '.lcl-viewhead')
    check('narrow: head row still one 32px row', narrow && narrow.h === 32, narrow)
    await shot(app, win, 'narrow')
  } catch (e) {
    console.error(e); failed = true
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1))
    await ctx.close()
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed · shots in ${OUT}`)
  process.exit(failed || bad.length ? 1 : 0)
})()
