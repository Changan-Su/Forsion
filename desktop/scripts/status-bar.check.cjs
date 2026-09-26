/**
 * 底部状态栏的键盘可达与分组(09-25 UI/UX 评审 U-23)—— 打真 App(out/ 构建产物 + 隔离家目录)。
 *
 *  A 可点项一律是原生 <button type=button>(原来是 span+onClick:Tab 不到、读屏不知道能点)
 *  B 每个可点项都有悬停说明(title):点了会发生什么(切换 Space / 立即同步 / 打开反链…)
 *  C 从页面开头连按 Tab 真能走到状态栏的可点项(不是 el.focus() 硬塞),且落上时画的是 1px 焦点环
 *  D 新用户(无存档)缺省隐藏「收件箱未读」;已存偏好不动(写一份不隐藏的存档后重载,收件箱按钮真的可见)。
 *    桩引擎报 3 封未读 —— 未读为 0 时 InboxItem 返回 null、只剩空包装节点,只查包装节点 id 会假绿(Codex 第一轮 C-4)
 *  E 分组:隔离家目录装一个探针插件,左右各注册一个状态项;插件项排在所在侧内置项之后,交界处的分隔线**真的可见**
 *    (Codex 第一轮 C-5:以前采了 seps 不断言,且没插件项时整条跳过)
 *
 * 需要先在本目录 `npx electron-vite build`(读 out/)。跑:npm run check:statusbar
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

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
  // 桩引擎:收件箱报 UNREAD 封未读(D 要看「按钮真的可见」,未读为 0 时收件箱项根本不渲染按钮)。
  const UNREAD = Number(process.env.SB_UNREAD ?? 3)
  const stub = await startStubEngine({ handle: ({ path: p }) => (p === '/agent/inbox/unread-count' ? { count: UNREAD, latestId: null } : undefined) })
  // 钉成外部连接 = 桩引擎:否则 dev 缺省托管模式会起真引擎(tangu-agent 已构建时),重载后连的是它、未读恒 0。
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  // 探针插件(E):左右各一个状态项,右侧可点。
  const probeDir = path.join(home, 'plugins/sb-probe')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({ id: 'sb-probe', name: 'Status probe', version: '1.0.0', minAppVersion: '0.0.1' }))
  fs.writeFileSync(path.join(probeDir, 'main.js'), `
    ctx.registerStatusItem({ id: 'l', side: 'left', text: 'probe-left', title: 'Probe left' })
    ctx.registerStatusItem({ id: 'r', side: 'right', text: 'probe-right', title: 'Probe right', onClick: () => {} })
  `)
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_ENABLE_LOGGING: '1' },
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
    // 未读数在连接就绪后才拉(inboxStore 连接 ok 即首拉):等收件箱按钮出来,不按固定时长猜。
    const inboxBtn = win.locator('.sb .sb-item[data-sb-id="inbox.unread"] button.sb-click')
    await inboxBtn.waitFor({ state: 'visible', timeout: 40_000 }).catch(() => {})
    const inbox = await win.evaluate(() => {
      const b = document.querySelector('.sb .sb-item[data-sb-id="inbox.unread"] button.sb-click')
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { text: b.textContent.trim(), w: r.width, h: r.height, label: b.getAttribute('aria-label') || '' }
    })
    check(`D 已存偏好(不隐藏)原样生效:收件箱按钮真的可见且显示 ${UNREAD} 封未读`, !!inbox && inbox.w > 0 && inbox.h > 0 && inbox.text === String(UNREAD), JSON.stringify(inbox))

    // E 分组:探针插件左右各一项 → 各侧插件项排在内置项之后,交界处有一条可见的分隔线
    const layout = await win.evaluate(() => {
      const side = (root) => [...root.children].map((el) => el.classList.contains('sb-sep')
        ? { sep: true, visible: getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0 }
        : { id: el.dataset.sbId || '', filled: !!el.childElementCount || !!el.textContent })
      const left = document.querySelector('.sb > .sb-group:not(.sb-right)')
      const right = document.querySelector('.sb .sb-right')
      return { left: left ? side(left) : null, right: right ? side(right) : null }
    })
    for (const sideName of ['left', 'right']) {
      const list = layout[sideName] || []
      const items = list.filter((x) => !x.sep && x.filled)
      const firstPlugin = items.findIndex((x) => x.id.startsWith('plugin:'))
      const ordered = firstPlugin > 0 && items.slice(firstPlugin).every((x) => x.id.startsWith('plugin:'))
      // 交界:第一个插件项紧前面那个兄弟节点必须是可见的 .sb-sep
      const at = list.findIndex((x) => !x.sep && x.id.startsWith('plugin:'))
      const sepBefore = at > 0 && list[at - 1].sep && list[at - 1].visible
      check(`E ${sideName}:插件项在内置项之后,交界处的分隔线真的可见`, ordered && sepBefore, JSON.stringify(list))
    }
    if (SHOT_DIR) {
      const vw = await win.evaluate(() => window.innerWidth)
      const vh = await win.evaluate(() => window.innerHeight)
      await win.screenshot({ path: path.join(SHOT_DIR, 'statusbar-groups.png'), clip: { x: 0, y: vh - 40, width: vw, height: 40 } })
    }
  } finally {
    await app.close().catch(() => {})
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
