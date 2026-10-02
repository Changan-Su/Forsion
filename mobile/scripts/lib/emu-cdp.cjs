/** Shared emulator helpers for real-app Android harnesses: adb, uiautomator nodes (Compose testTags surface as
 *  resource-ids), screenshots, and ONE persistent CDP session to the app's WebView (debug builds only).
 *  A persistent session matters: Fetch interception and event listeners die with the socket, so per-call
 *  connections (live-island-emu.cjs style) cannot stub the backend across a reload. */
const { execFileSync, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const ADB = path.join(sdk, 'platform-tools/adb')
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

function adb(...args) {
  return execFileSync(ADB, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
}
function adbBuffer(...args) {
  return execFileSync(ADB, args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
/** uiautomator dump → flat node list with parsed bounds. */
function nodes(out) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      adb('shell', 'uiautomator', 'dump', '/sdcard/forsion-ui.xml')
      const xml = adb('shell', 'cat', '/sdcard/forsion-ui.xml')
      if (out) fs.writeFileSync(path.join(out, 'last-ui.xml'), xml)
      return [...xml.matchAll(/<node\s+([^>]+?)\/?>/g)].map((m) => {
        const n = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]))
        const b = (n.bounds || '').match(/\d+/g)?.map(Number) || [0, 0, 0, 0]
        n.rect = { left: b[0], top: b[1], right: b[2], bottom: b[3], cx: Math.round((b[0] + b[2]) / 2), cy: Math.round((b[1] + b[3]) / 2) }
        return n
      })
    } catch (e) {
      if (attempt === 2) throw e
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

module.exports = { adb, adbBuffer, nodes, byId, byIdPrefix, tapAt, tapNode, longPress, holdAt, key, screenshot, waitNodes, connect, waitPage, pause, Cdp }
