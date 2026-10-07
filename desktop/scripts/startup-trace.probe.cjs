/** 自然冷启动下开屏的时间线(真 Electron,三个平台都能跑)。跑之前先 build。
 *
 * 为什么存在:2026-10-06 那轮 Windows 验收(startup-windows.probe.cjs)为了截到完整画面,把应用入口模块扣住不放,
 * 量帧的那段主线程是空的 —— 而真实冷启动恰恰是主线程在解析 / 执行应用模块。那轮加的「连续慢帧就切静帧并立即退场」
 * 因此在验收里从不触发,在用户机器上每次冷启动都触发(开屏闪一下就僵住 / 直接进去,10-07 用户反馈)。
 * 这支探针什么都不扣:记下画面出现、是否被降级、应用首帧、淡出、移除各自的时刻,以及窗口真正露出来之后开屏还留了多久。
 *
 * 跑:npm run probe:startup-trace   可选 STARTUP_CPU_RATE=4(渲染进程 CPU 限速)、STARTUP_RUNS=3、STARTUP_SOFTWARE_GPU=1
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.resolve(__dirname, '..')
const RUNS = Number(process.env.STARTUP_RUNS) || 3
/** 树影的最短展示(startupAppearance.js 里是 1300ms):从窗口露出来算,到开始淡出。留 50ms 给两个进程的时钟差。 */
const MIN_HELD = 1250

// 每个新文档里先于页面脚本执行:只观察,不改任何行为。
const TRACE = `(() => {
  if (window.top !== window) return;
  const t = window.__splashTrace = { origin: performance.timeOrigin, events: [], gaps: [] };
  const mark = (name) => t.events.push([name, Math.round(performance.now())]);
  let last = 0;
  const frame = (now) => { if (last) t.gaps.push(Math.round(now - last)); last = now; if (!t.removed) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  new MutationObserver(() => {
    const s = document.getElementById('tangu-splash'), root = document.getElementById('root');
    if (s && !t.scene && s.querySelector('.fts')) { t.scene = true; mark('scene'); }
    if (s && !t.still && s.dataset.performanceStill) { t.still = s.dataset.performanceStill; mark('still'); }
    if (root && root.firstChild && !t.painted) { t.painted = true; mark('app'); }
    if (s && !t.fade && s.classList.contains('out')) { t.fade = true; mark('fade'); }
    if (t.scene && !s && !t.removed) { t.removed = true; mark('removed'); }
  }).observe(document, { subtree: true, childList: true, attributes: true });
})()`

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-startup-trace-'))
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'probe' }))
  }
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: 'forsion-desktop', version: require('../package.json').version, type: 'module', main: 'probe.mjs' }))
  fs.writeFileSync(path.join(home, 'probe.mjs'), `
import { app, ipcMain } from 'electron';
app.setAppPath(${JSON.stringify(ROOT)});
const probe = globalThis.__startupProbe = { events: [] };
// Chromium answers "disabled" for every feature until the GPU process has reported; gpuKnownAtCreate tells the two apart.
app.once('gpu-info-update', () => { probe.gpuAfterInfo = app.getGPUFeatureStatus().gpu_compositing ?? null; });
// A second listener on the preload's own question: what the status reads at that very moment, and whether it can be trusted yet.
ipcMain.on('appearance:softwareRendering', () => {
  if (probe.gpuAtPreload !== undefined) return;
  probe.gpuAtPreload = app.getGPUFeatureStatus().gpu_compositing ?? null;
  probe.gpuKnownAtPreload = probe.gpuAfterInfo !== undefined;
});
app.on('browser-window-created', (_event, win) => {
  if (probe.observed) return;
  probe.observed = true;
  if (process.env.STARTUP_CPU_RATE) {
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: Number(process.env.STARTUP_CPU_RATE) });
  }
  win.once('ready-to-show', () => probe.events.push(['ready', Date.now()]));
  win.once('show', () => probe.events.push(['show', Date.now()]));
});
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'out/main/main.js')).href)});
`)
  const rows = []
  let app
  try {
    for (let run = 1; run <= RUNS; run++) {
      app = await electron.launch({ args: [`--user-data-dir=${userdata}`, ...(process.env.STARTUP_SOFTWARE_GPU === '1' ? ['--disable-gpu'] : []), '--lang=zh-CN', home], cwd: ROOT,
        env: { ...process.env, TANGU_HARNESS_QUIET: '1', TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
      // Playwright holds the app's `ready` until it is attached, so this lands before the first window exists.
      await app.context().addInitScript(TRACE)
      const win = await app.firstWindow()
      await win.waitForFunction(() => window.__splashTrace?.removed, null, { timeout: 30000 })
      const trace = await win.evaluate(() => window.__splashTrace)
      const native = await app.evaluate(() => globalThis.__startupProbe)
      await app.close(); app = null
      const at = (name) => trace.events.find((e) => e[0] === name)?.[1] ?? null
      const shown = native.events.find((e) => e[0] === 'show')
      // shownAt:窗口露出来的时刻(和别的几项一样,从页面开始加载算);held:露出来之后到开始淡出;visible:到整块移除。
      const shownAt = shown ? Math.round(shown[1] - trace.origin) : null
      const held = shown && at('fade') !== null ? at('fade') - shownAt : null, visible = shown ? at('removed') - shownAt : null
      const row = { run, still: trace.still ?? null, scene: at('scene'), shownAt, app: at('app'), fade: at('fade'), removed: at('removed'), held, visible,
        slowFrames: trace.gaps.filter((gap) => gap > 50).length, maxGap: Math.max(0, ...trace.gaps), gpuAtPreload: native.gpuAtPreload ?? null, gpuKnownAtPreload: native.gpuKnownAtPreload ?? null, gpuAfterInfo: native.gpuAfterInfo ?? null }
      rows.push(row)
      console.log(JSON.stringify(row))
    }
  } finally { if (app) await app.close(); await stub.close() }
  const out = path.join(ROOT, 'outputs/startup-trace')
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ platform: process.platform, cpuRate: Number(process.env.STARTUP_CPU_RATE) || 1, rows }, null, 2))
  let failed = 0
  const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`) }
  // 软件合成(没有显卡的机器 / CI)下画面是静帧,但退场一样要留够时间、一样淡出。
  const software = rows.some((row) => row.still === 'software')
  check('主线程忙不会把树影降级成静帧', rows.every((row) => row.still === null || row.still === 'software'))
  check('开屏淡出,而不是直接消失', rows.every((row) => row.fade !== null))
  check('窗口露出来之后守满最短展示才开始淡出', rows.every((row) => row.held !== null && row.held >= MIN_HELD))
  console.log(`${failed ? 'FAILED' : 'OK'}${software ? '(软件合成:静帧)' : ''};记录:${path.join(out, 'results.json')}`)
  if (failed) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
