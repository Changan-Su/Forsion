/**
 * Forsion Extend 主进程半身 × 真 Electron(electron/cloudHost.ts):清单里带 desktop 的内置包,启动时验签装载,
 * 云端账号面 IPC(个人中心 / 会员页 / 额度 / 反馈 / cloud:fetch)由它注册,不再住在 main.ts。
 *
 * 钉住:
 *  ① dev 随包(node_modules/@forsion/extend)播种进 <home>/plugins/forsion-extend/(含 SIGNATURE),[cloud-host] 装载成功;
 *  ② 渲染层 window.tangu.accountQuota / submitFeedback / cloudFetch / openPayCenter 都在;未登录 accountQuota → {status:401,json:null};
 *     cloudFetch 绝对 URL → bad_path(token 不出主进程、边界仍在);②b Connect 三个桥键由 Extend 0.2 注册,越界 publish 被拒;
 *  ③ 已装副本被改过(用户目录可写:版本抬高、入口改动、没重签)→ 下次启动播种把它换回可信的随包那份(永不降级的唯一例外),
 *     装载的是换回来的已装副本,账号面仍在;
 *  ④ 负对照 --absent:随包缺席 → preload 按 cloud:present 删键,四个键全 undefined(渲染层门控自动隐藏,不是 reject)。
 *
 * 需先 npm run build(读 out/)。用法:npm run e2e:extend;负对照:node scripts/extend-seam.e2e.cjs --absent
 * 前置:node_modules/@forsion/extend 是签过名的 npm 包(npm install 装的;本地 pack 的也行,签名用同一把钥匙)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const ABSENT = process.argv.includes('--absent')
const BUNDLED = path.join(ROOT, 'node_modules', '@forsion', 'extend')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function launch(home, stubUrl) {
  const logs = []
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState:所有台架与用户 dev 实例共用同一个 node_modules/electron/dist/Electron.app,前一个实例被杀后
    // macOS 会弹「应用在重新打开窗口时意外退出」模态框,主进程卡在 NSAlert runModal、永远不出窗口(同日日志「Electron 台架启动卡死」)。
    // ⚠️ 单短横的 Cocoa 参数必须放在应用路径之后:放前面会被 Electron 当成应用路径,launch 直接超时。
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    // ELECTRON_ENABLE_LOGGING:主进程 console 实时走 stderr;不开的话 stdout 是管道时要到进程退出才冲出来,起不来窗口就什么也看不到。
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 90_000,
  })
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => logs.push(String(d)))
  // 机器满载时(别的会话在打包)冷启动可能超过 Playwright 默认的 30s;超时把主进程日志尾巴带出来,别只报「没窗口」。
  // 卡住的主进程连 SIGTERM 都不理,app.close() 会一起挂死 —— 直接 SIGKILL。
  const win = await app.firstWindow({ timeout: 120_000 }).catch(async (e) => {
    try { app.process().kill('SIGKILL') } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 500))
    throw new Error(`${e.message}\n--- main log tail ---\n${logs.join('').split('\n').filter((l) => !/AppleShowScrollBars|^\s*$/.test(l)).slice(-15).join('\n')}`)
  })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(1500)
  const bridge = await win.evaluate(async () => {
    const t = window.tangu || {}
    const out = {
      accountQuota: typeof t.accountQuota, submitFeedback: typeof t.submitFeedback, cloudFetch: typeof t.cloudFetch, openPayCenter: typeof t.openPayCenter,
      connectStore: typeof t.connectStore, connectPublish: typeof t.connectPublish, connectMeta: typeof t.connectMeta,
    }
    if (typeof t.accountQuota === 'function') out.quota = await t.accountQuota()
    if (typeof t.cloudFetch === 'function') out.evil = await t.cloudFetch({ path: 'https://evil.test/x' })
    // Connect(Extend 0.2 起):meta 读不存在的目录 → {};publish 越界目录 → 拒(不打云端)
    if (typeof t.connectMeta === 'function') out.meta = await t.connectMeta('/nonexistent/project-dir')
    if (typeof t.connectPublish === 'function') out.publishOutside = await t.connectPublish({ dir: '/tmp', name: 'x', slug: 'x', entry: 'index.html' })
    return out
  })
  return { app, win, logs: () => logs.join(''), bridge }
}

;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-extend-seam-'))
  const stub = await startStubEngine({ models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }] })
  const installed = path.join(home, 'plugins', 'forsion-extend')
  let hidden = null
  try {
    if (ABSENT) {
      hidden = `${BUNDLED}.absent-${process.pid}`
      fs.renameSync(BUNDLED, hidden)
      const { app, logs, bridge } = await launch(home, stub.url)
      await app.close().catch(() => {})
      check('④ 随包缺席:播种跳过、装载器没装、cloud:present=[] → 账号面与 Connect 的桥键全从 window.tangu 删掉', bridge.accountQuota === 'undefined' && bridge.submitFeedback === 'undefined' && bridge.cloudFetch === 'undefined' && bridge.openPayCenter === 'undefined' && bridge.connectStore === 'undefined' && bridge.connectPublish === 'undefined' && !fs.existsSync(installed), JSON.stringify(bridge))
      check('④ 主进程日志:随包来源缺失被记下(不是静默)', logs().includes('随包来源缺失'), logs().split('\n').filter((l) => l.includes('builtin')).join(' / ').slice(0, 200))
    } else {
      const bundledVersion = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'manifest.json'), 'utf8')).version
      // 本机 node_modules 里的那份必须就是 package.json 钉的版本:「声明 0.1、实装 0.2」会让这份台架假绿而干净安装红(Codex)
      const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies['@forsion/extend']
      check(`⓪ node_modules 里的 @forsion/extend@${bundledVersion} = package.json 钉的 ${pinned}`, bundledVersion === pinned)
      const run1 = await launch(home, stub.url)
      await run1.app.close().catch(() => {})
      const seeded = fs.existsSync(path.join(installed, 'SIGNATURE')) && JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8')).version === bundledVersion
      check(`① 随包 @forsion/extend@${bundledVersion} 播种进 <home>/plugins/forsion-extend(含 SIGNATURE),[cloud-host] 装载成功`, seeded && run1.logs().includes(`[cloud-host] 已装载 forsion-extend@${bundledVersion}`), run1.logs().split('\n').filter((l) => l.includes('cloud-host') || l.includes('builtin-plugins')).join(' / ').slice(0, 300))
      check('② 渲染层四个云端键都在;未登录 accountQuota → 401;cloudFetch 绝对 URL → bad_path', run1.bridge.accountQuota === 'function' && run1.bridge.submitFeedback === 'function' && run1.bridge.cloudFetch === 'function' && run1.bridge.openPayCenter === 'function' && run1.bridge.quota?.status === 401 && run1.bridge.quota?.json === null && run1.bridge.evil?.error === 'bad_path', JSON.stringify(run1.bridge))
      check('②b Connect(0.2 起)由 Extend 注册:三个 connect 键在;meta 读不存在目录 → {};publish 越界目录被拒且不打云端', run1.bridge.connectStore === 'function' && run1.bridge.connectPublish === 'function' && run1.bridge.connectMeta === 'function' && JSON.stringify(run1.bridge.meta) === '{}' && run1.bridge.publishOutside?.ok === false && /只能发布|不存在/.test(String(run1.bridge.publishOutside?.detail)), JSON.stringify({ meta: run1.bridge.meta, publishOutside: run1.bridge.publishOutside }))

      // ③ 用户目录里的副本被改:抬版本 + 改入口 + 不重签
      const evil = fs.readFileSync(path.join(installed, 'dist', 'desktop.mjs'), 'utf8') + '\n// tampered'
      fs.writeFileSync(path.join(installed, 'dist', 'desktop.mjs'), evil)
      const m = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'))
      fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({ ...m, version: '9.9.9' }))
      const run2 = await launch(home, stub.url)
      await run2.app.close().catch(() => {})
      const healed = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8')).version === bundledVersion
        && !fs.readFileSync(path.join(installed, 'dist', 'desktop.mjs'), 'utf8').includes('// tampered')
      check('③ 改过的已装副本:播种验签失败后换回随包那份(9.9.9 → 随包版本),装载的是换回来的已装副本,账号面仍在', healed && run2.logs().includes('已装副本验签失败') && run2.logs().includes(`[cloud-host] 已装载 forsion-extend@${bundledVersion}(${installed})`) && run2.bridge.accountQuota === 'function' && run2.bridge.quota?.status === 401, run2.logs().split('\n').filter((l) => l.includes('cloud-host') || l.includes('builtin-plugins] forsion')).join(' / ').slice(0, 400))
    }
  } catch (e) {
    check('台架本身没炸', false, String(e?.stack || e).slice(0, 400))
  } finally {
    if (hidden) fs.renameSync(hidden, BUNDLED)
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${ABSENT ? '(负对照)' : ''}`)
  process.exit(failed ? 1 : 0)
})()
