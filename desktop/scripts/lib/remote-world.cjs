/**
 * 远程会话台架的「世界」(P1 · K9):假 hub + 真 standalone 引擎 + 真 unitWeb(挂真 K4 远程会话闸)+ 真 unitHost。
 * check:remotechain(手机形态页全链路)与 check:streamrenew(>1h 流续订)共用;手机那一端由调用方接(浏览器页或 Node 替身)。
 *
 * 与生产 main.ts 的对应(改 main.ts 的接线时同步这里):
 *   引擎    backendManager 的 spawn:TANGU_LOCAL_TOKEN(本机令牌)/ TANGU_TOKEN(云端账号)/ TANGU_REMOTE_MARK_SECRET / TANGU_HOST_CLIENT /
 *           --cloud-url(= 假 hub,所以 LLM 走「云端大脑」,api_usage 的 client 在 hub 这侧可观测)/ --sandbox none;隔离 TANGU_HOME、会话沙箱目录;
 *   unitWeb webDeps:getEngine / remoteAccess = createRemoteSessions(...).gate / readConfig(家目录 + 默认工作区)/ 主机文件面钳在工作区;
 *   unitHost getCreds(hub + 账号 token)/ getUnitWeb(url + internalSecret + proxyCallerKey)/ 配对只在内存。
 * 不在内:K2 急停 / 锁定(本分支未合入)、K7 caps 上报器(这里直接替它 POST 一次 caps {engine:'ready'})、seedGatedEngine(本机项目根种子)。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { loadTs } = require('./load-ts.cjs')
const { startFakeUnitHub, accountToken } = require('./fake-unit-hub.cjs')

const DESKTOP = path.resolve(__dirname, '../..')
const GENESIS = path.resolve(DESKTOP, '..')
const ENGINE_ENTRY = path.join(GENESIS, 'tangu-agent/dist/standalone/main.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })

/**
 * @param {object} o
 * @param {(call: object) => object[]} o.llm           假模型(见 fake-unit-hub brainFrames)
 * @param {string} [o.staticDir]                        手机页 dist(浏览器台架)
 * @param {string} [o.homeEngineUrl]
 * @param {{totalMs?: number, idleMs?: number}} [o.streamCut]
 * @param {object} [o.hubNegctl]
 * @param {(row: object) => void} [o.hubOnRegister]  假 hub 建完名册行之后调(模拟用户随后在名册里改名,R-25)
 * @param {(opts: object) => Promise<boolean|null>} [o.confirm]  K4 首次确认框的应答(缺省:允许)
 * @param {string} [o.desktopName]
 * @param {boolean} [o.approvalDelivery]  起真 K3 approvalDelivery(订阅引擎 /agent/approvals/stream,假通知,收件箱提醒打假 hub)。
 *        60s 升级提醒按「快进」跑:≥45s 的定时器 1.5s 就触发,同时把它的 now() 往前拨同样的量(引擎 idle 45s 的看门狗不受影响)。
 * @param {'zh'|'en'} [o.mainLocale]  主进程语言(确认框 / 系统通知的文案);缺省按 mainI18n 自己的回落
 * @param {(m: string) => void} [o.log]
 */
async function startRemoteWorld(o) {
  if (!fs.existsSync(ENGINE_ENTRY)) throw new Error(`缺引擎构建:先 cd tangu-agent && npm run build(期望 ${ENGINE_ENTRY})`)
  // 引擎 dist 比源码旧 = 测的是老代码(09-28 集成实测:dist 停在 P0,K1 调用方字段全缺,30/40 假红)。按 mtime 比,旧了就大声失败。
  const newestSrc = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((m, e) => {
    const f = path.join(dir, e.name)
    return Math.max(m, e.isDirectory() ? newestSrc(f) : (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? fs.statSync(f).mtimeMs : 0))
  }, 0)
  const srcAt = newestSrc(path.join(GENESIS, 'tangu-agent/src'))
  if (srcAt > fs.statSync(ENGINE_ENTRY).mtimeMs && !process.env.REMOTECHAIN_STALE_ENGINE_OK) {
    throw new Error(`引擎 dist 比 tangu-agent/src 旧:先 cd tangu-agent && npm run build(硬要跑旧 dist:REMOTECHAIN_STALE_ENGINE_OK=1)`)
  }
  const log = o.log || (() => {})
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-k9-'))
  const shared = path.join(out, 'forsion')
  const home = path.join(shared, 'tangu')
  const workspace = path.join(out, 'workspace')
  const sandboxDir = path.join(out, 'sessions')
  const userData = path.join(out, 'userData')
  for (const d of [home, workspace, sandboxDir, userData]) fs.mkdirSync(d, { recursive: true })

  const USER = `k9-${crypto.randomBytes(3).toString('hex')}`
  const JWT_SECRET = crypto.randomBytes(24).toString('hex')
  const DESKTOP_TOKEN = accountToken(USER)
  // 手机与桌面同一账号(hub 属主闸),token 串不同:一枚是手机登录的,一枚是电脑登录的
  const PHONE_TOKEN = DESKTOP_TOKEN.replace('.k9sig', '.k9phone')

  const hub = await startFakeUnitHub({ jwtSecret: JWT_SECRET, staticDir: o.staticDir, homeEngineUrl: o.homeEngineUrl, llm: o.llm, streamCut: o.streamCut, negctl: o.hubNegctl, onRegister: o.hubOnRegister })

  // ── 真 standalone 引擎(隔离 home)──
  const LOCAL_TOKEN = crypto.randomUUID()
  const REMOTE_MARK = crypto.randomUUID()
  const enginePort = await freePort()
  const engineLog = path.join(out, 'engine.log')
  const child = spawn(process.execPath, [ENGINE_ENTRY,
    '--port', String(enginePort), '--host', '127.0.0.1', '--data-dir', path.join(home, 'state.db'),
    '--sandbox', 'none', '--cloud-url', hub.url, '--model', 'k9-model',
  ], {
    env: {
      ...process.env,
      TANGU_HOME: home, TANGU_LOCAL_TOKEN: LOCAL_TOKEN, TANGU_TOKEN: DESKTOP_TOKEN, TANGU_REMOTE_MARK_SECRET: REMOTE_MARK,
      TANGU_HOST_CLIENT: 'desktop/9.9.9-k9', TANGU_DEFAULT_WORKSPACE: workspace, AGENT_SANDBOX_SESSION_DIR: sandboxDir,
      TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_ENABLED: '0',
      FORSION_DESKTOP_CONFIG: path.join(userData, 'tangu-desktop-config.json'),
      FORSION_REMOTE_LOCK_FILE: path.join(userData, 'remote-lock.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => fs.appendFileSync(engineLog, d))
  child.stderr.on('data', (d) => fs.appendFileSync(engineLog, d))
  let engineExit = null
  child.once('exit', (code, signal) => { engineExit = { code, signal } })
  const engineUrl = `http://127.0.0.1:${enginePort}`
  for (let i = 0; i < 200; i++) {
    if (engineExit) throw new Error(`引擎启动即退出 ${JSON.stringify(engineExit)}:\n${fs.readFileSync(engineLog, 'utf8').slice(-1500)}`)
    const ok = await fetch(`${engineUrl}/health`).then((r) => r.ok).catch(() => false)
    if (ok) break
    if (i === 199) throw new Error(`引擎 20s 未就绪:\n${fs.readFileSync(engineLog, 'utf8').slice(-1500)}`)
    await sleep(100)
  }
  const engineApi = async (p, init = {}) => {
    const r = await fetch(engineUrl + p, { ...init, headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) } })
    const text = await r.text()
    let body; try { body = JSON.parse(text) } catch { body = text }
    return { status: r.status, body }
  }

  // ── 真 unitWeb + 真 K4 远程会话闸 + 真 unitHost ──
  const M = loadTs(path.join(__dirname, 'remote-world.entry.ts'))
  const { startUnitWeb, UnitHost, forsionAccountId } = M
  const rsMod = M
  if (o.mainLocale) M.setMainLocale(o.mainLocale)
  const confirms = []
  const remoteSessions = rsMod.createRemoteSessions({
    file: () => path.join(userData, rsMod.REMOTE_SESSIONS_FILE || 'remote-sessions.json'),
    unitHostEnabled: async () => true,
    readCap: async () => 'auto-edit',
    writeCap: async () => {},
    accountId: () => forsionAccountId(hub.url, DESKTOP_TOKEN),
    lookupUnit: (unitId) => rsMod.lookupRosterUnit({ base: hub.url, token: DESKTOP_TOKEN }, unitId),
    confirm: async (opts, signal) => {
      confirms.push({ at: Date.now(), message: opts.message, detail: opts.detail })
      const a = o.confirm ? await o.confirm(opts, signal) : true
      return a
    },
    permitted: () => true,
    isLocked: () => false,
    onChanged: () => {},
    log: (m) => log(`[remoteSessions] ${m}`),
  })
  // 「允许远程会话」开着、信任表为空(新调用方要本机首次确认);不走 unitHostEnabled 迁移预置(那会预置账号行)
  fs.writeFileSync(path.join(userData, rsMod.REMOTE_SESSIONS_FILE || 'remote-sessions.json'), JSON.stringify({ v: 1, enabled: true, migratedFromUnitHost: true, trusted: [], accountStrict: [] }))
  await remoteSessions.init()

  const realRoots = [workspace, sandboxDir].map((d) => fs.realpathSync(d))
  const inRoots = (p) => { try { const r = fs.realpathSync(p); return realRoots.some((root) => r === root || r.startsWith(root + path.sep)) ? r : null } catch { return null } }
  const unitWeb = await startUnitWeb({
    remoteAccess: remoteSessions.gate,
    getEngine: () => ({ url: engineExit ? null : engineUrl, token: LOCAL_TOKEN, remoteMark: REMOTE_MARK }),
    confirmPair: async () => false,
    pairedDevices: { list: () => [], add: async () => {} },
    readPlugins: async () => [],
    readSpaces: async () => [],
    readConfig: async () => ({ homeDir: out, defaultWorkspaceDir: workspace }),
    writeConfig: async (p) => p,
    readProviders: async () => [],
    readHostFile: async (p) => {
      const r = inRoots(p); if (!r || !fs.statSync(r).isFile()) return null
      const buf = fs.readFileSync(r)
      return { mimeType: r.endsWith('.txt') ? 'text/plain' : 'application/octet-stream', content: buf.toString('base64'), size: buf.length }
    },
    readHostDir: async (p) => { const r = inRoots(p); if (!r || !fs.statSync(r).isDirectory()) return null; return fs.readdirSync(r, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory(), size: 0, path: path.join(p, e.name) })) },
    readHostStat: async (p) => { const r = inRoots(p); if (!r) return null; const st = fs.statSync(r); return { isDir: st.isDirectory(), mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs } },
    meta: { instanceId: `k9-${crypto.randomBytes(4).toString('hex')}`, name: o.desktopName || 'K9 Studio Mac', version: '9.9.9' },
    webDistDir: () => null,
    vault: () => null,
    log: (m) => log(`[unitWeb] ${m}`),
  }, { port: 0, bindHost: '127.0.0.1' })

  let pairing = null
  const unitHost = new UnitHost({
    getCreds: () => ({ cloudUrl: hub.url, token: DESKTOP_TOKEN }),
    getUnitWeb: () => ({ url: `http://127.0.0.1:${unitWeb.port}`, internalSecret: unitWeb.internalSecret, proxyCallerKey: unitWeb.proxyCallerKey }),
    getLanUrl: () => null,
    getPairing: () => pairing,
    savePairing: async (p) => { pairing = p },
    clearPairing: async () => { pairing = null },
    log: (m) => log(m),
  })
  unitHost.start()
  for (let i = 0; i < 100 && !(pairing && hub.online(pairing.unitId)); i++) await sleep(100)
  if (!pairing || !hub.online(pairing.unitId)) throw new Error('unitHost 10s 内没连上假 hub 的通道')
  const DESKTOP_UNIT = pairing.unitId
  const row = hub.units.get(DESKTOP_UNIT)
  row.name = o.desktopName || 'K9 Studio Mac' // 用户在名册里改过名(registered_name 仍是登记时的 hostname)
  // K7 的 caps 上报器(本分支未合入)在通道接上后会报一次;这里替它报,UnitsSheet 才显示「可用」
  await fetch(`${hub.url}/api/units/${DESKTOP_UNIT}/caps`, { method: 'POST', headers: { Authorization: `Bearer ${DESKTOP_TOKEN}`, 'X-Unit-Secret': pairing.secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'ready', tools: [] }) })

  // ── K3 待批送达(真 approvalDelivery,假通知)──
  let delivery = null
  const notes = []
  if (o.approvalDelivery) {
    const { createApprovalDelivery, mt } = M
    let skew = 0
    delivery = createApprovalDelivery({
      getEngine: () => ({ url: engineExit ? null : engineUrl, token: LOCAL_TOKEN }),
      onEngineStatus: (cb) => { cb(true); return () => {} },
      unitCreds: () => (pairing && hub.online(pairing.unitId) ? { cloudUrl: hub.url, token: DESKTOP_TOKEN, unitId: pairing.unitId, secret: pairing.secret } : null),
      t: mt,
      notify: (n) => { const rec = { ...n, at: Date.now(), closed: false }; notes.push(rec); return { close() { rec.closed = true }, onClick() {} } },
      openSession: () => {},
      log: (m) => log(m),
      now: () => Date.now() + skew,
      setTimeout: (fn, ms) => (ms > 45_000 ? setTimeout(() => { skew += ms - 1500; fn() }, 1500) : setTimeout(fn, ms)),
      clearTimeout: (h) => clearTimeout(h),
    })
    delivery.start()
  }

  /** 只读打开引擎 state.db(better-sqlite3 借 tangu-agent 的依赖)。 */
  function db() {
    const Database = require(path.join(GENESIS, 'tangu-agent/node_modules/better-sqlite3'))
    return new Database(path.join(home, 'state.db'), { readonly: true, fileMustExist: true })
  }

  return {
    out, home, workspace, sandboxDir, userData, engineLog, engineUrl, engineApi,
    hub, unitWeb, unitHost, remoteSessions, confirms, delivery, notes,
    USER, JWT_SECRET, DESKTOP_TOKEN, PHONE_TOKEN, LOCAL_TOKEN, REMOTE_MARK, DESKTOP_UNIT,
    get pairing() { return pairing },
    db,
    engineAlive: () => !engineExit,
    /** 收摊。产物目录(引擎 state.db / 日志 / 工作区 / userData)缺省删掉;keep(台架判红时)或 REMOTECHAIN_KEEP=1 时留下并打出路径。 */
    async close({ keep = false } = {}) {
      try { delivery?.stop() } catch { /* ignore */ }
      try { unitHost.stop() } catch { /* ignore */ }
      try { await unitWeb.close() } catch { /* ignore */ }
      try { hub.close() } catch { /* ignore */ }
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      for (let i = 0; i < 30 && !engineExit; i++) await sleep(100)
      if (!engineExit) try { child.kill('SIGKILL') } catch { /* ignore */ }
      if (keep || process.env.REMOTECHAIN_KEEP === '1') console.log(`  产物目录留着:${out}`)
      else try { fs.rmSync(out, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

module.exports = { startRemoteWorld, ENGINE_ENTRY, GENESIS, DESKTOP }
