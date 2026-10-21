/** Actual OS mouse input. Dedicated GitHub runner only; never mocks cursor or resize IPC. */
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path')
const {execFile}=require('node:child_process'), {promisify}=require('node:util')
const electron=require('./lib/launch-electron.cjs')
const {startStubEngine}=require('./lib/stub-engine.cjs')
const {skipOnboarding}=require('./lib/skip-onboarding.cjs')
const run=promisify(execFile), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const ROOT=path.resolve(__dirname,'..'), output=path.join(ROOT,'outputs/mini-native-windows')
async function main() {
  if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true') throw new Error('Requires an exclusive GitHub Windows desktop')
  fs.mkdirSync(output,{recursive:true})
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'forsion-mini-native-')), userData=path.join(home,'userdata')
  const stub=await startStubEngine(), checks=[]
  const check=(name,ok,details)=>{checks.push({name,ok:!!ok,details});assert.ok(ok,name+': '+JSON.stringify(details));console.log('PASS '+name)}
  const native=async(action,args=[])=>run('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'lib/mini-native-input.ps1'),'-Action',action,...args],{windowsHide:true,timeout:30000})
  for(const dir of [userData,userData+'-dev']) {
    fs.mkdirSync(dir,{recursive:true})
    fs.writeFileSync(path.join(dir,'tangu-desktop-config.json'),JSON.stringify({mode:'external',backendUrl:stub.url,token:'mini-native',cloudUrl:'http://127.0.0.1:9',browserEnabled:false,unitHostEnabled:false}))
  }
  let app,mini
  try {
    app=await electron.launch({args:['--user-data-dir='+userData,'--lang=en-US',ROOT],cwd:ROOT,
      env:{...process.env,TANGU_HOME:home,TANGU_BACKEND_URL:stub.url,FORSION_TEST_DESKTOP:'',TANGU_HARNESS_QUIET:'0'}})
    const win=await app.firstWindow()
    check('real application exits onboarding',await skipOnboarding(win))
    await win.evaluate(()=>window.tangu.openMini({spaceId:'calendar'}))
    for(let i=0;i<200;i++){mini=app.windows().find(w=>w.url().includes('window=mini'));if(mini)break;await pause(50)}
    assert.ok(mini,'Real Mini window exists')
    await mini.locator('.mini-todo .amx-todo').waitFor({timeout:30000})
    const receipt=await app.evaluate(({screen,app,BrowserWindow})=>{
      const main=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('window=mini'))
      const area=screen.getPrimaryDisplay().workArea
      main.setBounds({x:area.x,y:area.y,width:area.width,height:area.height});main.show()
      return {windows:process.getSystemVersion(),electron:process.versions.electron,version:app.getVersion(),displays:screen.getAllDisplays(),main:main.getNativeWindowHandle().readBigUInt64LE().toString(),area}
    })
    fs.writeFileSync(path.join(output,'runtime.json'),JSON.stringify({commit:process.env.GITHUB_SHA,...receipt},null,2))
    const geometry=()=>app.evaluate(({BrowserWindow})=>{
      const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=mini'))
      return {bounds:w.getContentBounds(),hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString(),zoom:w.webContents.getZoomFactor(),focused:w.isFocused()}
    })
    const place=async(width=340,height=340)=>{
      await app.evaluate(({BrowserWindow},b)=>{
        const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=mini'))
        w.setContentBounds(b);w.showInactive()
      },{x:receipt.area.x+200,y:receipt.area.y+100,width,height})
      await pause(350)
    }
    await mini.evaluate(()=>{
      window.__nativeEdges=[]
      for(const type of ['pointerdown','pointermove','pointerup']) document.addEventListener(type,e=>{
        if(type==='pointermove'&&!e.buttons)return
        window.__nativeEdges.push({type,trusted:e.isTrusted,edge:e.target.closest('.mini-card-edge')?.dataset.edge,x:e.screenX,y:e.screenY,buttons:e.buttons})
      },true)
    })
    const drag=async(edge,dx,dy,name)=>{
      await native('activate',['-Window',receipt.main])
      const before=await geometry()
      check(name+' starts with Mini inactive',!before.focused,before)
      const target=mini.locator('.mini-card-edge[data-edge="'+edge+'"]'), box=await target.boundingBox()
      const point=edge.length===1?{x:box.x+box.width/2,y:box.y+box.height/2}:
        {x:edge.includes('w')?box.x+box.width-2:box.x+2,y:edge.includes('n')?box.y+box.height-2:box.y+2}
      check(name+' shows the correct resize cursor',await target.evaluate(el=>getComputedStyle(el).cursor)===(edge.length===1?(edge==='s'||edge==='n'?'ns-resize':'ew-resize'):(edge==='ne'||edge==='sw'?'nesw-resize':'nwse-resize')))
      const start=await mini.evaluate(()=>window.__nativeEdges.length)
      await native('drag',['-Window',before.hwnd,'-X',String(Math.round(point.x*before.zoom)),'-Y',String(Math.round(point.y*before.zoom)),'-Dx',String(dx),'-Dy',String(dy)])
      await pause(250)
      const after=await geometry(), events=await mini.evaluate(start=>window.__nativeEdges.slice(start),start)
      check(name+' receives trusted down, held moves and up on the first gesture',
        events.some(e=>e.type==='pointerdown'&&e.trusted&&e.edge===edge)&&events.filter(e=>e.type==='pointermove'&&e.trusted&&e.buttons===1).length>=2&&events.some(e=>e.type==='pointerup'&&e.trusted),events)
      fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify({before,after,events},null,2))
      return {before:before.bounds,after:after.bounds}
    }
    const closeEnough=(a,b)=>Math.abs(a-b)<=2
    for(const edge of ['s','n','e','w','se','sw','ne','nw']) {
      await place()
      const dx=edge.includes('e')?50:edge.includes('w')?-50:0,dy=edge.includes('s')?40:edge.includes('n')?-40:0
      const {before:b,after:a}=await drag(edge,dx,dy,'edge-'+edge)
      const expected={x:b.x+(edge.includes('w')?dx:0),y:b.y+(edge.includes('n')?dy:0),width:b.width+(edge.includes('w')?-dx:dx),height:b.height+(edge.includes('n')?-dy:dy)}
      check('native '+edge+' resize anchors the opposite edge and follows the pointer',Object.keys(expected).every(k=>closeEnough(a[k],expected[k])),{before:b,after:a,expected})
      const kept=await geometry();await pause(300)
      check('native '+edge+' release keeps the chosen bounds',JSON.stringify(kept.bounds)===JSON.stringify((await geometry()).bounds))
    }
    await place()
    const small=await drag('se',-200,-220,'minimum')
    check('actual inward gesture clamps at 260 by 160',small.after.width===260&&small.after.height===160,small)
    await place()
    const large=await drag('se',450,500,'maximum')
    check('actual outward gesture stops at maximum width and work area bottom',large.after.width===640&&large.after.y+large.after.height<=receipt.area.y+receipt.area.height&&large.after.height>340,large)
    await place()
    await mini.evaluate(()=>localStorage.setItem('forsion_ui_zoom','1.1'));await mini.reload()
    await mini.locator('.mini-todo .amx-todo').waitFor()
    // Reload resets the passive observer, so reinstall it for the independent zoom case.
    await mini.evaluate(()=>{window.__nativeEdges=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{if(type!=='pointermove'||e.buttons)window.__nativeEdges.push({type,trusted:e.isTrusted,edge:e.target.closest('.mini-card-edge')?.dataset.edge,buttons:e.buttons,x:e.screenX,y:e.screenY})},true)})
    check('110 percent uses the actual stored UI zoom',await mini.evaluate(()=>Math.abs(parseFloat(getComputedStyle(document.body).zoom)-1.1)<0.001))
    const zoomed=await drag('s',0,60,'zoom-110')
    check('110 percent native bottom drag tracks screen coordinates',closeEnough(zoomed.after.height,zoomed.before.height+60)&&zoomed.after.y===zoomed.before.y,zoomed)
    await mini.screenshot({path:path.join(output,'zoom-110.png')})
    await native('capture',['-Path',path.join(output,'desktop-final.png')])
  } catch(error) {
    await native('capture',['-Path',path.join(output,'failure-desktop.png')]).catch(()=>{})
    throw error
  } finally {
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks},null,2))
    if(app) {
      const child=app.process()
      await Promise.race([app.close().catch(()=>{}),pause(8000)])
      if(child.exitCode===null)await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{})
    }
    await stub.close()
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
