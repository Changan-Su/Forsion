/** Homepage 前置 Space 区：固定入口 + 独立副本持久化 + Ribbon 排序隔离。先 npm run build。 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const PINNED_KEY = 'forsion.homepage.pinned-spaces.v1'
const ORDER_KEY = 'forsion_tangu_ribbon_order'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + JSON.stringify(detail) : ''}`)
}

async function drag(win, from, to, out = false) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  if (!a || !b) return false
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await win.mouse.down()
  await win.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 3 })
  await win.waitForTimeout(90)
  const started = await win.locator('.hp-drag-overlay').count()
  await win.mouse.move(
    out ? b.x + b.width - 3 : b.x + b.width / 2,
    out ? b.y + b.height - 3 : b.y + b.height / 2,
    { steps: 14 },
  )
  await win.waitForTimeout(160)
  const probe = await win.evaluate(() => ({
    overlay: document.querySelectorAll('.hp-drag-overlay').length,
    pinnedOver: document.querySelector('.hp-pinned-zone')?.hasAttribute('data-over') || false,
    normalOver: document.querySelector('.hp-space-main [data-over]')?.getAttribute('data-id') || null,
  }))
  probe.from = a
  probe.to = b
  probe.started = started
  await win.mouse.up()
  await win.waitForTimeout(450)
  return probe
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('先 npm run build')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-home-pinned-'))
  const stub = await startStubEngine()
  let app, win
  const errors = []
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(testHome, 'userdata')}`, ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: testHome, TANGU_BACKEND_URL: stub.url },
    })
    win = await app.firstWindow()
    win.on('pageerror', (error) => errors.push(error.message))
    await win.waitForSelector('#root')
    await win.waitForTimeout(2500)
    for (const text of ['跳过引导', 'Skip']) {
      const button = win.getByText(text, { exact: true }).first()
      if (await button.count()) { await button.click(); break }
    }
    await win.waitForSelector('.dv-groupview')
    await win.evaluate(() => localStorage.setItem('forsion_tangu_active_space', 'home'))
    await win.reload()
    await win.waitForSelector('.hp-spaces')
    await win.waitForSelector('#tangu-splash', { state: 'hidden', timeout: 5000 }).catch(() => {})

    const initial = await win.evaluate(() => {
      const fixed = [...document.querySelectorAll('.hp-pinned-zone [data-fixed-id]')]
        .map((el) => ({ id: el.getAttribute('data-fixed-id'), draggable: el.getAttribute('draggable') }))
      const zone = document.querySelector('.hp-pinned-zone')?.getBoundingClientRect()
      const divider = document.querySelector('.hp-space-divider')?.getBoundingClientRect()
      const dock = document.querySelector('.hp-space-main')?.getBoundingClientRect()
      return {
        fixed,
        commands: document.querySelectorAll('.hp-commands, .hp-command-list, .hp-command-add').length,
        geometry: zone && divider && dock ? {
          zoneRight: zone.right, dividerLeft: divider.left, dividerRight: divider.right,
          dockLeft: dock.left, dividerHeight: divider.height,
        } : null,
      }
    })
    check('主页命令区已完整移除', initial.commands === 0, initial)
    check('前置区开头固定应用市场与成就，且不可拖动',
      initial.fixed.map((x) => x.id).join() === 'rb-market,rb-achievements'
        && initial.fixed.every((x) => x.draggable === 'false'), initial.fixed)
    check('前置区与 Ribbon 同步区由竖线分隔且没有重叠', !!initial.geometry
      && initial.geometry.zoneRight <= initial.geometry.dividerLeft + 1
      && initial.geometry.dividerRight <= initial.geometry.dockLeft + 1
      && initial.geometry.dividerHeight >= 40, initial.geometry)

    await win.click('.hp-pinned-zone [data-fixed-id="rb-market"]')
    const marketOpened = await win.locator('.settings-page .mk-nav-brand').waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)
    if (marketOpened) await win.click('.settings-page .settings-back')
    await win.waitForSelector('.hp-spaces')
    await win.click('.hp-pinned-zone [data-fixed-id="rb-achievements"]')
    const achievementsOpened = await win.locator('.settings-page .ach-serieshead').waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)
    if (achievementsOpened) await win.click('.settings-page .settings-back')
    await win.waitForSelector('.hp-spaces')
    check('应用市场与成就固定入口复用原操作并可正常打开', marketOpened && achievementsOpened, { marketOpened, achievementsOpened })

    const zone = win.locator('.hp-pinned-zone')
    const normal = win.locator('.hp-space-main .hp-tile[data-id^="space:"]').first()
    const normalId = await normal.getAttribute('data-id').catch(() => null)
    const beforeOrder = await win.evaluate((key) => localStorage.getItem(key) || '[]', ORDER_KEY)
    const pinned = normalId && await zone.count() ? await drag(win, normal, zone) : false
    const afterPin = await win.evaluate(({ pinnedKey, orderKey, normalId }) => ({
      pinned: JSON.parse(localStorage.getItem(pinnedKey) || '[]'),
      order: localStorage.getItem(orderKey) || '[]',
      copy: document.querySelectorAll(`.hp-pinned-space[data-space-id="${normalId?.replace(/^space:/, '')}"]`).length,
      normal: document.querySelectorAll(`.hp-space-main .hp-tile[data-id="${normalId}"]`).length,
    }), { pinnedKey: PINNED_KEY, orderKey: ORDER_KEY, normalId })
    check('普通 Space 拖入前置区后额外显示一份，原位置仍保留', !!pinned?.overlay && pinned.pinnedOver && !!normalId
      && afterPin.copy === 1 && afterPin.normal === 1 && afterPin.pinned.includes(normalId.replace(/^space:/, '')), { pinned, afterPin })
    check('钉住 Space 不参与 Ribbon 排序', afterPin.order === beforeOrder, { beforeOrder, after: afterPin.order })

    await win.reload()
    await win.waitForSelector('.hp-spaces')
    await win.waitForSelector('#tangu-splash', { state: 'hidden', timeout: 5000 }).catch(() => {})
    const restored = normalId ? await win.locator(`.hp-pinned-space[data-space-id="${normalId.replace(/^space:/, '')}"]`).count() : 0
    check('前置 Space 副本刷新后恢复', restored === 1, { normalId, restored })

    if (restored && normalId) {
      const copy = win.locator(`.hp-pinned-space[data-space-id="${normalId.replace(/^space:/, '')}"]`)
      const dockTarget = win.locator('.hp-space-main')
      await drag(win, copy, dockTarget, true)
    }
    const afterRemove = await win.evaluate(({ pinnedKey, orderKey }) => ({
      pinned: JSON.parse(localStorage.getItem(pinnedKey) || '[]'),
      order: localStorage.getItem(orderKey) || '[]',
      copies: document.querySelectorAll('.hp-pinned-space').length,
    }), { pinnedKey: PINNED_KEY, orderKey: ORDER_KEY })
    check('用户钉住的副本可拖出移除，Ribbon 顺序仍不变', afterRemove.pinned.length === 0
      && afterRemove.copies === 0 && afterRemove.order === beforeOrder, afterRemove)

    const fixedBefore = await win.locator('.hp-pinned-zone [data-fixed-id]').count()
    if (fixedBefore) await drag(win, win.locator('.hp-pinned-zone [data-fixed-id]').first(), win.locator('.hp-space-main'))
    const fixedAfter = await win.locator('.hp-pinned-zone [data-fixed-id]').count()
    check('应用市场与成就无法拖出前置区', fixedBefore === 2 && fixedAfter === 2, { fixedBefore, fixedAfter })

    for (const size of [[1100, 420], [500, 850]]) {
      await app.evaluate(({ BrowserWindow }, next) => {
        const current = BrowserWindow.getAllWindows()[0]
        current.setMinimumSize(320, 300)
        current.setSize(next[0], next[1])
      }, size)
      await win.waitForTimeout(450)
      const responsive = await win.evaluate(() => {
        const root = document.querySelector('.hp-root')?.getBoundingClientRect()
        const zone = document.querySelector('.hp-pinned-zone')?.getBoundingClientRect()
        const divider = document.querySelector('.hp-space-divider')?.getBoundingClientRect()
        const main = document.querySelector('.hp-space-main')?.getBoundingClientRect()
        const pane = document.querySelector('.hp-spaces')?.getBoundingClientRect()
        return root && zone && divider && main && pane ? {
          contained: pane.left >= root.left - 1 && pane.right <= root.right + 1 && pane.top >= root.top - 1 && pane.bottom <= root.bottom + 1,
          ordered: zone.right <= divider.left + 1 && divider.right <= main.left + 1,
          widths: [zone.width, main.width],
        } : null
      })
      check(`${size.join('×')} 前置区/竖线/普通区仍完整分段`, !!responsive?.contained && responsive.ordered
        && responsive.widths.every((width) => width > 0), responsive)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820))
    await win.waitForTimeout(450)

    if (SHOT) for (const mode of ['light', 'dark']) {
      await win.evaluate((m) => {
        document.documentElement.dataset.mode = m
        document.documentElement.classList.toggle('dark', m === 'dark')
      }, mode)
      await win.waitForTimeout(400)
      await win.screenshot({ path: path.join(os.tmpdir(), `forsion-homepage.pinned-${mode}.png`) })
    }
    check('没有未捕获渲染异常', errors.length === 0, errors)
  } finally {
    await app?.close().catch(() => {})
    await stub.close()
    fs.rmSync(testHome, { recursive: true, force: true })
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} 通过`)
  process.exitCode = results.some((r) => !r.ok) ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
