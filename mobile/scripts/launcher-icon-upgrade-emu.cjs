/** Upgrade acceptance for the home screen entry (the app icon) on one connected emulator / device.
 *
 * Up to 2.13.x the launcher entry was the activity itself (`.MainActivity`). Since the app icon can be switched it is an
 * activity-alias of that name, and the real activity is `AppActivity` (see AndroidManifest.xml, LauncherIconPlugin.kt).
 * What an update must not break is on people's home screens, so this installs the old build first:
 *   1. the old build pins a Space shortcut (its intent names `.MainActivity`);
 *   2. the new build goes on top: the entry keeps its component name (the icon stays where it is), and the pinned
 *      shortcut's intent is rewritten to `AppActivity` even though it is not in the long-press list;
 *   3. the built-in icon is picked with the app in front (started through the entry, like a launcher does): the app
 *      is not closed and nothing is switched; once the app is left the old entry goes — the pinned shortcut stays on
 *      the home screen (shortcuts hang on an entry; they are moved to the new one first) and still opens the app.
 *
 * OLD_APK=<a debug build from before the change> NEW_APK=<the build under test> node scripts/launcher-icon-upgrade-emu.cjs
 * Both must carry the same signature (two debug builds from one machine do). Leaves the new build installed with the
 * default entry; the probe shortcut stays on the emulator's home screen (an app cannot remove a pinned shortcut).
 */
const assert = require('node:assert/strict')
const h = require('./lib/emu-cdp.cjs')

const PKG = process.env.PKG || 'com.forsion.tangu'
const { OLD_APK, NEW_APK } = process.env
const ID = 'space:upgrade-probe'

const entry = () => h.adb('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', PKG).trim().split('\n').pop().trim()
/** The probe shortcut as the system holds it. */
function probe() {
  const out = h.adb('shell', 'dumpsys', 'shortcut', '-p', PKG)
  const own = out.slice(out.indexOf(`Package: ${PKG} `))
  const block = own.split('ShortcutInfo {').find((b) => b.startsWith(`id=${ID},`))
  return block ? { pinned: /flags=0x[0-9a-f]+ \[[^\]]*Pin/.test(block), target: /intents=\[Intent \{[^}]*cmp=([^ }]+)/.exec(block)?.[1] || '', off: !/disabledReason=\[Not disabled\]/.test(block) } : null
}
async function until(read, ok, what, timeout = 20000) {
  const end = Date.now() + timeout
  let last = read()
  while (!ok(last) && Date.now() < end) { await h.pause(500); last = read() }
  assert.ok(ok(last), `${what} (${JSON.stringify(last)})`)
  return last
}
/** Open the probe's link the way its shortcut does; `am` reports a component that is off as an error (and a non-zero exit). */
function open(component) {
  try { return h.adb('shell', 'am', 'start', '-n', component, '-a', 'android.intent.action.VIEW', '-d', 'tangu://space?id=upgrade-probe') } catch (e) { return `Error: ${e.stderr || e.stdout || e.message}` }
}
async function start(activity) {
  h.adb('shell', 'am', 'force-stop', PKG)
  h.adb('shell', 'am', 'start', '-n', `${PKG}/com.forsion.tangu.${activity}`)
  const cdp = await h.connect(PKG)
  assert.ok(await h.waitPage(cdp, 'document.readyState === "complete" && !!window.Capacitor?.Plugins?.SpaceShortcuts', 30000), 'the app did not come up')
  return cdp
}

async function main() {
  assert.ok(OLD_APK && NEW_APK, 'OLD_APK and NEW_APK are required')
  // ── 1. the old build pins a shortcut
  // A run that died with the built-in icon on left `.MainActivity` switched off — under the old build that name is the
  // activity itself, and the app could not be opened at all. Only the app may change it back (the shell is refused).
  if (h.adb('shell', 'pm', 'list', 'packages', PKG).split('\n').some((l) => l.trim() === `package:${PKG}`) && entry() !== `${PKG}/.MainActivity`) {
    h.adb('install', '-r', '-d', NEW_APK)
    const reset = await start('AppActivity')
    await reset.eval("Capacitor.Plugins.LauncherIcon.set({ id: null }).then(() => true)")
    h.adb('shell', 'input', 'keyevent', '3')
    await until(entry, (e) => e === `${PKG}/.MainActivity`, 'the default entry could not be restored before the run')
    reset.close()
  }
  h.adb('install', '-r', '-d', OLD_APK)
  let cdp = await start('MainActivity')
  assert.equal(entry(), `${PKG}/.MainActivity`, 'control: the old build is entered through .MainActivity')
  if (!probe()?.pinned) {
    await cdp.eval("Capacitor.Plugins.SpaceShortcuts.pin({ id: 'upgrade-probe', label: 'Probe' }).then(() => true)")
    const dialog = await h.waitNodes((l) => l.find((n) => /^(add to home screen|add automatically|add)$/i.test(n.text || '')), { timeout: 10000 })
    assert.ok(dialog.hit, "the launcher's pin confirmation did not appear")
    h.tapNode(dialog.hit)
  } else {
    // Already on the home screen from an earlier run (pinning again changes nothing): publishing it once from the old
    // build rewrites its intent the old way; the app's own list replaces this one at its next publish.
    await cdp.eval("Capacitor.Plugins.SpaceShortcuts.setSpaces({ spaces: [{ id: 'upgrade-probe', label: 'Probe' }] }).then(() => true)")
  }
  await until(probe, (p) => !!p && p.pinned && /\.MainActivity$/.test(p.target), 'control: the old build did not pin a shortcut that names .MainActivity')
  console.log(`PASS old build: pinned ${ID} → ${probe().target}`)
  cdp.close()

  // ── 2. the new build on top
  h.adb('install', '-r', NEW_APK)
  assert.equal(entry(), `${PKG}/.MainActivity`, 'the home screen entry changed its name with the update (the icon would leave the home screen)')
  console.log('PASS update: the home screen entry is still .MainActivity')
  cdp = await start('MainActivity')
  const moved = await until(probe, (p) => !!p && /\.AppActivity$/.test(p.target), 'the pinned shortcut still names the old entry after the update')
  assert.ok(moved.pinned && !moved.off, `the pinned shortcut was lost or switched off (${JSON.stringify(moved)})`)
  console.log(`PASS update: pinned ${ID} → ${moved.target}`)

  // ── 3. the built-in icon. The app was started through the entry, like a launcher does: its task begins there, and
  //       Android removes the task about a second after that entry is switched off. So nothing is switched in front.
  const front = () => h.adb('shell', 'dumpsys', 'activity', 'activities').split('\n').some((l) => l.includes('topResumedActivity=') && l.includes(` ${PKG}/`))
  try {
    assert.ok((await cdp.eval("Capacitor.Plugins.LauncherIcon.set({ id: 'builtin:arioso' })")).changed, 'the entry was not asked to change')
    await h.pause(3500)
    assert.ok(front(), 'the app was closed under the user when the icon was picked')
    assert.equal(entry(), `${PKG}/.MainActivity`, 'the entry was switched while the app was in front')
    console.log('PASS built-in icon picked: the app stays in front, nothing is switched yet')
    h.adb('shell', 'input', 'keyevent', '3')
    await until(entry, (e) => e === `${PKG}/.IconArioso`, 'leaving the app did not bring the built-in icon')
    // Shortcuts hang on an entry: the launcher takes a pinned one off the home screen when its entry goes away.
    await h.pause(4000)
    const kept = probe()
    assert.ok(kept && kept.pinned && !kept.off, `the pinned shortcut did not survive the switch (${JSON.stringify(kept)})`)
    const left = open(`${PKG}/.MainActivity`)
    assert.ok(/Error/.test(left), `control: the old entry still opens while the built-in icon is on (${left.trim()})`)
    const opened = open(kept.target)
    assert.ok(!/Error/.test(opened), `the pinned shortcut's target does not open: ${opened.trim()}`)
    await until(front, Boolean, 'the app did not come to the front')
    console.log('PASS after leaving: the built-in icon is the entry, the pinned shortcut stays and opens the app')
  } finally {
    // Back to the default entry: ask in front (a fresh page — the old task went with its entry), then leave.
    cdp.close()
    cdp = await start('AppActivity')
    await cdp.eval("Capacitor.Plugins.LauncherIcon.set({ id: null }).then(() => true)").catch(() => null)
    h.adb('shell', 'input', 'keyevent', '3')
    await until(entry, (e) => e === `${PKG}/.MainActivity`, 'the default entry was not restored')
    cdp.close()
  }
  console.log('5/5 passed')
}
main().catch((e) => { console.error(`FAIL ${e.message}`); process.exit(1) })
