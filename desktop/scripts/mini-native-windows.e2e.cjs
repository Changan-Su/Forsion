/** Actual OS mouse input. Dedicated GitHub runner only; never mocks cursor or resize IPC. */
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path')
const {execFile}=require('node:child_process'), {promisify}=require('node:util')
const electron=require('./lib/launch-electron.cjs')
const {startStubEngine}=require('./lib/stub-engine.cjs')
const {skipOnboarding}=require('./lib/skip-onboarding.cjs')
const run=promisify(execFile), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const ROOT=path.resolve(__dirname,'..'), output=path.join(ROOT,'outputs/mini-native-windows')
async function main() {
  if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
    process.env.GITHUB_WORKFLOW!=='probe-windows-mini-native'||process.env.GITHUB_JOB!=='native-mini'||
    !process.env.RUNNER_TEMP) throw new Error('Requires the dedicated GitHub-hosted Windows Mini job')
  fs.mkdirSync(output,{recursive:true})
  const captures=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'forsion-mini-native-frames-'))
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'forsion-mini-native-')), userData=path.join(home,'userdata')
  const stub=await startStubEngine(), checks=[]
  const check=(name,ok,details,continueOnFailure=false)=>{
    checks.push({name,ok:!!ok,details})
    console.log((ok?'PASS ':'FAIL ')+name)
    if(!continueOnFailure) assert.ok(ok,name+': '+JSON.stringify(details))
  }
  const native=async(action,args=[])=>run('powershell.exe',['-NoProfile','-NonInteractive','-STA','-File',path.join(__dirname,'lib/mini-native-input.ps1'),'-Action',action,...args],{windowsHide:true,timeout:30000})
  for(const dir of [userData,userData+'-dev']) {
    fs.mkdirSync(dir,{recursive:true})
    fs.writeFileSync(path.join(dir,'tangu-desktop-config.json'),JSON.stringify({mode:'external',backendUrl:stub.url,token:'mini-native',cloudUrl:'http://127.0.0.1:9',browserEnabled:false,unitHostEnabled:false}))
  }
  let app,mini,fixture
  try {
    app=await electron.launch({args:['--user-data-dir='+userData,'--lang=en-US',ROOT],cwd:ROOT,
      env:{...process.env,TANGU_HOME:home,TANGU_BACKEND_URL:stub.url,FORSION_TEST_DESKTOP:'',TANGU_HARNESS_QUIET:'0'}})
    const win=await app.firstWindow()
    check('real application exits onboarding',await skipOnboarding(win))
    const openCalendar=()=>win.evaluate(()=>window.tangu.openMini({spaceId:'calendar'}))
    const waitForMini=async()=>{
      for(let i=0;i<200;i++){
        const opened=app.windows().find(w=>!w.isClosed()&&w.url().includes('window=mini'))
        if(opened) return opened
        await pause(50)
      }
    }
    await openCalendar()
    mini=await waitForMini()
    assert.ok(mini,'Real Mini window exists')
    await mini.locator('.mini-todo .amx-todo').waitFor({timeout:30000})
    await mini.evaluate(()=>localStorage.setItem('forsion_theme_pref','light'))
    await mini.reload()
    await mini.locator('.mini-todo .amx-todo').waitFor({timeout:30000})
    await mini.waitForFunction(()=>document.documentElement.dataset.mode==='light')
    const receipt=await app.evaluate(({screen,app,BrowserWindow})=>{
      const main=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('window=mini'))
      const primary=screen.getPrimaryDisplay(),area=primary.workArea
      main.setBounds({x:area.x,y:area.y,width:area.width,height:area.height});main.show()
      return {windows:process.getSystemVersion(),electron:process.versions.electron,version:app.getVersion(),displays:screen.getAllDisplays(),main:main.getNativeWindowHandle().readBigUInt64LE().toString(),area,displayBounds:primary.bounds,displayScale:primary.scaleFactor}
    })
    fs.writeFileSync(path.join(output,'runtime.json'),JSON.stringify({commit:process.env.GITHUB_SHA,...receipt},null,2))
    fixture=JSON.parse((await native('fixture')).stdout.trim())
    fs.writeFileSync(path.join(output,'foreground-fixture.json'),JSON.stringify(fixture,null,2))
    const geometry=()=>app.evaluate(({BrowserWindow})=>{
      const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=mini'))
      return {bounds:w.getContentBounds(),hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString(),zoom:w.webContents.getZoomFactor(),focused:w.isFocused(),visible:w.isVisible()}
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
    const drag=async(edge,move,name,visualFixture)=>{
      if(visualFixture) {
        await app.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id).focus(),visualFixture.id)
        check(name+' owns the foreground before mouse down',
          (await native('foreground',['-Window',visualFixture.hwnd])).stdout.trim()==='True')
      } else await native('activate',['-Window',fixture.hwnd])
      const before=await geometry()
      check(name+' starts with Mini inactive',!before.focused,before)
      const target=mini.locator('.mini-card-edge[data-edge="'+edge+'"]'), box=await target.boundingBox()
      const point=edge.length===1?{x:box.x+box.width/2,y:box.y+box.height/2}:
        {x:edge.includes('w')?box.x+box.width-2:box.x+2,y:edge.includes('n')?box.y+box.height-2:box.y+2}
      check(name+' shows the correct resize cursor',await target.evaluate(el=>getComputedStyle(el).cursor)===(edge.length===1?(edge==='s'||edge==='n'?'ns-resize':'ew-resize'):(edge==='ne'||edge==='sw'?'nesw-resize':'nwse-resize')))
      const x=Math.round(point.x*before.zoom),y=Math.round(point.y*before.zoom)
      const {dx,dy}=typeof move==='function'?move(before.bounds,x,y):move
      const start=await mini.evaluate(()=>window.__nativeEdges.length)
      const frameDir=path.join(captures,name)
      let frames
      try {
        const trace=await native('drag',['-Window',before.hwnd,'-X',String(x),'-Y',String(y),'-Dx',String(dx),'-Dy',String(dy),
          ...(visualFixture?['-FrameDir',frameDir,'-BackdropWindow',visualFixture.hwnd]:[])])
        if(visualFixture) frames=JSON.parse(trace.stdout.trim())
      } finally {
        if(visualFixture&&fs.existsSync(frameDir)) fs.cpSync(frameDir,path.join(output,name),{recursive:true})
      }
      await pause(250)
      const after=await geometry(), events=await mini.evaluate(start=>window.__nativeEdges.slice(start),start)
      check(name+' receives trusted down, held moves and up on the first gesture',
        events.some(e=>e.type==='pointerdown'&&e.trusted&&e.edge===edge)&&events.filter(e=>e.type==='pointermove'&&e.trusted&&e.buttons===1).length>=2&&events.some(e=>e.type==='pointerup'&&e.trusted),events)
      fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify({before,after,events,frames},null,2))
      return {before:before.bounds,after:after.bounds,frames}
    }
    const closeEnough=(a,b)=>Math.abs(a-b)<=2
    for(const edge of ['s','n','e','w','se','sw','ne','nw']) {
      await place()
      const dx=edge.includes('e')?50:edge.includes('w')?-50:0,dy=edge.includes('s')?40:edge.includes('n')?-40:0
      const {before:b,after:a}=await drag(edge,{dx,dy},'edge-'+edge)
      const expected={x:b.x+(edge.includes('w')?dx:0),y:b.y+(edge.includes('n')?dy:0),width:b.width+(edge.includes('w')?-dx:dx),height:b.height+(edge.includes('n')?-dy:dy)}
      check('native '+edge+' resize anchors the opposite edge and follows the pointer',Object.keys(expected).every(k=>closeEnough(a[k],expected[k])),{before:b,after:a,expected})
      const kept=await geometry();await pause(300)
      check('native '+edge+' release keeps the chosen bounds',JSON.stringify(kept.bounds)===JSON.stringify((await geometry()).bounds))
    }
    await place()
    const small=await drag('se',{dx:-200,dy:-220},'minimum')
    check('actual inward gesture clamps at 260 by 160',small.after.width===260&&small.after.height===160,small)
    await place()
    const large=await drag('se',{dx:450,dy:500},'maximum')
    check('actual outward gesture reaches maximum width and work area bottom',large.after.width===640&&closeEnough(large.after.y+large.after.height,receipt.area.y+receipt.area.height)&&large.after.x===large.before.x&&large.after.y===large.before.y,large)
    // One dark, owned native window covers the capture area behind the Mini on
    // the exclusive runner. Screenshot each sample from the Windows desktop,
    // because the renderer cannot see stale or clipped compositor frames.
    const visualFixture=await app.evaluate(async ({BrowserWindow},area)=>{
      const w=new BrowserWindow({...area,frame:false,show:false,backgroundColor:'#161820'})
      await w.loadURL('data:text/html,<body style="margin:0;background:%23161820">')
      w.show()
      return { id:w.id,hwnd:w.getNativeWindowHandle().readBigUInt64LE().toString() }
    },receipt.area)
    try {
      for(const direction of ['minimum','maximum']) {
        await place()
        const inward=direction==='minimum'
        const toLimit=(bounds,x,y)=>{
          const rightLimit=inward?bounds.x+260:bounds.x+640
          const bottomLimit=inward?bounds.y+160:Math.min(bounds.y+900,receipt.area.y+receipt.area.height)
          const screenRight=receipt.displayBounds.x+receipt.displayBounds.width
          const screenBottom=receipt.displayBounds.y+receipt.displayBounds.height
          const endX=inward?rightLimit-36:Math.min(rightLimit+36,screenRight-10)
          const endY=inward?bottomLimit-36:Math.min(bottomLimit+26,screenBottom-10)
          assert.ok(inward||(endX-rightLimit>=16&&endY-bottomLimit>=16),'Actual display has to permit pointer travel beyond both clamps')
          return {dx:endX-(bounds.x+x),dy:endY-(bounds.y+y)}
        }
        const {before,after,frames}=await drag('se',toLimit,direction+'-compositor',visualFixture)
        const stable=frames.filter(frame=>frame.stableGeometry)
        const first=stable.find(frame=>frame.phase==='before'),last=stable.findLast(frame=>frame.phase==='released')
        const held=frames.filter(frame=>frame.phase==='clamped')
        const moving=stable.filter(frame=>frame.phase==='drag')
        const active=frames.filter(frame=>frame.phase==='drag'||frame.phase==='clamped')
        // GDI may spend longer on its first capture before any mouse movement.
        const gap=Math.max(...active.slice(1).map((frame,i)=>frame.timeMs-active[i].timeMs))
        const physicalWidth=Math.round((inward?260:640)*receipt.displayScale)
        const physicalHeight=Math.round((inward?160:Math.min(900,receipt.area.y+receipt.area.height-before.y))*receipt.displayScale)
        const visuallyWhole=frame=>frame.clearBackdrop&&frame.roundedCorners===4&&frame.filledSides===4&&frame.lightInterior>=23
        check(direction+' compositor has a bright rounded Mini surrounded by a dark fixture before resizing',first&&visuallyWhole(first),first,true)
        check(direction+' reaches the expected resize limit',
          inward ? after.width===260&&after.height===160 : after.width===640&&closeEnough(after.y+after.height,receipt.area.y+receipt.area.height),after)
        check(direction+' stays at its final size and position while the pointer moves beyond both axes',
          last&&closeEnough(last.width,physicalWidth)&&closeEnough(last.height,physicalHeight)&&held.length>=12&&
          new Set(held.map(frame=>frame.cursorX)).size>1&&new Set(held.map(frame=>frame.cursorY)).size>1&&held.every(frame=>
            frame.width===last.width&&frame.height===last.height&&frame.x===last.x&&frame.y===last.y&&
              (inward ? frame.cursorX<frame.x+frame.width-8&&frame.cursorY<frame.y+frame.height-8 :
                frame.cursorX>frame.x+frame.width+8&&frame.cursorY>frame.y+frame.height+8)),held)
        check(direction+' timestamped independent compositor samples observe the moving native card',
          frames.length>=40&&moving.length>=12&&new Set(moving.map(frame=>frame.width)).size>=5&&gap<=65,{samples:frames.length,moving:moving.length,gap},true)
        check(direction+' stable-geometry compositor samples show filled sides and rounded corner contours',
          last&&stable.length>=frames.length*.75&&stable.every(visuallyWhole),stable.filter(frame=>!visuallyWhole(frame)),true)
      }
    } finally {
      await app.evaluate(({BrowserWindow},id)=>BrowserWindow.fromId(id)?.destroy(),visualFixture.id)
    }
    await place()
    const inward=await drag('s',{dx:0,dy:-80},'bottom-inward')
    check('actual upward bottom-edge drag shortens only the height',inward.after.x===inward.before.x&&inward.after.y===inward.before.y&&inward.after.width===inward.before.width&&closeEnough(inward.after.height,inward.before.height-80),inward)
    await pause(300)
    check('upward bottom-edge release keeps the chosen size',JSON.stringify(inward.after)===JSON.stringify((await geometry()).bounds))
    await place()
    await mini.evaluate(()=>localStorage.setItem('forsion_ui_zoom','1.1'));await mini.reload()
    await mini.locator('.mini-todo .amx-todo').waitFor()
    // Reload resets the passive observer, so reinstall it for the independent zoom case.
    await mini.evaluate(()=>{window.__nativeEdges=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>{if(type!=='pointermove'||e.buttons)window.__nativeEdges.push({type,trusted:e.isTrusted,edge:e.target.closest('.mini-card-edge')?.dataset.edge,buttons:e.buttons,x:e.screenX,y:e.screenY})},true)})
    check('110 percent uses the actual stored UI zoom',await mini.evaluate(()=>Math.abs(parseFloat(getComputedStyle(document.body).zoom)-1.1)<0.001))
    const zoomed=await drag('s',{dx:0,dy:60},'zoom-110')
    check('110 percent native bottom drag tracks screen coordinates',closeEnough(zoomed.after.height,zoomed.before.height+60)&&zoomed.after.y===zoomed.before.y,zoomed)
    await mini.screenshot({path:path.join(output,'zoom-110.png')})
    await mini.evaluate(()=>{window.__miniControlClicks=[];document.addEventListener('click',e=>window.__miniControlClicks.push({trusted:e.isTrusted,label:e.target.closest('button')?.getAttribute('aria-label')}),true)})
    const nativeClick=async locator=>{
      const geo=await geometry(),box=await locator.boundingBox()
      assert.ok(box,'Native control must have actual bounds')
      await native('click',['-Window',geo.hwnd,'-X',String(Math.round((box.x+box.width/2)*geo.zoom)),'-Y',String(Math.round((box.y+box.height/2)*geo.zoom))])
    }
    const showMain=mini.getByRole('button',{name:'Show in main panel',exact:true})
    const showLabel=await showMain.getAttribute('aria-label')
    await nativeClick(showMain)
    await win.waitForFunction(()=>!!document.querySelector('.amx-todo'))
    check('native main-panel button receives a trusted click',await mini.evaluate(label=>window.__miniControlClicks.some(e=>e.trusted&&e.label===label),showLabel))
    const mainForeground=(await native('foreground',['-Window',receipt.main])).stdout.trim()==='True'
    check('native main-panel button focuses the visible exact ToDo surface',mainForeground&&await win.locator('.amx-todo').first().isVisible())
    const kept=(await geometry()).bounds
    const closeMini=async()=>{
      await nativeClick(mini.locator('.mini-card-close'))
      for(let i=0;i<60&&!mini.isClosed();i++) await pause(50)
      return mini.isClosed()
    }
    check('native close button closes Mini without resize interception',await closeMini())
    await openCalendar()
    mini=await waitForMini()
    assert.ok(mini,'Opening the same calendar should recreate Mini')
    await mini.locator('.mini-todo .amx-todo').waitFor()
    const reopened=(await geometry()).bounds
    check('native close and reopening the same calendar retain the exact resized dimensions',
      kept.width===reopened.width&&kept.height===reopened.height,{kept,reopened},true)
    fs.writeFileSync(path.join(output,'native-reopen.json'),JSON.stringify({target:{spaceId:'calendar'},kept,reopened},null,2))
    await mini.screenshot({path:path.join(output,'native-reopened.png')})
    assert.ok(await closeMini(),'No targeted Mini should be open before testing the global shortcut')
    // The global shortcut can create the default entity. Minimize the main
    // surface whose activation was verified so it cannot cover Notepad.
    await app.evaluate(({BrowserWindow},handle)=>BrowserWindow.getAllWindows().find(w=>w.getNativeWindowHandle().readBigUInt64LE().toString()===handle).minimize(),receipt.main)
    await pause(300)
    await native('hotkey',['-Window',fixture.hwnd])
    mini=await waitForMini()
    assert.ok(mini,'Native global shortcut reopens Mini')
    await mini.locator('.mini-todo .amx-todo').waitFor()
    const shortcut=await geometry()
    check('native Ctrl Shift M visibly reopens the real Mini from another app',!mini.isClosed()&&shortcut.visible,shortcut)
    await mini.screenshot({path:path.join(output,'native-shortcut.png')})
    await native('capture',['-Path',path.join(output,'desktop-final.png')])
    console.log(checks.filter(result=>result.ok).length+'/'+checks.length+' checks passed')
    if(checks.some(result=>!result.ok)) process.exitCode=1
  } catch(error) {
    await native('capture',['-Path',path.join(output,'failure-desktop.png')]).catch(()=>{})
    throw error
  } finally {
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks},null,2))
    if(fixture)await run('taskkill.exe',['/PID',String(fixture.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{})
    if(app) {
      const child=app.process()
      await Promise.race([app.close().catch(()=>{}),pause(8000)])
      if(child.exitCode===null)await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{})
    }
    await stub.close()
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
