/**
 * Vault sync hand-over, end to end: turning the new sync off gives the vault back to the legacy sync.
 *
 * Real Electron (this checkout's out/) × one-use test-signed Forsion Extend (EXTEND_PKG's dist/) × the REAL standalone engine
 * (../tangu-agent/dist, spawned by the host in managed mode with the fake account's credentials) × isolated temp home ×
 * local fake cloud (scripts/lib/vault-sync-cloud.cjs). Never reads ~/.forsion*, ~/.tangu, real userData or a real server.
 *
 * Story (all through the real UI where a user would click):
 *   B  legacy entry sync is configured for a few entries and uploads an edit;
 *   C  Penzor › Sync, first open: switch on Notes + My profile, Start syncing → Extend claims, the legacy sync stops;
 *   R  switch both off, Confirm → Extend releases: state file owned:false without `releasing`, host PUT /agent/sync/content-owner
 *      {enabled:false} to the engine, the engine drops `owner` from agents/.cloudsync-default.json, the legacy sync restarts and
 *      uploads an in-scope edit; the human/ consent (`enabled` for this account) is untouched;
 *   M  over the whole run, no request touches `.forsion-sync-id.json` (upload, download, delete, move).
 *
 * Negative controls (NEG=…) patch throwaway copies only, must show their fault actually fired (F-fault-exercised), and must
 * turn exactly the declared checks red:
 *   release-fails  host → engine release PUT answers 500 (main-process fetch wrapper)
 *   no-restart     host claim(false) skips restartSync()       (patched copy of out/main/main.js)
 *   no-stop        host claim(true) skips stopSync()           (patched copy of out/main/main.js)
 *   marker         legacy sync stops ignoring the marker        (patched copy of Extend dist, signed with the one-use key)
 *   human-off      engine release also turns the human/ consent off (patched copy of the engine dist)
 *
 * Prereqs: cd ../tangu-agent && npm run build; npm run build (here, for out/); Extend: npm run build (dist/).
 * Run (takes the GUI lock; several sessions share this machine):
 *   EXTEND_PKG=<built Extend checkout> node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="sync release" --eta=20 -- \
 *     node scripts/sync-release.e2e.cjs --all          (or: npm run e2e:syncrelease)
 * Single scenario: NEG=<name> node scripts/sync-release.e2e.cjs. ELECTRON_BIN=<Electron binary> when node_modules has none
 * (its dist/version must match desktop's electron). Evidence (local only, may hold temp paths): SYNC_EVIDENCE
 * (default <tmp>/forsion-sync-release-evidence). KEEP_HOME=1 keeps the temp home for inspection.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { spawnSync, execFileSync } = require('child_process')

const ROOT = path.resolve(process.env.GENESIS_DESKTOP || path.join(__dirname, '..'))
const ENGINE = path.resolve(ROOT, '..', 'tangu-agent')
const EXTEND = path.resolve(process.env.EXTEND_PKG || path.join(ROOT, '..', '..', 'Forsion-Extend'))
const NEG = process.env.NEG || ''
const OUT = path.resolve(process.env.SYNC_EVIDENCE || path.join(os.tmpdir(), 'forsion-sync-release-evidence'))
const MARKER = '.forsion-sync-id.json'
const MARKER_RE = /(^|\/)\.forsion-sync-id\.json$/
const SCENARIO_DEADLINE_MS = 12 * 60_000

/** Which checks each scenario must turn red (setup checks S* / F* must stay green in every scenario). */
const EXPECT_RED = {
  '': [],
  'release-fails': ['R1-state-released', 'R2-host-release-call', 'R3-engine-owner-dropped', 'R4-legacy-restarted', 'R5-legacy-uploads', 'H-human-consent'],
  'no-restart': ['R4-legacy-restarted', 'R5-legacy-uploads'],
  'no-stop': ['C2-legacy-stopped'],
  marker: ['M-marker-untouched'],
  'human-off': ['H-human-consent'],
}
const ALL_CHECKS = ['C1-claimed', 'C2-legacy-stopped', 'R1-state-released', 'R2-host-release-call', 'R3-engine-owner-dropped', 'R4-legacy-restarted', 'R5-legacy-uploads', 'H-human-consent', 'M-marker-untouched']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const until = async (fn, ms, step = 500) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step) } }

/** Replace exactly one occurrence, or fail loudly (a silent no-op patch makes a negative control vacuous). */
function patchOnce(file, from, to) {
  const src = fs.readFileSync(file, 'utf8')
  const n = src.split(from).length - 1
  if (n !== 1) throw Error(`patch anchor matched ${n}× in ${path.basename(file)}: ${from.slice(0, 80)}`)
  fs.writeFileSync(file, src.replace(from, () => to))
}

// ───────────────────────────── --all: run every scenario as its own process ─────────────────────────────
if (process.argv.includes('--all')) {
  const rows = []
  for (const neg of Object.keys(EXPECT_RED)) {
    console.log(`\n=== scenario ${neg || 'positive'} ===`)
    const file = path.join(OUT, `${neg || 'positive'}.json`)
    fs.rmSync(file, { force: true })
    const r = spawnSync(process.execPath, [__filename], { stdio: 'inherit', env: { ...process.env, NEG: neg }, timeout: SCENARIO_DEADLINE_MS, killSignal: 'SIGTERM' })
    const res = readJson(file)
    rows.push({ neg: neg || 'positive', exit: r.status, pass: r.status === 0 && res?.pass === true, red: res?.red ?? null, setupOk: res?.setupOk ?? false, timedOut: r.error?.code === 'ETIMEDOUT' })
  }
  console.log('\nsummary')
  for (const x of rows) console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.neg.padEnd(14)} red=${JSON.stringify(x.red)}${x.setupOk ? '' : '  (setup failed)'}${x.timedOut ? '  (timed out)' : ''}`)
  process.exit(rows.every((x) => x.pass) ? 0 : 1)
}

// ───────────────────────────── seed ─────────────────────────────
const note = (title, lines) => `# ${title}\n\n${lines.join('\n')}\n`
const ENTRIES = [
  { path: 'Inbox.md', kind: 'page' },
  { path: 'Projects/Course A', kind: 'folder' },
  { path: 'Journal', kind: 'folder' },
  { path: 'Reading', kind: 'folder' },
]
const CLOUD_NAME = 'Notes'
const AMADEUS_DEVICE_ID = 'desk-rig0000000000000'
const CONTENT_DEVICE_ID = '0b6e1d1c-3f0a-4c55-9a51-6a2d7c1e9f00'
const marker = (id) => JSON.stringify({ id })
/** Markers in legacy scope: both sides (Course A), local only (Journal), cloud only (Reading). */
const LOCAL_MARKERS = { [`Projects/Course A/${MARKER}`]: marker('7d3c0e57-8a3b-4b4e-9f8e-2c1a6b5d4e30'), [`Journal/${MARKER}`]: marker('2a4b6c8d-1e3f-4a5b-8c7d-9e0f1a2b3c4d') }
const CLOUD_MARKERS = { [`${CLOUD_NAME}/Projects/Course A/${MARKER}`]: marker('1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b'), [`${CLOUD_NAME}/Reading/${MARKER}`]: marker('5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9') }
const localFiles = () => ({
  'Inbox.md': note('Inbox', ['- [ ] Read chapter 3']),
  'Projects/Course A/Course A.md': note('Course A', ['- [[L01 Basics]]']),
  'Projects/Course A/L01 Basics.md': note('L01 Basics', ['- Definitions first.']),
  'Journal/2026-W47.md': note('2026-W47', ['- Tidied the notes.']),
  'Journal/2026-W48.md': note('2026-W48', ['- Sorted out sync.']),
  'Reading/Overview.md': note('Overview', ['- Collected material.']),
  'Home.md': note('Home', ['- [[Inbox]]']), // local only
  'Todo.md': note('Todo', ['- [ ] Hand in homework']), // local only
  ...LOCAL_MARKERS, // left by earlier new-sync rules on those folders
})
const covered = (rel) => ENTRIES.some((e) => e.path === rel || (e.kind === 'folder' && rel.startsWith(e.path + '/')))
function cloudFiles() {
  const f = {}
  for (const [rel, data] of Object.entries(localFiles())) if (covered(rel) && !MARKER_RE.test(rel)) f[`${CLOUD_NAME}/${rel}`] = data
  f[`${CLOUD_NAME}/.forsion-vault.md`] = `---\ndevices: ${JSON.stringify([{ id: AMADEUS_DEVICE_ID, name: 'Rig Mac', since: '2026-08-12' }])}\n---\n`
  Object.assign(f, CLOUD_MARKERS) // uploaded as plain files by an older client
  f['Welcome.md'] = note('Welcome', ['Written on the web.'])
  return f
}
const accountIdOf = (cloudUrl) => { const u = new URL(cloudUrl); return `${u.origin}${u.pathname.replace(/\/+$/, '')}::u1` }
const jwt = () => 'header.' + Buffer.from(JSON.stringify({ userId: 'u1', sub: 'u1' })).toString('base64url') + '.signature'
/** Engine agentSyncScope: sha256(JSON.stringify([normalized cloud origin, userId])) (services/cloudSyncAccount.ts cloudIdentity). */
const engineScopeOf = (cloudUrl) => { const u = new URL(cloudUrl); return sha(JSON.stringify([`${u.origin}${u.pathname.replace(/\/+$/, '')}`, 'u1'])) }

function seedHome({ home, cloudUrl, extendPkg }) {
  const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
  const vault = path.join(home, 'Documents', 'Notes')
  const workspace = path.join(home, 'Forsion')
  const userData = path.join(home, 'userdata')
  for (const [rel, data] of Object.entries(localFiles())) w(path.join(vault, rel), data)
  w(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl, token: jwt() }))
  // A real install already has config.json. Without it the engine's first-run legacy migration (core/config.ts
  // migrateLegacyConfig) moves auth.json into config.json and renames it to .bak, and the host reads that as signed out.
  w(path.join(home, 'config.json'), JSON.stringify({ cloud: { url: cloudUrl, token: jwt(), defaultModel: '' } }))
  w(path.join(home, 'content-sync-device.json'), JSON.stringify({ id: CONTENT_DEVICE_ID, name: 'Rig Mac' })) // no hostname fallback
  // A My-profile file the first new-sync round can carry no matter how far the engine got with its own human/ files
  // (HUMAN.md is on Extend's human/ whitelist and the engine's legacy mirror leaves it alone).
  w(path.join(home, 'tangu', 'human', 'HUMAN.md'), note('About me', ['- Prefers short answers.']))
  // human/ consent on before the new sync ever claims (the account switch the engine keeps per cloud account)
  const scope = engineScopeOf(cloudUrl)
  w(path.join(home, 'tangu', 'agents', '.cloudsync-default.json'), JSON.stringify({ accounts: { [scope]: { enabled: true, revision: 1 } } }, null, 2))
  const accountId = accountIdOf(cloudUrl)
  const amadeusConfig = {
    lastVault: vault, localVault: vault, vaults: [{ root: vault }],
    cloudAccounts: { [sha(accountId)]: {
      cloudSync: { enabled: true, vaultId: 'v-main', deviceId: AMADEUS_DEVICE_ID },
      entrySync: [{ vaultRoot: vault, cloudName: CLOUD_NAME, entries: ENTRIES }],
    } },
  }
  for (const d of [userData, userData + '-dev']) {
    fs.mkdirSync(d, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) w(path.join(d, f), JSON.stringify(amadeusConfig, null, 2))
    w(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', cloudUrl, defaultWorkspaceDir: workspace }))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(extendPkg, 'package.json'), 'utf8'))
  const dest = path.join(home, 'plugins', 'forsion-extend')
  for (const f of ['package.json', ...pkg.files]) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.cpSync(path.join(extendPkg, f), path.join(dest, f), { recursive: true }) }
  return { vault, workspace, userData, accountId, scope, stateFile: path.join(home, 'content-sync', sha(accountId) + '.json'), engineDefaults: path.join(home, 'tangu', 'agents', '.cloudsync-default.json') }
}

// ───────────────────────────── preflight ─────────────────────────────
function preflight() {
  const main = path.join(ROOT, 'out/main/main.js'), engine = path.join(ENGINE, 'dist/standalone/main.js'), ext = path.join(EXTEND, 'dist/desktop.mjs')
  for (const [f, hint] of [[main, 'npm run build (desktop)'], [engine, 'cd ../tangu-agent && npm run build'], [ext, 'npm run build in EXTEND_PKG']]) if (!fs.existsSync(f)) throw Error(`missing ${f}: ${hint}`)
  if (!fs.readFileSync(main, 'utf8').includes('/agent/sync/content-owner')) throw Error('out/main/main.js predates content ownership; rebuild desktop')
  if (!fs.readFileSync(path.join(ENGINE, 'dist/routes/memory.js'), 'utf8').includes('content-owner')) throw Error('engine dist predates /agent/sync/content-owner; rebuild tangu-agent')
  const extSrc = fs.readFileSync(ext, 'utf8')
  if (!extSrc.includes('releasing') || !extSrc.includes(MARKER)) throw Error('Extend dist predates the step-0 release / marker ignore; rebuild Extend')
  if (process.env.ELECTRON_BIN) {
    const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version
    const verFile = path.resolve(path.dirname(process.env.ELECTRON_BIN), '../../../version')
    const got = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf8').trim().replace(/^v/, '') : null
    if (got !== want) throw Error(`ELECTRON_BIN is Electron ${got}, desktop wants ${want}`)
  }
  // Build provenance: an artifact older than its checkout's HEAD commit was not built from what we report.
  const git = (d, ...a) => { try { return execFileSync('git', ['-C', d, ...a]).toString().trim() } catch { return null } }
  const heads = {}
  for (const [key, dir, file] of [['genesis', ROOT, main], ['engine', ENGINE, engine], ['extend', EXTEND, ext]]) {
    const head = git(dir, 'rev-parse', '--short', 'HEAD'), at = Number(git(dir, 'log', '-1', '--format=%ct')) * 1000, built = fs.statSync(file).mtimeMs
    if (at && built < at) throw Error(`${path.relative(dir, file)} (built ${new Date(built).toISOString()}) is older than ${key} HEAD ${head}; rebuild`)
    heads[key] = { head, dirty: !!git(dir, 'status', '--porcelain', '--untracked-files=no'), built: new Date(built).toISOString() }
  }
  return heads
}

/** Throwaway Extend copy for NEG=marker: the legacy ignore list loses the marker. Signed afterwards by preparePenzorFixture. */
function extendForScenario(tmp) {
  if (NEG !== 'marker') return EXTEND
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTEND, 'package.json'), 'utf8'))
  const dest = path.join(tmp, 'extend-src')
  for (const f of ['package.json', ...pkg.files, 'scripts']) if (fs.existsSync(path.join(EXTEND, f))) { fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.cpSync(path.join(EXTEND, f), path.join(dest, f), { recursive: true }) }
  const file = path.join(dest, 'dist/desktop.mjs'), src = fs.readFileSync(file, 'utf8')
  const m = /var (\w+)="\.forsion-sync-id\.json";function \w+\((\w+)\)\{return!!\(/.exec(src)
  if (!m) throw Error('marker ignore anchor not found in Extend dist')
  const needle = `||${m[2]}===${m[1]}||`, at = src.indexOf(needle, m.index)
  if (at < 0 || at - m.index > 200) throw Error('marker ignore clause not found next to its constant')
  fs.writeFileSync(file, src.slice(0, at) + '||' + src.slice(at + needle.length))
  return dest
}

/** The host resolves the dev engine at <app>/../tangu-agent/dist/standalone/main.js. Link it; NEG=human-off gets a patched dist copy. */
function linkEngine(fixtureRoot) {
  const dest = path.join(fixtureRoot, 'tangu-agent')
  if (NEG !== 'human-off') { fs.symlinkSync(ENGINE, dest); return }
  fs.mkdirSync(dest)
  for (const name of fs.readdirSync(ENGINE)) if (name !== 'dist') fs.symlinkSync(path.join(ENGINE, name), path.join(dest, name))
  fs.cpSync(path.join(ENGINE, 'dist'), path.join(dest, 'dist'), { recursive: true })
  patchOnce(path.join(dest, 'dist/services/cloudSyncAccount.js'), 'accounts[scope] = { enabled: cur?.enabled ?? false,', 'accounts[scope] = { enabled: enabled && (cur?.enabled ?? false),')
}

function patchHost(appDir) {
  const main = path.join(appDir, 'out/main/main.js')
  if (NEG === 'no-stop') patchOnce(main, 'if (owned) await host.stopSync();', 'if (owned) await Promise.resolve();')
  if (NEG === 'no-restart') patchOnce(main, 'else await host.restartSync();', 'else await Promise.resolve();')
}

// ───────────────────────────── run ─────────────────────────────
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const name = NEG || 'positive'
  if (!(NEG in EXPECT_RED)) throw Error(`unknown NEG=${NEG}; one of ${Object.keys(EXPECT_RED).filter(Boolean).join(', ')}`)
  const result = { scenario: name, heads: preflight(), checks: [], setup: [], setupOk: false, red: [], pass: false }
  const log = (...a) => console.log(`[sync-release:${name}]`, ...a)
  const check = (bucket, id, ok, detail) => { result[bucket].push({ id, ok: !!ok, detail }); log(ok ? 'ok  ' : 'RED ', id, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }

  const electron = require(path.join(ROOT, 'scripts/lib/launch-electron.cjs'))
  const { skipOnboarding } = require(path.join(ROOT, 'scripts/lib/skip-onboarding.cjs'))
  const { startVaultSyncCloud } = require(path.join(ROOT, 'scripts/lib/vault-sync-cloud.cjs'))
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-syncrel-')))
  let fixture = null, cloud = null, app = null, win = null, enginePid = null, fault = null
  try {
    const home = path.join(tmp, 'home'); fs.mkdirSync(home)
    fixture = await require(path.join(ROOT, 'scripts/lib/penzor-fixture.cjs')).preparePenzorFixture(ROOT, extendForScenario(tmp))
    linkEngine(fixture.root)
    patchHost(fixture.app)
    cloud = await startVaultSyncCloud({ vaultFiles: cloudFiles(), devices: [[CONTENT_DEVICE_ID, 'Rig Mac']], desktop: ROOT })
    const seed = seedHome({ home, cloudUrl: cloud.url, extendPkg: fixture.extend })
    const vaultReal = fs.realpathSync(seed.vault)
    const vaultFile = (rel) => path.join(seed.vault, rel)
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TANGU_|FORSION_|PI_CU_|ELECTRON_|GENESIS_DESKTOP$|EXTEND_PKG$|NEG$|KEEP_HOME$|SYNC_EVIDENCE$)/.test(k)))
    Object.assign(env, {
      TANGU_HOME: home, FORSION_WORKSPACE_DIR: seed.workspace, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock'),
      TANGU_BROWSER_EXTENSION_PORT: String(await freePort()), TANGU_MCP_OAUTH_PORT: String(await freePort()),
    })
    app = await electron.launch({ ...(process.env.ELECTRON_BIN ? { executablePath: process.env.ELECTRON_BIN } : {}), args: [`--user-data-dir=${seed.userData}`, '--lang=zh-CN', fixture.app], cwd: fixture.app, env, timeout: 120_000 })
    win = await app.firstWindow({ timeout: 120_000 })
    win.on('pageerror', (e) => log('pageerror', String(e).slice(0, 200)))
    await win.waitForSelector('#root', { timeout: 60_000 })
    await skipOnboarding(win)
    win.setDefaultTimeout(15_000)
    // Record (and for NEG=release-fails, refuse) every host → engine ownership call in the main process, with Extend's
    // persisted state at the moment the host dispatches it.
    await app.evaluate((_e, { failRelease, stateFile }) => {
      if (globalThis.__ownerCalls) return
      const orig = globalThis.fetch, rfs = process.getBuiltinModule('fs')
      globalThis.__ownerCalls = []
      globalThis.fetch = async (input, init) => {
        const url = String(input?.url ?? input)
        if (!url.endsWith('/agent/sync/content-owner')) return orig(input, init)
        let body = null; try { body = JSON.parse(init?.body ?? 'null') } catch { /* keep null */ }
        let state = null; try { const s = JSON.parse(rfs.readFileSync(stateFile, 'utf8')); state = { owned: s.owned, releasing: s.releasing ?? null } } catch { /* none yet */ }
        const rec = { at: Date.now(), url, method: init?.method ?? 'GET', body, auth: init?.headers?.Authorization ?? null, state, status: 0 }
        globalThis.__ownerCalls.push(rec)
        if (failRelease && body?.enabled === false) { rec.status = 500; rec.injected = true; return new Response('{"detail":"rig refused release"}', { status: 500 }) }
        const r = await orig(input, init); rec.status = r.status; return r
      }
    }, { failRelease: NEG === 'release-fails', stateFile: seed.stateFile })
    const ownerCalls = () => app.evaluate(() => globalThis.__ownerCalls.map(({ auth, ...r }) => ({ ...r, hasAuth: !!auth })))
    const engineToken = () => app.evaluate(() => [...globalThis.__ownerCalls].reverse().find((r) => r.auth)?.auth ?? null)
    const backendStatus = () => win.evaluate(() => window.tangu?.backendStatus?.()).catch(() => null)

    const backend = await until(() => backendStatus().then((s) => (s?.state === 'ready' && s.url ? s : null)), 120_000, 1000)
    check('setup', 'S0-real-engine-ready', !!backend, backend && { url: backend.url })
    if (!backend) throw Error('engine never became ready')
    enginePid = backend.pid
    // The renderer talks to the engine with the local token; keep the latest one per engine origin (claiming restarts the
    // engine on a new port, so neither the URL nor the token read at boot can be reused).
    const rendererTokens = new Map()
    win.on('request', (r) => { try { const a = r.headers().authorization; if (a) rendererTokens.set(new URL(r.url()).origin, a) } catch { /* not a URL */ } })
    const later = win.getByRole('button', { name: '稍后', exact: true })
    if (await later.first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) await later.first().click()

    /** GET /agent/sync/default on whatever engine is current, retrying through an engine restart (up to 45 s). */
    const humanDefault = async () => {
      let last = { error: 'engine not ready' }
      const got = await until(async () => {
        const s = await backendStatus()
        if (s?.state !== 'ready' || !s.url) return null
        enginePid = s.pid ?? enginePid
        const auth = rendererTokens.get(new URL(s.url).origin) || (await engineToken())
        if (!auth) { last = { error: 'no engine token seen yet' }; return null }
        try {
          const r = await fetch(`${s.url}/agent/sync/default`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(5000) })
          last = { status: r.status, ...(await r.json()) }
          return r.ok ? last : null
        } catch (e) { last = { error: String(e) }; return null }
      }, 45_000, 1000)
      return got ?? last
    }
    /** Legacy engines over IPC; null = could not read them (never treated as "stopped"). */
    const legacy = () => win.evaluate(async () => { const r = await window.amadeusSync?.getAll?.(); return Array.isArray(r?.engines) ? r.engines.map((e) => ({ state: e.state, binding: e.binding ?? null, shareKey: e.shareKey ?? null })) : null }).catch(() => null)
    const seededEntry = (engines) => (engines || []).find((e) => e.binding && fs.realpathSync(e.binding) === vaultReal)
    const entryRunning = (engines) => ['idle', 'syncing', 'starting'].includes(seededEntry(engines)?.state)
    const contentStatus = () => win.evaluate(async () => { const r = await window.tangu?.cloudInvoke?.('penzor:sync:status'); return r && typeof r === 'object' && 'value' in r ? r.value : r }).catch((e) => ({ error: String(e) }))
    const appendLine = (rel, token) => fs.appendFileSync(vaultFile(rel), `- rig ${token}\n`)
    /** The legacy entry writer stored `token` at exactly `remote` (not a conflict copy elsewhere). */
    const landed = (token, remote) => cloud.writesWith(token).some((r) => r.names[0] === remote) && (cloud.files.get(remote)?.content ?? '').includes(token)

    // ── B: the legacy entry sync is alive before anything else ──
    const settled = await until(async () => { const l = await legacy(); return seededEntry(l)?.state === 'idle' ? l : null }, 90_000, 1000)
    check('setup', 'S1-legacy-entry-sync-idle', !!settled, settled ?? (await legacy()))
    const t0 = `T0-${crypto.randomBytes(4).toString('hex')}`
    appendLine('Inbox.md', t0)
    const b0 = await until(() => landed(t0, `${CLOUD_NAME}/Inbox.md`), 30_000)
    check('setup', 'S2-legacy-uploads-before-claim', b0, { token: t0, writes: cloud.writesWith(t0).map((r) => r.names[0]) })
    const h0 = await humanDefault()
    check('setup', 'S3-human-consent-on-before-claim', h0.status === 200 && h0.enabled === true, h0)

    // ── C: claim through Penzor › Sync (first open) ──
    const openSync = async () => {
      let b = win.locator('.rb [aria-label="蓬洲云"]').first()
      if (!(await b.count()) || !(await b.isVisible().catch(() => false))) { await win.locator('.rb-more[data-rb-more="top"]').click().catch(() => {}); await sleep(500); b = win.locator('[aria-label="蓬洲云"]').first() }
      await b.click(); await win.mouse.move(800, 500)
      await win.waitForSelector('.pz', { timeout: 30_000 })
      await win.locator('.t2s-srow-title', { hasText: /^同步$/ }).first().click()
      await win.waitForSelector('.pz-sync-card', { timeout: 30_000 })
    }
    const sw = (label) => win.locator(`.pz-sync-card button[role="switch"][aria-label="${label}"]`).first()
    const setRow = async (label, on) => { const s = sw(label); if ((await s.getAttribute('aria-checked')) !== String(on)) await s.click(); await until(async () => (await s.getAttribute('aria-checked')) === String(on), 5000, 200) }
    const barPrimary = () => win.locator('.pz-cs-bar button.pz-btn.pri').first()
    await openSync()
    await setRow('笔记', true); await setRow('我的资料', true)
    const claimAt = Date.now()
    await barPrimary().click({ timeout: 60_000 })
    // Poll the three pieces of claim evidence together (the host restarts the engine while claiming).
    const claimEvidence = async () => {
      const s = readJson(seed.stateFile), f = readJson(seed.engineDefaults), calls = (await ownerCalls()).filter((c) => c.at >= claimAt)
      return { state: s && { owned: s.owned, releasing: s.releasing ?? null }, accounts: f?.accounts ?? null, calls }
    }
    const claimOk = (e) => e.state?.owned === true && e.state.releasing === null && Object.keys(e.accounts ?? {}).length === 1 && e.accounts[seed.scope]?.owner === 'content'
      && e.calls.some((c) => c.method === 'PUT' && c.body?.enabled === true && c.body.expectedAccount === seed.accountId && c.status === 200)
    const ce = (await until(async () => { const e = await claimEvidence(); return claimOk(e) ? e : null }, 45_000)) ?? (await claimEvidence())
    const h1 = await humanDefault()
    check('checks', 'C1-claimed', claimOk(ce) && h1.status === 200 && h1.enabled === false,
      { ...ce, humanWhileOwned: h1, engineUrl: { boot: backend.url, afterClaim: (await backendStatus())?.url ?? null } })
    // The first new-sync round must actually have run on both rows (Confirm stays disabled while it runs).
    const roundDone = await until(async () => { const s = await contentStatus(); return s && s.owned && !s.running && s.phase === 'idle' && s.lastRound && s.lastRound.completed !== false ? s : null }, 90_000, 1000)
    const nodes = [...(cloud.namespaces.get('default') ?? [])].filter((n) => !n.deleted && n.kind === 'file').map((n) => n.path)
    const cfg = readJson(seed.stateFile)?.config
    check('setup', 'S4-new-sync-round-done', !!roundDone && nodes.some((p) => p.startsWith('Amadeus/')) && nodes.some((p) => p.startsWith('human/')) && cfg?.enabled === true,
      { lastRound: roundDone?.lastRound ?? (await contentStatus())?.lastRound ?? null, uploaded: { amadeus: nodes.filter((p) => p.startsWith('Amadeus/')).length, human: nodes.filter((p) => p.startsWith('human/')).length }, rules: cfg?.rules })
    const markersPresent = { ...Object.fromEntries(Object.keys(LOCAL_MARKERS).map((r) => [`local:${r}`, fs.existsSync(vaultFile(r))])), 'local:vault root (new sync)': fs.existsSync(vaultFile(MARKER)), ...Object.fromEntries(Object.keys(CLOUD_MARKERS).map((r) => [`cloud:${r}`, cloud.files.has(r)])) }
    check('setup', 'S5-markers-present', Object.values(markersPresent).every(Boolean), markersPresent)
    const t1 = `T1-${crypto.randomBytes(4).toString('hex')}`
    appendLine('Journal/2026-W48.md', t1)
    await sleep(15_000)
    const l1 = await legacy()
    if (NEG === 'no-stop') fault = { legacyWhileOwned: l1 }

    // ── R: release through the same page ──
    await setRow('笔记', false); await setRow('我的资料', false)
    const releaseAt = Date.now()
    // C2 closes at the release boundary: no legacy transfer attempt carrying the claimed-phase edit, accepted or not.
    check('checks', 'C2-legacy-stopped', Array.isArray(l1) && !entryRunning(l1) && cloud.attemptsWith(t1).length === 0, { token: t1, legacyAttempts: cloud.attemptsWith(t1).length, engines: l1 })
    await barPrimary().click({ timeout: 60_000 })
    const released = await until(() => { const s = readJson(seed.stateFile); return s && s.owned === false && !('releasing' in s) ? s : null }, 45_000)
    await sleep(2000)
    const st = readJson(seed.stateFile)
    check('checks', 'R1-state-released', !!released, { owned: st?.owned, releasing: st?.releasing ?? null, enabled: st?.config?.enabled })
    const calls2 = (await ownerCalls()).filter((c) => c.at >= releaseAt)
    // Extend must persist owned:false + releasing BEFORE asking the host; the host must target the account it releases.
    check('checks', 'R2-host-release-call', calls2.some((c) => c.method === 'PUT' && c.body?.enabled === false && c.body.expectedAccount === seed.accountId && c.status === 200 && c.state?.owned === false && c.state?.releasing === true), calls2)
    const engineFile2 = readJson(seed.engineDefaults)
    const acct2 = engineFile2?.accounts?.[seed.scope]
    check('checks', 'R3-engine-owner-dropped', !!acct2 && !('owner' in acct2) && Object.keys(engineFile2.accounts).length === 1, engineFile2?.accounts)
    const back = await until(async () => { const l = await legacy(); return entryRunning(l) ? l : null }, 45_000, 1000)
    check('checks', 'R4-legacy-restarted', !!back, back ?? (await legacy()))
    const t2 = `T2-${crypto.randomBytes(4).toString('hex')}`
    appendLine('Projects/Course A/L01 Basics.md', t2)
    const r5 = await until(() => landed(t2, `${CLOUD_NAME}/Projects/Course A/L01 Basics.md`), 40_000)
    check('checks', 'R5-legacy-uploads', r5, { token: t2, writes: cloud.writesWith(t2).map((r) => r.names[0]) })
    const h2 = await humanDefault()
    check('checks', 'H-human-consent', ce.accounts?.[seed.scope]?.enabled === true && acct2?.enabled === true && h0.enabled === true && h1.enabled === false && h2.status === 200 && h2.enabled === true,
      { storedWhileOwned: ce.accounts?.[seed.scope]?.enabled, storedAfter: acct2?.enabled, before: h0.enabled, whileOwned: h1.enabled, after: h2.enabled })
    if (NEG === 'release-fails') fault = { injected: calls2.filter((c) => c.injected), state: { owned: st?.owned, releasing: st?.releasing ?? null } }
    if (NEG === 'human-off') fault = { storedAfter: acct2?.enabled, getAfter: h2 }
    if (NEG === 'no-restart') fault = { releaseAccepted: calls2.some((c) => c.body?.enabled === false && c.status === 200) }
    enginePid = (await backendStatus())?.pid ?? enginePid
  } catch (e) {
    result.error = String((e && e.stack) || e)
    log('error', result.error.split('\n')[0])
    await win?.screenshot({ path: path.join(OUT, `${name}-failure.png`) }).catch(() => {})
  } finally {
    if (app) {
      const closing = app.close().catch(() => {})
      const timer = setTimeout(() => { try { app.process()?.kill('SIGKILL') } catch { /* ignore */ } }, 10_000)
      await Promise.race([closing, sleep(15_000)]); clearTimeout(timer)
    }
    // The host stops its engine on quit; make sure a killed shell does not leave it running.
    if (enginePid) { try { process.kill(enginePid, 0); process.kill(enginePid, 'SIGTERM') } catch { /* already gone */ } }
    await sleep(1000) // let late requests land before the marker count
    if (cloud && !result.error) {
      // ── M: nobody ever asked the cloud about the marker (counted after every client is gone) ──
      const hits = cloud.touched(MARKER_RE).map((r) => ({ method: r.method, path: r.path, names: r.names.filter((n) => MARKER_RE.test(n)), status: r.status }))
      check('checks', 'M-marker-untouched', hits.length === 0, hits.slice(0, 10))
      if (NEG === 'marker') fault = { markerRequests: hits.length }
      result.requests = cloud.requests.length
    }
    await cloud?.close().catch(() => {})
    if (!process.env.KEEP_HOME) fs.rmSync(tmp, { recursive: true, force: true })
    if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true })
  }

  // A negative control only counts when its fault demonstrably fired.
  if (NEG && !result.error) {
    const fired = { 'release-fails': (f) => f?.injected?.length > 0 && f.state.owned === false && f.state.releasing === true, 'no-restart': (f) => f?.releaseAccepted === true,
      'no-stop': (f) => entryRunningSnapshot(f?.legacyWhileOwned), marker: (f) => f?.markerRequests > 0, 'human-off': (f) => f?.storedAfter === false && f?.getAfter?.status === 200 && f.getAfter.enabled === false }[NEG]
    check('setup', 'F-fault-exercised', fired(fault), fault)
  }
  const red = result.checks.filter((c) => !c.ok).map((c) => c.id)
  const ran = new Set(result.checks.map((c) => c.id))
  result.setupOk = !result.error && result.setup.every((c) => c.ok) && ALL_CHECKS.every((id) => ran.has(id))
  result.red = red
  const want = EXPECT_RED[NEG]
  result.pass = result.setupOk && red.length === want.length && want.every((id) => red.includes(id))
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(result, null, 2))
  log(result.pass ? 'PASS' : 'FAIL', `red=${JSON.stringify(red)} expected=${JSON.stringify(want)}${result.setupOk ? '' : ' (setup failed or checks missing)'}`)
  process.exit(result.pass ? 0 : 1)
}
/** For F under NEG=no-stop: some entry engine was still running while the new sync owned the vault. */
const entryRunningSnapshot = (engines) => Array.isArray(engines) && engines.some((e) => e.binding && ['idle', 'syncing', 'starting'].includes(e.state))

main().catch((e) => { console.error(e); process.exit(2) })
