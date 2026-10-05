/** Real Android acceptance: isolated preview APK, Compose accessibility tree + Web state.
 * Build/install instructions: README.md. Requires one connected emulator/device and Node 22+.
 * OUT=/absolute/output node scripts/native-picker-emu.cjs
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk')
const pkg = 'com.forsion.tangu.nativepreview'
const out = path.resolve(process.env.OUT || 'artifacts/native-picker')
fs.mkdirSync(out, { recursive: true })
const adb = (...args) => execFileSync(path.join(sdk, 'platform-tools/adb'), args, { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function evaluate(expression) {
  const value = execFileSync(process.execPath, [path.join(__dirname, 'live-island-emu.cjs'), 'eval', expression], {
    env: { ...process.env, PKG: pkg }, encoding: 'utf8', timeout: 20000,
  }).trim()
  return value === 'undefined' ? undefined : JSON.parse(value)
}
const decode = s => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
function nodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/forsion-native-picker.xml')
  const xml = adb('shell', 'cat', '/sdcard/forsion-native-picker.xml')
  fs.writeFileSync(path.join(out, 'last-ui.xml'), xml)
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(m => Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])])))
}
function tap(match) {
  const node = nodes().find(n => typeof match === 'string' ? n.text === match || n['content-desc'] === match : match(n))
  assert.ok(node, `Native node missing: ${match}`)
  const b = node.bounds.match(/\d+/g).map(Number)
  adb('shell', 'input', 'tap', String(Math.round((b[0] + b[2]) / 2)), String(Math.round((b[1] + b[3]) / 2)))
}
function screenshot(name) {
  fs.writeFileSync(path.join(out, name + '.png'), execFileSync(path.join(sdk, 'platform-tools/adb'), ['exec-out', 'screencap', '-p']))
}
const checks = []
function check(name, test) { test(); checks.push(name); console.log('PASS', name) }
async function openPicker() {
  evaluate('document.querySelector(".model-pill-btn").click()')
  await pause(650)
  check('Compose sheet owns the picker (no Web menu)', () => assert.equal(evaluate('!!document.querySelector(".cm-advanced-reveal")'), false))
}
async function reload(query = '') {
  evaluate(`setTimeout(() => { location.href = '/native-preview.html${query}' }, 30); true`)
  for (let i = 0; i < 25; i++) {
    await pause(300)
    try { if (evaluate('!!window.__nativePreview && !!document.querySelector(".model-pill-btn")')) return } catch {}
  }
  throw new Error('Preview did not mount')
}
;(async () => {
  assert.ok(adb('shell', 'pidof', pkg).trim(), 'Launch the preview APK first')
  await reload()
  screenshot('01-chat-light')
  await openPicker()
  screenshot('02-model-sheet-light')
  tap('Claude Opus')
  tap(n => (n.text || '').startsWith('思考档位'))
  tap('High')
  tap('完成')
  await pause(400)
  check('Model and effort commit together', () => assert.deepEqual(evaluate('__nativePreview.evidence.chat'), { modelId: 'sample-deep', thinkingLevel: 'high' }))
  await openPicker()
  tap('Claude Sonnet')
  adb('shell', 'input', 'keyevent', '4')
  await pause(500)
  check('System back cancels without changing draft selection', () => assert.deepEqual(evaluate('__nativePreview.evidence.chat'), { modelId: 'sample-deep', thinkingLevel: 'high' }))
  evaluate('__nativePreview.setTab("plugins")')
  await pause(400)
  check('Plugin view mounted through actual registry', () => assert.ok(evaluate('!!document.querySelector(".np-plugin .model-pill-btn")')))
  const draft = evaluate('document.querySelector(".np-plugin textarea").value')
  await openPicker()
  tap('Claude Opus')
  tap('完成')
  await pause(400)
  check('Plugin selection returns to its own draft', () => {
    assert.equal(evaluate('__nativePreview.evidence.plugin.modelId'), 'sample-deep')
    assert.equal(evaluate('__nativePreview.evidence.plugin.thinkingLevel'), 'medium')
    assert.equal(evaluate('document.querySelector(".np-plugin textarea").value'), draft)
    assert.equal(evaluate('__nativePreview.evidence.chat.thinkingLevel'), 'high')
  })
  screenshot('03-plugin-light')
  await openPicker()
  evaluate('__nativePreview.disablePlugin()')
  await pause(600)
  check('Disabling plugin dismisses its native sheet', () => assert.equal(nodes().some(n => n.text === '完成'), false))
  evaluate('__nativePreview.enablePlugin(); __nativePreview.setMode("dark")')
  await pause(500)
  await openPicker()
  screenshot('04-plugin-sheet-dark')
  tap(n => n.class === 'android.widget.EditText')
  adb('shell', 'input', 'text', 'Opus')
  await pause(600)
  check('Native search filters models', () => {
    const ui = nodes()
    assert.ok(ui.some(n => n.text === 'Claude Opus'))
    assert.equal(ui.some(n => n.text === 'Claude Sonnet'), false)
  })
  screenshot('05-native-search-keyboard')
  await reload('?locale=en')
  check('Page navigation dismisses native sheet', () => assert.equal(nodes().some(n => n.text === '完成'), false))
  await openPicker()
  check('English labels arrive from shared localization', () => assert.ok(nodes().some(n => n.text === 'Done')))
  screenshot('06-model-sheet-english')
  adb('shell', 'input', 'keyevent', '4')
  await reload()
  fs.writeFileSync(path.join(out, 'acceptance.json'), JSON.stringify({ package: pkg, checks, completedAt: new Date().toISOString() }, null, 2))
  console.log('Artifacts:', out)
})().catch(error => { console.error(error); process.exitCode = 1 })
