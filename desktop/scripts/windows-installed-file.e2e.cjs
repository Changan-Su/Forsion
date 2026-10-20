/** Actual NSIS-installed application. Dedicated, disposable Windows runner only. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const checks = []
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); checks.push(name) }
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const ps = source => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('$ErrorActionPreference="Stop"; ' + source, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 20000 })
async function until(name, predicate, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await sleep(100) }
  throw new Error(name)
}
function pdf() {
  const stream = 'BT /F1 18 Tf 40 100 Td (Installed PDF) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let text = '%PDF-1.4\n'; const offsets = []
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const at = text.length
  return text + `xref\n0 6\n0000000000 65535 f \n` + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`
}
async function main() {
  assert.ok(process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true', 'Installed-app check requires a disposable Actions Windows runner')
  const exe = process.env.FORSION_INSTALLED_EXE, out = process.env.FORSION_INSTALLED_OUTPUT
  assert.ok(exe && out && process.env.RUNNER_TEMP)
  for (const target of [exe, out]) {
    const rel = path.relative(process.env.RUNNER_TEMP, path.resolve(target))
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'All test paths must stay inside RUNNER_TEMP')
  }
  fs.mkdirSync(out, { recursive: true })
  const home = path.join(out, 'profile'), vault = path.join(home, 'Vault'), outside = path.join(home, 'Outside')
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(outside, { recursive: true })
  const md = path.join(outside, 'Outside note.md'), pdfFile = path.join(outside, 'Outside document.pdf'), inside = path.join(vault, 'Inside.md')
  fs.writeFileSync(md, '# Outside note\n\nInstalled baseline.\n'); fs.writeFileSync(pdfFile, pdf())
  fs.writeFileSync(inside, '# Inside\n\nInside packaged note.\n')
  // The shell's second launch must use the same normal installed profile as
  // the first. This is safe only on the guarded disposable runner.
  for (const name of ['Forsion', 'forsion-desktop']) {
    const dir = path.join(process.env.APPDATA, name); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'amadeus-config.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  }
  const stub = await startStubEngine()
  let app
  const children = []
  try {
    app = await electron.launch({ executablePath: exe, args: ['--lang=zh-CN', md], env: { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: path.join(home, 'workspace'), TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), exe: process.execPath, data: app.getPath('userData') }))
    check('runtime is the real installed 2.13.5 executable', info.packaged && info.version === '2.13.5' && path.resolve(info.exe).toLowerCase() === path.resolve(exe).toLowerCase())
    const win = await app.firstWindow()
    check('actual installed application leaves first-run onboarding', await skipOnboarding(win, 60000))
    const active = () => win.evaluate(() => [...document.querySelectorAll('.wsfile-tab .wsfile-name')].filter(el => el.offsetParent !== null).at(-1)?.textContent || null)
    const titles = () => win.locator('.dv-tab').allTextContents()
    await until('cold argv opens the real external Markdown file', async () => await active() === md)
    check('cold installed argv opens one external Markdown tab', (await titles()).filter(title => title.trim() === 'Outside note.md').length === 1)
    const editor = win.locator('.wsfile-tab .ProseMirror:visible').first()
    await editor.locator('p').filter({ hasText: 'Installed baseline.' }).click(); await win.keyboard.press('End'); await win.keyboard.type(' SAVED BY INSTALLED APP')
    await until('installed Markdown editor saves the original file', () => fs.readFileSync(md, 'utf8').includes('SAVED BY INSTALLED APP'))
    check('external edit writes the original and creates no imported copy', !fs.existsSync(path.join(vault, 'Outside note.md')))
    const second = spawn(exe, ['--lang=zh-CN', pdfFile], { windowsHide: true, stdio: 'ignore', env: { ...process.env, TANGU_HOME: home } }); children.push(second)
    const exited = new Promise(resolve => { second.once('exit', resolve); second.once('error', () => resolve(-1)) })
    check('second installed process exits into the existing application', await Promise.race([exited, sleep(20000).then(() => -1)]) === 0)
    await until('second installed process opens its PDF', async () => await active() === pdfFile)
    const page = win.locator('.wsfile-tab:visible .pdfViewer .page[data-page-number="1"][data-loaded="true"]')
    await page.waitFor({ timeout: 45000 })
    await until('PDF contains expected rendered text', async () => (await page.innerText()).includes('Installed PDF'))
    const ink = await page.locator('canvas').first().evaluate(canvas => { const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) n++; return n })
    check('installed PDF renders a real page with text and ink', ink > 20)
    // Start on another tab: ignoring ShellExecute must fail this check.
    // Use the untouched NSIS ProgID, never an emitted open-file event.
    ps(`Start-Process -FilePath ${quote(md)}`)
    await until('shell open reuses the external tab', async () => await active() === md)
    check('actual shell Markdown open reuses its installed tab', (await titles()).filter(title => title.trim() === 'Outside note.md').length === 1)
    ps(`Start-Process -FilePath ${quote(inside)}`)
    await win.locator('.ProseMirror:visible').filter({ hasText: 'Inside packaged note.' }).first().waitFor({ timeout: 30000 })
    check('shell opens a vault file in its native note view', await active() !== inside && (await titles()).filter(title => title.trim() === 'Inside').length === 1)
    ps(`Start-Process -FilePath ${quote(md)}`)
    await until('leave the note before lowercase delivery', async () => await active() === md)
    const lower = spawn(exe, [inside.toLowerCase()], { windowsHide: true, stdio: 'ignore' }); children.push(lower)
    check('lowercase installed argv process exits normally', await Promise.race([new Promise(resolve => { lower.once('exit', resolve); lower.once('error', () => resolve(-1)) }), sleep(20000).then(() => -1)]) === 0)
    await win.locator('.ProseMirror:visible').filter({ hasText: 'Inside packaged note.' }).first().waitFor({ timeout: 30000 })
    check('lowercase vault path reuses the native note', (await titles()).filter(title => title.trim().toLowerCase() === 'inside').length === 1 && !await win.locator('.wsfile-name').filter({ hasText: inside.toLowerCase() }).count())
    await win.screenshot({ path: path.join(out, 'installed-note.png') })
    fs.writeFileSync(path.join(out, 'application-results.json'), JSON.stringify({ checks, runtime: info }, null, 2))
    console.log(`${checks.length}/${checks.length} application checks passed`)
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    try { if (app) { const process = app.process(); await Promise.race([app.close(), sleep(15000)]).catch(() => {}); if (process.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } }
    finally { await stub.close() }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
