/**
 * 代码块「运行」的**真引擎真模型** live 台架:自起一个隔离 Electron(独立 userData + 独立 TANGU_HOME,
 * 只复制 ~/.forsion-dev/auth.json 的登录态),托管引擎自起(空闲端口,不碰你手里的 dev 实例、不需要 devlock)。
 *
 * 流程:新会话 → 选 grok(缺省 --model=grok,按 pill 菜单文本匹配)→ 让模型给一条 bash 命令 → 点 Run →
 *       底部终端跑完自动回传 → 模型的下一条回复应当认出退出码/输出。
 * 断言区分两种红:「UI/引擎坏了」与「这次模型没配合」(后者脚本会明说)。
 *
 * 跑:npm run build && node scripts/runblock-live.e2e.cjs [--model=grok]   ⚠️ 真花模型额度(两轮短对话)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split('=').slice(1).join('=')
const MODEL = arg('model', 'grok-4.7')
const MARK = 'FORSION_LIVE_OK'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 1000) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const devAuth = path.join(os.homedir(), '.forsion-dev/auth.json')
  if (!fs.existsSync(devAuth)) { console.error('缺 ~/.forsion-dev/auth.json —— 先在 dev 版登录'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-runblock-live-'))
  const userdata = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  fs.mkdirSync(userdata); fs.mkdirSync(vault)
  fs.copyFileSync(devAuth, path.join(home, 'auth.json')) // 只借登录态;其余数据全在隔离 home
  // ⚠️ 引擎首启「config.json 不存在」会把 auth.json 收进 config.json 并改名 .bak(core/config.ts:172)——壳这边
  // auth.json 是登录态唯一真源,被改名 = 登出 = 「暂无可用模型」。先放一个 config.json 让那次迁移不跑。
  const cloudUrl = JSON.parse(fs.readFileSync(devAuth, 'utf8')).cloudUrl || ''
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ cloud: { url: cloudUrl } }))
  // 直连订阅登录(xai grok / codex …)住 provider-auth.json:照 tangu-agent live-harness 的做法**软链**进隔离共享域,
  // 引擎自己读、刷新的 token 写回真文件(复制一份会让 refresh_token 分叉,把真登录态刷废)。本脚本不读不打印。
  const devProviderAuth = path.join(os.homedir(), '.forsion-dev/provider-auth.json')
  if (fs.existsSync(devProviderAuth)) fs.symlinkSync(devProviderAuth, path.join(home, 'provider-auth.json'))
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  // 壳配置缺省 mode='external'(等 8787 的外部后端)→ 输入框永远 disabled;要托管引擎自起必须先种上 managed。
  // userData 目录 main.ts 可能补 -dev 后缀,两处都种。
  for (const d of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed' }))
  }
  const t0 = Date.now()
  const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, ELECTRON_ENABLE_LOGGING: '1' },
    })
    // 主进程日志一律落 home/app.log(起不来引擎时只有它说得清);CHECK_VERBOSE=1 再同时打到 stdout
    const appLog = fs.createWriteStream(path.join(home, 'app.log'))
    for (const [tag, stream] of [['[app] ', app.process().stdout], ['[app!] ', app.process().stderr]]) {
      stream?.on('data', (b) => { appLog.write(tag + b); if (process.env.CHECK_VERBOSE) process.stdout.write(tag + b) })
    }
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1000))
    await win.waitForSelector('#root', { timeout: 60_000 })
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`button:text-is("${label}")`).first()
      if (await b.isVisible().catch(() => false)) { await b.click(); break }
    }
    await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})

    // 会话侧栏 → 新会话(同 plan-live 的入口纪律:按 data-act,不按文案)
    const picker = win.locator('.t2sw-mode-picker').first()
    if (await picker.count().catch(() => 0)) {
      await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
      await picker.locator('[data-workspace-mode="orbits"]').click().catch(() => {})
      await sleep(800)
    }
    const newBtn = win.locator('[data-act="new-chat"]').first()
    await newBtn.waitFor({ state: 'visible', timeout: 90_000 })
    await newBtn.click()
    const ta = win.locator('.t2c-ta').first()
    await ta.waitFor({ state: 'visible', timeout: 30_000 })
    // 托管引擎在全新 home 里要先播种再就绪,输入框在此之前是 disabled(占位「先在设置里连接后端」)
    const ready = await until(async () => (await ta.isEnabled()) || null, 120_000, 1000)
    check(`L0 新会话输入框就位、引擎已连上(${el()})`, !!ready, ready ? '' : `placeholder=${await ta.getAttribute('placeholder')}`)
    if (!ready) throw new Error('backend not ready')

    // 选模型:pill → 「模型」行 → 文本含 MODEL 的项
    let picked = ''
    try {
      await win.locator('.model-pill-btn').first().click()
      const menu = win.locator('.composer-menu--model').first()
      await menu.waitFor({ state: 'visible', timeout: 5_000 })
      const row = menu.locator('.cm-model-row').first()
      if (await row.count()) await row.click()
      await sleep(400)
      const item = menu.getByText(new RegExp(MODEL, 'i')).first()
      if (await item.count()) { picked = (await item.innerText()).trim(); await item.click() }
      else console.log('  ↳ 菜单里没有匹配项,菜单文本:', (await menu.innerText()).replace(/\s+/g, ' ').slice(0, 300))
      await win.keyboard.press('Escape')
    } catch (e) { console.log('  ↳ 选模型失败(用缺省模型继续):', String(e.message || e).slice(0, 120)) }
    const pill = (await win.locator('.model-pill-btn').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    check(`L1 模型已选(pill=「${pill}」)`, !picked || new RegExp(MODEL, 'i').test(pill), picked ? `picked=${picked}` : '未能匹配,沿用缺省')

    // 第一轮:要一条命令
    const prompt = `Reply with exactly one \`\`\`bash code block containing this single command and nothing else (no explanation, do not run it yourself): echo ${MARK}; exit 7`
    await ta.fill(prompt)
    await ta.press('Enter')
    const t1 = Date.now()
    const runBtn = await until(async () => {
      const running = await win.locator('.t2c-stop').isVisible().catch(() => false)
      const btn = win.locator('[id^="tocmsg-"] [data-testid="code-run"]').first()
      return !running && (await btn.count()) ? btn : null
    }, 240_000, 1500)
    const firstReply = (await win.locator('[id^="tocmsg-"] .t2-content').last().innerText().catch(() => '')).trim()
    check(`L2 ⭐ 模型给出了带 Run 键的 bash 代码块(${((Date.now() - t1) / 1000).toFixed(1)}s)`, !!runBtn,
      runBtn ? `reply=${JSON.stringify(firstReply.slice(0, 160))}` : `模型没配合或超时:${JSON.stringify(firstReply.slice(0, 200))}`)
    if (!runBtn) throw new Error('no run button')
    await win.screenshot({ path: path.join(home, 'live-1-reply.png') })

    // 点 Run → 终端 → 自动回传
    const beforeX = await win.locator('.xterm').count()
    await runBtn.click()
    const xterm = await until(async () => (await win.locator('.xterm').count()) > beforeX || null, 15_000, 300)
    check('L3 点 Run 开出底部终端', !!xterm)
    // ⚠️ 别按 MARK 过滤:第一条用户消息(提示词)里也有它,会立刻命中 → 后面两条断言在进程还没退出时就读终端(假红)。
    const bubble = await until(async () => {
      const b = win.locator('.t2-user').filter({ hasText: /退出码 7|exit code 7/ }).last()
      return (await b.count()) ? (await b.innerText()) : null
    }, 30_000, 500)
    check('L4 退出后结果自动作为用户消息回传', !!bubble && /退出码 7|exit code 7/.test(bubble), bubble ? bubble.replace(/\n/g, '⏎').slice(0, 160) : 'no bubble')
    const termText = (await win.locator('.xterm-rows').last().innerText().catch(() => '')).replace(/\s+/g, ' ')
    check('L5 终端画面含回显与输出,退出码 7', termText.includes(MARK) && /进程已退出\(code 7\)|Process exited \(code 7\)/.test(await win.locator('body').innerText()), termText.slice(0, 120))

    // 第二轮:模型对回传的反应
    const t2 = Date.now()
    const second = await until(async () => {
      const running = await win.locator('.t2c-stop').isVisible().catch(() => false)
      const contents = win.locator('[id^="tocmsg-"] .t2-content')
      const n = await contents.count()
      if (running || n < 2) return null
      const txt = (await contents.last().innerText()).trim()
      return txt && txt !== firstReply ? txt : null
    }, 240_000, 1500)
    const acknowledged = !!second && (second.includes(MARK) || /\b7\b/.test(second) || /退出|exit|non-?zero|非零/i.test(second))
    check(`L6 ⭐ 模型下一条回复认出了执行结果(${((Date.now() - t2) / 1000).toFixed(1)}s)`, acknowledged,
      second ? `模型原话=${JSON.stringify(second.slice(0, 300))}` : '模型没回话或超时')
    await win.screenshot({ path: path.join(home, 'live-2-ack.png') })
    console.log('screenshots:', home, `| 墙钟 ${el()}`)
  } catch (e) {
    const w = app?.windows()[0]
    await w?.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
    console.error('failure screenshot:', path.join(home, 'failure.png'), '| app log:', path.join(home, 'app.log'))
    console.error(e)
    results.push({ name: 'exception', ok: false }) // 抛了就是红,不许「2/2 passed」
  } finally {
    await app?.close().catch(() => {})
    // 借来的登录态用完即焚(截图/日志留着)
    // provider-auth.json 是软链,rmSync 只摘链不动真文件
    for (const f of ['auth.json', 'auth.json.bak', 'config.json', 'auth-accounts.json', 'desktop-local-token', 'provider-auth.json']) fs.rmSync(path.join(home, f), { force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
main()
