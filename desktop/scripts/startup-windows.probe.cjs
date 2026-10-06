/** Windows cold-start/first-show probe. Run after build; never modifies the user's profile or display settings.
 * STARTUP_SYSTEM_SCALE=1.25 checks the actual OS scaling (no Chromium scale override).
 * Optional: STARTUP_DISPLAY_ID, STARTUP_MAXIMIZED=1, STARTUP_SYSTEM_REDUCED=1, STARTUP_SOFTWARE_GPU=1.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'outputs/windows-startup')
const SYSTEM_SCALE = process.env.STARTUP_SYSTEM_SCALE ? Number(process.env.STARTUP_SYSTEM_SCALE) : null

async function main() {
  assert.equal(process.platform, 'win32', 'This probe requires Windows')
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-windows-startup-'))
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'probe' }))
  }
  // Observe the native window before the real main module constructs it.
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: 'forsion-desktop', version: require('../package.json').version, type: 'module', main: 'probe.mjs' }))
  fs.writeFileSync(path.join(home, 'probe.mjs'), `
import { app, screen } from 'electron';
import { writeFileSync } from 'node:fs';
app.setAppPath(${JSON.stringify(ROOT)});
globalThis.__startupProbe = { events: [] };
app.on('browser-window-created', (_event, win) => {
  if (globalThis.__startupProbe.observed) return;
  globalThis.__startupProbe.observed = true;
  if (process.env.STARTUP_DISPLAY_ID) {
    const display = screen.getAllDisplays().find(d => String(d.id) === process.env.STARTUP_DISPLAY_ID);
    if (!display) throw new Error('Requested native display is unavailable');
    win.setBounds({ x: display.workArea.x + 80, y: display.workArea.y + 80, width: 1200, height: 820 });
  }
  // Keep the HTML splash visible for font/scene capture, then let the actual application paint and exit it.
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, cb) => {
    if (!details.url.includes('/assets/index-') || !details.url.endsWith('.js')) { cb({}); return; }
    globalThis.__releaseStartupEntry = () => { globalThis.__releaseStartupEntry = null; cb({}); };
  });
  globalThis.__startupProbe.events.push({ event: 'created', visible: win.isVisible() });
  let painted = false;
  win.once('ready-to-show', () => {
    painted = true; globalThis.__startupProbe.events.push({ event: 'ready' });
    if (process.env.STARTUP_MAXIMIZED === '1') win.maximize();
  });
  win.once('show', async () => {
    globalThis.__startupProbe.events.push({ event: 'show', painted });
    const image = await win.webContents.capturePage();
    writeFileSync(process.env.STARTUP_FIRST_SHOT, image.toPNG());
    const size = image.getSize(), bits = image.toBitmap();
    const offset = (Math.floor(size.height * .45) * size.width + Math.floor(size.width * .03)) * 4;
    globalThis.__startupProbe.pixel = [...bits.subarray(offset, offset + 4)];
  });
});
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'out/main/main.js')).href)});
`)
  let app
  const launch = async (label, scale = 1) => {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, ...(!SYSTEM_SCALE ? [`--force-device-scale-factor=${scale}`] : []), ...(process.env.STARTUP_SOFTWARE_GPU === '1' ? ['--disable-gpu'] : []), '--lang=zh-CN', home], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, STARTUP_FIRST_SHOT: path.join(OUT, `${label}-first.png`) } })
    return app.firstWindow()
  }
  const results = []
  let checks = 0
  const check = (name, ok) => { assert.ok(ok, name); checks++; console.log(`PASS ${name}`) }
  const captureScene = async (win, label) => {
    // Locator screenshots wait for document.fonts.ready, which also waits for the held module.
    // Capture the compositor directly while the initial scene is still mounted.
    await win.waitForTimeout(1800)
    assert.ok(await win.locator('#tangu-splash .fts').count(), 'Capture must contain the startup scene')
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
    fs.writeFileSync(path.join(OUT, `${label}.png`), Buffer.from(png, 'base64'))
    const brandRect = await win.locator('.fts-brand').evaluate(node => {
      const r = node.getBoundingClientRect()
      return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 }
    })
    const brand = await app.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect)).toPNG().toString('base64'), brandRect)
    fs.writeFileSync(path.join(OUT, `${label}-brand.png`), Buffer.from(brand, 'base64'))
  }
  try {
    let win = await launch('seed')
    await win.waitForSelector('#tangu-splash .fts')
    await app.evaluate(() => globalThis.__releaseStartupEntry?.())
    await win.waitForSelector('#root')
    await win.evaluate(() => {
      localStorage.setItem('forsion_default_space', 'tangu')
      localStorage.setItem('tangu_locale', 'zh')
    })
    for (const mode of ['light', 'dark']) {
      // Persist the actual renderer preferences, then cold-start the same isolated profile.
      await win.evaluate((mode) => { localStorage.setItem('forsion_theme', mode); localStorage.setItem('forsion_theme_pref', mode) }, mode)
      await app.close(); app = null
      for (const scale of SYSTEM_SCALE ? [SYSTEM_SCALE] : [1, 1.25, 1.5]) {
        const label = `${mode}-${scale}`
        win = await launch(label, scale)
        await win.waitForSelector('#tangu-splash .fts')
        const scene = await win.evaluate(() => {
          const splash = document.querySelector('#tangu-splash'), scene = splash.querySelector('.fts')
          const verse = scene.querySelector('.fts-verse'), brand = scene.querySelector('.fts-brand')
          const visible = (node) => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }
          return { mode: document.documentElement.dataset.mode, scale: devicePixelRatio, lines: [...verse.querySelectorAll('p')].map((p) => p.textContent),
            inView: visible(verse) && visible(brand), classic: !!splash.querySelector('.tangu-splash-logo'),
            mediaReduce: matchMedia('(prefers-reduced-motion: reduce)').matches, nativeReduce: window.tangu.startupAppearance.prefersReducedMotion,
            reduce: splash.hasAttribute('data-reduced-motion'), animations: scene.getAnimations({ subtree: true }).length }
        })
        let native
        for (let attempt = 0; attempt < 50; attempt++) {
          native = await app.evaluate(() => globalThis.__startupProbe)
          if (native.pixel) break
          await win.waitForTimeout(50)
        }
        check(`${label}: hidden at creation, shown only after first paint`, native.events[0].visible === false && native.events.find((e) => e.event === 'show')?.painted)
        check(`${label}: first visible frame has the selected background`, native.pixel?.slice(0, 3).every((channel) => mode === 'dark' ? channel < 80 : channel > 150))
        check(`${label}: tree shadow and verse fit at requested DPI`, scene.mode === mode && Math.abs(scene.scale - scale) < .02 && scene.inView && !scene.classic && scene.lines.length === 3)
        await win.evaluate(() => {
          window.__startupFrames = []
          const scene = document.querySelector('#tangu-splash .fts')
          const frame = (at) => { window.__startupFrames.push(at); if (scene.isConnected) requestAnimationFrame(frame) }
          requestAnimationFrame(frame)
        })
        await captureScene(win, label)
        const system = await app.evaluate(async ({ app, BrowserWindow, screen }) => {
          const win = BrowserWindow.getAllWindows()[0];
          return { bounds: win.getBounds(), maximized: win.isMaximized(), displays: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor })), gpu: await app.getGPUInfo('basic'), gpuFeatures: app.getGPUFeatureStatus() };
        })
        if (process.env.STARTUP_SYSTEM_REDUCED === '1') { console.log('NOTE native reduced motion', scene); check(`${label}: OS animation setting produces a complete still scene`, scene.reduce && scene.animations === 0) }
        results.push({ label, scene, native, system })
        await app.evaluate(() => globalThis.__releaseStartupEntry?.())
        await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 15000 })
        const frames = await win.evaluate(() => window.__startupFrames)
        const gaps = frames.slice(1).map((at, i) => at - frames[i]).sort((a, b) => a - b)
        results[results.length - 1].timing = gaps.length ? { frames: frames.length, fps: 1000 * gaps.length / (frames.at(-1) - frames[0]), p95: gaps[Math.floor(gaps.length * .95)], max: gaps.at(-1) } : null
        check(`${label}: splash exits`, true)
        if (!SYSTEM_SCALE && scale !== 1.5) { await app.close(); app = null }
      }
      // Electron ignores the Chromium reduced-motion CLI flag on Windows. Emulate the renderer media preference explicitly.
      if (process.env.STARTUP_SYSTEM_REDUCED !== '1') await win.emulateMedia({ reducedMotion: 'reduce' })
      await win.reload({ waitUntil: 'commit' })
      await win.waitForSelector('#tangu-splash .fts')
      const reduced = await win.evaluate(() => {
        const scene = document.querySelector('#tangu-splash .fts')
        return { reduce: document.querySelector('#tangu-splash').hasAttribute('data-reduced-motion'), animations: scene.getAnimations({ subtree: true }).length,
          verse: getComputedStyle(scene.querySelector('.fts-verse p')).opacity, cloud: getComputedStyle(scene.querySelector('.fts-cloud')).opacity }
      })
      check(`${mode}: ${process.env.STARTUP_SYSTEM_REDUCED === '1' ? 'OS' : 'emulated'} reduced motion paints a complete still scene`, reduced.reduce && reduced.animations === 0 && reduced.verse === '1' && reduced.cloud === '0')
      await captureScene(win, `${mode}-reduced`)
      await app.evaluate(() => globalThis.__releaseStartupEntry?.())
      await win.locator('#tangu-splash').waitFor({ state: 'detached', timeout: 15000 })
      check(`${mode}: reduced-motion splash exits`, true)
      results.push({ label: `${mode}-reduced-media`, reduced })
    }
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ checks, results }, null, 2))
    console.log(`${checks} checks passed; screenshots: ${OUT}`)
  } finally { if (app) await app.close(); await stub.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
