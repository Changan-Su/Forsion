/** Shared emulator helpers for real-app Android harnesses: adb, uiautomator nodes (Compose testTags surface as
 *  resource-ids), screenshots, and ONE persistent CDP session to the app's WebView (debug builds only).
 *  A persistent session matters: Fetch interception and event listeners die with the socket, so per-call
 *  connections (live-island-emu.cjs style) cannot stub the backend across a reload. */
const { execFileSync, execFile, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const ADB = path.join(sdk, 'platform-tools/adb')
/** Where a run's time goes: calls and milliseconds per kind of device round trip, and the sleeps asked for. */
const spent = {}
const tally = (kind, ms) => { const s = (spent[kind] ||= { n: 0, ms: 0 }); s.n++; s.ms += ms }
const kindOf = (args) => {
  if (args[0] !== 'shell' && args[0] !== 'exec-out') return 'adb other'
  const cmd = args.slice(1).join(' ')
  return /uiautomator dump/.test(cmd) ? 'read tree' : /^input /.test(cmd) ? 'input' : /screencap/.test(cmd) ? 'screenshot' : 'adb other'
}
/** One line for the end of a run, largest first: `read tree 412s×180 · sleep 96s×140 · …`. */
const timing = () => Object.entries(spent).sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k} ${Math.round(v.ms / 1000)}s×${v.n}`).join(' · ')
const pause = (ms) => { tally('sleep', ms); return new Promise((r) => setTimeout(r, ms)) }

function adb(...args) {
  const t0 = Date.now()
  try { return execFileSync(ADB, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 }) } finally { tally(kindOf(args), Date.now() - t0) }
}
function adbBuffer(...args) {
  const t0 = Date.now()
  try { return execFileSync(ADB, args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 }) } finally { tally(kindOf(args), Date.now() - t0) }
}

// ── Reading the tree ──
// `uiautomator dump` starts a process on the device and waits for a full second of quiet, every time: 2 s a read, and
// reads were four fifths of a run (2026-10-09, 13 checks: 395 s of 490 in 194 reads). lib/UiTreeServer.java is the same
// reader kept connected — built, pushed and started on the first read, 0.03 s on a quiet screen. It still waits for
// quiet, but counted from the last thing that moved (EMU_IDLE_MS, 500), not from its own start.
// EMU_TREE=dump reads the old way; so does a run that cannot build or start the reader (said once).
const TREE_PORT = 9344
const IDLE_MS = Number(process.env.EMU_IDLE_MS || 500)
const OLD_DUMP = 'rm -f /sdcard/forsion-ui.xml; uiautomator dump /sdcard/forsion-ui.xml >/dev/null 2>&1; cat /sdcard/forsion-ui.xml'
let reader = process.env.EMU_TREE === 'dump' ? 'off' : 'down' // down → up; off = `uiautomator dump` for the rest of the run
let unanswered = 0
const napSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
/** One request to the reader.
 *  ponytail: a curl per request — a local process of a few milliseconds — keeps reads synchronous for the callers.
 *  A socket held open needs a worker thread to stay synchronous; worth it only if ~20 ms a read starts to matter. */
const ask = (pathname, max = 20) => execFileSync('curl', ['-sSf', '--max-time', String(max), `http://127.0.0.1:${TREE_PORT}${pathname}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

/** Build (once per source) → push → start → wait until it answers. False = not to be had here. */
function startReader() {
  try {
    const src = path.join(__dirname, 'UiTreeServer.java')
    const dir = path.join(os.tmpdir(), `forsion-uitree-${crypto.createHash('sha1').update(fs.readFileSync(src)).digest('hex').slice(0, 12)}`)
    if (!fs.existsSync(path.join(dir, 'classes.dex'))) {
      const newest = (sub, has) => fs.readdirSync(path.join(sdk, sub)).map((d) => path.join(sdk, sub, d)).filter((d) => fs.existsSync(path.join(d, has))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
      const jar = path.join(newest('platforms', 'android.jar'), 'android.jar')
      const tmp = `${dir}.${process.pid}` // built aside and moved in whole: two runs starting together never read half a file
      fs.mkdirSync(path.join(tmp, 'classes'), { recursive: true })
      execFileSync('javac', ['--release', '11', '-Xlint:-options', '-nowarn', '-cp', jar, '-d', path.join(tmp, 'classes'), src], { stdio: 'pipe' })
      execFileSync(path.join(newest('build-tools', 'd8'), 'd8'), ['--lib', jar, '--output', tmp, ...fs.readdirSync(path.join(tmp, 'classes')).map((f) => path.join(tmp, 'classes', f))], { stdio: 'pipe' })
      try { fs.renameSync(tmp, dir) } catch { /* another run got there first */ }
    }
    stopReader() // one left by a run that died holds the device's only automation slot
    adb('push', path.join(dir, 'classes.dex'), '/data/local/tmp/forsion-uitree.dex')
    spawn(ADB, ['shell', 'CLASSPATH=/data/local/tmp/forsion-uitree.dex exec app_process / UiTreeServer'], { detached: true, stdio: 'ignore' }).unref()
    adb('forward', `tcp:${TREE_PORT}`, 'localabstract:forsion-uitree')
    for (let i = 0; i < 40; i++) {
      try { if (ask('/ping', 1).includes('forsion-uitree')) return true } catch { /* not listening yet */ }
      napSync(150)
    }
    throw new Error('it did not answer within 6 s')
  } catch (e) {
    console.log(`[emu] no connected tree reader here (${String(e.stderr || e.message || e).trim().split('\n')[0]}) — reading with uiautomator dump`)
    return false
  }
}
/** Ask it to leave, and make sure: while one is connected, `uiautomator dump` fails for everybody on this device. */
function stopReader() {
  try { ask('/quit', 2) } catch { /* none listening */ }
  try { adb('shell', "pkill -f 'UiTree[S]erver'; true") } catch { /* no device */ } // [S]: the pattern must not match the shell that runs it
  try { execFileSync(ADB, ['forward', '--remove', `tcp:${TREE_PORT}`], { stdio: 'ignore' }) } catch { /* none set up */ }
}
process.on('exit', () => { if (reader === 'up') stopReader() })

/** The active window as XML. Throws when there is none to read (between two windows): the caller's next attempt. */
function treeXml() {
  if (reader === 'down') reader = startReader() ? 'up' : 'off'
  if (reader === 'up') {
    const t0 = Date.now()
    try {
      const xml = ask(`/dump?idle=${IDLE_MS}`)
      unanswered = 0
      return xml
    } catch (e) {
      if (String(e.stderr || '').includes('error: 503')) throw new Error('no active window')
      const why = String(e.stderr || e.message).trim().split('\n')[0]
      // It left (nobody asked for 30 s — it does not outlive a dead run — or the device restarted): the next read
      // starts one. Three in a row is not that: the old way from here on (`adb logcat -s forsion-uitree` says why).
      if (++unanswered < 3) reader = 'down'
      else { stopReader(); reader = 'off'; console.log(`[emu] the connected tree reader keeps failing (${why}) — reading with uiautomator dump from here on`) }
      throw new Error(`the tree reader did not answer (${why})`)
    } finally { tally('read tree', Date.now() - t0) }
  }
  return adb('shell', OLD_DUMP)
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&#13;/g, '\r').replace(/&#9;/g, '\t').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
/** The active window's tree → flat node list with parsed bounds (the XML of `uiautomator dump`, whoever read it). */
function nodes(out) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Never an old tree. The old way removes the previous dump first, so a dump that fails ("could not get idle
      // state" while the page keeps animating) leaves nothing for `cat` to print — the attempt is repeated instead of
      // answering with what was on screen a while ago (a full run failed once with the bar on screen and absent from
      // eight seconds of dumps). The connected reader has no file to go stale, and reads a moving screen as it is.
      const xml = treeXml()
      if (!xml.includes('<hierarchy')) throw new Error('no tree')
      if (out) fs.writeFileSync(path.join(out, 'last-ui.xml'), xml)
      return [...xml.matchAll(/<node\s+([^>]+?)\/?>/g)].map((m) => {
        const n = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]))
        const b = (n.bounds || '').match(/\d+/g)?.map(Number) || [0, 0, 0, 0]
        n.rect = { left: b[0], top: b[1], right: b[2], bottom: b[3], cx: Math.round((b[0] + b[2]) / 2), cy: Math.round((b[1] + b[3]) / 2) }
        return n
      })
    } catch (e) {
      if (attempt === 2) throw e
      napSync(300) // the old way took two seconds to fail; between two windows that was the wait
    }
  }
  return []
}
const byId = (list, id) => list.find((n) => n['resource-id'] === id)
const byIdPrefix = (list, prefix) => list.filter((n) => (n['resource-id'] || '').startsWith(prefix))
function tapAt(x, y) { adb('shell', 'input', 'tap', String(x), String(y)) }
function tapNode(node) { tapAt(node.rect.cx, node.rect.cy) }
function longPress(node, ms = 900) {
  adb('shell', 'input', 'swipe', String(node.rect.cx), String(node.rect.cy), String(node.rect.cx), String(node.rect.cy), String(ms))
}
/** Keep a finger down at one point for `ms` without blocking: resolves when it lifts (lets the caller sample the pressed state). */
function holdAt(x, y, ms) {
  return new Promise((resolve, reject) => execFile(ADB, ['shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(ms)], (e) => (e ? reject(e) : resolve())))
}
function key(code) { adb('shell', 'input', 'keyevent', String(code)) }
function screenshot(out, name) {
  const file = path.join(out, `${name}.png`)
  fs.writeFileSync(file, adbBuffer('exec-out', 'screencap', '-p'))
  return file
}
/** Poll a predicate over fresh uiautomator dumps. */
async function waitNodes(pred, { timeout = 8000, out } = {}) {
  const end = Date.now() + timeout
  let last = []
  while (Date.now() < end) {
    last = nodes(out)
    const hit = pred(last)
    if (hit) return { hit, nodes: last }
    await pause(250)
  }
  return { hit: null, nodes: last }
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString())
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject } = this.pending.get(d.id)
        this.pending.delete(d.id)
        if (d.error) reject(new Error(`${d.error.message} (${d.error.code})`))
        else resolve(d.result)
      } else if (d.method) {
        for (const fn of this.handlers.get(d.method) || []) {
          try { fn(d.params) } catch (e) { console.error('[cdp handler]', e) }
        }
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)) }, 20000)
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }
  /** Evaluate in the page (awaits promises, returns by value). Throws on page exceptions. */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
    return res.result.value
  }
  close() { try { this.ws.close() } catch { /* already closed */ } }
}

/** Attach to the app's WebView page over the devtools socket. Only `attached` pages (see live-island-emu.cjs). */
async function connect(pkg, port = 9343, timeout = 20000) {
  const end = Date.now() + timeout
  let lastErr = null
  while (Date.now() < end) {
    try {
      const pid = adb('shell', 'pidof', pkg).trim()
      if (!pid) throw new Error('app not running')
      adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`)
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && JSON.parse(t.description || '{}').attached)
      if (!page) throw new Error('no attached WebView page')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
      return new Cdp(ws)
    } catch (e) {
      lastErr = e
      await pause(400)
    }
  }
  throw new Error(`CDP connect failed: ${lastErr?.message}`)
}

/** Poll a page expression until truthy. */
async function waitPage(cdp, expression, timeout = 10000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { last = await cdp.eval(expression); if (last) return last } catch { /* page reloading */ }
    await pause(250)
  }
  return last
}

/** For scripts/uitree-compare.cjs: the two readers one at a time. */
const tree = { old: () => adb('shell', OLD_DUMP), start: startReader, stop: stopReader, ask }
module.exports = { adb, adbBuffer, nodes, byId, byIdPrefix, tapAt, tapNode, longPress, holdAt, key, screenshot, waitNodes, connect, waitPage, pause, timing, tree, Cdp }
