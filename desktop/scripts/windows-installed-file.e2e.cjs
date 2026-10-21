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
  const stream = 'q 1 0 0 rg 30 20 60 20 re f 0 0 1 rg 150 20 90 20 re f Q BT /F1 18 Tf 40 100 Td (Installed PDF) Tj ET'
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
  let app, win, runtime
  const children = []
  const closeApp = async () => {
    if (!app) return
    const process = app.process()
    await Promise.race([app.close(), sleep(15000)]).catch(() => {})
    if (process.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    app = undefined
  }
  try {
    app = await electron.launch({ executablePath: exe, args: ['--lang=zh-CN', md], env: { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: path.join(home, 'workspace'), TANGU_BACKEND_URL: stub.url }, timeout: 60000 })
    const info = runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), exe: process.execPath, data: app.getPath('userData') }))
    check('runtime is the real installed 2.13.5 executable', info.packaged && info.version === '2.13.5' && path.resolve(info.exe).toLowerCase() === path.resolve(exe).toLowerCase())
    win = await app.firstWindow()
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
    // The external preview is PdfView, not the notebook PdfAnnotator. It paints
    // canvas only. Check this file's two unique colors and black text region;
    // a blank allocated canvas, other PDF, or an unloaded font must fail.
    const canvas = win.locator('.wsfile-tab:visible canvas.wsfile-pdf-page').first()
    await canvas.waitFor({ timeout: 45000 })
    await until('installed PDF paints the fixture geometry and text', async () => canvas.evaluate(canvas => {
      const width = canvas.width, height = canvas.height, data = canvas.getContext('2d').getImageData(0, 0, width, height).data
      const pixel = (x, y) => [...data.slice(4 * (Math.floor(y * height) * width + Math.floor(x * width)), 4 * (Math.floor(y * height) * width + Math.floor(x * width)) + 4)]
      const red = pixel(60 / 300, 170 / 200), blue = pixel(195 / 300, 170 / 200), white = pixel(120 / 300, 170 / 200)
      let ink = 0
      for (let y = Math.floor(height * 75 / 200); y < height * 110 / 200; y++) for (let x = Math.floor(width * 35 / 300); x < width * 210 / 300; x++) {
        const i = 4 * (y * width + x); if (data[i + 3] > 240 && data[i] < 180 && data[i + 1] < 180 && data[i + 2] < 180) ink++
      }
      return red[0] > 240 && red[1] < 10 && red[2] < 10 && blue[0] < 10 && blue[1] < 10 && blue[2] > 240 && white.slice(0, 3).every(v => v > 240) && ink > 40
    }), 45000)
    check('installed PDF paints the unique color geometry and text ink', true)
    await win.screenshot({ path: path.join(out, 'installed-pdf.png'), timeout: 10000 })
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
    await closeApp()
    // Exercise the actual cold ShellExecute path after all installed processes
    // exit, inspecting its rendered content through native UIA without attaching
    // a debugger or changing the official registry handler.
    const cold = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'windows-installed-cold-shell.ps1'), '-Executable', exe, '-File', md, '-Output', path.join(out, 'cold-shell.json')], {
      windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: path.join(home, 'workspace'), TANGU_BACKEND_URL: stub.url },
    })
    const coldCode = await new Promise((resolve, reject) => { cold.once('exit', resolve); cold.once('error', reject) })
    check('actual cold shell open renders the original file in the installed app', coldCode === 0 && JSON.parse(fs.readFileSync(path.join(out, 'cold-shell.json'), 'utf8').replace(/^\uFEFF/, '')).passed)
    fs.writeFileSync(path.join(out, 'application-results.json'), JSON.stringify({ checks, runtime: info }, null, 2))
    console.log(`${checks.length}/${checks.length} application checks passed`)
  } catch (error) {
    const state = win && !win.isClosed() ? await win.locator('body').innerText().catch(() => '') : ''
    if (win && !win.isClosed()) await win.screenshot({ path: path.join(out, 'failure.png'), timeout: 10000 }).catch(() => {})
    fs.writeFileSync(path.join(out, 'application-results.json'), JSON.stringify({ checks, runtime, error: String(error), state: state.slice(-12000) }, null, 2))
    throw error
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    try { await closeApp() }
    finally { await stub.close() }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
