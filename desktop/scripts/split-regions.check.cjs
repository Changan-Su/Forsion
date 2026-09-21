/** Real Dockview regression: shell panels must surround the whole split Main region.
 * Run with a dev renderer: HARNESS_URL=http://localhost:5273/harness.html npm run check:splitregions
 * Uses an isolated browser profile. Never reads or writes the user's saved workspace.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')
const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-split-regions-'))
const engine = `/@fs${path.resolve(__dirname, '../../lcl/engine/index.ts')}`
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const executablePath = process.env.CHROMIUM_EXE || fs.readdirSync(cache).filter(x => x.startsWith('chromium-')).sort().reverse()
  .flatMap(x => ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']
    .map(app => path.join(cache, x, 'chrome-mac-arm64', app))).find(x => fs.existsSync(x))
let failed = 0
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) failed++ }
async function run() {
  const browser = await chromium.launch({ executablePath, headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } })
    page.on('pageerror', e => { console.error(e.message); failed++ })
    await page.goto(`${process.env.HARNESS_URL || 'http://localhost:5273/harness.html'}?dock`)
    await page.waitForSelector('.dockh-body[data-tag="main"]')
    await page.evaluate(async url => { window.__regions = await import(url) }, engine)
    const setup = async () => {
      await page.evaluate(() => {
        const w = window.__regions.useWorkspace.getState()
        w.api.clear()
        const a = w.openView('mainv', { label: 'video' }, 'main', { newTab: true })
        w.splitActive('right', { label: 'document' })
        w.activateLeaf(a.id)
        w.splitActive('down', { label: 'chat' })
        w.openView('sidev', {}, 'left')
      })
      await page.waitForTimeout(400)
      await page.evaluate(() => {
        const api = window.__regions.useWorkspace.getState().api
        window.__kept = api.panels.filter(p => p.params.__loc === 'main').map(p => {
          const el = p.group.element.querySelector('.dockh-body')
          const input = document.createElement('input')
          input.value = `draft:${p.id}`
          el.append(input)
          // Fixed-size content isolates scroll restoration from legitimate browser scroll anchoring
          // when the long Chinese paragraphs reflow during width changes.
          const scroller = document.createElement('div'), content = document.createElement('div')
          scroller.style.cssText = 'height:120px;overflow:auto'
          content.style.height = '4000px'
          scroller.append(content); el.append(scroller); scroller.scrollTop = 140
          return { id: p.id, group: p.group, el, input, scroller, scroll: scroller.scrollTop }
        })
      })
    }
    const snap = () => page.evaluate(() => {
      const api = window.__regions.useWorkspace.getState().api
      return api.groups.map(g => {
        const r = g.element.getBoundingClientRect()
        return { id: g.id, loc: g.panels[0]?.params.__loc, labels: g.panels.map(p => p.params.label), x: r.x, y: r.y, w: r.width, h: r.height }
      })
    })
    const validate = async name => {
      const all = await snap()
      const mains = all.filter(g => g.loc === 'main'), left = all.find(g => g.loc === 'left')
      const right = all.filter(g => g.loc === 'right'), bottom = all.filter(g => g.loc === 'bottom')
      const bounds = gs => ({ x: Math.min(...gs.map(g => g.x)), y: Math.min(...gs.map(g => g.y)),
        r: Math.max(...gs.map(g => g.x + g.w)), b: Math.max(...gs.map(g => g.y + g.h)) })
      const m = bounds(mains), r = bounds(right), b = bounds(bottom)
      check(`${name}: Main 仍有三个分屏`, mains.length === 3)
      if (right.length) {
        check(`${name}: 右栏在所有 Main 右侧`, r.x >= m.r - 2, r.x < m.r - 2 ? JSON.stringify(all) : '')
        check(`${name}: 右栏与整个 Main 等高`, Math.abs(r.y - m.y) < 3 && Math.abs(r.b - m.b) < 3)
      }
      if (bottom.length) {
        check(`${name}: 底部在所有 Main 下方`, b.y >= m.b - 2)
        check(`${name}: 底部横跨 Main 和右栏`, Math.abs(b.x - m.x) < 3 && Math.abs(b.r - (right.length ? r.r : m.r)) < 3)
        if (left) check(`${name}: 左栏通高`, Math.abs(left.y + left.h - b.b) < 3)
      }
      const video = mains.find(g => g.labels.includes('video')), chat = mains.find(g => g.labels.includes('chat')), doc = mains.find(g => g.labels.includes('document'))
      check(`${name}: Main 内部左右/上下关系保留`, video && chat && doc && Math.abs(video.x - chat.x) < 3 && Math.abs(doc.x - video.x - video.w) < 3 && Math.abs(chat.y - video.y - video.h) < 3 && Math.abs(doc.y - video.y) < 3 && Math.abs(doc.y + doc.h - chat.y - chat.h) < 3)
      check(`${name}: Main 分屏比例保持`, video && chat && doc && Math.abs(video.h - chat.h) < 3 && Math.abs(video.w - doc.w) < 3)
      const kept = await page.evaluate(() => window.__kept.map(({ id, group, el, input, scroller, scroll }) => {
        const p = window.__regions.useWorkspace.getState().api.getPanel(id)
        return { id, sameGroup: p?.group === group, connected: el.isConnected, sameView: el === group.element.querySelector('.dockh-body'),
          draft: input.value === `draft:${id}`, scroll, actualScroll: scroller.scrollTop }
      }))
      const unchanged = kept.every(p => p.sameGroup && p.connected && p.sameView && p.draft && p.scroll === p.actualScroll)
      check(`${name}: View/分组身份、草稿与滚动保持`, unchanged, unchanged ? '' : JSON.stringify(kept))
    }
    for (const order of [['right', 'bottom'], ['bottom', 'right']]) {
      await setup()
      for (const side of order) {
        await page.evaluate(s => window.__regions.useWorkspace.getState().toggleSidebar(s), side)
        await page.waitForTimeout(450)
        await validate(`${order.join('→')}/${side}`)
      }
      await page.screenshot({ path: path.join(shots, `${order.join('-')}.png`) })
      for (const side of ['left', 'right', 'bottom']) {
        await page.evaluate(s => window.__regions.useWorkspace.getState().toggleSidebar(s), side)
        await page.waitForTimeout(500)
        await page.evaluate(s => window.__regions.useWorkspace.getState().toggleSidebar(s), side)
        await page.waitForTimeout(600)
        await validate(`重开${side}`)
      }
    }
    for (const side of ['right', 'bottom']) {
      await setup()
      await page.evaluate(side => {
        window.__extension = window.__dock.extend(side)
        window.__extension.element.textContent = 'Transient native panel'
      }, side)
      await page.waitForTimeout(600)
      await validate(`临时扩展${side}`)
      await page.evaluate(async () => { await window.__extension.dispose() })
      await page.waitForTimeout(400)
      await validate(`关闭临时扩展${side}`)
    }

    // Multiple side groups stay inside their region as another shell panel opens.
    await setup()
    await page.evaluate(() => {
      const w = window.__regions.useWorkspace.getState()
      w.openView('sidev', {}, 'right')
      w.splitActive('down')
    })
    await page.waitForTimeout(400)
    await page.evaluate(() => window.__regions.useWorkspace.getState().toggleSidebar('bottom'))
    await page.waitForTimeout(450)
    await validate('右侧栏自身上下分屏')

    // Persist the exact old fault (side/bottom anchored to one Main leaf), then load it through
    // the real named-layout restoration path. Existing main content and tabs must all survive.
    await setup()
    await page.evaluate(() => {
      const w = window.__regions.useWorkspace.getState(), api = w.api
      const video = api.panels.find(p => p.params.label === 'video')
      api.addPanel({ id: 'old-right', component: 'sidev', params: { __type: 'sidev', __loc: 'right' }, position: { referencePanel: video.id, direction: 'right' } })
      api.addPanel({ id: 'old-bottom', component: 'sidev', params: { __type: 'sidev', __loc: 'bottom' }, position: { referencePanel: video.id, direction: 'below' } })
      w.saveNamed('old-broken-split')
      w.applyNamed('old-broken-split')
      window.__kept = [] // fromJSON is deliberately a restore; identity is checked only for live shell changes
    })
    await page.waitForTimeout(500)
    // The original broken layout had unequal sizes, so test boundaries and content preservation,
    // not an invented old ratio that was never stored.
    const restored = await snap(), main = restored.filter(g => g.loc === 'main')
    const right = restored.find(g => g.loc === 'right'), bottom = restored.find(g => g.loc === 'bottom')
    check('恢复旧坏布局: 右栏归位', main.length === 3 && right.x >= Math.max(...main.map(g => g.x + g.w)) - 2)
    check('恢复旧坏布局: 底部归位', bottom.y >= Math.max(...main.map(g => g.y + g.h)) - 2)
    await page.evaluate(() => {
      const w = window.__regions.useWorkspace.getState()
      w.saveCurrent()
    })
    await page.reload()
    await page.waitForSelector('.dockh-body[data-tag="main"]')
    await page.evaluate(async url => { window.__regions = await import(url) }, engine)
    await page.waitForTimeout(400)
    const reboot = await snap(), rm = reboot.filter(g => g.loc === 'main'), rr = reboot.find(g => g.loc === 'right'), rb = reboot.find(g => g.loc === 'bottom')
    check('重启持久化: 分区边界保持', rm.length === 3 && rr.x >= Math.max(...rm.map(g => g.x + g.w)) - 2 && rb.y >= Math.max(...rm.map(g => g.y + g.h)) - 2)
    console.log(`Screenshots: ${shots}`)
  } finally { await browser.close() }
}
run().then(() => process.exit(failed ? 1 : 0)).catch(e => { console.error(e); process.exit(1) })
