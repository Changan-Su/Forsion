/** Real installed-app/window enumeration. User windows are only read, never activated or minimized. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFile } = require('node:child_process')
const { buildSync } = require('esbuild')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-win-apprefs-'))
  const moduleFile = path.join(home, 'apprefs.cjs')
  buildSync({ entryPoints: [path.join(ROOT, 'electron/appRefsWin.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: moduleFile })
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'ud')}`, path.join(__dirname, 'fixtures/windows-contracts-main.cjs')], env: { ...process.env, TANGU_HOME: home } })
  try {
    await app.firstWindow()
    // Dedicated CI desktops have no user windows to enumerate.
    if (!process.env.FORSION_TEST_DESKTOP) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    let calls = 0
    const { createWinAppRefs, parseWinInstalled } = require(moduleFile)
    let inventory = null
    const refs = createWinAppRefs({ ownPid: process.pid,
      run: (file, args, opts) => new Promise((resolve, reject) => {
        calls++
        execFile(file, args, { windowsHide: true, timeout: opts.timeoutMs, maxBuffer: 4 << 20, env: { ...process.env, ...opts.env } }, (e, stdout) => {
          if (e) { reject(e); return }
          const request = JSON.parse(Buffer.from(opts.env.FSN_APPREFS_IN, 'base64').toString('utf8'))
          if (request.op === 'installed') inventory = parseWinInstalled(stdout)
          resolve(stdout)
        }).stdin?.end()
      }),
      fileIcon: p => app.evaluate(async ({ app }, p) => { try { return (await app.getFileIcon(p)).toDataURL() } catch { return null } }, p),
    })
    const list = await refs.list()
    assert.ok(inventory && inventory.start.length > 0 && inventory.links.length > 0 && inventory.paths.length > 0 && !inventory.errors.length, 'all three installed-app sources must return real, error-free inventory')
    assert.ok(!list.error && list.apps.length > 0 && list.windows.length > 0)
    console.log('PASS actual PowerShell lists installed applications and current windows')
    assert.ok(![...list.apps, ...list.windows].some(x => /applicationframehost/i.test(x.id)))
    console.log('PASS packaged app windows are not attributed to ApplicationFrameHost')
    const firstIdle = list.apps.findIndex(x => !x.running)
    assert.ok(firstIdle < 0 || list.apps.slice(firstIdle).every(x => !x.running))
    console.log('PASS running applications precede idle applications')
    // Background-only test windows are intentionally absent from Alt-Tab. Use a read-only
    // reference to an existing classic window; never output its title or open() the reference.
    const own = list.windows.find(x => x.id.endsWith('.exe'))
    assert.ok(own, 'real native snapshot contains a classic application window')
    assert.equal((await refs.status([{ kind: 'window', id: own.id, name: own.title }]))[0].state, 'live')
    console.log('PASS real native window round-trips through reference status without activation')
    const icons = await refs.icons([own.id])
    assert.ok(icons[own.id]?.startsWith('data:image/'))
    console.log('PASS real window owner resolves through Electron file-icon extraction')
    const beforeIdle = calls
    await new Promise(r => setTimeout(r, 1500))
    assert.equal(calls, beforeIdle)
    console.log('PASS idle references create no recurring PowerShell process')
    // Counts only: avoid including personal app names or window titles in public evidence.
    console.log(`Inventory: ${list.apps.length} apps, ${list.windows.length} windows, ${list.apps.filter(x => x.id.includes('%21')).length} packaged apps`)
    console.log('6/6 passed')
  } finally { await app.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
