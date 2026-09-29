/**
 * 设备凭据(P1-K5)**真 Electron** 验证 —— 真主进程 × 真 safeStorage × 真磁盘 × 真 IPC × 真设备切换器。
 *
 * 为什么要真 Electron:secretStore / deviceSecrets 的单测注入的是假加密后端与内存文件系统,证不了
 * 「main.ts 在 whenReady 里真的先迁移、loadConfig 真的解密回填、config:get 真的不再带设备密钥、
 *  锁定时 unitHost 真的没建、点「重试」真的恢复」这条接线。
 *
 * 隔离(⚠️ 这支台架绝不许碰真账号 / 真设备名册 / 真钥匙串):
 *   - TANGU_HOME=临时目录 → 没有 auth.json → UnitHost 停在「未登录」,永不入册(不会往你的真名册里多塞一台设备);
 *     TANGU_CLOUD_URL 另指向本机一个不监听的端口,双保险。
 *   - macOS 用 Chromium 的 MockKeychain(固定口令 mock_password),**不读写真钥匙串**;Linux 用 basic 后端走降级路径
 *     (level=plaintext,远程会话 fail closed)。真正起作用的是 Playwright 的 Electron loader:每次 `_electron.launch` 都在
 *     ready 之前 appendSwitch('use-mock-keychain') + ('password-store','basic')(playwright-core 1.61.1
 *     lib/server/electron/loader.js:69-70)—— 所以别的预置 external token 的台架同样不碰真钥匙串。下面 launch 参数里再写一遍,
 *     是让 Node 侧 mockDecrypt 的前提在本文件里看得见。⚠️ 绕过 loader 直接 spawn Electron 的台架(如 live-voice.e2e)要自己带这两个开关。
 *   - userData = --user-data-dir + '-dev'(dev 态),后端 = 桩引擎(external 模式 + TANGU_BACKEND_URL)。
 *
 * 三段:
 *   A 迁移:预置一份带 unitHostId / unitHostSecret / token 的旧 shell 配置 → 启动 → 两份文件的字节里都没有明文;
 *     getConfig() 不带设备密钥、external token 解密回填;setConfig({unitHostSecret}) 写不进去;状态 level 符合平台。
 *   B 锁定:把配对密文写坏、打开「允许其他设备连接本机」→ 重启 → 文件字节不变、unitHost 不运行(局域网面照起)、
 *     切换器脚部出锁定提示;把好的密文放回盘上、点「重试」→ 恢复、unitHost 起来、配对仍是原 unit id(没有重新登记)。
 *   C 截图:锁定提示 zh(真 Electron 主窗,DESIGN §8)。en、降级态与「要重启」态的截图走 web harness(?ribbon&unit&secrets=…)。
 *   D 迁移卡住(device-secrets.json 是个目录:读 EISDIR、写 rename 失败)→ shell 里的三键原样保留 → getConfig() 仍不许带
 *     unitHostId / unitHostSecret(loadConfig 的 `...shell` 剥离;迁移成功时 shell 已空,A3 证不到这条)、token 回落 shell、
 *     配对按锁定(unitHost 不运行)、存储「文件」没被写成别的东西。
 *   E external token 锁定且互联关着(切换器里不挂提示):设置 › 连接 › 外部连接面板出 token 锁定提示(只有「重试」,
 *     没有「重新登记本机」),截图;把好的密文放回、点重试 → 提示消失、getConfig().token 恢复。
 *
 * 负对照(断言必须能红):在 K5 之前的 main.ts 上跑(git checkout 297408ab -- electron/main.ts && npm run build)→
 *   A1(shell 字节里有明文)、A3(getConfig 带 unitHostSecret)必须红;删掉 loadConfig 里两行 `delete merged.unitHost*` → D2 红
 *   (2026-09-28 实测)。
 *
 * 用法:npm run build && npm run check:secrets   [--keep] [--no-lock]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-device-secrets-e2e')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const UNIT_ID = 'u-e2e-7f31c9'
const UNIT_SECRET = 'E2E_UNIT_SECRET_4b9d0f6a8c'
const EXT_TOKEN = 'E2E_EXT_TOKEN_19e7aa02'

// ── 结果统计 ──────────────────────────────────────────────────────────────────────────────────
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const d = detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`)
}
function skip(name, why) {
  results.push({ name, skipped: true })
  console.log(`SKIP  ${name}  | 未验:${why}`)
}
const note = (name, detail) => console.log(`NOTE  ${name}${detail ? '  | ' + detail : ''}`)

// ── devlock(同 computer-history.e2e)──────────────────────────────────────────────────────────
function findDevlock() {
  for (let d = __dirname; ; d = path.dirname(d)) {
    const f = path.join(d, '.claude', 'hooks', 'devlock.cjs')
    if (fs.existsSync(f)) return f
    if (path.dirname(d) === d) return null
  }
}
const LOCK_SCRIPT = findDevlock()
let lockHeld = false
function releaseLock() {
  if (!lockHeld) return
  lockHeld = false
  const r = spawnSync(process.execPath, [LOCK_SCRIPT, 'release'], { encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
}
function acquireLock() {
  if (argv.includes('--no-lock')) { note('devlock', '--no-lock:不上锁'); return }
  if (!LOCK_SCRIPT) { note('devlock', '向上找不到 .claude/hooks/devlock.cjs,不上锁'); return }
  const r = spawnSync(process.execPath, [LOCK_SCRIPT, 'acquire', '--what=device-secrets e2e', '--vehicle=e2e', '--eta=10', `--pid=${process.pid}`], { encoding: 'utf8' })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')
  if (r.status !== 0) {
    console.error('devlock 被占用:等它空闲(node devlock.cjs wait)再跑;确认那轮已废才 release。')
    process.exit(3)
  }
  lockHeld = true
}
process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { releaseLock(); process.exit(130) })
process.on('uncaughtException', (e) => { console.error(e); releaseLock(); process.exit(1) })

// ── 工具 ──────────────────────────────────────────────────────────────────────────────────────
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const readText = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
/** 字节里没有明文:连 base64 解码后的 data 字段也查(base64(明文) 会骗过子串检查)。 */
function plaintextHits(text, secrets) {
  if (!text) return []
  const hits = secrets.filter((s) => text.includes(s))
  try {
    const j = JSON.parse(text)
    for (const e of Object.values((j && j.entries) || {})) {
      if (!e || typeof e.data !== 'string') continue
      const dec = Buffer.from(e.data, 'base64').toString('utf8')
      for (const s of secrets) if (dec.includes(s) || e.data.includes(s)) hits.push(`${s}(base64 解码后)`)
    }
  } catch { /* 不是 JSON:只查子串 */ }
  return hits
}
/** Chromium MockKeychain 的 OSCrypt 密文(v10 + AES-128-CBC,key = PBKDF2(mock_password, saltysalt, 1003))→ 明文。 */
function mockDecrypt(b64) {
  const b = Buffer.from(b64, 'base64')
  if (b.subarray(0, 3).toString() !== 'v10') return null
  const key = crypto.pbkdf2Sync('mock_password', 'saltysalt', 1003, 16, 'sha1')
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  try { return Buffer.concat([d.update(b.subarray(3)), d.final()]).toString('utf8') } catch { return null }
}

async function launchApp(home, stubUrl) {
  const env = {
    ...process.env,
    TANGU_HOME: home, // 没有 auth.json → 不登录、不入册
    TANGU_BACKEND_URL: stubUrl,
    TANGU_CLOUD_URL: 'http://127.0.0.1:9', // 双保险:即便有 token 也连不上真 hub
  }
  delete env.FORSION_UNIT_AUTO_PAIR
  const extra = process.platform === 'darwin' ? ['--use-mock-keychain'] : process.platform === 'linux' ? ['--password-store=basic'] : []
  // -ApplePersistenceIgnoreState YES 放在 ROOT 之后:跳过 macOS 崩溃后的「重新打开窗口」模态框(否则 firstWindow 干等)。
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ...extra, ROOT, '-ApplePersistenceIgnoreState', 'YES'], cwd: ROOT, env })
  const mainLog = []
  app.process().stdout?.on('data', (d) => mainLog.push(String(d)))
  app.process().stderr?.on('data', (d) => mainLog.push(String(d)))
  return { app, mainLog }
}
async function closeApp(app) {
  if (!app) return
  const closed = await Promise.race([app.close().then(() => true, () => false), sleep(15_000).then(() => false)])
  if (!closed) { try { app.process().kill('SIGKILL') } catch { /* 已退 */ } }
}
async function mainWindow(app) {
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 40_000 })
  return win
}
const bridge = (win, expr) => win.evaluate(expr)

async function main() {
  acquireLock()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-secrets-'))
  const ud = path.join(home, 'userdata-dev') // dev 态 userData = --user-data-dir + '-dev'
  const shellPath = path.join(ud, 'tangu-desktop-config.json')
  const storePath = path.join(ud, 'device-secrets.json')
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const expectLevel = process.platform === 'linux' ? 'plaintext' : 'os'
  let app = null, mainLog = []
  try {
    // ── A 迁移 ─────────────────────────────────────────────────────────────────────────────
    fs.mkdirSync(ud, { recursive: true })
    fs.writeFileSync(shellPath, JSON.stringify({ mode: 'external', token: EXT_TOKEN, unitHostEnabled: false, unitHostId: UNIT_ID, unitHostSecret: UNIT_SECRET, mcpEnabled: false }, null, 2))
    ;({ app, mainLog } = await launchApp(home, stub.url))
    let win = await mainWindow(app)
    check('A0 首启引导已跳过', await skipOnboarding(win))
    await win.waitForTimeout(800)

    const shellText = readText(shellPath)
    const storeText = readText(storePath)
    check('A1 shell 配置的字节里没有配对密钥 / external token(三键已迁走)', !!shellText && plaintextHits(shellText, [UNIT_SECRET, EXT_TOKEN]).length === 0
      && !/unitHostId|unitHostSecret|"token"/.test(shellText), shellText && shellText.slice(0, 300))
    check('A1b 其余 shell 键原样(mode / unitHostEnabled / mcpEnabled)', (() => { const j = readJson(shellPath); return j && j.mode === 'external' && j.unitHostEnabled === false && j.mcpEnabled === false })(), readJson(shellPath))
    const hits = plaintextHits(storeText, [UNIT_SECRET, EXT_TOKEN])
    check('A2 device-secrets.json 存在,字节里(含 base64 解码后)没有明文', !!storeText && (expectLevel !== 'os' || hits.length === 0), expectLevel === 'os' ? hits : `level=${expectLevel}:明文兼容回落,只核存在`)
    const store = readJson(storePath)
    if (process.platform === 'darwin') {
      const pr = store && store.entries && store.entries.unitPairing
      const pairing = pr && pr.enc === 'os' ? mockDecrypt(pr.data) : null
      const tk = store && store.entries && store.entries.externalToken
      check('A2b(MockKeychain 独立解密)存的就是那份配对与 token,enc=os / backend=keychain',
        pairing === JSON.stringify({ unitId: UNIT_ID, secret: UNIT_SECRET }) && !!tk && tk.enc === 'os' && mockDecrypt(tk.data) === EXT_TOKEN && pr.backend === 'keychain',
        { pairing, token: tk && tk.enc === 'os' ? mockDecrypt(tk.data) : tk })
      const st = await fs.promises.stat(storePath).catch(() => null)
      check('A2c device-secrets.json 权限 0600', !!st && (st.mode & 0o777) === 0o600, st ? (st.mode & 0o777).toString(8) : '文件不存在')
    } else skip('A2b MockKeychain 独立解密', `平台 ${process.platform} 不用 MockKeychain`)

    const cfg = await bridge(win, () => window.tangu.getConfig())
    check('A3 getConfig() 不带 unitHostId / unitHostSecret(渲染层读不到设备密钥)', !('unitHostId' in cfg) && !('unitHostSecret' in cfg) && !JSON.stringify(cfg).includes(UNIT_SECRET),
      Object.keys(cfg).filter((k) => /unitHost/.test(k)))
    check('A4 external token 从加密存储解密回填(getConfig().token / externalConnection.token)', cfg.token === EXT_TOKEN && cfg.externalConnection && cfg.externalConnection.token === EXT_TOKEN, { token: cfg.token, ext: cfg.externalConnection })
    const storeBefore = readText(storePath)
    await bridge(win, () => window.tangu.setConfig({ unitHostSecret: 'EVIL', unitHostId: 'u-evil' }))
    await win.waitForTimeout(300)
    check('A5 setConfig({unitHostSecret, unitHostId}) 写不进去:加密存储字节不变、shell 不出现这两个键',
      readText(storePath) === storeBefore && !/unitHostId|unitHostSecret|EVIL/.test(readText(shellPath) || ''), readText(shellPath))
    const st = await bridge(win, () => window.tangu.secretStorageStatus?.()).catch((e) => ({ error: String(e) }))
    check(`A6 secretStorageStatus() level=${expectLevel},无锁定`, st && st.level === expectLevel && Array.isArray(st.locked) && st.locked.length === 0, st)
    // main.ts 的时序契约:deviceSecrets.init 必须是 configQueue 的第一个使用者、先于一切 loadConfig。有人抢跑,
    // deviceSecrets 会出声「在 init 之前被调用」(并按锁定 / 空处理 —— external token 那一刻读成空)。
    const early = mainLog.join('').split('\n').filter((l) => l.includes('在 init 之前被调用'))
    // 防假绿:日志确实接到了主进程输出(主窗建好时 main 必打「[main] …」/「[mcp]…」之类的行;一行都没有 = 管道断了)
    check('A7 启动时没有任何调用抢在 deviceSecrets.init 之前(主进程日志)', early.length === 0 && mainLog.join('').trim().length > 0,
      early.length ? early.slice(0, 3) : `已接到主进程日志 ${mainLog.join('').split('\n').filter(Boolean).length} 行`)
    await closeApp(app); app = null

    // ── B 锁定 → 重试恢复 ────────────────────────────────────────────────────────────────────
    const good = readText(storePath)
    const bad = JSON.parse(good)
    if (bad.entries.unitPairing.enc === 'os') bad.entries.unitPairing.data = Buffer.from('v10' + 'x'.repeat(29)).toString('base64') // 解不开的密文
    else bad.entries.unitPairing = { enc: 'os', backend: 'keychain', data: Buffer.from('v10' + 'x'.repeat(29)).toString('base64'), at: 1 } // plaintext 平台:os 条目 = 锁定
    const badText = JSON.stringify(bad, null, 2)
    fs.writeFileSync(storePath, badText, { mode: 0o600 })
    const sh = readJson(shellPath); sh.unitHostEnabled = true; fs.writeFileSync(shellPath, JSON.stringify(sh, null, 2))
    ;({ app, mainLog } = await launchApp(home, stub.url))
    win = await mainWindow(app)
    await skipOnboarding(win)
    await win.waitForTimeout(1500) // doRefreshUnitHost 起 unitWeb
    const hs = await bridge(win, () => window.tangu.unitHostStatus())
    check('B1 配对读不出来 → unitHost 不运行(局域网面照起)', hs && hs.running === false && hs.unitId === null && typeof hs.webPort === 'number', hs)
    const stL = await bridge(win, () => window.tangu.secretStorageStatus())
    check('B2 secretStorageStatus().locked 含 unitPairing', stL && stL.locked.includes('unitPairing'), stL)
    check('B3 锁定时文件字节不变(不删、不覆盖、没有重新登记)', readText(storePath) === badText)
    // 切换器脚部的锁定提示
    const pill = win.locator('.rb-head .unitsw-pill').first()
    const pillOk = await pill.waitFor({ timeout: 10_000 }).then(() => true, () => false)
    if (pillOk) {
      await pill.click()
      const notice = win.locator('.secnotice[data-secrets="locked"]').first()
      const shown = await notice.waitFor({ timeout: 5_000 }).then(() => true, () => false)
      check('B4 切换器脚部出现锁定提示(解密失败 = 重试 + 重新登记本机;不是「要重启」态)', shown && (await notice.locator('button').count()) === 2 && (await win.locator('.secnotice[data-secrets="restart"]').count()) === 0, shown ? await notice.innerText() : null)
      if (shown) {
        await win.waitForTimeout(700) // 菜单呼出带淡入展开:等动画走完再拍,否则截到半透明的中间帧
        const menu = win.locator('.unitsw-menu').first()
        const box = await menu.boundingBox()
        const file = path.join(SHOT_DIR, 'device-secrets-locked-zh.png')
        if (box) await win.screenshot({ path: file, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: box.width + 16, height: box.height + 16 } })
        note('C 截图', file)
        // 把好的密文放回盘上(模拟「钥匙串恢复 / 用户在系统框里点了允许」),点「重试」
        fs.writeFileSync(storePath, good, { mode: 0o600 })
        await notice.locator('button').first().click()
        const gone = await win.locator('.secnotice').first().waitFor({ state: 'detached', timeout: 8_000 }).then(() => true, () => false)
        check('B5 点「重试」→ 锁定解除、提示消失', gone)
      }
    } else skip('B4/B5 切换器提示', '主窗 ribbon 里没找到 Unit 胶囊')
    if (!results.some((r) => r.name.startsWith('B5'))) {
      // 没走 UI(胶囊没找到):直接走同一条 IPC
      fs.writeFileSync(storePath, good, { mode: 0o600 })
      await bridge(win, () => window.tangu.secretStorageRetry())
    }
    const deadline = Date.now() + 8_000
    let hs2 = null
    while (Date.now() < deadline) { hs2 = await bridge(win, () => window.tangu.unitHostStatus()); if (hs2 && hs2.running) break; await sleep(300) }
    const stR = await bridge(win, () => window.tangu.secretStorageStatus())
    check('B6 重试后 unitHost 起来、状态无锁定,配对仍是原 unit id(没有重新登记)', hs2 && hs2.running === true && hs2.unitId === UNIT_ID && stR.locked.length === 0, { hs2, stR })
    check('B7 设备通道停在「未登录」(台架隔离:没有 auth.json,绝不入册真名册)', hs2 && hs2.connected === false, hs2 && hs2.lastError)
    const after = readJson(storePath)
    if (process.platform === 'darwin') {
      check('B8 盘上配对仍是原 unit id(MockKeychain 解密)', after && mockDecrypt(after.entries.unitPairing.data) === JSON.stringify({ unitId: UNIT_ID, secret: UNIT_SECRET }))
    } else skip('B8 盘上配对解密核对', `平台 ${process.platform}`)
    await closeApp(app); app = null

    // ── D 迁移卡住:存储文件读不了、写不进 → shell 原样保留,渲染层照样拿不到设备密钥 ─────────────────────
    const homeD = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-secrets-d-'))
    try {
      const udD = path.join(homeD, 'userdata-dev')
      const shellD = path.join(udD, 'tangu-desktop-config.json')
      const storeD = path.join(udD, 'device-secrets.json')
      fs.mkdirSync(storeD, { recursive: true }) // 目录:readFile → EISDIR(读不懂),rename(tmp, 目录) → 失败(写不进)
      fs.writeFileSync(shellD, JSON.stringify({ mode: 'external', token: EXT_TOKEN, unitHostEnabled: true, unitHostId: UNIT_ID, unitHostSecret: UNIT_SECRET, mcpEnabled: false }, null, 2))
      ;({ app, mainLog } = await launchApp(homeD, stub.url))
      win = await mainWindow(app)
      await skipOnboarding(win)
      await win.waitForTimeout(1500)
      const shD = readJson(shellD)
      check('D1 前提:迁移没做成,shell 里配对密钥与 token 原样留着(这正是 `...shell` 会把密钥带进 config:get 的状态)',
        shD && shD.unitHostSecret === UNIT_SECRET && shD.unitHostId === UNIT_ID && shD.token === EXT_TOKEN, shD && Object.keys(shD))
      const cfgD = await bridge(win, () => window.tangu.getConfig())
      check('D2 getConfig() 仍不带 unitHostId / unitHostSecret(loadConfig 剥掉 shell 残留)', !('unitHostId' in cfgD) && !('unitHostSecret' in cfgD) && !JSON.stringify(cfgD).includes(UNIT_SECRET),
        Object.keys(cfgD).filter((k) => /unitHost/.test(k)))
      check('D3 external token 回落 shell 里那份(瞬时故障不断外部连接)', cfgD.token === EXT_TOKEN, cfgD.token)
      const stD = await bridge(win, () => window.tangu.secretStorageStatus())
      const hsD = await bridge(win, () => window.tangu.unitHostStatus())
      check('D4 配对按锁定:status.locked 含 unitPairing、unitHost 不运行(不会当成「空」去重新登记)', stD && stD.locked.includes('unitPairing') && hsD && hsD.running === false, { stD, hsD })
      check('D5 存储路径仍是那个目录(没被迁移 / 重新登记写成别的文件)', fs.statSync(storeD).isDirectory() && fs.readdirSync(storeD).length === 0)
    } finally {
      await closeApp(app); app = null
      if (!KEEP) fs.rmSync(homeD, { recursive: true, force: true })
      else note('保留临时目录(D)', homeD)
    }

    // ── E external token 锁定、互联关着:设置页外部连接面板给提示 ─────────────────────────────────────
    const homeE = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-secrets-e-'))
    try {
      const udE = path.join(homeE, 'userdata-dev')
      const storeE = path.join(udE, 'device-secrets.json')
      fs.mkdirSync(udE, { recursive: true })
      const goodE = JSON.parse(good)
      delete goodE.entries.unitPairing
      const goodEText = JSON.stringify(goodE, null, 2)
      const badE = JSON.parse(goodEText)
      badE.entries.externalToken = { enc: 'os', backend: 'keychain', data: Buffer.from('v10' + 'y'.repeat(29)).toString('base64'), at: 1 }
      fs.writeFileSync(storeE, JSON.stringify(badE, null, 2), { mode: 0o600 })
      fs.writeFileSync(path.join(udE, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, unitHostEnabled: false, mcpEnabled: false }, null, 2))
      ;({ app, mainLog } = await launchApp(homeE, stub.url))
      win = await mainWindow(app)
      await skipOnboarding(win)
      const cfgE = await bridge(win, () => window.tangu.getConfig())
      check('E1 token 锁定 → getConfig().token 为空(不是乱码),status.locked 含 externalToken', cfgE.token === '' && (await bridge(win, () => window.tangu.secretStorageStatus())).locked.includes('externalToken'), cfgE.token)
      await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'connection' } }))
      let fl = null
      const until = Date.now() + 20_000
      while (Date.now() < until && !fl) { fl = app.windows().find((w) => w.url().includes('window=floating')) || null; if (!fl) await sleep(200) }
      if (!fl) throw new Error('settings floating window missing')
      const noticeE = fl.locator('.settings-external-panel .secnotice[data-secrets="locked"]').first()
      const shownE = await noticeE.waitFor({ timeout: 20_000 }).then(() => true, () => false)
      const txt = shownE ? await noticeE.innerText() : ''
      check('E2 设置 › 外部连接面板出 token 锁定提示:只有「重试」,没有「重新登记本机」', shownE && (await noticeE.locator('button').count()) === 1 && !txt.includes('重新登记'), txt)
      if (shownE) {
        await fl.waitForTimeout(400)
        const panel = fl.locator('.settings-external-panel').first()
        const file = path.join(SHOT_DIR, 'device-secrets-token-locked-settings-zh.png')
        await panel.screenshot({ path: file })
        note('E 截图', file)
        fs.writeFileSync(storeE, goodEText, { mode: 0o600 })
        await noticeE.locator('button').first().click()
        const goneE = await fl.locator('.settings-external-panel .secnotice').first().waitFor({ state: 'detached', timeout: 8_000 }).then(() => true, () => false)
        const cfgE2 = await bridge(win, () => window.tangu.getConfig())
        check('E3 放回好的密文、点重试 → 提示消失、token 恢复', goneE && cfgE2.token === EXT_TOKEN, cfgE2.token)
      }
    } finally {
      await closeApp(app); app = null
      if (!KEEP) fs.rmSync(homeE, { recursive: true, force: true })
      else note('保留临时目录(E)', homeE)
    }
  } catch (e) {
    check('台架未抛错', false, String(e && e.stack || e).slice(0, 800))
    console.error('主进程日志尾:\n' + mainLog.join('').split('\n').filter(Boolean).slice(-40).join('\n'))
  } finally {
    await closeApp(app)
    stub.close()
    if (!KEEP) fs.rmSync(home, { recursive: true, force: true })
    else note('保留临时目录', home)
  }
  const failed = results.filter((r) => !r.skipped && !r.ok).length
  const passed = results.filter((r) => !r.skipped && r.ok).length
  const skipped = results.filter((r) => r.skipped).length
  console.log(`\n${failed ? '❌' : '✅'} device-secrets e2e:${passed} 通过 / ${failed} 失败 / ${skipped} 未验(共 ${results.length})`)
  process.exitCode = failed ? 1 : 0
}

main()
