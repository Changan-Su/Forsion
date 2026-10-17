/**
 * 外部文件打开整链 e2e(真 Electron × 假引擎):Finder「打开方式」/ 拖到 Dock / 命令行参数送来的文件
 * → 主进程 deliverOpenFile → 渲染层 openFileInstall → 库外进 wsfile 临时标签页、库内走 Amadeus 原生视图。
 *
 *   O1 冷启动 argv 里的库外 .md(win/linux 首启那条)→ wsfile 标签页;argv 里的 app 根目录与开关不被当文件
 *   O2 库外 .md 就地编辑 → 写回原文件(「临时编辑」不导入笔记库:库目录里不多出文件)
 *   O3 mac 的 open-file 事件(Finder 双击 / 拖到 Dock)→ 库外 .pdf 进 wsfile,PDF 渲染出来
 *   O4 已开着时二次启动带文件(win/linux 双击)→ 二号进程退出,文件落在一号实例里
 *   O5 本地库内的 .md → Amadeus 笔记视图,不进 wsfile(与已开着的库外文件同名,不许认成那一个)
 *   O6 同一路径再开一次 → 聚焦已有标签页,不重复开
 *   O7 渲染层重载(⌘R)之后再打开 → 照样落地(主进程不记「已就绪」,新页装载时自己来拉)
 *
 * 需先 npm run build。用法:npm run e2e:openfile
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 最小可用的单页 PDF(带一行字;xref 偏移现算,pdf.js 不用走修复路径)。 */
function tinyPdf() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // 4:内容流
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = 'BT /F1 18 Tf 40 100 Td (Outside PDF) Tj ET'
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

/** 当前激活的 wsfile 标签页显示的路径(没有 → null)。 */
const activeWsfile = (win) => win.evaluate(() => {
  const names = [...document.querySelectorAll('.wsfile-tab .wsfile-name')].filter((e) => e.offsetParent !== null)
  return names.length ? names[names.length - 1].textContent : null
}).catch(() => null)

async function waitFor(fn, ms = 15_000, step = 300) {
  const t0 = Date.now()
  let v
  while (Date.now() - t0 < ms) {
    v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, step))
  }
  return v
}

/** dockview 标签条上的标题(数重复开了几个用)。 */
const tabTitles = (win) => win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())).catch(() => [])

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-openfile-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  // 库内笔记与 O4 的库外文件同名:「已开着就聚焦」不许按文件名把它认成那个库外预览页
  fs.writeFileSync(path.join(vaultDir, '二次启动.md'), '# 二次启动\n\n这是库里的同名笔记。\n')
  const outside = path.join(home, '桌面')
  fs.mkdirSync(outside, { recursive: true })
  const extMd = path.join(outside, '外部说明.md')
  fs.writeFileSync(extMd, '# 外部说明\n\n第一段。\n')
  const extPdf = path.join(outside, '外部文档.pdf')
  fs.writeFileSync(extPdf, tinyPdf(), 'latin1')
  const secondMd = path.join(outside, '二次启动.md')
  fs.writeFileSync(secondMd, '# 二次启动\n')
  const afterReload = path.join(outside, '重载后.md')
  fs.writeFileSync(afterReload, '# 重载后\n')
  /** 库里有没有出现外部文件的副本(应用自己会在库里建 Sessions/ 之类,不能比整份目录)。 */
  const copiedIntoVault = (dir = vaultDir) => fs.readdirSync(dir, { withFileTypes: true }).some((d) =>
    d.isDirectory() ? copiedIntoVault(path.join(dir, d.name)) : d.name.includes('外部'))

  const userData = path.join(home, 'userdata')
  const udDev = `${userData}-dev`
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const stub = await startStubEngine({})
  const env = { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url }
  // O1:库外 .md 放在冷启动 argv 里(ROOT 是目录、--lang 是开关,都不该被当成要打开的文件)
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT, extMd],
    cwd: ROOT,
    env,
  })
  const shot = (name) => app.windows()[0]?.screenshot({ path: path.join(os.tmpdir(), `openfile-${name}.png`) }).catch(() => {})
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })

    const o1 = await waitFor(async () => (await activeWsfile(win)) === extMd, 20_000)
    const titles1 = await tabTitles(win)
    check('O1 冷启动 argv 里的库外 .md 开成 wsfile 标签页(且只开了这一个)', !!o1 && titles1.filter((t) => t.includes('外部说明')).length === 1,
      `active=${await activeWsfile(win)} tabs=${titles1.join('|')}`)
    if (!o1) await shot('o1')

    // O2:就地编辑写回原文件,库目录里不多出东西
    const editor = win.locator('.wsfile-tab .ProseMirror').first()
    let o2 = false
    if (await editor.count().catch(() => 0)) {
      await editor.click()
      await win.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
      await win.keyboard.type('临时编辑写回')
      o2 = await waitFor(() => fs.readFileSync(extMd, 'utf8').includes('临时编辑写回'), 8000)
    }
    check('O2 库外 .md 就地编辑 → 写回原文件,笔记库里没有它的副本', !!o2 && !copiedIntoVault(),
      `disk=${JSON.stringify(fs.readFileSync(extMd, 'utf8').slice(0, 60))} copied=${copiedIntoVault()}`)
    if (!o2) await shot('o2')

    // O3:mac 的 open-file(Finder 双击 / 打开方式 / 拖到 Dock)
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p) }, extPdf)
    const o3 = await waitFor(async () => (await activeWsfile(win)) === extPdf, 15_000)
    const pdfOk = o3 && await waitFor(() => win.evaluate(() => {
      const tab = [...document.querySelectorAll('.wsfile-tab')].find((t) => t.offsetParent !== null)
      return !!tab && !tab.querySelector('.wsfile-fallback') && !!tab.querySelector('canvas, .page, .pdfViewer')
    }).catch(() => false), 15_000)
    check('O3 open-file 事件把库外 .pdf 开成 wsfile 并渲染出页面', !!pdfOk, `active=${await activeWsfile(win)}`)
    if (!pdfOk) await shot('o3')

    // O4:二次启动带文件 —— 二号进程拿不到单实例锁直接退出,文件经 second-instance 落到这里
    const electronBin = require('electron')
    const second = spawn(electronBin, [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT, secondMd, ...electron.MAC_FLAGS], {
      cwd: ROOT, env: electron.workspaceEnv(env), stdio: 'ignore',
    })
    const exitCode = await new Promise((r) => { const t = setTimeout(() => { second.kill(); r('timeout') }, 20_000); second.on('exit', (c) => { clearTimeout(t); r(c) }) })
    const o4 = await waitFor(async () => (await activeWsfile(win)) === secondMd, 15_000)
    check('O4 已开着时二次启动带文件 → 二号进程退出、文件落在一号实例的 wsfile', exitCode === 0 && !!o4, `exit=${exitCode} active=${await activeWsfile(win)}`)
    if (!o4) await shot('o4')

    // O5:本地库内的 .md → Amadeus 原生笔记视图
    const vaultNote = path.join(vaultDir, '二次启动.md')
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p) }, vaultNote)
    const o5 = await waitFor(async () => {
      const titles = await tabTitles(win)
      // 笔记标签的标题不带 .md;库外那页(二次启动.md)不该是激活的
      return titles.includes('二次启动') && (await activeWsfile(win)) !== secondMd ? titles : null
    }, 15_000)
    const anyWsVault = await win.evaluate((p) => [...document.querySelectorAll('.wsfile-name')].some((e) => e.textContent === p), vaultNote).catch(() => true)
    const keptPrev = (await tabTitles(win)).includes('二次启动.md')
    check('O5 本地库内的 .md 走 Amadeus 笔记视图(新开标签,不顶掉当前那个),不进 wsfile', !!o5 && !anyWsVault && keptPrev,
      `tabs=${(await tabTitles(win)).join('|')}`)
    if (!o5) await shot('o5')

    // O6:同一路径再开 → 聚焦已有的,不重复开(先切走,确认是「聚焦回来」)
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p) }, extPdf)
    const o6 = await waitFor(async () => (await activeWsfile(win)) === extPdf, 10_000)
    const pdfTabs = (await tabTitles(win)).filter((t) => t.includes('外部文档')).length
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p) }, vaultNote)
    await win.waitForTimeout(1500)
    const noteTabs = (await tabTitles(win)).filter((t) => t === '二次启动').length
    check('O6 同一文件再开一次 → 聚焦已有标签页,不重复开(库外 PDF、库内笔记各一次)', !!o6 && pdfTabs === 1 && noteTabs === 1,
      `pdfTabs=${pdfTabs} noteTabs=${noteTabs}`)
    if (!o6 || pdfTabs !== 1 || noteTabs !== 1) await shot('o6')

    // O7:重载渲染层后再从系统打开
    await win.reload()
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await app.evaluate(({ app: a }, p) => { a.emit('open-file', { preventDefault() {} }, p) }, afterReload)
    const o7 = await waitFor(async () => (await activeWsfile(win)) === afterReload, 15_000)
    check('O7 渲染层重载之后再从系统打开 → 照样落地', !!o7, `active=${await activeWsfile(win)}`)
    if (!o7) await shot('o7')
  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) console.log(`失败截图在 ${os.tmpdir()}/openfile-*.png`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
