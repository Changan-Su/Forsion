/**
 * 右栏「主视图规则」端到端契约(真 Electron × 桩引擎 × 隔离 home)。2026-10-20 用户定方案 B
 * (方案页 docs/ToBeImproved/右栏主视图规则方案_2026-10-20):主视图自带一组右栏视图,排在 Space 规则、用户规则前面。
 *
 *  1 Tangu,主区对话:右栏 = Tangu 详情 / 文件 / 大纲,前台详情
 *  2 对话旁开一篇笔记:右栏换成 对话面板 / 大纲 / 反链 / 关系图,前台对话面板;主区前台仍是笔记(焦点没被拽到右栏)
 *  3 笔记就地换成 PDF:右栏只剩对话面板
 *  4 点回对话标签:右栏换回 详情 / 文件 / 大纲,前台详情
 *  5 右栏收起后切到 PDF:右栏照旧收着;展开看到的是 PDF 那组
 *  6 关掉规则带进来的对话面板再重载:不被补回(存档记着对到的组);负对照:删掉存档里记的组,重载后补回
 *  7 笔记 Space,主区换成对话:右栏 = 详情 / 文件 / 大纲,没有对话面板(不再两个对话并排)
 *  8 配方 Space 右栏写了主区对话 `chat`:按侧栏身份 chat-panel 开出来
 *
 * 需先 npm run build。用法:npm run check:rightrules(截图落 SHOT_DIR,缺省系统临时目录)
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir, sleep } = require('./lib/uiux-electron.cjs')

const R = makeReporter()
const SHOTS = shotDir('rightrules')

/** 最小合法 PDF(一页一行字),xref 偏移现算。 */
function tinyPdf() {
  const stream = 'BT /F1 18 Tf 40 100 Td (Spec) Tj ET'
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

const RECIPE = {
  id: 'rr-recipe', name: { zh: '右栏配方', en: 'Right recipe' }, icon: 'target',
  layout: { main: [{ type: 'agents-detail' }], left: [], right: [{ type: 'chat' }, { type: 'outline' }] },
}

/** 右栏(图标标签、不是左栏的那几组)的标签类型与前台;展开没展开看右边那颗边钮。 */
const rightNow = (win) => win.evaluate(() => {
  const tabs = [...document.querySelectorAll('.dv-tab')].filter((t) => t.querySelector('.wb-tab--icon:not(.wb-tab--left)') && t.getBoundingClientRect().width > 0)
  const type = (t) => t.querySelector('.wb-tab')?.getAttribute('data-view-type') || ''
  const real = tabs.filter((t) => !['sidebar-empty', '__extend'].includes(type(t)))
  return {
    open: document.querySelector('.dv-edge-right')?.getAttribute('aria-pressed') === 'true',
    tabs: real.map(type),
    front: real.filter((t) => t.classList.contains('dv-active-tab')).map(type)[0] ?? null,
  }
})
/** 主区前台标签的类型。 */
const mainFront = (win) => win.evaluate(() => {
  const t = [...document.querySelectorAll('.dv-tab.dv-active-tab')].find((x) => x.querySelector('.wb-tab:not(.wb-tab--icon)'))
  return t?.querySelector('.wb-tab')?.getAttribute('data-view-type') ?? null
})
const link = (win, href) => win.evaluate((h) => { const a = document.createElement('a'); a.href = h; document.body.appendChild(a); a.click(); a.remove() }, href)
const setRight = async (win, open) => {
  if ((await rightNow(win)).open !== open) { await win.locator('.dv-edge-right').first().click(); await sleep(700) }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const TANGU = ['tangu-details', 'workspace', 'outline']
const NOTE = ['chat-panel', 'outline', 'amadeus-backlinks', 'amadeus-graph']

async function main() {
  const ctx = await launch({ tag: 'rightrules', beforeLaunch: ({ home, vault }) => {
    fs.writeFileSync(path.join(vault, 'Alpha.md'), '# Alpha\n\n## One\n\ntext\n')
    fs.writeFileSync(path.join(vault, 'Spec.pdf'), tinyPdf(), 'latin1')
    const dir = path.join(home, 'spaces', RECIPE.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'space.json'), JSON.stringify(RECIPE))
  } })
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1512, height: 950 })
    await enterSpace(win, 'tangu')
    const row = win.locator('.t2s-srow[data-sel-id="fx-p1"]').first()
    await row.waitFor({ timeout: 20000 }); await row.click(); await sleep(1200)
    await setRight(win, true)
    let r = await rightNow(win)
    R.check('1 Tangu 对话:右栏 = 详情 / 文件 / 大纲,前台详情', same(r.tabs, TANGU) && r.front === 'tangu-details', JSON.stringify(r))

    await link(win, 'forsion://note/Alpha.md'); await sleep(2200)
    r = await rightNow(win)
    const m2 = await mainFront(win)
    R.check('2 开笔记:右栏 = 对话面板 / 大纲 / 反链 / 关系图,前台对话面板', same(r.tabs, NOTE) && r.front === 'chat-panel', JSON.stringify(r))
    R.check('2 主区前台仍是笔记', m2 === 'amadeus-editor', String(m2))
    await win.screenshot({ path: path.join(SHOTS, '2-tangu-note.png') })

    await link(win, 'forsion://open?view=amadeus-pdf&pdfPath=Spec.pdf'); await sleep(2200) // 主区就地换成 PDF
    r = await rightNow(win)
    R.check('3 笔记换成 PDF:右栏只剩对话面板', same(r.tabs, ['chat-panel']) && r.front === 'chat-panel', `${JSON.stringify(r)} main=${await mainFront(win)}`)

    await win.locator('.dv-tab').filter({ has: win.locator('.wb-tab[data-view-type="chat"]') }).first().click(); await sleep(1200)
    r = await rightNow(win)
    R.check('4 回到对话:右栏换回 详情 / 文件 / 大纲,前台详情', same(r.tabs, TANGU) && r.front === 'tangu-details', JSON.stringify(r))

    await setRight(win, false)
    await win.locator('.dv-tab').filter({ has: win.locator('.wb-tab[data-view-type="amadeus-pdf"]') }).first().click(); await sleep(1200)
    r = await rightNow(win)
    R.check('5 收着时切到 PDF:右栏照旧收着', !r.open && r.tabs.length === 0, JSON.stringify(r))
    await setRight(win, true)
    r = await rightNow(win)
    R.check('5 展开看到 PDF 那组', same(r.tabs, ['chat-panel']) && r.front === 'chat-panel', JSON.stringify(r))

    // 6 用户把规则带进来的对话面板关掉 → 重载:同组不再对账,不被补回来。负对照:删掉存档里记的组再重载,它就被补回来了
    const reload = async () => { await sleep(1500); await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await sleep(3000) }
    await win.locator('.dv-tab').filter({ has: win.locator('.wb-tab[data-view-type="chat-panel"]') }).first().click({ button: 'right' })
    await win.locator('.ctx-menu button').filter({ hasText: '关闭' }).first().click(); await sleep(800)
    R.check('6 关掉对话面板', (await rightNow(win)).tabs.length === 0, JSON.stringify(await rightNow(win)))
    await reload()
    r = await rightNow(win)
    R.check('6 重载:关掉的没被补回来', r.tabs.length === 0 && (await mainFront(win)) === 'amadeus-pdf', `${JSON.stringify(r)} main=${await mainFront(win)}`)
    const stripped = await win.evaluate(() => { // 键带账号作用域后缀(tangu2_layout_v4:account:…),逐个剥
      let n = 0
      for (const k of Object.keys(localStorage).filter((x) => x.startsWith('tangu2_layout_v4'))) {
        const b = JSON.parse(localStorage.getItem(k))
        if (!b?.sidebars?.right || !('rule' in b.sidebars.right)) continue
        delete b.sidebars.right.rule
        localStorage.setItem(k, JSON.stringify(b))
        n++
      }
      return n > 0
    })
    const rules = () => win.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tangu2_')).map((k) => {
      try { const b = JSON.parse(localStorage.getItem(k)); return `${k.split(':')[0]}=${b?.sidebars ? b.sidebars.right.rule : Object.entries(b || {}).map(([n, v]) => `${n}:${v?.sidebars?.right?.rule}`).join(',')}` } catch { return k }
    }).join(' '))
    const before = await rules()
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await sleep(3000)
    r = await rightNow(win)
    const all = await win.evaluate(() => [...document.querySelectorAll('.wb-tab[data-view-type]')].map((t) => t.getAttribute('data-view-type')).join(','))
    R.check('6 负对照:存档里没记组 → 重载后按规则补回', stripped && same(r.tabs, ['chat-panel']), `stripped=${stripped} ${JSON.stringify(r)} main=${await mainFront(win)} | before: ${before} | after: ${await rules()} | all: ${all}`)

    await enterSpace(win, 'amadeus'); await sleep(1200)
    await link(win, 'forsion://note/Alpha.md'); await sleep(2000)
    await setRight(win, true)
    r = await rightNow(win)
    R.check('7 笔记 Space 笔记:右栏 = 对话面板 / 大纲 / 反链 / 关系图', same(r.tabs, NOTE), JSON.stringify(r))
    await link(win, 'forsion://open?view=chat'); await sleep(2200)
    r = await rightNow(win)
    R.check('7 主区换成对话:右栏 = 详情 / 文件 / 大纲,没有对话面板', same(r.tabs, TANGU) && r.front === 'tangu-details', `${JSON.stringify(r)} main=${await mainFront(win)}`)
    await win.screenshot({ path: path.join(SHOTS, '7-amadeus-chat.png') })

    const entered = await enterSpace(win, RECIPE.id); await sleep(1500)
    await setRight(win, true)
    r = await rightNow(win)
    R.check('8 配方右栏写的 chat → 开成对话面板', entered && same(r.tabs, ['chat-panel', 'outline']), `entered=${entered} ${JSON.stringify(r)}`)
    await win.screenshot({ path: path.join(SHOTS, '8-recipe.png') })
  } finally {
    await ctx.close()
  }
  console.log(`截图:${SHOTS}`)
  process.exitCode = R.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
