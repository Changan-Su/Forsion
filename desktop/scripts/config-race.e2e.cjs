/**
 * 并发写配置不丢不坏 —— 真 Electron × 假引擎 × 两个真引擎写者子进程。
 *
 * 渲染层一拍里并发 5 个 setConfig(shell 键 3 个、config.json 段 2 个)+ 1 个 setUpdateBeta(saveHomeSection),
 * 连打 10 轮;同时两个 node 子进程直接 import 引擎构建产物 `tangu-agent/dist/core/config.js`,**往同一段 channels**
 * 各自每毫秒追加自己的键(a1..aN / b1..bN),写法同引擎生产调用点(updateSection 锁内读改写)。
 * 核对:两个进程指向同一份 config.json、每轮六个写入全部成功且落盘、两个引擎写者的键一个不少、子进程零报错、
 * 两份配置 JSON 合法、不留临时文件 / 锁、0600。开跑前核构建产物比源码新(防遗留产物假绿)。
 *
 * 钉住:main.ts 的 configQueue(本进程读改写串行)+ writePrivateJson(原子写)+ lockedUpdateJson(跨进程写锁),
 *      引擎 core/config.ts 的 updateConfigFile(同一把锁 + 原子写)。
 * 用法:先 electron-vite build(desktop)与 npm run build(tangu-agent),再 node scripts/config-race.e2e.cjs。
 *      ENGINE_DIST=<另一份 dist> 可换引擎构建做对照(不核新鲜度);WRITER=save 让引擎写者改用锁外读段 + saveSection 的旧写法。
 * 负对照(2026-09-17 实跑,干净 worktree):
 *   - 上一轮桌面(本进程队列 + 原子写,无跨进程锁)× 新引擎 → 3 FAIL:好几轮桌面键被引擎整份写回盖掉,两个引擎段各丢 1 / 7 个键;
 *   - 新桌面 × 旧引擎(saveSection 截断直写、无锁)→ 9 FAIL:两个引擎进程的截断写把 config.json 拼坏,引擎写者报 ~1600 次
 *     「解析失败,拒绝写入」、两段被清空,桌面 config:set 读到半截 JSON 被拒;
 *   - 更早(同日上一轮修复前):桌面自己并发 setConfig 就把两份配置都写成非法 JSON。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { pathToFileURL } = require('url')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const ENGINE_DIST = process.env.ENGINE_DIST || path.join(ROOT, '..', 'tangu-agent', 'dist')
const WRITER = process.env.WRITER === 'save' ? 'save' : 'update'
const ROUNDS = 10
let fails = 0
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 引擎侧写者:往 SECTION 段里追加 PREFIX1..N。update = 生产写法(updateSection 锁内读改写);save = 旧写法(锁外读段再 saveSection)
const ENGINE_WRITER = `
const cfg = await import(process.env.CFG_URL)
const { configFile } = await import(process.env.HOME_URL)
console.log('FILE ' + configFile())
const name = process.env.SECTION
const prefix = process.env.PREFIX
let n = 0
const errors = []
const end = Date.now() + Number(process.env.DURATION_MS)
while (Date.now() < end) {
  try {
    const key = prefix + (n + 1)
    if (process.env.WRITER === 'save') cfg.saveSection(name, { ...(cfg.getRawSection(name) || {}), [key]: n + 1 })
    else cfg.updateSection(name, (sec) => ({ ...(sec || {}), [key]: n + 1 }))
    n++
  } catch (e) { errors.push(String((e && e.message) || e)) }
  await new Promise((r) => setTimeout(r, 1))
}
console.log('DONE ' + JSON.stringify({ n, errors: errors.length, firstError: errors[0] || null }))
`
function startEngineWriter(home, section, prefix, durationMs) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', ENGINE_WRITER], {
    env: {
      ...process.env,
      TANGU_HOME: home,
      SECTION: section,
      PREFIX: prefix,
      WRITER,
      DURATION_MS: String(durationMs),
      CFG_URL: pathToFileURL(path.join(ENGINE_DIST, 'core', 'config.js')).href,
      HOME_URL: pathToFileURL(path.join(ENGINE_DIST, 'core', 'tanguHome.js')).href,
    },
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise((resolve) => child.on('exit', (code) => {
    const file = /^FILE (.*)$/m.exec(out)?.[1]
    const result = /^DONE (.*)$/m.exec(out)?.[1]
    resolve({ section, prefix, code, file, result: result ? JSON.parse(result) : null, err: err.slice(0, 300) })
  }))
  return done
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/ —— 先 electron-vite build'); process.exit(1) }
  if (!fs.existsSync(path.join(ENGINE_DIST, 'core', 'config.js'))) { console.error(`缺 ${ENGINE_DIST}/core/config.js —— 先在 tangu-agent 里 npm run build`); process.exit(1) }
  // 产物比源码旧 = 测的不是当前代码(遗留构建会让台架假绿)
  const mtime = (p) => fs.statSync(p).mtimeMs
  const stale = [
    ...['electron/main.ts', 'electron/configWrite.ts'].filter((src) => mtime(path.join(ROOT, src)) > mtime(path.join(ROOT, 'out/main/main.js'))).map((src) => `out/main/main.js 旧于 ${src}(先 electron-vite build)`),
    ...(process.env.ENGINE_DIST ? [] : [path.join(ROOT, '..', 'tangu-agent', 'src', 'core', 'config.ts')].filter((src) => mtime(src) > mtime(path.join(ENGINE_DIST, 'core', 'config.js'))).map(() => 'tangu-agent/dist/core/config.js 旧于 src/core/config.ts(先 npm run build)')),
  ]
  if (stale.length) { console.error(stale.join('\n')); process.exit(1) }
  const stub = await startStubEngine({ sessions: [], messages: [], models: [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cfgrace-'))
  const userData = path.join(home, 'userdata')
  const shellFile = path.join(userData + '-dev', 'tangu-desktop-config.json') // dev 实例 userData 加 -dev 后缀
  const homeFile = path.join(home, 'config.json') // TANGU_HOME 重定向后 config.json 就在它下面
  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => typeof window.tangu?.setConfig === 'function', null, { timeout: 30000 })
    await win.waitForTimeout(4000) // 启动期自己的配置写入先落定
    const parse = (file, label) => {
      const raw = fs.readFileSync(file, 'utf8')
      try { return JSON.parse(raw) } catch (e) { check(`${label} ${path.basename(file)} 是合法 JSON`, false, `${e.message} 原文=${JSON.stringify(raw.slice(0, 200))}`); return {} }
    }

    const writers = [startEngineWriter(home, 'channels', 'a', 4000), startEngineWriter(home, 'channels', 'b', 4000)] // 两个进程改同一段
    await sleep(300) // 子进程起来、开始写
    const bad = []
    for (let round = 1; round <= ROUNDS; round++) {
      const statuses = await win.evaluate(async (n) => {
        const t = window.tangu
        const all = Promise.allSettled([
          t.setConfig({ lastApprovalMode: `r${n}-approval` }),
          t.setConfig({ summaryOpenIn: `r${n}-summary` }),
          t.setConfig({ agentDeskEnabled: n % 2 === 1 }),
          t.setConfig({ notesDailyFolder: `r${n}-daily` }),
          t.setConfig({ ttsVoice: `r${n}-voice` }),
          t.setUpdateBeta(n % 2 === 1),
        ]).then((rs) => rs.map((r) => (r.status === 'fulfilled' ? 'ok' : `rejected:${r.reason}`)))
        return Promise.race([all, new Promise((r) => setTimeout(() => r('TIMEOUT(疑似队列自等死锁)'), 15000))])
      }, round)
      const shell = parse(shellFile, `R${round}`)
      const cfg = parse(homeFile, `R${round}`)
      const lost = []
      if (shell.lastApprovalMode !== `r${round}-approval`) lost.push('shell.lastApprovalMode')
      if (shell.summaryOpenIn !== `r${round}-summary`) lost.push('shell.summaryOpenIn')
      if (shell.agentDeskEnabled !== (round % 2 === 1)) lost.push('shell.agentDeskEnabled')
      if (cfg.notes?.dailyFolder !== `r${round}-daily`) lost.push('config.notes.dailyFolder')
      if (cfg.tts?.voice !== `r${round}-voice`) lost.push('config.tts.voice')
      if (cfg.updater?.beta !== (round % 2 === 1)) lost.push('config.updater.beta')
      const failed = Array.isArray(statuses) ? statuses.filter((s) => s !== 'ok') : [statuses]
      if (failed.length || lost.length) bad.push(`R${round}: ${failed.length} 个写入失败 ${failed.slice(0, 1).join('').slice(0, 160)} / 丢 ${lost.join(',')}`)
      await sleep(150)
    }
    check(`R1-${ROUNDS} 每轮六个并发写入全部成功且落盘(引擎两个进程同时在写)`, bad.length === 0, bad.slice(0, 3).join(' ‖ '))

    const engines = await Promise.all(writers)
    const cfg = parse(homeFile, 'END')
    const keys = Object.keys(cfg.channels || {})
    for (const w of engines) {
      check(`E-${w.prefix}a 引擎写者与桌面指向同一份 config.json`, w.file === homeFile, `${w.file} vs ${homeFile}`)
      check(`E-${w.prefix}b 引擎写者正常退出、零报错、确实写了很多次`, w.code === 0 && w.result && w.result.errors === 0 && w.result.n > 200, JSON.stringify({ code: w.code, ...w.result, err: w.err }))
      const n = w.result?.n || 0
      const missing = []
      for (let i = 1; i <= n; i++) if (!keys.includes(`${w.prefix}${i}`)) missing.push(i)
      check(`E-${w.prefix}c 同段写者 ${w.prefix}1..${w.prefix}${n} 一个不少(没被另一个引擎进程或桌面盖掉)`, n > 0 && missing.length === 0, `缺 ${missing.length} 个,如 ${missing.slice(0, 5).join(',')}`)
    }
    const total = engines.reduce((s, w) => s + (w.result?.n || 0), 0)
    check('E-d channels 段键数 = 两个写者写入次数之和(没有多余 / 残缺)', keys.length === total, `${keys.length} vs ${total}`)
    const last = ROUNDS
    const shell = parse(shellFile, 'END')
    const lostEnd = []
    if (shell.lastApprovalMode !== `r${last}-approval`) lostEnd.push('shell.lastApprovalMode')
    if (cfg.notes?.dailyFolder !== `r${last}-daily`) lostEnd.push('config.notes.dailyFolder')
    if (cfg.tts?.voice !== `r${last}-voice`) lostEnd.push('config.tts.voice')
    if (cfg.updater?.beta !== (last % 2 === 1)) lostEnd.push('config.updater.beta')
    check('END 引擎写完之后桌面最后一轮的键仍在(没被引擎的整份写回盖掉)', lostEnd.length === 0, lostEnd.join(','))

    const leftovers = [userData + '-dev', home].flatMap((d) => fs.readdirSync(d).filter((f) => /\.(tmp|lock)$|\.stale-/.test(f)))
    check('R4 两个配置目录都没留临时文件 / 锁', leftovers.length === 0, leftovers.join(','))
    if (process.platform !== 'win32') {
      const modes = [shellFile, homeFile].map((f) => (fs.statSync(f).mode & 0o777).toString(8))
      check('R5 两份配置文件都是 0600(含 token / apiKey / 配对密钥)', modes.every((m) => m === '600'), modes.join(','))
    }
  } finally {
    await app.close().catch(() => {})
    try { stub.close?.() } catch { /* ignore */ }
  }
  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
