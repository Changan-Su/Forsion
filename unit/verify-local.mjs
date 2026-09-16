/** Real installed-artifact acceptance: no source checkout, Forsion Server, cloud
 * account, external database, or model provider is needed for this fixture.
 * Build first, then run with the Node ABI matching the packaged runtimes:
 *   node unit/verify-local.mjs [--serve] [--unit unit/dist] [--qbird /package/path]
 * --serve keeps only this isolated instance alive for browser verification.
 * Private owner access remains in fixture.json (0600), never stdout/report. */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const source = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const distribution = resolve(option('--unit', join(source, 'dist')))
const qbird = resolve(option('--qbird', join(source, '../../Forsion-Instrumentality-Project/bluebird')))
const reportFile = resolve(option('--report', '/tmp/forsion-unit-local-verification.json'))
const serving = args.includes('--serve')
const scratch = await mkdtemp(join(tmpdir(), 'forsion-unit-local-verify-'))
const unitDir = join(scratch, 'unit')
const instanceDir = join(scratch, 'instance')
const configFile = join(instanceDir, 'unit.json')
const fixtureFile = join(scratch, 'fixture.json')
const checks = []
const logFile = join(scratch, 'unit.log')
let child = null
let baseUrl = ''
let owner = ''
let logs = ''
let stopped = false
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version, nodeAbi: process.versions.modules,
  distribution, qbird, scratch, checks, ok: false }
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const check = (name, condition, detail) => {
  const item = { name, ok: !!condition, ...(detail === undefined ? {} : { detail }) }
  checks.push(item)
  if (!condition) throw new Error(`Acceptance failed: ${name}${detail ? ` (${detail})` : ''}`)
}

async function cli(...command) {
  const output = await new Promise((done, reject) => {
    const proc = spawn(process.execPath, [join(unitDir, 'main.mjs'), ...command], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.once('error', reject)
    proc.once('exit', (code) => code === 0 ? done(stdout) : reject(new Error(`Unit ${command[0]} failed (${code}): ${stderr || stdout}`)))
  })
  return JSON.parse(output)
}

async function start() {
  const env = { ...process.env }
  delete env.UNIT_PORT
  child = spawn(process.execPath, [join(unitDir, 'main.mjs'), 'run', configFile], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let error
  child.once('error', (value) => { error = value })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs += String(chunk) })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (error) throw error
    if (child.exitCode !== null) throw new Error(`Unit exited before ready: ${logs.slice(-8000)}`)
    const status = await cli('status', configFile).catch(() => null)
    if (status?.running) {
      baseUrl = `http://127.0.0.1:${status.port}/web/`
      owner = (await readFile(join(instanceDir, 'data/owner-token'), 'utf8')).trim()
      await writeFile(fixtureFile, JSON.stringify({ root: scratch, unitDir, configFile, baseUrl, ownerToken: owner, pid: child.pid }, null, 2) + '\n', { mode: 0o600 })
      return status
    }
    await delay(100)
  }
  throw new Error(`Unit startup timed out: ${logs.slice(-8000)}`)
}

async function stop() {
  const proc = child
  child = null
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) await new Promise((done) => {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 8000)
    proc.once('exit', () => { clearTimeout(timer); done() })
    proc.kill('SIGTERM')
  })
  await writeFile(logFile, logs, { mode: 0o600 })
}

async function request(path, { auth = true, ...init } = {}) {
  return fetch(new URL(path, baseUrl), { ...init, headers: {
    ...(auth ? { Authorization: `Bearer ${owner}` } : {}), ...init.headers,
  }, signal: AbortSignal.timeout(15_000) })
}
async function json(path, options) {
  const response = await request(path, options)
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}
async function rpc(ch, ...rpcArgs) {
  const response = await json('vault/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ch, args: rpcArgs, client: 'local-artifact-verifier' }) })
  if (!response.ok) throw new Error(`${ch}: ${response.error}`)
  return response.result
}

try {
  await cp(distribution, unitDir, { recursive: true, dereference: true })
  await cli('init', instanceDir, '--mode', 'local', '--base', '/web/', '--port', '0')
  for (const id of ['amadeus', 'tangu', 'calendar', 'automation']) await cli('install', configFile, join(unitDir, 'plugins', id))
  await cli('install', configFile, qbird)
  const config = JSON.parse(await readFile(configFile, 'utf8'))
  config.defaultSpace = 'bluebird'
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  const manifests = await Promise.all(config.plugins.map(async (plugin) => JSON.parse(await readFile(join(plugin.path, 'manifest.json'), 'utf8'))))
  check('installs real business packages and Qbird without Server', manifests.map((m) => m.id).sort().join(',') === 'amadeus,automation,bluebird,calendar,tangu')
  check('all installations are self contained outside the source checkout', config.plugins.every((plugin) => plugin.path.startsWith(instanceDir + '/')))
  let status = await start()
  check('CLI reports every package active', status.plugins.every((plugin) => plugin.state === 'active'), status.plugins.map(({ id, state }) => ({ id, state })))
  for (const [path, method, body] of [['unit/config', 'GET'], ['engine/agent/agents', 'GET'], ['vault/rpc', 'POST', JSON.stringify({ ch: 'vault:restore', args: [] })], ['vault/asset?path=Calendar.db', 'GET']]) {
    const response = await request(path, { auth: false, method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {}) })
    check(`rejects unauthenticated ${path}`, response.status === 401 || response.status === 403, response.status)
  }
  const shell = await (await request('', { auth: false })).text()
  check('public shell advertises local native features and Qbird default Space', shell.includes('bluebird') && shell.includes('amadeus') && shell.includes('calendar') && shell.includes('automation') && shell.includes('local'))
  check('shell never contains the owner credential', !shell.includes(owner))
  const meta = await json('unit/meta', { auth: false })
  check('local vault and engine are ready without cloud services', meta.projection === 'local' && meta.localCapabilities?.vault && meta.localCapabilities?.engine && !meta.account)
  const plugins = await json('unit/plugins')
  const bluebird = plugins.plugins.find((plugin) => plugin.id === 'bluebird')
  check('Qbird JavaScript and bilingual onboarding are installed', !!bluebird?.code && !!bluebird?.onboarding?.en)
  const spaces = await json('unit/spaces')
  check('Qbird Space recipe is exposed by installed package', spaces.spaces.some((space) => space.slug === 'bluebird' || space.plugin === 'bluebird' || JSON.stringify(space).includes('bluebird')))
  check('Qbird bundled agent reaches existing local engine through owner proxy', (await json('engine/agent/agents')).agents.some((agent) => agent.slug === 'bluebird'))
  const health = await json('engine/health')
  check('engine runs existing standalone assembly', health.ok && health.mode === 'standalone')
  const inbox = await json('engine/agent/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Offline Unit notification', body: 'Local Inbox works without cloud broadcasts.' }) })
  check('local Inbox accepts owner notifications without Server', inbox.ok && !!inbox.id)
  const pull = await json('engine/agent/inbox/pull', { method: 'POST' })
  check('unconfigured cloud broadcast capability remains absent', pull.pulled === false && pull.added === 0)
  const boot = await rpc('vault:restore')
  check('vault belongs to this fresh isolated workspace', boot.root.startsWith(await realpath(join(instanceDir, 'data/workspace'))))
  const marker = `UNIT_LOCAL_${randomUUID()}`
  const note = '# Offline Unit note\n\n' + marker + '\n\nNo Forsion Server or account is configured.\n'
  await rpc('file:write-text', 'Offline note.md', note)
  check('creates and indexes local Markdown', (await rpc('vault:list')).includes('Offline note.md'))
  await rpc('file:write-text', 'Offline note.md', note + '\nPersisted edit.\n')
  check('reads edited note immediately', (await rpc('file:read-text', 'Offline note.md')).includes('Persisted edit.'))
  await rpc('file:write-text', 'Remove me.md', 'Temporary deletion check')
  const renamed = await rpc('page:rename-file', 'Remove me.md', 'Renamed fixture')
  await rpc('page:delete', renamed)
  check('rename and delete operate on local files', (await rpc('file:read-text', renamed)) === null)
  const calendar = await rpc('db:read', '', 'Calendar.db')
  check('seeds an editable Calendar.db', calendar.status === 'ok' && calendar.data.rows.length === 0)
  const [name, date, done] = calendar.data.columns.map((column) => column.id)
  calendar.data.rows.push({ id: 'unit-local-calendar-event', cells: { [name]: 'Offline Unit verification', [date]: new Date().toISOString().slice(0, 10), [done]: false } })
  const cas = await rpc('db:write-cas', calendar.path, calendar.data, calendar.version)
  check('Calendar writes through the shared CAS API', cas.ok)
  const pluginData = JSON.stringify({ fixture: marker, savedLocally: true })
  await rpc('plugins:data-write', 'unit-verification', pluginData)
  const media = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64')
  await rpc('vault:save-bytes', 'assets/unit-fixture.png', { __u8: media.toString('base64') })
  const token = await json('vault/asset-token', { method: 'POST' })
  const image = await request(`vault/asset?path=assets%2Funit-fixture.png&at=${token.token}`, { auth: false })
  check('serves local media using a short lived asset token', image.ok && image.headers.get('content-type') === 'image/png' && Buffer.from(await image.arrayBuffer()).equals(media))
  const preferences = await json('unit/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentDeskEnabled: true, token: 'must-not-persist', backendUrl: 'https://must-not-persist.invalid' }) })
  check('owner preferences cannot replace credentials or connection settings', preferences.config.agentDeskEnabled === true && !('token' in preferences.config) && !('backendUrl' in preferences.config))
  const oldPid = status.pid
  await stop()
  check('CLI confirms Unit stopped cleanly', (await cli('status', configFile)).running === false)
  status = await start()
  check('full Unit process restart succeeds', status.pid !== oldPid && status.plugins.every((plugin) => plugin.state === 'active'))
  check('Markdown survives full restart', (await rpc('file:read-text', 'Offline note.md')) === note + '\nPersisted edit.\n')
  check('Calendar survives full restart', (await rpc('db:read', '', 'Calendar.db')).data.rows.some((row) => row.id === 'unit-local-calendar-event'))
  check('plugin data survives full restart', (await rpc('plugins:data-read', 'unit-verification')) === pluginData)
  check('media bytes survive full restart', (await rpc('vault:read-bytes', 'assets/unit-fixture.png')).__u8 === media.toString('base64'))
  check('UI preferences survive full restart', (await json('unit/config')).config.agentDeskEnabled === true)
  check('local Inbox notification survives full restart', (await json('engine/agent/inbox')).messages.some((message) => message.id === inbox.id))
  check('owner key is private on disk', ((await stat(join(instanceDir, 'data/owner-token'))).mode & 0o777) === 0o600)
  const tanguConfig = JSON.parse(await readFile(join(instanceDir, 'data/plugins/tangu/config.json'), 'utf8'))
  check('local engine has no cloud credential or database URL', !tanguConfig.cloud?.url && !tanguConfig.cloud?.token && !tanguConfig.database?.url)
  const database = await readFile(join(instanceDir, 'data/plugins/tangu/tangu/state.db'))
  check('existing engine persists to embedded SQLite', database.subarray(0, 16).toString() === 'SQLite format 3\0')
  // Existing cloud broadcast polling starts after 15s. Observe beyond that kick
  // to catch accidental advertisement of an unconfigured cloud capability.
  await delay(16_000)
  check('serverless runtime does not attempt background cloud Inbox polling', !/\[inbox\] pull failed|Failed to parse URL/.test(logs))
  report.ok = true
  report.baseUrl = baseUrl
  report.fixtureFile = fixtureFile
  report.finishedAt = new Date().toISOString()
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, passed: checks.length, report: reportFile, baseUrl, fixtureFile, serving }, null, 2))
  if (serving) await new Promise((done) => {
    const finish = async () => { if (stopped) return; stopped = true; await stop(); done() }
    process.once('SIGINT', finish); process.once('SIGTERM', finish)
  })
} catch (error) {
  report.error = String(error?.message || error)
  report.finishedAt = new Date().toISOString()
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n')
  console.error(JSON.stringify({ ok: false, error: report.error, report: reportFile, logFile }, null, 2))
  process.exitCode = 1
} finally {
  await stop()
  if (!serving && report.ok) await rm(scratch, { recursive: true, force: true })
}
