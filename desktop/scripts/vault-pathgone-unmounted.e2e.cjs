/**
 * 没挂载的标签也跟随树上的改名 / 删除,真 Electron × 真主进程 × 真磁盘 × 真 dockview × 真多窗口。
 * 2026-09-16 Codex 评审:第一版在视图里订阅 onNotePathGone,视图没挂载就收不到 ——
 * 折叠侧栏的面板被序列化进 stash、分离窗口是另一个 JS realm(主进程只发不带路径的 structureChange);
 * 同时多维表 / 白板的防抖写在文件挪走之后照旧落到旧路径(db:write-cas 缺文件即新建)。
 * 现在工作区 store 层统一跟随 + 主进程把路径广播转给其它窗口 + 两个文件 store 按广播改指。e2e:pathgonefiles 管挂载着的那半。
 *
 *   S0 夹具:资料/ 下 笔记.md(内嵌 ![[表.db]])、图.png、书.pdf 各开一个标签
 *   S1 图片标签拖进右侧栏再折叠 → 它只剩 stash 里的一条
 *   S2 PDF 标签「移到新窗口」→ 分离窗口里的标签
 *   S3 另开一个 PDF 画一笔墨迹(2.5s 防抖内未落盘)后紧接着树上改文件夹名:stash 条目 / 分离窗口的标签 / 编辑器标签
 *      都跟到 资料改/;那一笔随文件挪过去,旧位置没被 PdfAnnotator 的卸载收尾写回来(整份 PDF 的幽灵副本)。
 *      笔记里内嵌表接着改 → 写进 资料改/表.db(冒烟:桌面 watcher 在旧路径消失时会按基名把 ![[表.db]] 的条目
 *      重新解析过去,所以这条在桌面上分辨不出 dbStore 的改指 —— 那半由 pageStore.filestores.test.ts 证明)
 *   S4 树上删文件夹:stash 条目摘掉、分离窗口的标签关掉(就地变 home)、编辑器标签回落到还活着的笔记;没有文件被建回来
 *
 * 用法:npm run build && npm run e2e:pathgoneunmounted   (--shot 存截图到 /tmp/forsion-pathgone-unmounted-*.png)
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
  results.push({ name, ok: !!ok }) // !! —— 断言链遇 null 会短路成 null,按 ok===false 统计会漏项
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const DB = { version: 1, name: '表', columns: [{ id: 'c1', name: '标题', type: 'text' }], rows: [{ id: 'r1', cells: {} }] }
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 合成一次引擎自管的标签拖拽(WorkspaceHost 的 dragstart → window 捕获的 dragover/drop):落在右侧栏组的下半截。 */
const DRAG_TAB_TO_RIGHT = (title) => {
  const tab = [...document.querySelectorAll('.dv-tab')].find((t) => (t.textContent || '').trim() === title)
  const src = tab && tab.querySelector('.wb-tab')
  const groups = [...document.querySelectorAll('.dv-groupview')]
    .filter((g) => g.getBoundingClientRect().width > 0 && g.querySelector('.wb-tab--icon') && !g.querySelector('.wb-tab--left'))
    .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)
  const content = groups[0] && (groups[0].querySelector('.dv-content-container') || groups[0])
  if (!src || !content) return `missing src=${!!src} right=${!!content}`
  const r = content.getBoundingClientRect()
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height * 0.8 }
  const dt = new DataTransfer()
  const ev = (type, extra) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra })
  src.dispatchEvent(ev('dragstart'))
  window.dispatchEvent(ev('dragover', at))
  window.dispatchEvent(ev('drop', at))
  src.dispatchEvent(ev('dragend', at))
  return 'ok'
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js')) || !fs.existsSync(path.join(ROOT, 'out/renderer'))) {
    console.error('缺 out/main/main.js 或 out/renderer —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pathgone-unmounted-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  const dir = path.join(vault, '资料')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(vault, '1.md'), '# 1\n', 'utf8')
  fs.writeFileSync(path.join(dir, '笔记.md'), '# 笔记\n\n![[表.db]]\n', 'utf8')
  fs.writeFileSync(path.join(dir, '表.db'), `${JSON.stringify(DB, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, '书.pdf'), tinyPdf(['UNMOUNTED']))
  const INKPDF = tinyPdf(['INK'])
  fs.writeFileSync(path.join(dir, '批注.pdf'), INKPDF)
  fs.writeFileSync(path.join(dir, '图.png'), PNG_1PX)
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
    const shot = async (name, page = win) => { if (SHOT) await page.screenshot({ path: `/tmp/forsion-pathgone-unmounted-${name}.png` }).catch(() => {}) }
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
    const menu = async (target, label) => {
      await target.click({ button: 'right' })
      await win.locator('.ctx-menu button', { hasText: label }).first().click()
    }
    const tabTitles = () => win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((e) => (e.textContent || '').trim()))
    /** 落盘布局(主窗口 + 各分离窗口,同源共用 localStorage):重启 / 展开侧栏都按它还原。 */
    const layouts = () => win.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tangu2_layout_'))
      .map((k) => ({ k, v: JSON.parse(localStorage.getItem(k) || 'null') })))
    const mainLayout = async () => (await layouts()).find((l) => l.k.startsWith('tangu2_layout_v4'))?.v
    const detachedLayout = async () => (await layouts()).find((l) => l.k.startsWith('tangu2_layout_detached'))?.v
    const panelsOf = (v) => Object.values((v && v.dockview && v.dockview.panels) || {}).map((p) => p.params || {})
    const rightStash = async () => ((await mainLayout())?.sidebars?.right?.stash) || []

    // ── S0 夹具 ─────────────────────────────────────────────────────────
    await folder('资料').waitFor({ timeout: 15_000 })
    if (!(await row('图.png').isVisible().catch(() => false))) await folder('资料').locator('.t2s-folder-row').click()
    await row('图.png').waitFor({ timeout: 10_000 })
    await row('笔记').click()
    await until(async () => (await tabTitles()).includes('笔记'))
    await row('图.png').click({ modifiers: ['Meta'] })
    await until(async () => (await tabTitles()).includes('图.png'))
    await row('书.pdf').click({ modifiers: ['Meta'] })
    await until(async () => (await tabTitles()).includes('书.pdf'))
    await win.waitForTimeout(1200)
    const p0 = panelsOf(await mainLayout())
    check('S0 笔记 / 图片 / PDF 各开一个标签', p0.some((p) => p.notePath === '资料/笔记.md') && p0.some((p) => p.imagePath === '资料/图.png') && p0.some((p) => p.pdfPath === '资料/书.pdf'),
      JSON.stringify(await tabTitles()))

    // ── S1 图片标签拖进右侧栏,再把右侧栏折叠 → 只剩 stash 里的一条 ─────────────────
    if (!(await win.evaluate(() => [...document.querySelectorAll('.dv-groupview')].some((g) => g.getBoundingClientRect().width > 0 && g.querySelector('.wb-tab--icon') && !g.querySelector('.wb-tab--left'))))) {
      await win.locator('.dv-edge-toggle.dv-edge-right').click()
      await win.waitForTimeout(800)
    }
    const dragged = await win.evaluate(DRAG_TAB_TO_RIGHT, '图.png')
    const inRight = await until(async () => panelsOf(await mainLayout()).some((p) => p.imagePath === '资料/图.png' && p.__loc === 'right'))
    check('S1a 图片标签进了右侧栏', inRight, `drag=${dragged} ${JSON.stringify(panelsOf(await mainLayout()).map((p) => [p.__type, p.__loc]))}`)
    await win.locator('.dv-edge-toggle.dv-edge-right').click()
    const stashed = await until(async () => {
      const live = panelsOf(await mainLayout()).some((p) => typeof p.imagePath === 'string')
      return !live && (await rightStash()).some((v) => v.params && v.params.imagePath === '资料/图.png')
    })
    check('S1b 折叠后图片视图只在 stash 里(没有挂载的面板)', stashed, JSON.stringify(await rightStash()))
    await shot('s1-stashed')

    // ── S2 PDF 标签移到新窗口 ──────────────────────────────────────────────
    const winEvent = app.waitForEvent('window', { timeout: 20_000 })
    await win.locator('.dv-tab', { hasText: /^书\.pdf$/ }).first().click({ button: 'right' })
    await win.locator('.ctx-menu button', { hasText: '移到新窗口' }).first().click()
    const detached = await winEvent
    detached.on('pageerror', (e) => logs.push(`[detached pageerror] ${e.message}`))
    await detached.waitForSelector('.dv-groupview', { timeout: 30_000 })
    const inDetached = await until(async () => panelsOf(await detachedLayout()).some((p) => p.pdfPath === '资料/书.pdf'), 15_000)
    check('S2 PDF 标签移进分离窗口(主窗口里已经没有它)', inDetached && !(await tabTitles()).includes('书.pdf'),
      JSON.stringify(panelsOf(await detachedLayout())))

    // ── S3 另开一个 PDF 画一笔墨迹(不切工具 = 不立即提交,2.5s 防抖),紧接着树上改文件夹名 ─────────
    await row('批注.pdf').click({ modifiers: ['Meta'] })
    await until(async () => (await tabTitles()).includes('批注.pdf'))
    await win.locator('.dv-tab', { hasText: /^批注\.pdf$/ }).first().click()
    const pageBox = await until(async () => {
      const b = await win.locator('.amx-pdfview .page').first().boundingBox()
      return b && b.width > 50 && b.height > 50 ? b : null
    }, 15_000)
    await win.locator('button.pdfa-tool[title^="手写笔"]').first().click()
    const x0 = pageBox.x + pageBox.width * 0.3
    const y0 = pageBox.y + Math.min(pageBox.height * 0.3, 160)
    await win.mouse.move(x0, y0)
    await win.mouse.down()
    await win.mouse.move(x0 + 80, y0 + 30, { steps: 12 })
    await win.mouse.up()
    const inkedAt = Date.now()

    await menu(folder('资料'), '重命名')
    const nameInput = win.locator('.dialog input').last()
    await nameInput.fill('资料改')
    await nameInput.press('Enter')
    const renameLag = Date.now() - inkedAt
    await until(async () => fs.existsSync(path.join(vault, '资料改', '表.db')))
    check('S3a 磁盘上文件夹已改名', fs.existsSync(path.join(vault, '资料改', '表.db')) && !fs.existsSync(dir))
    const stashFollowed = await until(async () => (await rightStash()).some((v) => v.params && v.params.imagePath === '资料改/图.png'))
    check('S3b 折叠侧栏里的图片条目跟到 资料改/', stashFollowed, JSON.stringify(await rightStash()))
    const detachedFollowed = await until(async () => panelsOf(await detachedLayout()).some((p) => p.pdfPath === '资料改/书.pdf'))
    check('S3c 分离窗口里的 PDF 标签跟到 资料改/(主进程转来的路径广播)', detachedFollowed, JSON.stringify(panelsOf(await detachedLayout())))
    const editorFollowed = await until(async () => panelsOf(await mainLayout()).some((p) => p.notePath === '资料改/笔记.md'))
    check('S3d 编辑器标签跟到 资料改/笔记.md', editorFollowed)
    // 前置态:改名必须在墨迹的 2.5s 提交防抖之内发起,否则那一笔早就正常落盘了,下面这条就测不到卸载收尾
    check('S3g0 改名在墨迹落盘之前发起(< 2.5s)', renameLag < 2500, `lag=${renameLag}ms`)
    const inked = await until(async () => {
      try { return !fs.readFileSync(path.join(vault, '资料改', '批注.pdf')).equals(INKPDF) } catch { return false }
    }, 8000)
    await win.waitForTimeout(2500)
    check('S3g PDF 里那一笔随文件挪到 资料改/,旧位置没被卸载收尾写回一份', inked && !fs.existsSync(path.join(dir, '批注.pdf')),
      `新位置有墨迹=${!!inked} 旧位置=${fs.existsSync(path.join(dir, '批注.pdf'))}`)

    // 笔记里的内嵌表:引用 ![[表.db]] 没变,dbStore 里那条是改名前载入的 —— 接着改一个格子
    await win.locator('.dv-tab', { hasText: /^笔记$/ }).first().click()
    const cellInput = win.locator('.amx-db-input').first()
    await cellInput.waitFor({ timeout: 15_000 })
    await cellInput.click()
    await cellInput.pressSequentially('跟过去', { delay: 20 })
    const written = await until(async () => {
      try { return fs.readFileSync(path.join(vault, '资料改', '表.db'), 'utf8').includes('跟过去') } catch { return false }
    }, 8000)
    await win.waitForTimeout(1500)
    check('S3e 改名后接着改内嵌表:写进 资料改/表.db,旧文件夹没被建回来(冒烟)', written && !fs.existsSync(dir),
      `written=${!!written} 资料存在=${fs.existsSync(dir)}`)
    await shot('s3-renamed')

    // 展开右侧栏:图片视图按新路径装载(展开后前台可能是别的侧栏视图 —— 先点到图片那个标签)
    await win.locator('.dv-edge-toggle.dv-edge-right').click()
    // 侧栏组的标签头压在顶栏按钮层底下(真点会被「恢复默认布局」钮截走),直接在标签上派发指针事件激活
    const imgTab = win.locator('.dv-tab', { has: win.locator('.wb-tab[title="图.png"]') }).first()
    await imgTab.waitFor({ state: 'attached', timeout: 10_000 })
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) await imgTab.dispatchEvent(type, { button: 0 })
    const imgOk = await until(() => win.evaluate(() => decodeURIComponent(document.querySelector('img.amx-imgview-img')?.getAttribute('src') || '').includes('资料改/图.png')))
    check('S3f 展开右侧栏:图片视图装的是新路径', imgOk, await win.evaluate(() => document.querySelector('img.amx-imgview-img')?.getAttribute('src') || '(无 img)'))
    await win.locator('.dv-edge-toggle.dv-edge-right').click()
    await until(async () => !panelsOf(await mainLayout()).some((p) => typeof p.imagePath === 'string') && (await rightStash()).some((v) => v.params && v.params.imagePath === '资料改/图.png'))
    // 焦点落回主区:左栏「自动」档跟着活动视图走,焦点停在侧栏视图上时笔记树会换成别的列表
    await win.locator('.dv-tab', { hasText: /^笔记$/ }).first().click()
    await folder('资料改').waitFor({ timeout: 15_000 })

    // ── S4 树上删文件夹 ──────────────────────────────────────────────────
    await menu(folder('资料改'), '删除')
    const stashDropped = await until(async () => !(await rightStash()).some((v) => v.params && typeof v.params.imagePath === 'string'))
    check('S4a 折叠侧栏里的图片条目被摘掉', stashDropped, JSON.stringify(await rightStash()))
    const detachedClosed = await until(async () => {
      const ps = panelsOf(await detachedLayout())
      return !ps.some((p) => typeof p.pdfPath === 'string') && ps.filter((p) => (p.__loc || 'main') === 'main').map((p) => p.__type).join() === 'home'
    })
    check('S4b 分离窗口里的 PDF 标签关掉(主区就地变 home 占位)', detachedClosed, JSON.stringify(panelsOf(await detachedLayout())))
    const editorFell = await until(async () => panelsOf(await mainLayout()).some((p) => p.__type === 'amadeus-editor' && p.notePath === '1.md'))
    check('S4c 编辑器标签没关,回落到还活着的 1.md', editorFell, JSON.stringify(panelsOf(await mainLayout()).map((p) => [p.__type, p.notePath])))
    await win.waitForTimeout(3000)
    check('S4d 文件夹与文件没被建回来', !fs.existsSync(path.join(vault, '资料改')) && !fs.existsSync(dir))
    await shot('s4-deleted')
    await shot('s4-detached', detached)

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
