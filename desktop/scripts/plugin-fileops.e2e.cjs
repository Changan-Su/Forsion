/**
 * ctx.app.createFolder / stat / renamePath / movePath 端到端(2026-11-16)—— 真 Electron × 真外置插件 × 预置笔记库 × 落盘核对。
 *
 * 单测(appFileOps.test.ts)用的是假的文件树动作;这里验它们看不见的那半:改名 / 挪动真的走到主进程的引用重写
 * (别的笔记里的 [[链接]] 跟着改)、开着的编辑器跟着新路径走、确认框真的画在宿主里(取消 = user_declined 且盘上不动,
 * 允许 = 照做),以及边界 —— 插件自己这一程写出来的笔记、createFolder 建的文件夹、工作文件夹里的文件不弹框。
 *
 * 需先 npm run build。用法(GUI 台架,走 devlock):
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="插件文件操作" --eta=3 -- node scripts/plugin-fileops.e2e.cjs
 * 负对照:--nc=preseed —— Drafts/new.md 启动前就在盘上(插件只是覆盖写,不算它建的)→ 期望 T3 起「不弹框」变红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const SHOT = (name) => path.join(os.tmpdir(), `${name}${NC ? '-nc-' + NC : ''}.png`)
const PROBE = 'foprobe'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) {
    let v = null
    try { v = await fn() } catch { v = null }
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 200))
  }
}

function writeProbe(pluginsDir) {
  const dir = path.join(pluginsDir, PROBE)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), 'window.__foprobe = { app: ctx.app }\n')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: PROBE, name: PROBE, version: '1.0.0', minAppVersion: '0.0.1', description: 'e2e probe for ctx.app file operations, not a product plugin',
  }, null, 2))
}

function seedVault(vault) {
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'Archive'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'Plugins', PROBE), { recursive: true })
  fs.writeFileSync(path.join(vault, 'Notes', 'linker.md'), '# Linker\n\nSee [[new]] and [[Target]].\n')
  fs.writeFileSync(path.join(vault, 'Notes', 'Target.md'), '# Target\n')
  fs.writeFileSync(path.join(vault, 'Plugins', PROBE, 'seeded.md'), '# Seeded\n')
  if (NC === 'preseed') {
    fs.mkdirSync(path.join(vault, 'Drafts'), { recursive: true })
    fs.writeFileSync(path.join(vault, 'Drafts', 'new.md'), '# Already here\n')
  }
}

async function launch(home, stubUrl) {
  const app = await electron.launch({
    args: ['--user-data-dir=' + path.join(home, 'userdata'), '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: Object.assign({}, process.env, { TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl }),
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 40000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator('text=' + label).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 40000 })
  return { app, win }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (NC) console.log('⚠️ 负对照模式 --nc=' + NC + ':期望相关断言变红\n')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-fo-'))
  const vault = path.join(home, 'vault')
  const at = (...p) => path.join(vault, ...p)
  const read = (...p) => { try { return fs.readFileSync(at(...p), 'utf8') } catch { return null } }
  let stub = null, app = null, win = null
  try {
    stub = await startStubEngine({ sessions: [], messages: [], models: [] })
    fs.mkdirSync(vault, { recursive: true })
    seedVault(vault)
    fs.mkdirSync(path.join(home, 'userdata-dev'), { recursive: true })
    fs.writeFileSync(path.join(home, 'userdata-dev', 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    writeProbe(path.join(home, 'plugins'))
    ;({ app, win } = await launch(home, stub.url))

    const has = await waitFor(() => win.evaluate(() => {
      const a = window.__foprobe && window.__foprobe.app
      return a && a.vaultRoot && a.vaultRoot() && ['createFolder', 'stat', 'renamePath', 'movePath'].every((k) => typeof a[k] === 'function')
    }), 30000)
    check('T0 探针装载、库已恢复、四个方法都在', has)

    /** 发起一次调用(不等它),结果落在 window.__foRes。 */
    const start = (expr, args) => win.evaluate(({ expr, args }) => {
      window.__foRes = undefined
      Promise.resolve().then(() => new Function('app', 'args', `return (${expr})`)(window.__foprobe.app, args))
        .then((v) => ({ ok: v === undefined ? null : v }), (e) => ({ err: String((e && e.message) || e) }))
        .then((r) => { window.__foRes = r })
    }, { expr, args })
    const result = (ms = 10000) => waitFor(() => win.evaluate(() => window.__foRes), ms)
    const dialog = win.locator('dialog.plugin-dialog[open]')
    /** 期望不弹框:调用自己落定,且期间没有确认框。弹了就点取消收掉,免得卡住后面。 */
    const direct = async (expr, args) => {
      await start(expr, args)
      const r = await result(8000)
      const shown = await dialog.count()
      if (shown) await dialog.locator('button[data-secondary]').first().click().catch(() => {})
      return { r, shown }
    }
    /** 期望弹框:等框出来,读标题,按 answer 点允许 / 取消,再等结果。 */
    const viaDialog = async (expr, args, answer, shot) => {
      await start(expr, args)
      const up = await dialog.first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
      const title = up ? await dialog.locator('.plugin-dialog-title').first().textContent().catch(() => '') : ''
      if (shot && up) await win.screenshot({ path: SHOT(shot) }).catch(() => {})
      if (up) await dialog.locator(answer === 'allow' ? '.plugin-dialog-actions button.primary' : 'button[data-secondary]').first().click().catch(() => {})
      return { up, title, r: await result(10000) }
    }
    const call = (expr, args) => start(expr, args).then(() => result())

    // ── T1 createFolder ──
    let r = await call('app.createFolder("Projects/2026/Q4")')
    check('T1a createFolder 建出嵌套的三层', r && r.ok === null && fs.statSync(at('Projects', '2026', 'Q4')).isDirectory(), JSON.stringify(r))
    r = await call('app.createFolder("Projects/2026/Q4")')
    check('T1b 已有的文件夹直接 resolve', r && r.ok === null, JSON.stringify(r))
    r = await call('app.createFolder("Notes/linker.md/x")')
    check('T1c 有文件挡着 → reject', r && /file is in the way/.test(r.err || ''), JSON.stringify(r))
    if (fs.existsSync(at('projects'))) {
      r = await call(`app.createFolder(${JSON.stringify('projects\\2026\\q4')})`)
      check('T1d 大小写不敏感卷:已有目录的大小写别名直接成功', r?.ok === null && fs.readdirSync(at('Projects', '2026')).join() === 'Q4', JSON.stringify(r))
    }

    // ── T2 stat ──
    r = await call('app.stat("Notes/linker.md")')
    const st = fs.statSync(at('Notes', 'linker.md'))
    const s = r && r.ok
    check('T2a 文件:种类 / 大小 / 修改时间与盘上一致,创建时间是数字或 null', s && s.kind === 'file' && s.size === st.size && Math.abs(s.mtime - st.mtimeMs) < 2 && (s.ctime === null || s.ctime > 0), JSON.stringify(s))
    r = await call('Promise.all([app.stat("Notes"), app.stat("missing.md")])')
    check('T2b 文件夹 kind=folder;不存在 → null', r && r.ok && r.ok[0] && r.ok[0].kind === 'folder' && r.ok[1] === null, JSON.stringify(r))
    r = await call('app.stat("../outside")')
    check('T2c 越界 → reject', r && /escapes/.test(r.err || ''), JSON.stringify(r))

    // ── T3 插件这一程写出来的笔记:改名不问;别的笔记里的 [[链接]] 跟着改;开着的编辑器跟着走 ──
    r = await call('app.writeFile("Drafts/new.md", "# New\\n")')
    await win.evaluate(() => window.__foprobe.app.openNote('Drafts/new.md'))
    const opened = await waitFor(() => win.evaluate(() => window.__foprobe.app.getActivePage() === 'Drafts/new.md'), 15000)
    check('T3a 插件写出新笔记并在编辑器里打开', r && !r.err && opened, JSON.stringify({ r, active: await win.evaluate(() => window.__foprobe.app.getActivePage()) }))
    let d = await direct('app.renamePath("Drafts/new.md", "Renamed")')
    check('T3b 自己建的笔记改名:不弹框,返回新路径', !d.shown && d.r && d.r.ok === 'Drafts/Renamed.md', JSON.stringify(d))
    check('T3c 盘上改了名', fs.existsSync(at('Drafts', 'Renamed.md')) && !fs.existsSync(at('Drafts', 'new.md')))
    const linked = await waitFor(() => (read('Notes', 'linker.md') || '').includes('[[Renamed]]'), 8000)
    check('T3d 别的笔记里的 [[new]] 改写成 [[Renamed]]', linked, JSON.stringify(read('Notes', 'linker.md')))
    const follows = await waitFor(() => win.evaluate(() => window.__foprobe.app.getActivePage() === 'Drafts/Renamed.md'), 8000)
    check('T3e 开着它的编辑器跟到新路径', follows, String(await win.evaluate(() => window.__foprobe.app.getActivePage())))

    // ── T4 挪进用户已有的文件夹:同样不问,编辑器跟着走 ──
    d = await direct('app.movePath("Drafts/Renamed.md", "Archive")')
    check('T4a 自己建的笔记挪进 Archive:不弹框,返回新路径', !d.shown && d.r && d.r.ok === 'Archive/Renamed.md', JSON.stringify(d))
    check('T4b 盘上挪过去了', fs.existsSync(at('Archive', 'Renamed.md')) && !fs.existsSync(at('Drafts', 'Renamed.md')))
    const follows2 = await waitFor(() => win.evaluate(() => window.__foprobe.app.getActivePage() === 'Archive/Renamed.md'), 8000)
    check('T4c 编辑器跟到挪过去的路径', follows2, String(await win.evaluate(() => window.__foprobe.app.getActivePage())))

    const before = read('Archive', 'Renamed.md')
    d = await direct('app.renamePath("Archive/Renamed.md", "RENAMED")')
    check('T4d 只改笔记名大小写:磁盘拼写变了、文件内容保留', !d.shown && d.r?.ok === 'Archive/RENAMED.md'
      && fs.readdirSync(at('Archive')).includes('RENAMED.md') && read('Archive', 'RENAMED.md') === before, JSON.stringify(d))
    const caseFollowed = await waitFor(() => win.evaluate(() => window.__foprobe.app.getActivePage() === 'Archive/RENAMED.md'))
    check('T4e 仅改大小写后,打开的编辑器跟到新拼写', caseFollowed)
    if (caseFollowed) await win.screenshot({ path: SHOT('plugin-fileops-case-rename') }).catch(() => {})

    // ── T5 工作文件夹里的(不是插件写的)与 createFolder 建的文件夹:不问 ──
    d = await direct('app.renamePath("Plugins/foprobe/seeded.md", "seeded2")')
    check('T5a 工作文件夹里的文件改名不弹框', !d.shown && d.r && d.r.ok === 'Plugins/foprobe/seeded2.md' && fs.existsSync(at('Plugins', PROBE, 'seeded2.md')), JSON.stringify(d))
    d = await direct('app.renamePath("Projects/2026/Q4", "Q1")')
    check('T5b createFolder 建的文件夹改名不弹框', !d.shown && d.r && d.r.ok === 'Projects/2026/Q1' && fs.existsSync(at('Projects', '2026', 'Q1')), JSON.stringify(d))

    // ── T6 用户的笔记:先问。取消 = user_declined、盘上不动;允许 = 照做,[[链接]] 跟着改 ──
    let v = await viaDialog('app.renamePath("Notes/Target.md", "Target2")', null, 'cancel', 'plugin-fileops-confirm')
    check('T6a 改用户的笔记弹宿主确认框,标题说清谁要把什么改成什么', v.up && /foprobe/.test(v.title) && v.title.includes('Notes/Target.md') && v.title.includes('Target2.md'), JSON.stringify(v.title))
    check('T6b 取消 → reject user_declined,盘上不动', v.r && v.r.err === 'user_declined' && fs.existsSync(at('Notes', 'Target.md')) && !fs.existsSync(at('Notes', 'Target2.md')), JSON.stringify(v.r))
    v = await viaDialog('app.renamePath("Notes/Target.md", "Target2")', null, 'allow')
    check('T6c 允许 → 改名成功', v.up && v.r && v.r.ok === 'Notes/Target2.md' && fs.existsSync(at('Notes', 'Target2.md')) && !fs.existsSync(at('Notes', 'Target.md')), JSON.stringify(v.r))
    const linked2 = await waitFor(() => (read('Notes', 'linker.md') || '').includes('[[Target2]]'), 8000)
    check('T6d [[Target]] 改写成 [[Target2]]', linked2, JSON.stringify(read('Notes', 'linker.md')))
    v = await viaDialog('app.movePath("Notes/Target2.md", "")', null, 'allow')
    check('T6e 挪用户的笔记到根:框里写「智库根目录」,允许后挪过去', v.up && v.title.includes('智库根目录') && v.r && v.r.ok === 'Target2.md' && fs.existsSync(at('Target2.md')), JSON.stringify(v))
    v = await viaDialog('app.renamePath("Archive", "Archive2")', null, 'cancel')
    check('T6f 用户原有的文件夹(插件没建)改名也要问;取消不动', v.up && v.r && v.r.err === 'user_declined' && fs.existsSync(at('Archive')), JSON.stringify(v.r))
  } catch (e) {
    console.error('\n跑挂了:', e && e.stack)
    if (win) await win.screenshot({ path: SHOT('plugin-fileops-crash') }).catch(() => {})
    results.push({ name: '脚本跑完', ok: false })
  } finally {
    if (app) await app.close().catch(() => {})
    if (stub && stub.close) await Promise.resolve(stub.close()).catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(`${home}-workspace`, { recursive: true, force: true })
  }
  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad} passed / ${bad} failed  (共 ${results.length})`)
  console.log(`截图:${SHOT('plugin-fileops-confirm')}`)
  process.exit(bad ? 1 : 0)
}

main()
