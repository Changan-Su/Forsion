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
 *   T8  文件变了 → 内置阅读器原地重载:插件 writeBytes(阅读器在前台 / 在后台各一次)、外部工具直接改文件;
 *       插件自己的 ctx.app.watchFile 对 .pdf 也收到回调
 *       T8e 多页 PDF 翻到第 8 页再被改写 → 重载后还在第 8 页、滚动位置没动;T8f 重载后 pdf.js 的编辑器没被重新打开
 *   T9  设置 → 插件 → 已安装 →「默认打开方式」:选内置阅读器 → 树上点 PDF 进内置、右键只剩「打开」;
 *       改选插件 → 又归插件(设置在独立浮窗里,偏好经 storage 事件传到主窗 —— 走的是真路径)
 *       T9d 改偏好不卸载已经开着的插件视图(它可能有没存的改动)
 *
 * 负对照(2026-10-05 实跑):`--nc=nooverride` 探针不写 override: true → T1 / T2 / T2a / T2b / T2c / T2d / T3 / T4 / T5a / T7 红
 *   (宿主照旧拒掉它,PDF 全程归内置阅读器,探针视图没挂所以 T2* 也读不到)。
 *   宿主侧负对照(同日实跑,临时改源码重建):去掉页表面那道 isPagePipelinePath → T2c 红(PDF 真被装成了当前页)。
 *   T2d 认的是宿主的拒绝告警;ctx.app.loadPage 那道闸本身的负对照在 fileTypeOverride.test.ts。
 *   T8 的宿主侧负对照(同日实跑,临时改源码重建):watcher.ts 去掉「PDF 只报变了」那个分支 → T8a / T8b / T8c / T8d 红;
 *   去掉 ResizeObserver 里「回前台补上欠着的重载」→ 只有 T8c 红。
 *   T8e / T8f / T9d 是 Codex 评审指出问题后先写的断言:在修之前的构建上实跑三条都红(滚动 6587 → 10、
 *   编辑层 0 → 2、插件视图被卸掉),修完重建后转绿 —— 那次红就是它们的负对照。
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
// 台架借探针的手写盘 / 监听(插件接管 PDF 后真会这么干):writeBytes 改写文件,watchFile 数回调。
st.write = function (rel, arr) { return ctx.app.writeBytes(rel, new Uint8Array(arr)) }
st.registered = ctx.registerFileType({
  id: 'pdfprobe',
  extensions: ['.pdf'],
  override: true,
  title: 'PDF Probe',
  mount: function (el, file) {
    st.mounts++
    if (ctx.app.watchFile && !st.watching) {
      st.watching = true
      ctx.app.watchFile(file.filePath, function () { st.watchHits = (st.watchHits || 0) + 1 })
    }
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

/** 进设置 → 插件 → 已安装插件。设置画在独立浮窗里:开窗前先 arm window 事件,返回那个窗口的 page。
 *  (照抄 plugin-seams.e2e.cjs 的 openPluginsTab。) */
async function openPluginsTab(app, win) {
  const opened = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
  await win.keyboard.press('Meta+Comma')
  let sp = await opened
  if (!sp) {
    const retry = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
    await win.locator('#rb-settings, [data-ribbon-id="rb-settings"]').first().click({ timeout: 4000 }).catch(() => {})
    sp = await retry
  }
  if (!sp) throw new Error('设置浮窗没开出来')
  await sp.waitForLoadState('domcontentloaded').catch(() => {})
  await sp.waitForSelector('.settings-main', { timeout: 20000 }).catch(() => {})
  const nav = sp.locator('.settings-nav')
  for (const label of ['插件', 'Plugins']) {
    const b = nav.getByRole('button', { name: label, exact: true }).first()
    if (await b.count().catch(() => 0)) {
      await b.scrollIntoViewIfNeeded().catch(() => {})
      await b.click().catch(() => {})
      break
    }
  }
  await sp.locator('.settings-sub--amadeus-plugins').first().waitFor({ timeout: 5000 }).catch(() => {})
  await sp.locator('.settings-nav-subitem', { hasText: /^(已安装插件|Installed plugins)$/ }).first().click().catch(() => {})
  await sp.waitForTimeout(900)
  return sp
}
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
  // 多页夹具:重载后「还在原来那页」只有多页才分辨得出(单页永远在第 1 页)。
  const longAbs = path.join(dir, '长.pdf')
  const longPdf = (tag) => Buffer.from(tinyPdf(Array.from({ length: 12 }, (_, i) => `${tag}${i + 1}`)))
  fs.writeFileSync(longAbs, longPdf('L'))
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
    /** 内置阅读器文本层里的字(tinyPdf 每页一行大字);几个内置标签页开着同一份就拼在一起。 */
    const readerText = () => win.evaluate(() => [...document.querySelectorAll('.amx-pdfview .textLayer')].map((l) => l.textContent || '').join('|'))
    const sees = (word, ms = 12_000) => until(async () => (await readerText()).includes(word), ms)
    const probeWrite = (line) => win.evaluate(([rel, arr]) => window.__pdfprobe?.write?.(rel, arr), [PDF_REL, [...Buffer.from(tinyPdf([line]))]]).catch(() => {})
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

    // ── T8 文件变了 → 内置阅读器原地重载(此刻内置阅读器在前台)──────────────────────
    check('T8 内置阅读器显示的是原文件', await sees('OVERRIDE'), await readerText())
    await probeWrite('RELOADED')
    check('T8a 插件 writeBytes 之后,开着的内置阅读器换成新内容', await sees('RELOADED'), await readerText())
    const hits = await until(() => win.evaluate(() => window.__pdfprobe?.watchHits || 0), 5000)
    check('T8b 同一次写,插件自己的 ctx.app.watchFile 对 .pdf 也收到回调', hits > 0, `watchHits=${hits}`)
    await shot('5-reader-reloaded')
    // 内置标签页在后台时写盘:另开一个笔记标签把它压到后面,写完再切回来,必须是新内容。
    // (树上单击会就地换掉当前标签,所以用 ⌘ 点击另开;不这样做的话「后台」那一刻内置标签页根本不存在。)
    await row('1').click({ modifiers: ['Meta'] })
    const hidden = await until(async () => !(await win.locator('.amx-pdfview').first().isVisible().catch(() => false)) && (await typesFor()).includes('amadeus-pdf'))
    check('T8c0 前置:内置标签页还开着,但已经在后台', hidden, await typesFor())
    await probeWrite('HIDDEN')
    await win.waitForTimeout(1500)
    await win.locator('.dv-tab', { hasText: /^书\.pdf$/ }).first().click()
    check('T8c 内置阅读器在后台时文件被改 → 切回前台是新内容', await sees('HIDDEN'), await readerText())

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
    check('T6 停用期间右键菜单只剩「打开」', m6.includes('打开') && !m6.includes('用内置阅读器打开') && !m6.includes('打开（可批注）'), m6.join(' / '))
    await closeMenu()
    await row('书.pdf').click()
    await win.waitForTimeout(800)
    check('T6a 停用期间树上点 PDF → 内置阅读器,没有插件文件标签', !(await typesFor()).includes('amadeus-plugin-file') && !(await probeFile()), await typesFor())
    // 外部工具直接改文件(不经应用的写通道):同样跟上
    fs.writeFileSync(pdfAbs, Buffer.from(tinyPdf(['EXTERNAL'])))
    check('T8d 外部工具改了文件 → 开着的内置阅读器换成新内容', await sees('EXTERNAL'), await readerText())

    // 多页:翻到第 8 页、再挪开一点(不停在页边界上),文件被改写后必须还在原地。
    await row('长.pdf').click()
    await until(async () => ((await win.locator('.amx-pdfview .pdfa-pagetotal').first().textContent().catch(() => '')) || '').includes('12'), 15_000)
    const pageInput = win.locator('.amx-pdfview .pdfa-pageinput').first()
    await pageInput.fill('8')
    await pageInput.press('Enter')
    await until(async () => (await win.locator('.amx-pdfview .pdfa-pageinput').first().inputValue().catch(() => '')) === '8')
    const scrollTop = () => win.evaluate(() => document.querySelector('.amx-pdfview .pdfa-container')?.scrollTop ?? -1)
    await win.evaluate(() => { const c = document.querySelector('.amx-pdfview .pdfa-container'); if (c) c.scrollTop += 137 })
    await sees('L8')
    await win.waitForTimeout(600)
    const top0 = await scrollTop()
    const editorLayers = () => win.evaluate(() => document.querySelectorAll('.amx-pdfview .annotationEditorLayer').length)
    const layers0 = await editorLayers()
    fs.writeFileSync(longAbs, longPdf('M'))
    const sawM = await sees('M8')
    await win.waitForTimeout(1500) // 等 pagesloaded 之后的补算与快照层撤掉
    const top1 = await scrollTop()
    const page1 = await win.locator('.amx-pdfview .pdfa-pageinput').first().inputValue().catch(() => '')
    check('T8e 多页 PDF 在第 8 页被改写 → 重载后还在第 8 页、滚动位置没动', sawM && page1 === '8' && top0 > 500 && Math.abs(top1 - top0) < 4,
      `看到新内容=${!!sawM} 页码=${page1} scrollTop ${top0} → ${top1}`)
    const layers1 = await editorLayers()
    check('T8f 重载后 pdf.js 的编辑器没被重新打开(没有编辑层)', layers0 === 0 && layers1 === 0, `编辑层 重载前=${layers0} 重载后=${layers1}`)

    // ── T7 重新启用 ─────────────────────────────────────────────────────────────
    await setDisabled([])
    await win.waitForTimeout(600)
    await row('书.pdf').click()
    const t7 = await until(async () => (await probeFile()) === PDF_REL && (await typesFor()).includes('amadeus-plugin-file'))
    check('T7 重新启用 → 树上点 PDF 又归插件', t7, await typesFor())

    // ── T9 设置里的「默认打开方式」──────────────────────────────────────────────
    const sp = await openPluginsTab(app, win)
    const sel = sp.locator('select[data-file-opener=".pdf"]').first()
    const opts = await until(async () => ((await sel.count()) ? sel.evaluate((el) => [...el.options].map((o) => `${o.value}=${(o.textContent || '').trim()}`)) : null), 15_000)
    check('T9 设置里有「默认打开方式」,候选 = 自动 / 内置阅读器 / 接管 .pdf 的插件',
      !!opts && opts.join(',') === '=自动,builtin=内置阅读器,pdfprobe=PDF Probe', opts ? opts.join(' / ') : '没找到下拉框')
    await sel.scrollIntoViewIfNeeded().catch(() => {})
    if (SHOT) await sp.screenshot({ path: '/tmp/forsion-ftoverride-6-settings-openers.png' }).catch(() => {})
    const frontIs = (want) => until(async () => {
      const builtin = await win.locator('.amx-pdfview').first().isVisible().catch(() => false)
      const plugin = await win.locator('.pdfprobe-view').first().isVisible().catch(() => false)
      return want === 'builtin' ? builtin && !plugin : plugin && !builtin
    })
    const menuOnce = async () => { const m = await openMenu(); await closeMenu(); return m }
    const mounts0 = await win.evaluate(() => window.__pdfprobe?.mounts || 0)
    await sel.selectOption('builtin').catch(() => {})
    const m9 = await until(async () => { const m = await menuOnce(); return m.includes('用内置阅读器打开') ? null : m })
    check('T9a 选「内置阅读器」→ 主窗跟上:右键菜单只剩「打开」', !!m9 && m9.includes('打开'), m9 ? m9.join(' / ') : '菜单里还有「用内置阅读器打开」')
    await win.waitForTimeout(500)
    const mounts1 = await win.evaluate(() => window.__pdfprobe?.mounts || 0)
    check('T9d 改偏好不动已经开着的插件视图(没被卸载,也没重挂)', !!m9 && (await probeFile()) === PDF_REL && mounts1 === mounts0,
      `data-file=${await probeFile()} mounts ${mounts0} → ${mounts1}`)
    await row('书.pdf').click()
    check('T9b 树上点 PDF → 内置阅读器在前台', await frontIs('builtin'), await typesFor())
    await sel.selectOption('pdfprobe').catch(() => {})
    await until(async () => (await menuOnce()).includes('用内置阅读器打开'))
    await row('书.pdf').click()
    check('T9c 改选插件 → 树上点 PDF 归插件', await frontIs('plugin'), await typesFor())
    await sel.selectOption('').catch(() => {})

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
