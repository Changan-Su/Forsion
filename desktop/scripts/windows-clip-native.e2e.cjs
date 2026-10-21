/** Genuine Electron folder drag -> headed Chrome and its native folder picker.
 * All desktop input, clipboard and Explorer operations are CI-only. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { chromium } = require('playwright-core')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const run = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ROOT = path.resolve(__dirname, '..'), ID = 'gpajikakdmhjebadgcbmhidkkajclfoi'
async function until(name, condition, timeout=15000) {
  const end=Date.now()+timeout
  while(Date.now()<end){if(await condition())return;await sleep(100)}
  throw new Error(name)
}
async function main() {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Native Clip check requires a dedicated GitHub Actions Windows desktop')
  const output = path.join(ROOT, 'outputs/windows-clip-native'); fs.mkdirSync(output, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'Forsion Clip 中文 ')), userData = path.join(home, 'userdata')
  const desktop = async (action, args = []) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(__dirname, 'lib/windows-clip-desktop.ps1'), '-Action', action, ...args], { windowsHide: true, timeout: 30000 })).stdout.trim()
  const status = { enabled: true, port: 47655, listening: true, error: '', connected: false, clients: [], lastClient: null, extensionId: ID, extensionDir: '/unused/bundled', code: 'tangu:47655:' + 'ab'.repeat(24) }
  const stub = await startStubEngine({ handle: ({ path: p }) => p === '/agent/browser-extension' ? status : undefined })
  for (const dir of [userData, userData + '-dev']) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9', browserEnabled: false, unitHostEnabled: false }))
  }
  let app, browser, settings, copyDir
  const checks = []
  const check = (name, value, details) => { checks.push({ name, ok: !!value, details }); assert.ok(value, name + ': ' + JSON.stringify(details)); console.log('PASS ' + name) }
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=en-US', ROOT], cwd: ROOT,
      env: { ...process.env, FORSION_TEST_DESKTOP: '', TANGU_HARNESS_QUIET: '0', TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const win = await app.firstWindow()
    await app.context().route('**/agent/**', route => {
      const url = new URL(route.request().url())
      return route.continue({ url: stub.url + url.pathname + url.search })
    })
    check('the real main window exits onboarding', await skipOnboarding(win))
    await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, {timeout:60000})
    const opened = app.waitForEvent('window')
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'browser', nonce: Date.now() } }))
    settings = await opened
    const chip = settings.getByTestId('browser-extension-drag')
    await settings.locator('.settings-main').waitFor()
    if (!await chip.isVisible()) await settings.locator('.settings-nav-parent > button', { hasText: /^(浏览器控制|Browser control)$/ }).click()
    await chip.waitFor({ timeout: 30000 })
    const id = await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)?.id, settings.url())
    await settings.evaluate(()=>{window.__clipNativeClicks=[];document.addEventListener('click',event=>window.__clipNativeClicks.push({trusted:event.isTrusted,text:event.target.closest('button')?.textContent||event.target.textContent?.slice(0,100)}),{capture:true,passive:true})})
    const activateSettings = async () => {
      const hwnd=await app.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).getNativeWindowHandle().readBigUInt64LE().toString(),id)
      await desktop('activate',['-FromWindow',hwnd])
    }
    const nativeClick = async locator => {
      await activateSettings()
      await locator.evaluate(element=>{element.focus({preventScroll:true});element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})})
      await locator.click({trial:true,timeout:10000})
      const before=await settings.evaluate(()=>window.__clipNativeClicks.length), expected=await locator.innerText()
      const box=await locator.boundingBox()
      const geo=await app.evaluate(({BrowserWindow},id)=>{const w=BrowserWindow.fromId(id);return {bounds:w.getContentBounds(),zoom:w.webContents.getZoomFactor(),hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString()}},id)
      const viewport=await settings.evaluate(()=>({width:innerWidth,height:innerHeight,focused:document.hasFocus()}))
      assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height&&viewport.focused,'Native click target must be inside the focused settings viewport: '+JSON.stringify({box,viewport}))
      await desktop('click',['-FromWindow',geo.hwnd,'-FromX',String(Math.round((box.x+box.width/2)*geo.zoom)),'-FromY',String(Math.round((box.y+box.height/2)*geo.zoom))])
      await until('native button click is observed',()=>settings.evaluate(({before,expected})=>window.__clipNativeClicks.slice(before).some(click=>click.trusted&&click.text?.trim()===expected.trim()),{before,expected}),5000).catch(()=>{})
      const clicks=await settings.evaluate(()=>window.__clipNativeClicks)
      fs.writeFileSync(path.join(output,`click-${before}.json`),JSON.stringify({box,geo,clicks,expected},null,2))
      if(!clicks.slice(before).some(click=>click.trusted&&click.text?.trim()===expected.trim())) {
        await desktop('capture',['-Path',path.join(output,`click-${before}.png`)])
        throw new Error('Native click missed the intended settings button: '+JSON.stringify({expected,clicks}))
      }
    }
    const copied = await settings.evaluate(() => window.tangu.clipExtension.prepare(false)); copyDir = copied.dir
    check('settings prepares the actual bundled extension in the isolated profile', copyDir?.startsWith(home + path.sep) && fs.existsSync(path.join(copyDir, 'manifest.json')), copied)
    check('settings displays exactly the prepared copy path', (await settings.locator('.settings-browser-ext-panel').innerText()).includes(copyDir))
    await nativeClick(settings.getByTestId('browser-extension-open-chrome'))
    await until('the fallback address reaches the clipboard',async()=>await app.evaluate(({clipboard})=>clipboard.readText())==='chrome://extensions')
    check('Windows fallback copies the real chrome extensions address', await app.evaluate(({ clipboard }) => clipboard.readText()) === 'chrome://extensions')
    await settings.getByTestId('browser-extension-open-note').waitFor()
    check('the fallback prompt is visible', /Copied the address\. Paste it into the Chrome address bar\.|地址已复制/.test(await settings.getByTestId('browser-extension-open-note').innerText()))
    await nativeClick(settings.getByRole('button', { name: /^(Copy path|复制路径)$/ }))
    await until('Copy path reaches the real clipboard',async()=>await app.evaluate(({clipboard})=>clipboard.readText())===copyDir)
    check('Copy path writes the exact extension directory', await app.evaluate(({ clipboard }) => clipboard.readText()) === copyDir)
    await nativeClick(settings.getByRole('button', { name: /^(Open extension folder|打开扩展文件夹)$/ }))
    let explorer
    for (let i=0;i<20;i++) { explorer = JSON.parse(await desktop('explorer', ['-Path', copyDir])); if(explorer.found) break; await sleep(300) }
    check('Open folder creates a real Explorer window at the copied directory', explorer?.found, explorer)
    await desktop('explorer', ['-Path', copyDir, '-Close'])
    const work = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    // The runner has a 1024px desktop. Keep the real settings layout readable,
    // overlap Chrome behind it, and drop into Chrome's exposed right edge.
    const leftWidth = Math.min(820, work.width-160), chromeWidth=Math.min(600,work.width-200)
    await app.evaluate(({ BrowserWindow }, { id, work, leftWidth }) => {
      const window=BrowserWindow.fromId(id), parent=window.getParentWindow()
      if(parent) parent.hide()
      window.setMinimumSize(500,400); window.setBounds({x:work.x,y:work.y,width:leftWidth,height:work.height}); window.show(); window.focus()
    }, {id,work,leftWidth})
    browser = await chromium.launchPersistentContext(path.join(home, 'chrome'), { headless: false, viewport: null, locale: 'en-US', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--lang=en-US', '--no-first-run', '--no-default-browser-check', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', `--window-position=${work.x+work.width-chromeWidth},${work.y}`, `--window-size=${chromeWidth},${work.height}`] })
    const page = browser.pages()[0]; await page.goto('chrome://extensions')
    await page.evaluate(()=>{
      window.__clipNativeDrops=[]
      document.addEventListener('drop',event=>window.__clipNativeDrops.push({trusted:event.isTrusted,types:Array.from(event.dataTransfer?.types||[]),names:Array.from(event.dataTransfer?.files||[],file=>file.name)}),{capture:true,passive:true})
    })
    await app.evaluate(({ipcMain})=>{
      globalThis.__clipNativeDragRequests=[]
      ipcMain.on('fs:startDrag',(_event,file)=>globalThis.__clipNativeDragRequests.push(file))
    })
    const info = () => page.evaluate(() => chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}))
    const dev = enabled => page.evaluate(enabled => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:enabled}),enabled)
    const drag = async () => {
      const requestsBefore=await app.evaluate(()=>globalThis.__clipNativeDragRequests.length)
      const dropsBefore=await page.evaluate(()=>window.__clipNativeDrops.length)
      await activateSettings(); await chip.evaluate(element=>element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'})); await chip.click({trial:true}); await sleep(300)
      const box=await chip.boundingBox()
      const geo=await app.evaluate(({BrowserWindow},id)=>{const w=BrowserWindow.fromId(id);return {bounds:w.getContentBounds(),outer:w.getBounds(),zoom:w.webContents.getZoomFactor(),hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString()}},id)
      const from={x:Math.round((box.x+box.width/2)*geo.zoom),y:Math.round((box.y+box.height/2)*geo.zoom)}
      const to={x:Math.round((geo.outer.x+geo.outer.width+work.x+work.width)/2),y:Math.round(work.y+work.height*0.65)}
      assert.ok(from.x>=0&&from.y>=0&&from.x<geo.bounds.width&&from.y<geo.bounds.height&&to.x>geo.outer.x+geo.outer.width&&to.x<work.x+work.width,'Native drag endpoints must be visible on their real windows')
      fs.writeFileSync(path.join(output,'drag-points.json'),JSON.stringify({from,to,work,box,geo},null,2))
      await desktop('drag',['-FromWindow',geo.hwnd,'-FromX',String(from.x),'-FromY',String(from.y),'-ToX',String(to.x),'-ToY',String(to.y)])
      await sleep(1800)
      const requests=await app.evaluate(()=>globalThis.__clipNativeDragRequests)
      const drops=await page.evaluate(()=>window.__clipNativeDrops)
      fs.writeFileSync(path.join(output,`drop-${dropsBefore}.json`),JSON.stringify({requests,drops},null,2))
      check('each attempt starts a real native Electron folder drag',requests.length===requestsBefore+1&&requests.at(-1)===copyDir,requests)
      check('each native drag reaches the Chrome page as a trusted folder drop',drops.length===dropsBefore+1&&drops.at(-1).trusted&&drops.at(-1).types.includes('Files')&&drops.at(-1).names.includes(path.basename(copyDir)),drops)
    }
    await dev(false); await drag()
    check('native folder drag with developer mode off does not install Clip', !(await info()).some(e=>e.id===ID))
    await page.screenshot({path:path.join(output,'developer-off.png')})
    await dev(true); await drag()
    let installed
    for(let i=0;i<30;i++){ installed=(await info()).find(e=>e.id===ID);if(installed)break;await sleep(300) }
    await desktop('capture',['-Path',path.join(output,'native-drop.png')])
    check('real Electron native folder drag installs Clip as unpacked in Chrome', installed?.location==='UNPACKED' && installed?.state==='ENABLED' && installed?.path?.toLowerCase()===copyDir.toLowerCase(), installed)
    await page.evaluate(id=>chrome.management.uninstall(id,{showConfirmDialog:false}),ID)
    for(let i=0;i<30 && (await info()).some(e=>e.id===ID);i++) await sleep(200)
    check('Clip is removed before independent native picker verification',!(await info()).some(e=>e.id===ID))
    await page.getByRole('button',{name:'Load unpacked',exact:true}).click()
    await desktop('picker',['-Path',copyDir])
    for(let i=0;i<30;i++){ installed=(await info()).find(e=>e.id===ID);if(installed)break;await sleep(300) }
    check('native Load unpacked folder picker independently installs the copy',installed?.location==='UNPACKED' && installed?.path?.toLowerCase()===copyDir.toLowerCase(),installed)
    await page.screenshot({path:path.join(output,'native-picker-installed.png')})
  } finally {
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,home,copyDir},null,2))
    if(settings&&!settings.isClosed()) await settings.screenshot({path:path.join(output,'settings.png')}).catch(()=>{})
    if(browser)await browser.close().catch(()=>{})
    if(app)await app.close().catch(()=>{})
    await stub.close()
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
