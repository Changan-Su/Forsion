/** Real Windows shell shortcuts in temporary folders. No installed shortcuts or user icons are changed. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-win-icons-'))
  const moduleFile = path.join(home, 'system-icon.cjs')
  buildSync({ entryPoints: [path.join(ROOT, 'electron/systemIcon.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: moduleFile })
  const args = [`--user-data-dir=${path.join(home, 'userdata')}`, path.join(__dirname, 'fixtures/windows-contracts-main.cjs')]
  const opts = { args, cwd: ROOT, env: { ...process.env, TANGU_HOME: home } }
  let app
  try {
    app = await electron.launch(opts)
    await app.firstWindow()
    const result = await app.evaluate(async ({ shell, nativeImage }, input) => {
      const require = globalThis.__windowsProbeRequire
      const fs = require('node:fs/promises')
      const path = require('node:path')
      const { keepWindowsIcon } = require(input.module)
      const root = path.join(input.home, '中文, shortcuts')
      const folders = ['Desktop', 'Start Menu', 'TaskBar'].map(p => path.join(root, p))
      for (const p of folders) await fs.mkdir(p, { recursive: true })
      const exe = process.execPath
      const dir = path.join(root, 'user data')
      const png = Buffer.from(input.png, 'base64')
      const links = folders.map(p => path.join(p, 'Forsion.lnk'))
      const check = (condition, name) => { if (!condition) throw new Error(name); return name }
      const checks = []
      for (const link of links) check(shell.writeShortcutLink(link, 'create', { target: exe, icon: exe, iconIndex: 0, args: '--probe-argument', description: 'Keep description' }), 'create real .lnk')
      const other = path.join(folders[0], 'Other.lnk')
      check(shell.writeShortcutLink(other, 'create', { target: process.env.ComSpec, icon: process.env.ComSpec, iconIndex: 0 }), 'create unrelated shortcut')
      const target = { shell, folders, exe, dir }
      await keepWindowsIcon(target, 'arioso', () => png, 256)
      const icon = shell.readShortcutLink(links[0]).icon
      checks.push(check(links.every(p => shell.readShortcutLink(p).icon === icon) && icon.startsWith(dir), 'real Desktop / Start Menu / TaskBar shortcuts point to hashed ICO'))
      checks.push(check(!nativeImage.createFromPath(icon).isEmpty(), 'Windows Electron decodes generated ICO'))
      checks.push(check(links.every(p => { const s = shell.readShortcutLink(p); return s.args === '--probe-argument' && s.description === 'Keep description' }), 'updating icon preserves launch arguments and description'))
      checks.push(check(shell.readShortcutLink(other).icon === process.env.ComSpec, 'unrelated application shortcut preserved'))
      await keepWindowsIcon(target, 'custom-image', () => png, 256)
      const newer = shell.readShortcutLink(links[0]).icon
      checks.push(check(newer !== icon && (await fs.stat(icon)).isFile(), 'new image changes cache path and retains previous ICO'))
      // Installer recreates one of our shortcuts, then startup reconciles it.
      shell.writeShortcutLink(links[1], 'update', { icon: exe, iconIndex: 0 })
      await keepWindowsIcon(target, 'custom-image', () => { throw new Error('ICO should be reused') }, 256)
      checks.push(check(shell.readShortcutLink(links[1]).icon === newer, 'recreated shortcut reconciled on next keep'))
      shell.writeShortcutLink(links[0], 'update', { icon: exe, iconIndex: 1 })
      await keepWindowsIcon(target, null, () => png, 256)
      checks.push(check(shell.readShortcutLink(links[0]).iconIndex === 1 && links.slice(1).every(p => shell.readShortcutLink(p).icon === exe), 'reset preserves user icon and restores app-owned shortcuts'))
      await keepWindowsIcon(target, 'persisted', () => png, 256)
      return { checks, links, icon: shell.readShortcutLink(links[0]).icon }
    }, { home, module: moduleFile, png: fs.readFileSync(path.join(ROOT, 'build/icon.png')).toString('base64') })
    for (const name of result.checks) console.log(`PASS ${name}`)
    await app.close(); app = null
    assert.ok(fs.existsSync(result.icon))
    app = await electron.launch(opts)
    await app.firstWindow()
    assert.ok(await app.evaluate(({ shell }, r) => r.links.every(p => shell.readShortcutLink(p).icon === r.icon), result))
    console.log('PASS shortcut icon persists across complete Electron exit and restart')
    console.log(`${result.checks.length + 1}/${result.checks.length + 1} passed`)
  } finally {
    if (app) await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
