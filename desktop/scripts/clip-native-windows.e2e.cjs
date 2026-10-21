/** Genuine Electron folder drag -> headed Chrome and its native folder picker.
 * All desktop input, clipboard and Explorer operations are CI-only. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { fileURLToPath } = require('node:url')
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
  const packagedExe=process.env.FORSION_CLIP_NATIVE_EXE
  const output = path.join(ROOT, 'outputs/windows-clip-native',packagedExe?'packaged':'source'); fs.mkdirSync(output, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'Forsion Clip 中文 ')), userData = path.join(home, 'userdata')
  const desktop = async (action, args = []) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(__dirname, 'lib/windows-clip-desktop.ps1'), '-Action', action, ...args], { windowsHide: true, timeout: 30000 })).stdout.trim()
  const status = { enabled: true, port: 47655, listening: true, error: '', connected: false, clients: [], lastClient: null, extensionId: ID, extensionDir: '/unused/bundled', code: 'tangu:47655:' + 'ab'.repeat(24) }
  const stub = await startStubEngine({ handle: ({ path: p }) => p === '/agent/browser-extension' ? status : undefined })
  for (const dir of [userData, userData + '-dev']) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', backendUrl: stub.url, token: 'e2e', cloudUrl: 'http://127.0.0.1:9', browserEnabled: false, unitHostEnabled: false }))
  }
  let app, browser, settings, copyDir, deadline, phase='launch'
  const stage=name=>{phase=name;console.log('STAGE '+name);fs.writeFileSync(path.join(output,'stage.json'),JSON.stringify({phase,time:new Date().toISOString()},null,2))}
  const checks = []
  const check = (name, value, details) => { checks.push({ name, ok: !!value, details }); assert.ok(value, name + ': ' + JSON.stringify(details)); console.log('PASS ' + name) }
  try {
    await Promise.race([(async()=>{
    app = await electron.launch({ ...(packagedExe?{executablePath:packagedExe}:{}),args: [`--user-data-dir=${userData}`, '--lang=en-US',...(packagedExe?[]:[ROOT])], cwd: ROOT,
      env: { ...process.env, FORSION_TEST_DESKTOP: '', TANGU_HARNESS_QUIET: '0', TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
    const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,appData:app.getPath('appData'),resources:process.resourcesPath,electron:process.versions.electron,version:app.getVersion(),appPath:app.getAppPath()}))
    check('runtime uses the intended genuine source or packaged application',runtime.packaged===!!packagedExe,runtime)
    fs.writeFileSync(path.join(output,'runtime.json'),JSON.stringify({runtime,commit:process.env.GITHUB_SHA,windows:os.release()},null,2))
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
    const sameCopy = actual => {
      try { return typeof actual==='string'&&fs.realpathSync.native(actual).toLowerCase()===fs.realpathSync.native(copyDir).toLowerCase() } catch { return false }
    }
    const expectedCopy=packagedExe?path.join(runtime.appData,'Forsion','Forsion Clip'):path.join(home,'Forsion Clip')
    const sourceManifest=path.join(packagedExe?path.join(runtime.resources,'tangu-server/browser-extension'):path.join(ROOT,'node_modules/@forsion/clip/chrome-mv3'),'manifest.json')
    check('settings prepares the actual bundled extension at the correct runtime copy path',copyDir===expectedCopy&&fs.existsSync(path.join(copyDir,'manifest.json')),copied)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copyDir,'manifest.json'),'utf8')),JSON.parse(fs.readFileSync(sourceManifest,'utf8')))
    check('the copied manifest matches the real runtime bundle',true)
    check('settings displays exactly the prepared copy path', (await settings.locator('.settings-browser-ext-panel').innerText()).includes(copyDir))
    await nativeClick(settings.getByTestId('browser-extension-open-chrome'))
    await until('the fallback address reaches the clipboard',async()=>await app.evaluate(({clipboard})=>clipboard.readText())==='chrome://extensions')
    check('Windows fallback copies the real chrome extensions address', await app.evaluate(({ clipboard }) => clipboard.readText()) === 'chrome://extensions')
    await settings.getByTestId('browser-extension-open-note').waitFor()
    check('the fallback prompt is visible', /Copied the address\. Paste it into the Chrome address bar\.|已复制扩展页地址/.test(await settings.getByTestId('browser-extension-open-note').innerText()))
    await nativeClick(settings.getByRole('button', { name: /^(Copy path|复制路径)$/ }))
    await until('Copy path reaches the real clipboard',async()=>await app.evaluate(({clipboard})=>clipboard.readText())===copyDir)
    check('Copy path writes the exact extension directory', await app.evaluate(({ clipboard }) => clipboard.readText()) === copyDir)
    await nativeClick(settings.getByRole('button', { name: /^(Open extension folder|打开扩展文件夹)$/ }))
    let explorer
    for (let i=0;i<20;i++) { explorer = JSON.parse(await desktop('explorer', ['-Path', copyDir])); if(explorer.found) break; await sleep(300) }
    fs.writeFileSync(path.join(output,'explorer-info.json'),JSON.stringify(explorer,null,2))
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
    stage('launch Chrome')
    browser = await chromium.launchPersistentContext(path.join(home, 'chrome'), { headless: false, viewport: null, locale: 'en-US', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--lang=en-US', '--no-first-run', '--no-default-browser-check', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', `--window-position=${work.x+work.width-chromeWidth},${work.y}`, `--window-size=${chromeWidth},${work.height}`] })
    let page = browser.pages()[0]; await page.goto('chrome://extensions')
    fs.writeFileSync(path.join(output,'chrome.json'),JSON.stringify({version:browser.browser().version()},null,2))
    const observeDrops = () => page.evaluate(()=>{
      window.__clipNativeDrops=[]
      for(const type of ['dragenter','dragover','dragleave','drop']) document.addEventListener(type,event=>{
        const entry={type,trusted:event.isTrusted,types:Array.from(event.dataTransfer?.types||[]),names:Array.from(event.dataTransfer?.files||[],file=>file.name),target:event.target.tagName,time:performance.now()}
        window.__clipNativeDrops.push(entry)
        queueMicrotask(()=>{entry.defaultPrevented=event.defaultPrevented;entry.dragTarget=document.documentElement.classList.contains('drag-target')})
      },{capture:true,passive:true})
    })
    await observeDrops()
    await app.evaluate(({ipcMain})=>{
      globalThis.__clipNativeDragRequests=[]
      ipcMain.on('fs:startDrag',(_event,file)=>globalThis.__clipNativeDragRequests.push(file))
    })
    const info = () => page.evaluate(() => chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}))
    const dev = async enabled => {
      await page.bringToFront()
      const toggle=page.locator('extensions-toolbar').locator('#devMode')
      await toggle.waitFor()
      if(await toggle.evaluate(element=>element.checked)!==enabled) await toggle.click()
      await until('Chrome UI applies developer mode',()=>page.evaluate(enabled=>{const manager=document.querySelector('extensions-manager');return manager?.inDevMode===enabled&&manager?.shadowRoot?.querySelector('extensions-drop-overlay')?.dragEnabled===enabled},enabled),5000).catch(()=>{})
      const profile=await page.evaluate(()=>chrome.developerPrivate.getProfileConfiguration())
      const ui=await page.evaluate(()=>{const manager=document.querySelector('extensions-manager');return {inDevMode:manager?.inDevMode,dragEnabled:manager?.shadowRoot?.querySelector('extensions-drop-overlay')?.dragEnabled}})
      fs.writeFileSync(path.join(output,`developer-mode-${enabled}.json`),JSON.stringify({profile,ui},null,2))
      check('Chrome developer mode matches the real UI and native profile',profile.inDeveloperMode===enabled&&ui.inDevMode===enabled&&ui.dragEnabled===enabled,{profile,ui})
      await page.screenshot({path:path.join(output,`developer-mode-${enabled}.png`)})
    }
    const drag = async accepted => {
      const pagesBefore=new Set(browser.pages())
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
      const events=drops.slice(dropsBefore)
      const directoryTabs=browser.pages().filter(tab=>!pagesBefore.has(tab)&&tab.url().startsWith('file:')&&sameCopy(fileURLToPath(tab.url())))
      // Chromium refuses dragover with developer mode off, so the OS cannot
      // deliver an accepted drop. Observe trusted Files input without changing
      // that decision; filenames become readable only on an accepted drop.
      check('each native folder drag is received by Chrome',events.some(event=>['dragenter','dragover'].includes(event.type)&&event.trusted&&event.types.includes('Files'))||(!accepted&&directoryTabs.length===1),{events,directoryTabs:directoryTabs.map(tab=>tab.url())})
      if(accepted) check('enabled developer mode accepts the actual folder drop',events.some(event=>event.type==='drop'&&event.trusted&&event.types.includes('Files')&&event.names.includes(path.basename(copyDir))),events)
      if(!accepted&&directoryTabs.length) {
        fs.writeFileSync(path.join(output,'developer-off-behavior.json'),JSON.stringify({installed:(await info()).some(extension=>extension.id===ID),behavior:'Chrome opens the exact dropped directory as a file tab',urls:directoryTabs.map(tab=>tab.url())},null,2))
        await directoryTabs[0].screenshot({path:path.join(output,'developer-off-directory.png')})
        for(const tab of directoryTabs) await tab.close()
      }
    }
    stage('developer mode off native drag')
    await dev(false); await drag(false)
    check('native folder drag with developer mode off does not install Clip', !(await info()).some(e=>e.id===ID))
    await page.screenshot({path:path.join(output,'developer-off.png')})
    // The rejected OS drop opens a separate file tab. Start the positive case
    // with a fresh WebContents so its first dragenter is independently observed.
    // Keep the rejected-case event trace rather than mutating Chrome's handler.
    fs.writeFileSync(path.join(output,'developer-off-final-events.json'),JSON.stringify(await page.evaluate(()=>window.__clipNativeDrops),null,2))
    const rejectedPage=page
    stage('create independent positive Chrome page')
    page=await browser.newPage(); await page.goto('chrome://extensions'); await observeDrops(); await rejectedPage.close()
    stage('developer mode on native drag')
    await dev(true); await drag(true)
    let installed
    for(let i=0;i<30;i++){ installed=(await info()).find(e=>e.id===ID);if(installed)break;await sleep(300) }
    await desktop('capture',['-Path',path.join(output,'native-drop.png')])
    check('real Electron native folder drag installs Clip as unpacked in Chrome', installed?.location==='UNPACKED' && installed?.state==='ENABLED' && sameCopy(installed?.path), installed)
    stage('uninstall before native picker')
    await page.evaluate(id=>chrome.management.uninstall(id,{showConfirmDialog:false}),ID)
    for(let i=0;i<30 && (await info()).some(e=>e.id===ID);i++) await sleep(200)
    check('Clip is removed before independent native picker verification',!(await info()).some(e=>e.id===ID))
    stage('open native folder picker')
    await page.getByRole('button',{name:'Load unpacked',exact:true}).click()
    stage('select the actual directory in native picker')
    await desktop('picker',['-Path',copyDir])
    for(let i=0;i<30;i++){ installed=(await info()).find(e=>e.id===ID);if(installed)break;await sleep(300) }
    check('native Load unpacked folder picker independently installs the copy',installed?.location==='UNPACKED' && installed?.state==='ENABLED' && sameCopy(installed?.path),installed)
    await page.screenshot({path:path.join(output,'native-picker-installed.png')})
    stage('completed native checks')
    })(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Native Clip deadline exceeded at '+phase)),180000)})])
  } catch(error) {
    console.error('Native Clip acceptance failed:',error)
    await desktop('capture',['-Path',path.join(output,'failure-desktop.png')]).catch(()=>{})
    throw error
  } finally {
    clearTimeout(deadline)
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,home,copyDir},null,2))
    if(settings&&!settings.isClosed()) await settings.screenshot({path:path.join(output,'settings.png')}).catch(()=>{})
    if(browser)await Promise.race([browser.close().catch(()=>{}),sleep(10000)])
    if(app) {
      const child=app.process()
      await app.context().unrouteAll({behavior:'ignoreErrors'}).catch(()=>{})
      await Promise.race([app.close().catch(()=>{}),sleep(8000)])
      if(child.exitCode===null) await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{})
    }
    await Promise.race([stub.close(),sleep(5000)])
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
