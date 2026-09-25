/**
 * 底部状态栏的键盘可达与分组(09-25 UI/UX 评审 U-23)—— 打真 App(out/ 构建产物 + 隔离家目录)。
 *
 *  A 可点项一律是原生 <button type=button>(原来是 span+onClick:Tab 不到、读屏不知道能点)
 *  B 每个可点项都有悬停说明(title):点了会发生什么(切换 Space / 立即同步 / 打开反链…)
 *  C 从页面开头连按 Tab 真能走到状态栏的可点项(不是 el.focus() 硬塞),且落上时画的是 1px 焦点环
 *  D 新用户(无存档)缺省隐藏「收件箱未读」;已存偏好不动(写一份不隐藏的存档后重载,收件箱项回到可见清单)
 *  E 分组:插件项(plugin:*)在所在侧的内置项之后,相邻处有分隔(无插件项时跳过,排序由 lcl statusBar.test 锁)
 *
 * 需要先在本目录 `npx electron-vite build`(读 out/)。跑:npm run check:statusbar
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || ''
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先在本目录跑 npx electron-vite build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-statusbar-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', ELECTRON_ENABLE_LOGGING: '1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.sb .sb-click', { timeout: 30_000 })
    await win.waitForTimeout(1200)

    const info = await win.evaluate(() => {
      const clicks = [...document.querySelectorAll('.sb .sb-click')]
      return {
        tags: clicks.map((e) => `${e.tagName.toLowerCase()}${e.getAttribute('type') ? `[${e.getAttribute('type')}]` : ''}`),
        titles: clicks.map((e) => e.getAttribute('title') || ''),
        ids: [...document.querySelectorAll('.sb .sb-item[data-sb-id]')].map((e) => ({ id: e.dataset.sbId, side: e.closest('.sb-right') ? 'right' : 'left', empty: !e.childElementCount && !e.textContent })),
        seps: [...document.querySelectorAll('.sb .sb-sep')].map((e) => getComputedStyle(e).display !== 'none'),
        prefs: localStorage.getItem('forsion.sb.prefs'),
      }
    })
    check('A 可点项一律是 <button type=button>', info.tags.length > 0 && info.tags.every((t) => t === 'button[button]'), info.tags.join(','))
    check('B 每个可点项都有悬停说明', info.titles.every(Boolean), info.titles.join(' ‖ '))

    // C 真 Tab:先把焦点放回文档开头,再一格一格按,直到落进状态栏(上限 400 格)
    await win.evaluate(() => { (document.activeElement)?.blur?.(); document.body.focus() })
    let reached = null
    for (let i = 0; i < 400 && !reached; i++) {
      await win.keyboard.press('Tab')
      reached = await win.evaluate(() => {
        const a = document.activeElement
        if (!a || !a.closest?.('.sb')) return null
        const cs = getComputedStyle(a)
        return { cls: a.className, outline: `${cs.outlineWidth} ${cs.outlineStyle}`, focusVisible: a.matches(':focus-visible') }
      })
      if (reached) reached.presses = i + 1
    }
    check('C 连按 Tab 能走到状态栏可点项,落上时是 1px 实线焦点环', !!reached && reached.focusVisible && reached.outline === '1px solid', JSON.stringify(reached))
    if (SHOT_DIR && reached) {
      const vw = await win.evaluate(() => window.innerWidth)
      const vh = await win.evaluate(() => window.innerHeight)
      await win.screenshot({ path: path.join(SHOT_DIR, 'statusbar-focus.png'), clip: { x: vw - 360, y: vh - 40, width: 360, height: 40 } })
    }

    // D 缺省隐藏收件箱未读(无存档)
    check('D 新用户无存档(缺省值生效,未落盘)', info.prefs === null, `forsion.sb.prefs=${info.prefs}`)
    check('D 缺省不渲染「收件箱未读」项', !info.ids.some((x) => x.id === 'inbox.unread'), info.ids.map((x) => x.id).join(','))
    await win.evaluate(() => localStorage.setItem('forsion.sb.prefs', JSON.stringify({ enabled: true, hidden: [], order: [] })))
    await win.reload()
    await win.waitForSelector('.sb', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    const ids2 = await win.evaluate(() => [...document.querySelectorAll('.sb .sb-item[data-sb-id]')].map((e) => e.dataset.sbId))
    check('D 已存偏好(不隐藏)原样生效:收件箱项回到清单', ids2.includes('inbox.unread'), ids2.join(','))

    // E 分组
    const plug = info.ids.filter((x) => x.id.startsWith('plugin:'))
    if (!plug.length) {
      console.log('SKIP  E 本次没有插件状态项(排序与分隔由 lcl/engine/statusBar.test.ts 锁)')
    } else {
      const ok = ['left', 'right'].every((side) => {
        const list = info.ids.filter((x) => x.side === side).map((x) => x.id.startsWith('plugin:'))
        const firstPlugin = list.indexOf(true)
        return firstPlugin < 0 || list.slice(firstPlugin).every(Boolean)
      })
      check('E 插件项排在所在侧内置项之后', ok, info.ids.map((x) => x.id).join(','))
    }
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
