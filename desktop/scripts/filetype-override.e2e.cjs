/**
 * 插件覆盖内置文件类型(2026-10-05:内置阅读器是兜底,插件可以覆盖;目前只放开 `.pdf`),
 * 真 Electron × 真主进程 × 真磁盘 × 真文件树 × 从磁盘装的探针插件。
 * 单测(fileTypeOverride.test.ts)钉的是注册 / 查表 / 页表面三条规则;「树上点一下进谁的视图」「右键菜单」
 * 「插件一停标签页怎么办」「插件真能读到 PDF 字节」只有这里验得到。
 *
 *   T1  探针以 override: true 认领 .pdf → 注册成功
 *   T2  树上点 PDF → 进插件视图(不是内置阅读器);插件经 ctx.app.readBytes 读到整份文件
 *   T2c / T2d 毁档防线:插件对 PDF 调 file.surface.loadPage / ctx.app.loadPage 都被拒(没把它装成当前页),T2e 磁盘上的 PDF 一个字节没动
 *   T3  右键菜单:「打开」+「用内置阅读器打开」;点后者进内置阅读器
 *   T4  再点树 → 仍归插件
 *   T5  停用插件:留下的标签页给出「用内置阅读器打开」,点了**就地**换成内置阅读器(不多开标签)
 *   T6  停用期间:树上点 PDF 进内置阅读器,右键菜单回到原样
 *   T7  重新启用 → 树上点 PDF 又归插件
 *
 * 负对照(2026-10-05 实跑):`--nc=nooverride` 探针不写 override: true → T1 / T2 / T2a / T2b / T2c / T2d / T3 / T4 / T5a / T7 红
 *   (宿主照旧拒掉它,PDF 全程归内置阅读器,探针视图没挂所以 T2* 也读不到)。
 *   宿主侧负对照(同日实跑,临时改源码重建):去掉页表面那道 isPagePipelinePath → T2c 红(PDF 真被装成了当前页)。
 *   T2d 认的是宿主的拒绝告警;ctx.app.loadPage 那道闸本身的负对照在 fileTypeOverride.test.ts。
 * 用法:npm run build && npm run e2e:ftoverride   (--shot 存截图到 /tmp/forsion-ftoverride-*.png)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 探针插件:把收到的 filePath、读到的字节数写进 DOM;挂载时故意对 PDF 调一次 loadPage(必须被拒)。 */
const PROBE_MAIN = `
var st = (window.__pdfprobe = window.__pdfprobe || { mounts: 0 })
st.registered = ctx.registerFileType({
  id: 'pdfprobe',
  extensions: ['.pdf'],
  override: true,
  title: 'PDF Probe',
  mount: function (el, file) {
    st.mounts++
    var d = document.createElement('div')
    d.className = 'pdfprobe-view'
    d.setAttribute('data-file', file.filePath)
    d.textContent = 'pdfprobe: ' + file.filePath
    el.appendChild(d)
    // 两个页加载入口各捅一次:都必须被拒(放行 = PDF 进笔记管线,一编辑保存就成 markdown)。
    try { if (file.surface && file.surface.loadPage) file.surface.loadPage(file.filePath) } catch (e) { st.loadPageThrew = String(e) }
    try { ctx.app.loadPage(file.filePath) } catch (e) { st.appLoadPageThrew = String(e) }
    setTimeout(function () {
      d.setAttribute('data-surface-page', String((file.surface && file.surface.getActivePage && file.surface.getActivePage()) || ''))
      d.setAttribute('data-app-page', String(ctx.app.getActivePage() || ''))
      d.setAttribute('data-probed', '1')
    }, 1500)
    Promise.resolve(ctx.app.readBytes ? ctx.app.readBytes(file.filePath) : null).then(function (b) {
      d.setAttribute('data-bytes', b ? String(b.length) : '-1')
      d.setAttribute('data-head', b ? String.fromCharCode(b[0], b[1], b[2], b[3]) : '')
    })
    return function () { d.remove() }
  },
})
`

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PDF_REL = '资料/书.pdf'

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js')) || !fs.existsSync(path.join(ROOT, 'out/renderer'))) {
    console.error('缺 out/main/main.js 或 out/renderer —— 先跑 npm run build')
    process.exit(1)
  }
  if (NC) console.log(`⚠️ 负对照模式 --nc=${NC}:期望相关断言变红\n`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ftoverride-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  const dir = path.join(vault, '资料')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(vault, '1.md'), '# 1\n', 'utf8')
  const pdfBytes = Buffer.from(tinyPdf(['OVERRIDE']))
  const pdfAbs = path.join(dir, '书.pdf')
  fs.writeFileSync(pdfAbs, pdfBytes)
  const probeDir = path.join(home, 'plugins', 'pdfprobe')
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, 'main.js'), NC === 'nooverride' ? PROBE_MAIN.replace('override: true,', '') : PROBE_MAIN)
  // 清单刻意不写 fileExtensions:那个字段只保护 .md 类文件不被当笔记改写,PDF 用不着。
  fs.writeFileSync(path.join(probeDir, 'manifest.json'), JSON.stringify({
    id: 'pdfprobe', name: 'PDF Probe', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'e2e 用的 PDF 覆盖探针,不是产品插件',
  }, null, 2))
  // ⚠️ 四份配置全种:未打包时 userData 是 `<dir>-dev`,只种一份会打开本机真 dev 库。
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
    const warns = []
    win.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()) })
    const shot = async (name) => { if (SHOT) await win.screenshot({ path: `/tmp/forsion-ftoverride-${name}.png` }).catch(() => {}) }
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
    await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click({ timeout: 15_000 })

    const row = (title) => win.locator('.t2s-srow', { has: win.locator('.t2s-srow-title', { hasText: new RegExp(`^${esc(title)}$`) }) }).first()
    const folder = (name) => win.locator('.t2s-group', { has: win.locator('.t2s-group-label', { hasText: new RegExp(`^${esc(name)}$`) }) }).first()
    const openMenu = async () => {
      await row('书.pdf').click({ button: 'right' })
      await win.locator('.ctx-menu').first().waitFor({ timeout: 5000 })
      return win.evaluate(() => [...document.querySelectorAll('.ctx-menu button')].map((b) => (b.textContent || '').trim()))
    }
    const closeMenu = async () => { await win.keyboard.press('Escape'); await win.mouse.click(5, 5).catch(() => {}); await win.waitForTimeout(200) }
    /** 落盘布局里主区各面板的 { 类型, 攥着的路径 }。 */
    const mainPanels = () => win.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('tangu2_layout_v4'))
      const v = k ? JSON.parse(localStorage.getItem(k) || 'null') : null
      return Object.values((v && v.dockview && v.dockview.panels) || {}).map((p) => p.params || {})
        .filter((p) => (p.__loc || 'main') === 'main')
        .map((p) => ({ type: p.__type, path: p.filePath || p.pdfPath || '' }))
    })
    const typesFor = async () => (await mainPanels()).filter((p) => p.path === PDF_REL).map((p) => p.type).sort().join(',')
    const probeFile = () => win.evaluate(() => document.querySelector('.pdfprobe-view')?.getAttribute('data-file') || '')
    /** 模拟「别的窗口拨了插件开关」:写偏好 + 发 storage 事件,主窗走 syncDisabledPreferences 对账(真路径)。 */
    const setDisabled = (ids) => win.evaluate((list) => {
      localStorage.setItem('amadeus.plugins.disabled', JSON.stringify(list))
      window.dispatchEvent(new StorageEvent('storage', { key: 'amadeus.plugins.disabled' }))
    }, ids)

    await folder('资料').waitFor({ timeout: 15_000 })
    if (!(await row('书.pdf').isVisible().catch(() => false))) await folder('资料').locator('.t2s-folder-row').click()
    await row('书.pdf').waitFor({ timeout: 10_000 })

    // ── T1 注册 ──────────────────────────────────────────────────────────────────
    const reg = await until(() => win.evaluate(() => (window.__pdfprobe ? String(window.__pdfprobe.registered) : '')), 15_000)
    check('T1 探针以 override: true 认领 .pdf → registerFileType 返回 true', reg === 'true', `registered=${reg}`)

    // ── T2 树上点 PDF → 插件视图 ────────────────────────────────────────────────
    await row('书.pdf').click()
    const f2 = await until(async () => (await probeFile()) === PDF_REL)
    check('T2 树上点 PDF → 进插件视图', f2, `data-file=${await probeFile()}`)
    const t2 = await until(async () => (await typesFor()) === 'amadeus-plugin-file')
    check('T2a 开出来的是插件文件标签,没有另开内置阅读器', t2, await typesFor())
    const bytes = await until(() => win.evaluate(() => {
      const d = document.querySelector('.pdfprobe-view')
      return d && d.getAttribute('data-bytes') ? `${d.getAttribute('data-bytes')}|${d.getAttribute('data-head')}` : ''
    }))
    check('T2b 插件经 ctx.app.readBytes 读到整份 PDF', bytes === `${pdfBytes.length}|%PDF`, `got=${bytes} want=${pdfBytes.length}|%PDF`)
    // 「文件没变」证明不了被拒(加载本身是只读的,Codex 评审 P2)—— 直接看两个入口有没有把 PDF 装成当前页。
    const probed = await until(() => win.evaluate(() => {
      const d = document.querySelector('.pdfprobe-view')
      return d && d.getAttribute('data-probed') ? JSON.stringify({ surface: d.getAttribute('data-surface-page'), app: d.getAttribute('data-app-page') }) : ''
    }))
    const pages = probed ? JSON.parse(probed) : { surface: '?', app: '?' }
    check('T2c 毁档防线:页表面 loadPage 对 PDF 被拒(没有把它装成当前页)', !!probed && pages.surface !== PDF_REL, `surface.getActivePage()=${JSON.stringify(pages.surface)}`)
    // ctx.app.getActivePage() 只报笔记,PDF 就算被装进去也读不出来(宿主侧负对照实测)—— 认宿主的拒绝告警。
    const refused = warns.some((w) => w.includes('[plugin:pdfprobe] ctx.app.loadPage(') && w.includes('被拒'))
    check('T2d 毁档防线:ctx.app.loadPage 对 PDF 被拒(宿主打了拒绝告警)', !!probed && refused && pages.app !== PDF_REL, refused ? '' : `没见到拒绝告警;warns=${warns.length}`)
    const after = fs.readFileSync(pdfAbs)
    check('T2e 磁盘上的 PDF 一个字节没动', Buffer.compare(after, pdfBytes) === 0, `size ${pdfBytes.length} → ${after.length}`)
    await shot('1-plugin-view')

    // ── T3 右键菜单 ─────────────────────────────────────────────────────────────
    const m3 = await openMenu()
    await win.mouse.move(700, 600) // 挪开指针,别让树行的悬停提示盖在菜单上
    await win.waitForTimeout(400)  // 等菜单淡入完再拍
    await shot('2-menu-overridden')
    check('T3 右键菜单:「打开」+「用内置阅读器打开」', m3.includes('打开') && m3.includes('用内置阅读器打开') && !m3.includes('打开（可批注）'), m3.join(' / '))
    await win.locator('.ctx-menu button', { hasText: '用内置阅读器打开' }).first().click().catch(() => {})
    const t3 = await until(async () => (await typesFor()).includes('amadeus-pdf'))
    check('T3a 点「用内置阅读器打开」→ 进内置阅读器', t3, await typesFor())
    await closeMenu()

    // ── T4 再点树 → 仍归插件 ────────────────────────────────────────────────────
    await row('书.pdf').click()
    const t4 = await until(async () => (await typesFor()).includes('amadeus-plugin-file') && (await probeFile()) === PDF_REL)
    check('T4 再点树上的 PDF → 仍归插件', t4, await typesFor())

    // ── T5 停用插件:留下的标签页 → 就地回落 ─────────────────────────────────────
    const before = (await mainPanels()).length
    await setDisabled(['pdfprobe'])
    const gone = await until(async () => !(await probeFile()))
    check('T5 停用插件 → 插件视图卸掉', gone)
    const btn = win.locator('.amx-draw-state button', { hasText: '用内置阅读器打开' }).first()
    const hasBtn = await until(() => btn.isVisible())
    await shot('3-fallback-state')
    check('T5a 留下的标签页给出「用内置阅读器打开」', hasBtn)
    if (hasBtn) await btn.click()
    const t5 = await until(async () => (await typesFor()) === 'amadeus-pdf' || (await typesFor()) === 'amadeus-pdf,amadeus-pdf')
    const afterN = (await mainPanels()).length
    check('T5b 点了就地换成内置阅读器(标签数不变,不再有插件文件标签)', t5 && afterN === before, `types=${await typesFor()} panels ${before} → ${afterN}`)
    await shot('4-builtin-reader')

    // ── T6 停用期间 ─────────────────────────────────────────────────────────────
    const m6 = await openMenu()
    check('T6 停用期间右键菜单回到原样', m6.includes('打开（可批注）') && !m6.includes('用内置阅读器打开'), m6.join(' / '))
    await closeMenu()
    await row('书.pdf').click()
    await win.waitForTimeout(800)
    check('T6a 停用期间树上点 PDF → 内置阅读器,没有插件文件标签', !(await typesFor()).includes('amadeus-plugin-file') && !(await probeFile()), await typesFor())

    // ── T7 重新启用 ─────────────────────────────────────────────────────────────
    await setDisabled([])
    await win.waitForTimeout(600)
    await row('书.pdf').click()
    const t7 = await until(async () => (await probeFile()) === PDF_REL && (await typesFor()).includes('amadeus-plugin-file'))
    check('T7 重新启用 → 树上点 PDF 又归插件', t7, await typesFor())

    if (logs.length) console.log(`\n页面异常:\n${logs.join('\n')}`)
    check('全程无页面异常', logs.length === 0, logs[0])
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
