/**
 * 文件类标签(插件文件 / 白板 / 多维表 / PDF / 图片)跟随树上的改名 / 删除,真 Electron × 真主进程 × 真磁盘 × 真 dockview。
 * 2026-09-16:仪表盘标签修完(e2e:pathgone)后查出另外几家同病 —— 树上改名、挪走、删除之后标签还攥着旧路径,
 * 重开 / 重启就指向一个不存在的文件;pageStore 的 onNotePathGone 广播只有编辑器与仪表盘在听。
 * 单测(fileViews.pathgone.test.ts)桩掉了工作区句柄,真 dockview 的 leafById / 布局落盘只有这里验得到。
 *
 *   P0 夹具:资料/ 下五类文件各开一个标签(插件文件用自生成的探针插件 .probe.md)
 *   P1 树上改多维表名(renameDb):标签跟到新名,且不把它抢到前台(旧实现逐个 navigateLeaf:清参数 + setActive)
 *   P2 树上改文件夹名(prefix 广播):五个标签的参数全部跟到新文件夹,插件视图按新路径重挂,图片 src 换新
 *   P3 树上删 PDF:PDF 标签关掉,其余不动,文件没被建回来
 *   P4 树上删整个文件夹:剩下的标签全部关掉(主区最后一个经 closeLeaf 就地变 home 占位,不被拆空),文件夹没被建回来
 *   媒体(amadeus-media)树上点不开(交系统播放器),只有单测覆盖。
 *
 * 用法:npm run build && npm run e2e:pathgonefiles   (--shot 存截图到 /tmp/forsion-pathgone-files-*.png)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 探针插件:把插件文件视图收到的 filePath 写进 DOM —— 视图有没有按新路径重挂,一眼可断言。 */
const PROBE_MAIN = `
ctx.registerFileType({
  id: 'probe',
  extensions: ['.probe.md'],
  title: 'Probe',
  mount: function (el, file) {
    var d = document.createElement('div')
    d.className = 'pathprobe-view'
    d.setAttribute('data-file', file.filePath)
    d.textContent = file.filePath
    el.appendChild(d)
    return function () { d.remove() }
  },
})
`
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const DRAWING = [
  '---', '', 'excalidraw-plugin: parsed', 'tags: [excalidraw]', '', '---', '', '',
  '## Drawing', '```json',
  '{"type":"excalidraw","version":2,"source":"Forsion Amadeus","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"}}',
  '```', '%%',
].join('\n')
const DB = { version: 1, name: '表', columns: [{ id: 'c1', name: '标题', type: 'text' }], rows: [{ id: 'r1', cells: {} }] }

/** 五个标签:标题(视图 setTitle 的结果)/ 参数键 / 相对 资料/ 的文件名 / 树上行标题。 */
const TABS = [
  { title: '导图', key: 'filePath', file: '导图.probe.md', row: '导图' },
  { title: '板', key: 'drawingPath', file: '板.excalidraw.md', row: '板.excalidraw' },
  { title: '表', key: 'dbPath', file: '表.db', row: '表.db' },
  { title: '书.pdf', key: 'pdfPath', file: '书.pdf', row: '书.pdf' },
  { title: '图.png', key: 'imagePath', file: '图.png', row: '图.png' },
]

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js')) || !fs.existsSync(path.join(ROOT, 'out/renderer'))) {
    console.error('缺 out/main/main.js 或 out/renderer —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pathgone-files-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  const dir = path.join(vault, '资料')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(vault, '1.md'), '# 1\n', 'utf8')
  fs.writeFileSync(path.join(dir, '导图.probe.md'), '# 探针\n', 'utf8')
  fs.writeFileSync(path.join(dir, '板.excalidraw.md'), DRAWING, 'utf8')
  fs.writeFileSync(path.join(dir, '表.db'), `${JSON.stringify(DB, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, '书.pdf'), tinyPdf(['PATHGONE']))
  fs.writeFileSync(path.join(dir, '图.png'), PNG_1PX)
  const probeDir = path.join(home, 'plugins', 'pathprobe')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, 'main.js'), PROBE_MAIN)
  fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({
    id: 'pathprobe', name: 'Path Probe', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'e2e 用的路径探针,不是产品插件', fileExtensions: ['.probe.md'],
  }, null, 2))
  // ⚠️ 四份配置全种:未打包时 userData 是 `<dir>-dev`,只种一份会打开本机真 dev 库(sidebar-drop 同款)。
  for (const d of [userData, `${userData}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
      fs.writeFileSync(path.join(d, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2), 'utf8')
    }
  }

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
    const win = await app.firstWindow()
    const logs = []
    win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    const shot = async (name) => { if (SHOT) await win.screenshot({ path: `/tmp/forsion-pathgone-files-${name}.png` }).catch(() => {}) }
    const until = async (fn, ms = 10_000) => {
      const end = Date.now() + ms
      let v = await fn().catch(() => null)
      while (!v && Date.now() < end) { await win.waitForTimeout(250); v = await fn().catch(() => null) }
      return v
    }

    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('.rb-space[title="Note"], .rb-space:has-text("Note")').first().click({ timeout: 15_000 })

    const row = (title) => win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${esc(title)}$`) }) }).first()
    const folder = (name) => win.locator('.t2s-group', { has: win.locator('.t2s-group-label', { hasText: new RegExp(`^${esc(name)}$`) }) }).first()
    const expand = async (name, childTitle) => {
      await folder(name).waitFor({ timeout: 15_000 })
      if (!(await row(childTitle).isVisible().catch(() => false))) await folder(name).locator('.t2s-folder-row').click()
      await row(childTitle).waitFor({ timeout: 10_000 })
    }
    const menu = async (target, label) => {
      await target.click({ button: 'right' })
      await win.locator('.ctx-menu button', { hasText: label }).first().click()
    }
    const tabTitles = () => win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((e) => (e.textContent || '').trim()))
    const activeTitles = () => win.evaluate(() => [...document.querySelectorAll('.dv-tab.dv-active-tab')].map((e) => (e.textContent || '').trim()))
    /** 落盘布局里各面板的参数 —— 重启后标签按它还原,是「标签指向哪」的真源。 */
    const panelParams = () => win.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('tangu2_layout_v4'))
      const v = k ? JSON.parse(localStorage.getItem(k) || 'null') : null
      return Object.values((v && v.dockview && v.dockview.panels) || {}).map((p) => p.params || {})
    })
    const paramOf = async (key) => (await panelParams()).filter((p) => typeof p[key] === 'string').map((p) => p[key])
    const mainTypes = async () => (await panelParams()).filter((p) => (p.__loc || 'main') === 'main').map((p) => p.__type)
    const tabOpen = async (t) => (await tabTitles()).some((x) => x === t)

    // ── P0 夹具:五类文件各开一个标签 ──────────────────────────────────────
    await expand('资料', '图.png')
    // 插件注册文件类型之前,.probe.md 行会被当笔记开(= 进 compiler)—— 等行标题剥成插件基名再点。
    await row('导图').waitFor({ timeout: 20_000 })
    for (const [i, t] of TABS.entries()) {
      // 第一个就地替换主区缺省标签,其余 ⌘ 点新开 —— 主区只剩这五个,P4 删光时才走得到「关掉最后一个主标签」
      await row(t.row).click(i === 0 ? undefined : { modifiers: ['Meta'] })
      await until(() => tabOpen(t.title))
    }
    await win.waitForTimeout(1500)
    const t0 = await tabTitles()
    const opened0 = await until(async () => {
      for (const t of TABS) if ((await paramOf(t.key)).join() !== `资料/${t.file}`) return false
      return (await mainTypes()).length === TABS.length
    })
    check('P0 五类文件各开一个标签(主区只有这五个),布局里各攥着 资料/ 下的路径', TABS.every((t) => t0.includes(t.title)) && opened0,
      `${JSON.stringify(t0)} main=${JSON.stringify(await mainTypes())}`)
    await shot('p0-open')

    // ── P1 树上改多维表名(renameDb),图片标签在前台 ─────────────────────────
    await win.locator('.dv-tab', { hasText: /^图\.png$/ }).first().click()
    await win.waitForTimeout(500)
    await menu(row('表.db'), '重命名')
    const rename = win.locator('.t2s-rename')
    await rename.fill('表改')
    await rename.press('Enter')
    await until(async () => fs.existsSync(path.join(dir, '表改.db')))
    check('P1a 磁盘上多维表已改名', fs.existsSync(path.join(dir, '表改.db')) && !fs.existsSync(path.join(dir, '表.db')))
    const dbFollowed = await until(async () => (await paramOf('dbPath')).join() === '资料/表改.db')
    check('P1b 多维表标签的参数跟到新名', dbFollowed, JSON.stringify(await paramOf('dbPath')))
    check('P1c 标签标题换成新名', await until(() => tabOpen('表改')), JSON.stringify(await tabTitles()))
    const act1 = await activeTitles()
    check('P1d 改名不把多维表标签抢到前台(图片标签仍在前台)', act1.includes('图.png') && !act1.includes('表改'), JSON.stringify(act1))
    TABS.find((t) => t.key === 'dbPath').file = '表改.db'
    TABS.find((t) => t.key === 'dbPath').title = '表改'

    // ── P2 树上改文件夹名(prefix 广播)─────────────────────────────────────
    await menu(folder('资料'), '重命名')
    const nameInput = win.locator('.dialog input').last()
    await nameInput.fill('资料改')
    await nameInput.press('Enter')
    await until(async () => fs.existsSync(path.join(vault, '资料改', '书.pdf')))
    check('P2a 磁盘上文件夹已改名', fs.existsSync(path.join(vault, '资料改', '书.pdf')) && !fs.existsSync(dir))
    const followed = await until(async () => {
      for (const t of TABS) if ((await paramOf(t.key)).join() !== `资料改/${t.file}`) return false
      return true
    })
    const snap2 = JSON.stringify(Object.fromEntries(await Promise.all(TABS.map(async (t) => [t.key, await paramOf(t.key)]))))
    check('P2b 五个标签的参数全部跟到 资料改/(重启后不再指向不存在的路径)', followed, snap2)
    const t2 = await tabTitles()
    check('P2c 没有标签被关掉或多开', t2.length === t0.length && TABS.every((t) => t2.includes(t.title)), JSON.stringify(t2))
    await win.locator('.dv-tab', { hasText: /^导图$/ }).first().click()
    const probe = await until(() => win.evaluate(() => document.querySelector('.pathprobe-view')?.getAttribute('data-file') === '资料改/导图.probe.md'))
    check('P2d 插件文件视图按新路径重挂(插件收到的 filePath 是新的)', probe,
      await win.evaluate(() => [...document.querySelectorAll('.pathprobe-view')].map((e) => e.getAttribute('data-file')).join(',')))
    await win.locator('.dv-tab', { hasText: /^图\.png$/ }).first().click()
    const imgOk = await until(() => win.evaluate(() => decodeURIComponent(document.querySelector('img.amx-imgview-img')?.getAttribute('src') || '').includes('资料改/图.png')))
    check('P2e 图片视图的 src 换到新路径', imgOk, await win.evaluate(() => document.querySelector('img.amx-imgview-img')?.getAttribute('src') || '(无 img)'))
    await shot('p2-folder-renamed')

    // ── P3 树上删 PDF ─────────────────────────────────────────────────────
    await expand('资料改', '书.pdf')
    await menu(row('书.pdf'), '删除')
    const pdfClosed = await until(async () => !(await tabOpen('书.pdf')) && (await paramOf('pdfPath')).length === 0)
    check('P3a PDF 标签关掉(布局里也没有了)', pdfClosed, JSON.stringify(await tabTitles()))
    const rest3 = await tabTitles()
    check('P3b 其余标签不动', ['导图', '板', '表改', '图.png'].every((x) => rest3.includes(x)), JSON.stringify(rest3))
    await win.waitForTimeout(3000)
    check('P3c PDF 没被建回来', !fs.existsSync(path.join(vault, '资料改', '书.pdf')))
    await shot('p3-pdf-deleted')

    // ── P4 树上删整个文件夹 ──────────────────────────────────────────────
    await menu(folder('资料改'), '删除')
    const allClosed = await until(async () => {
      const titles = await tabTitles()
      if (['导图', '板', '表改', '图.png'].some((x) => titles.includes(x))) return false
      for (const t of TABS) if ((await paramOf(t.key)).length) return false
      return true
    })
    check('P4a 文件夹里剩下的标签全部关掉(布局里也没有了)', allClosed, JSON.stringify(await tabTitles()))
    // 关的是主区最后几个标签:须走 store 的 closeLeaf 收尾(最后一个就地变 home 占位),裸 panel.api.close() 会把主区组整个拆掉
    const main4 = await until(async () => (await mainTypes()).join() === 'home')
    check('P4d 主区最后一个标签被关后就地留下 home 占位(没有被拆空)', main4, `main=${JSON.stringify(await mainTypes())}`)
    await win.waitForTimeout(3000)
    check('P4b 文件夹与文件没被建回来', !fs.existsSync(path.join(vault, '资料改')))
    const sk = await win.evaluate(() => [...document.querySelectorAll('.sk')].filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.t2s-side')).length)
    check('P4c 主区没有卡住的骨架屏', sk === 0, `skeletons=${sk}`)
    await shot('p4-folder-deleted')

    if (logs.length) console.log('LOGS\n' + logs.slice(0, 10).join('\n'))
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
