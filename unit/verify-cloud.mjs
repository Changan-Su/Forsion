/** Two real Units, one signed account bundle and a local server, no Electron: sign-in, relay and note sync end to end.
 * Local servers only. The account's own cloud vault is used, so the run writes one throwaway note and removes it again.
 * Each Unit gets its own token from the device flow, so logging out here never revokes the --auth session.
 *   node unit/verify-cloud.mjs --extend <signed package dir> --auth <auth.json of the local server> [--unit unit/dist] [--keep]
 * Tokens stay in this process and the Units' private data directories; nothing here prints them. */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const source = dirname(fileURLToPath(import.meta.url))
const main = resolve(option('--unit', join(source, 'dist')), 'main.mjs')
const amadeus = resolve(dirname(main), 'plugins/amadeus')
const extend = resolve(option('--extend', ''))
const auth = JSON.parse(readFileSync(resolve(option('--auth', '')), 'utf8'))
const cloud = String(auth.cloudUrl || '').replace(/\/+$/, '')
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cloud) || !auth.token) throw new Error('verify-cloud only runs against a local server')
if (!existsSync(join(extend, 'SIGNATURE'))) throw new Error('--extend must be a signed package directory')

const scratch = realpathSync(await mkdtemp(join(tmpdir(), 'forsion-unit-cloud-')))
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
let failed = 0
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  ${detail}`}`) }
const until = async (probe, ms = 60_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) { try { if (await probe()) return Date.now() - start } catch { /* not yet */ } await delay(200) }
  return null
}
const cli = (...command) => new Promise((done, reject) => {
  const proc = spawn(process.execPath, [main, ...command], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  proc.stdout.on('data', (d) => { out += d })
  proc.stderr.on('data', (d) => { err += d })
  proc.once('exit', (code) => (code === 0 ? done(out) : reject(new Error(`${command[0]} failed (${code}): ${err || out}`))))
})
const hub = async (path, init = {}) => {
  const response = await fetch(`${cloud}/api${path}`, { ...init, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', ...init.headers } })
  return { status: response.status, json: await response.json().catch(() => null) }
}

function device(name) {
  const dir = join(scratch, name), config = join(dir, 'unit.json'), vault = join(dir, 'data/workspace/vault')
  const unit = {
    name, config, vault, child: null, log: '', port: 0,
    start: async () => {
      unit.child = spawn(process.execPath, [main, 'run', config], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
      for (const stream of [unit.child.stdout, unit.child.stderr]) stream.on('data', (d) => { unit.log += d })
      const up = await until(async () => { unit.port = JSON.parse(await cli('status', config)).port; return unit.port })
      if (up === null) throw new Error(`${name} did not start: ${unit.log.slice(-800)}`)
      unit.owner = readFileSync(join(dir, 'data/owner-token'), 'utf8').trim()
    },
    stop: async () => {
      const child = unit.child
      if (!child || child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise((done) => child.once('exit', done))
    },
    account: async () => JSON.parse(await cli('account', config)),
    rpc: async (ch, ...rpcArgs) => {
      const response = await fetch(`http://127.0.0.1:${unit.port}/web/vault/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${unit.owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ch, args: rpcArgs }) })
      const body = await response.json()
      if (!body.ok) throw new Error(body.error || `rpc ${ch} failed`)
      return body.result
    },
    login: () => new Promise((done, reject) => {
      const proc = spawn(process.execPath, [main, 'login', config, cloud], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = '', approved = false
      proc.stdout.on('data', async (d) => {
        out += d
        if (approved) return
        let started
        try { started = JSON.parse(out) } catch { return }
        approved = true
        const answer = await hub('/auth/cli/approve', { method: 'POST', body: JSON.stringify({ user_code: started.userCode }) })
        if (answer.status !== 200) reject(new Error(`approve failed (${answer.status})`))
      })
      proc.once('exit', (code) => (code === 0 ? done() : reject(new Error(`login failed (${code})`))))
    }),
  }
  return unit
}

const a = device('a'), b = device('b'), units = [a, b]
const stamp = Date.now(), note = `unit-cloud-verify-${stamp}.md`, late = `unit-cloud-verify-late-${stamp}.md`, folder = `unit-cloud-verify-${stamp}`
let registered = []
try {
  for (const unit of units) {
    await cli('init', dirname(unit.config), '--mode', 'local', '--port', '0', '--base', '/web/')
    await cli('install', unit.config, amadeus)
    await cli('install', unit.config, extend)
    await unit.start()
    await unit.login()
  }
  const accounts = await Promise.all(units.map((unit) => unit.account()))
  check('both Units sign in through the device flow', accounts.every((s) => s.loggedIn && s.tokenValid), accounts.map((s) => s.username).join(' / '))
  check('the empty vault binds to the account', accounts.every((s) => s.vaultBound))
  check('credentials are owner-only', units.every((unit) => (statSync(join(dirname(unit.config), 'data/cloud/auth.json')).mode & 0o077) === 0))

  const page = async (path) => (await fetch(`http://127.0.0.1:${a.port}/web${path}`, { headers: { Authorization: `Bearer ${a.owner}` } })).json()
  const [plugins, spaces] = await Promise.all([page('/unit/plugins'), page('/unit/spaces')])
  check('the owner page shows no account bundle', Array.isArray(plugins.plugins) && !plugins.plugins.some((p) => p.id === 'forsion-extend') && !spaces.spaces.some((p) => p.plugin === 'forsion-extend'))

  const ids = await Promise.all(units.map(async (unit) => { await until(async () => (await unit.account()).relay?.connected); return (await unit.account()).relay?.unitId }))
  registered = ids.filter(Boolean)
  const roster = (await hub('/units')).json?.units ?? []
  check('both Units are online on the relay', ids.every((id) => roster.some((u) => u.id === id && u.online)), `${roster.length} devices on the account`)
  const meta = await hub(`/units/${ids[0]}/proxy/unit/meta`)
  check('a request reaches Unit a through the relay', meta.status === 200 && meta.json?.name === 'Forsion Unit')
  const blocked = await hub(`/units/${ids[0]}/proxy/vault/rpc`, { method: 'POST', body: JSON.stringify({ ch: 'trash:empty', args: [] }) })
  check('a relayed request is not the owner', blocked.status === 403, `status ${blocked.status}`)

  const idle = await until(async () => (await Promise.all(units.map((unit) => unit.account()))).every((s) => s.sync?.state === 'idle'), 180_000)
  check('both sync engines reach idle', idle !== null, `${idle} ms`)

  await a.rpc('file:write-text', note, 'written on a\n', { create: true })
  const created = await until(() => existsSync(join(b.vault, note)))
  check('a note created in Unit a reaches Unit b', created !== null, `${created} ms`)
  await delay(4000)
  await b.rpc('file:write-text', note, 'edited on b\n')
  const edited = await until(() => readFileSync(join(a.vault, note), 'utf8').startsWith('edited'))
  check('an edit in Unit b reaches Unit a', edited !== null, `${edited} ms`)
  await delay(4000)
  await a.rpc('folder:create', '', folder)
  await a.rpc('page:move', note, folder)
  const moved = await until(() => !existsSync(join(b.vault, note)) && readFileSync(join(b.vault, folder, note), 'utf8').startsWith('edited'))
  check('a move in Unit a reaches Unit b', moved !== null, `${moved} ms`)
  await delay(4000)
  await a.rpc('page:delete', `${folder}/${note}`)
  const removed = await until(() => !existsSync(join(b.vault, folder, note)))
  check('a delete in Unit a reaches Unit b', removed !== null, `${removed} ms`)

  process.kill(a.child.pid, 'SIGSTOP')
  await delay(3000)
  const resumedAt = a.log.length
  process.kill(a.child.pid, 'SIGCONT')
  const redial = await until(() => /resume/.test(a.log.slice(resumedAt)), 3000)
  check('a resumed process redials at once', redial !== null, `${redial} ms`)
  const online = await until(async () => (await a.account()).relay?.connected, 10_000)
  check('the relay is back after a resume', online !== null, `${online} ms`)
  await until(async () => (await a.account()).sync?.state === 'idle', 30_000)
  await b.rpc('file:write-text', late, 'after the resume\n', { create: true })
  const caught = await until(() => existsSync(join(a.vault, late)))
  check('notes keep flowing after a resume', caught !== null, `${caught} ms`)
  await delay(4000)
  await b.rpc('page:delete', late)

  await b.stop()
  await b.start()
  const restarted = await until(async () => { const s = await b.account(); return s.loggedIn && s.relay?.connected && s.relay.unitId === ids[1] }, 30_000)
  check('a restart keeps the account and the same device', restarted !== null, `${restarted} ms`)
  const after = (await hub('/units')).json?.units ?? []
  check('a restart adds no device row', after.length === roster.length, `${after.length}`)

  await cli('logout', a.config)
  const out = await a.account()
  check('sign-out clears the Unit account and leaves its notes', !out.loggedIn && out.relay === null && existsSync(a.vault))
} catch (error) {
  failed++
  console.log(`FAIL  ${error instanceof Error ? error.message : error}`)
  for (const unit of units) console.log(`[${unit.name}] ${unit.log.slice(-1500)}`)
} finally {
  await cli('logout', b.config).catch(() => {})
  for (const unit of units) await unit.stop()
  for (const id of registered) await hub(`/units/${id}`, { method: 'DELETE' }).catch(() => {})
  if (args.includes('--keep')) console.log(`kept ${scratch}`)
  else await rm(scratch, { recursive: true, force: true })
  writeFileSync(1, failed ? `${failed} failed\n` : 'all passed\n')
  process.exit(failed ? 1 : 0)
}
