/**
 * 新会话落在哪、用哪个模型 —— 真 Electron × 真组件/store × 假引擎(托管模式,有本机文件系统)。
 *
 * 用户 2026-10-13 报的两件:
 *  ① 在 Amadeus 里呼出的 Tangu(右栏对话面板),工作目录还是默认工作区,应该是 Amadeus 工作区(笔记库);
 *  ② 新会话的模型不跟着上次用的走,一直卡在同一个上。
 * 钉住的契约(断言的是 UI 发给引擎的建会话请求,不是界面自己的说法):
 *  A 在 Tangu Space 里发新对话:照旧落默认工作区(对照,别把所有 Space 都改了);
 *  B 进 Amadeus、展开右栏对话:空白新对话的项目药丸就是「智库 · 库名」,发出去的会话 project_path / cwd = 库根,
 *    且不再把库另列进 extraRoots;
 *  C 在会话里把模型换成另一个,再 /new:当场建的会话带着刚换的那个模型(不带的话引擎按它启动时的缺省落库),落点仍是库;
 *  D 模型药丸「高级 → 默认辅助模型」的面板开着时,鼠标停在「模型」行上不许把面板换成主模型的(两份清单长得一样,
 *    换过去再点,改的就是主模型,还会被记成新会话的默认);在里面选的只改辅助模型。
 *
 * 需先 npm run build,以及 ../tangu-agent 的 npm run build(托管模式要等主进程自己起的引擎就绪)。用法:npm run e2e:chatlanding
 * 负对照:FORSION_E2E_ROOT=<没有这次改动的检出>/desktop node scripts/amadeus-chat-landing.e2e.cjs —— B、C、D 必须转红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = process.env.FORSION_E2E_ROOT || path.join(__dirname, '..')
const SHOT = path.join(os.tmpdir(), 'forsion-chat-landing.png')
const SHOT_MENU = path.join(os.tmpdir(), 'forsion-chat-landing-auxmenu.png')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const real = (p) => { try { return fs.realpathSync(p) } catch { return p } }

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error(`缺 ${ROOT}/out/main/main.js —— 先跑 npm run build`)
    process.exit(1)
  }
  const stub = await startStubEngine({
    sessions: [], messages: [],
    models: [
      { id: 'm1', name: 'Stub 甲', provider: 'stub', contextWindow: 128_000 },
      { id: 'm2', name: 'Stub 乙', provider: 'stub', contextWindow: 128_000 },
    ],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-landing-'))
  // 临时库 + 指向它的 Amadeus 配置(dev 态 userData = <--user-data-dir>-dev);不种的话会落到本机真实的库
  const vault = path.join(home, 'vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Alpha.md'), '# Alpha\n\nAlpha body\n')
  const workspace = path.join(home, 'workspace')
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
    // ⚠️ 全新配置缺省是 external(没有本机文件系统):新对话全建成云端会话,笔记库这个落点按设计不生效 —— 必须显式 managed。
    //    托管模式下渲染层连的是主进程自己起的真引擎,所以下面把 /agent/** 改道到桩(同 document-agents.electron.cjs)。
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
      mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9',
      sandbox: 'none', browserEnabled: false, defaultWorkspaceDir: workspace, modelId: 'm1', unitHostEnabled: false,
    }))
  }

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1' },
  })
  const creates = stub.seen.sessionCreates
  const waitCreates = async (win, n) => { for (let t0 = Date.now(); creates.length < n && Date.now() - t0 < 8000;) await win.waitForTimeout(150) }
  const sameDir = (a, b) => !!a && !!b && real(a) === real(b)

  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    await app.context().route('**/agent/**', async (route) => {
      const url = new URL(route.request().url())
      await route.continue({ url: `${stub.url}${url.pathname}${url.search}` })
    })
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    check('离开首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    const host = await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 60_000 }).then(() => true, () => false)
    const mode = await win.evaluate(() => window.tangu.getConfig().then((c) => c.mode))
    check('前置:托管模式、引擎就绪(有本机文件系统)', host && mode === 'managed', JSON.stringify({ host, mode }))

    /** 可见的那个聊天视图里的输入框:发一句。 */
    const send = async (text) => {
      const ta = win.locator('.t2-chat-view .t2c-ta:visible').first()
      for (let i = 0; i < 40 && !(await ta.isEnabled().catch(() => false)); i++) await win.waitForTimeout(250)
      await ta.click(); await ta.fill(text); await win.keyboard.press('Enter')
    }

    // ── A 对照:Tangu Space 里的新对话照旧落默认工作区 ──
    check('进 Tangu Space', await enterSpace(win, 'tangu'))
    await win.waitForTimeout(1200)
    await send('在默认工作区里的一句')
    await waitCreates(win, 1)
    const a = creates[0]
    check('A Tangu Space 的新对话:落在默认工作区,不是笔记库',
      !!a && sameDir(a.project_path, workspace) && a.agent_config?.cwd === a.project_path,
      JSON.stringify(a && { project_path: a.project_path, project_name: a.project_name, cwd: a.agent_config?.cwd }))

    // ── B Amadeus 右栏对话 ──
    check('进 Amadeus Space', await enterSpace(win, 'amadeus'))
    await win.waitForTimeout(2500)
    if (!(await win.locator('.t2-chat-view:visible').count().catch(() => 0))) {
      await win.click('.dv-edge-right', { timeout: 10_000 })
      await win.waitForTimeout(1500)
    }
    // 项目药丸按 `.project-selector:not(.runloc)` 找:左边的「运行位置」胶囊(RunLocationPicker)借了同一套类,不排掉读到的是「这台电脑」
    const pill = await win.locator('.t2-chat-view:visible .project-selector:not(.runloc) > .project-pill .project-pill-name').first().textContent({ timeout: 5000 }).catch(() => null)
    check('B1 空白新对话的项目药丸 = 笔记库(智库 · vault)', !!pill && pill.includes('智库') && pill.includes('vault'), JSON.stringify(pill))
    await win.screenshot({ path: SHOT })
    await send('在库里的一句')
    await waitCreates(win, 2)
    const b = creates[1]
    check('B2 发出去的会话:project_path = 库根',
      !!b && sameDir(b.project_path, vault), JSON.stringify(b && { project_path: b.project_path, project_name: b.project_name }))
    check('B3 初始配置:本机执行,cwd = 库根,库不再另列进 extraRoots',
      !!b && b.agent_config?.execMode === 'host' && sameDir(b.agent_config?.cwd, vault) && !(b.agent_config?.extraRoots || []).length,
      JSON.stringify(b && b.agent_config && { execMode: b.agent_config.execMode, cwd: b.agent_config.cwd, extraRoots: b.agent_config.extraRoots }))

    // ── C 在会话里换模型,再 /new ──
    await win.waitForTimeout(1500)
    const side = win.locator('.t2-chat-view:visible').first()
    await side.locator('.model-pill-btn').first().click()
    await win.locator('[data-pane-trigger="model"]').first().click()
    await win.locator('.cm-sub .menu-item', { hasText: 'Stub 乙' }).first().click()
    await win.waitForTimeout(600)
    const ta = win.locator('.t2-chat-view .t2c-ta:visible').first()
    await ta.click(); await ta.fill('/new'); await win.waitForTimeout(400); await win.keyboard.press('Enter')
    await waitCreates(win, 3)
    const c = creates[2]
    check('C1 /new 当场建的会话带着刚换的模型', !!c && c.model_id === 'm2', JSON.stringify(c && { model_id: c.model_id }))
    check('C2 /new 的落点同样是库根', !!c && sameDir(c.project_path, vault) && sameDir(c.agent_config?.cwd, vault),
      JSON.stringify(c && { project_path: c.project_path, cwd: c.agent_config?.cwd }))

    // ── D 辅助模型槽的面板开着时,鼠标停在「模型」行上不换面板;在里面选的只改辅助模型 ──
    await win.waitForTimeout(1200)
    const side2 = win.locator('.t2-chat-view:visible').first()
    await side2.locator('.model-pill-btn').first().click()
    await win.locator('.cm-advanced-toggle').first().click()
    await win.waitForTimeout(500)
    await win.locator('[data-pane-trigger="backgroundModelId"]').first().click()
    await win.waitForSelector('.cm-sub[data-pane="backgroundModelId"]', { timeout: 5000 })
    await win.waitForTimeout(400)
    await win.screenshot({ path: SHOT_MENU })
    const row = await win.locator('[data-pane-trigger="model"]').first().boundingBox()
    const geo = await win.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b ? { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } : null }
      return { slotRow: r('[data-pane-trigger="backgroundModelId"]'), modelRow: r('[data-pane-trigger="model"]'), sub: r('.cm-sub'), placement: document.querySelector('.cm-sub')?.className }
    })
    console.log('INFO  菜单几何 ' + JSON.stringify(geo))
    await win.mouse.move(row.x + row.width / 2, row.y + row.height / 2, { steps: 8 })
    await win.waitForTimeout(500) // 悬停开面板的延时是 150ms
    const paneAfterHover = await win.locator('.cm-sub').first().getAttribute('data-pane').catch(() => null)
    check('D1 辅助模型面板开着,鼠标停在「模型」行:面板没被换成主模型的', paneAfterHover === 'backgroundModelId', JSON.stringify(paneAfterHover))
    await win.locator('.cm-sub .menu-item', { hasText: 'Stub 甲' }).first().click()
    await win.waitForTimeout(600)
    const cfg = await win.evaluate(() => window.tangu.getConfig().then((c) => ({ modelId: c.modelId, backgroundModelId: c.backgroundModelId })))
    check('D2 在里面选的落在辅助模型上,新会话用的模型没被改', cfg.backgroundModelId === 'm1' && cfg.modelId === 'm2', JSON.stringify(cfg))
    await win.keyboard.press('Escape').catch(() => {})
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图 ${SHOT}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
