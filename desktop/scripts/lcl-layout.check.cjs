/** Real WorkspaceHost / Dockview geometry and state regression. npm run check:lcl-layout */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http')
const {build}=require('esbuild'),{chromium}=require('playwright-core')
const root=path.resolve(__dirname,'..'),out=fs.mkdtempSync(path.join(os.tmpdir(),'lcl-layout-'))
const assert=(ok,message,data)=>{if(!ok)throw Error(`${message}: ${JSON.stringify(data)}`);console.log(`PASS ${message}`)}
async function run(){
 await build({entryPoints:[path.join(__dirname,'fixtures/lcl-layout.tsx')],outfile:path.join(out,'app.js'),bundle:true,platform:'browser',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],alias:{'@lcl':path.resolve(root,'../lcl'),'@':path.join(root,'frontend/src')},loader:{'.woff2':'dataurl','.woff':'dataurl','.svg':'dataurl'},logLevel:'warning'})
 fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>*{box-sizing:border-box}html,body,#root{width:100%;height:100%;margin:0}.probe-shell{height:100%;display:flex;background:var(--sidebar-bg,#eee)}.probe-ribbon{width:48px;flex:none;padding:16px}main{min-width:0;flex:1;display:flex;flex-direction:column}header,footer{height:32px;flex:none;padding:6px 16px}section{min-height:0;flex:1;position:relative}.probe-content{height:100%;display:flex;flex-direction:column;padding:16px;gap:12px}.probe-content h2{font-size:18px}.probe-content textarea{min-height:56px;width:100%;flex:none}.probe-scroll{overflow:auto;flex:1;min-height:0}.probe-content iframe{height:60px;flex:none;border:1px solid #aaa;width:100%}</style></head><body><div id="root"></div><script src="app.js"></script></body></html>`)
 const server=http.createServer((req,res)=>{const f=path.join(out,req.url==='/'?'index.html':req.url.split('?')[0]);if(!fs.existsSync(f)){res.writeHead(404);res.end();return}res.setHeader('Content-Type',f.endsWith('.css')?'text/css':f.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(f))})
 await new Promise(r=>server.listen(0,'127.0.0.1',r))
 const cache=path.join(os.homedir(),'Library/Caches/ms-playwright')
 const executable=process.env.CHROMIUM_EXE||fs.readdirSync(cache).filter(d=>d.startsWith('chromium-')).sort().reverse().flatMap(d=>['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','Chromium.app/Contents/MacOS/Chromium'].map(a=>path.join(cache,d,'chrome-mac-arm64',a))).find(fs.existsSync)
 const browser=await chromium.launch({headless:true,executablePath:executable})
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[]
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.log('console:',m.text().slice(0,220))})
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(()=>window.probe?.ws.getState().api?.panels.length===4)
  await page.waitForTimeout(600)
  const state=()=>page.evaluate(()=>{const api=probe.ws.getState().api,v=document.querySelector('.wb-workspace-viewport');return{width:api.width,viewport:v.clientWidth,scrollWidth:v.scrollWidth,phase:v.dataset.layoutPhase,groups:api.groups.map(g=>({id:g.id,loc:g.panels[0]?.params.__loc,w:g.api.width,h:g.api.height,visible:g.api.isVisible,rect:g.element.getBoundingClientRect().toJSON()})),overlays:[...document.querySelectorAll('.dv-render-overlay[data-lcl-visible="true"]')].map(e=>({loc:e.dataset.lclLoc,rect:e.getBoundingClientRect().toJSON(),opacity:getComputedStyle(e).opacity,transform:getComputedStyle(e).transform}))}})
  const initial=await state();fs.writeFileSync(path.join(out,'initial.json'),JSON.stringify(initial,null,2))
  assert(initial.groups.filter(g=>g.loc==='main').every(g=>g.w>=320),'native main groups retain minimum width',initial)
  assert(initial.overlays.length===4,'all View content is visible',initial)
  await page.evaluate(()=>{const el=document.querySelector('.dv-render-overlay[data-lcl-loc="main"]');window.saved={el,scroll:el.querySelector('.probe-scroll'),draft:el.querySelector('textarea'),frame:el.querySelector('iframe')};saved.scroll.scrollTop=550;saved.draft.value='Persistent draft';saved.frame.contentWindow.marker='alive'})
  const sample=async(reverse=false)=>page.evaluate(async reverse=>{
   const api=probe.ws.getState().api,left=api.panels.find(p=>p.params.__loc==='left').group,frames=[],start=performance.now();let reversed=false
   probe.ws.getState().toggleSidebar('left')
   await new Promise(resolve=>{const tick=()=>{const t=performance.now()-start;frames.push({t,left:left.api.width,main:api.groups.filter(g=>g.panels[0]?.params.__loc==='main').map(g=>({w:g.api.width,x:g.element.getBoundingClientRect().x})),overlay:[...document.querySelectorAll('.dv-render-overlay[data-lcl-visible="true"]')].map(el=>({x:el.getBoundingClientRect().x,w:el.getBoundingClientRect().width,opacity:getComputedStyle(el).opacity,transform:getComputedStyle(el).transform,loc:el.dataset.lclLoc,contentWidth:el.firstElementChild.getBoundingClientRect().width}))});if(reverse&&!reversed&&t>65){reversed=true;probe.ws.getState().toggleSidebar('left')}if(t<400)requestAnimationFrame(tick);else resolve()};requestAnimationFrame(tick)})
   return frames
  },reverse)
  const frames=await sample(true);fs.writeFileSync(path.join(out,'frames.json'),JSON.stringify(frames,null,2))
  assert(frames.some(f=>f.left>5&&f.left<initial.groups.find(g=>g.loc==='left').w-5),'continuous intermediate sidebar geometry',frames.map(f=>f.left))
  assert((await state()).groups.find(g=>g.loc==='left').visible,'closing reversal returns to open')
  assert(frames.every(f=>f.overlay.filter(o=>o.loc==='left').every(o=>o.contentWidth>=initial.groups.find(g=>g.loc==='left').w-1)),'opening and closing clip readable sidebar content without squeezing it')
  assert(frames.every(f=>f.overlay.every(o=>o.opacity==='1'&&(o.transform==='none'||o.transform==='matrix(1, 0, 0, 1, 0, 0)'))),'no content crossfade or scale')
  const retained=await page.evaluate(()=>({node:saved.el.isConnected,draft:saved.draft.value,scroll:saved.scroll.scrollTop,frame:saved.frame.contentWindow.marker}))
  assert(retained.node&&retained.draft==='Persistent draft'&&retained.scroll===550&&retained.frame==='alive','draft, scroll and iframe state survive reversal',retained)
  await page.evaluate(()=>{const api=probe.ws.getState().api,mains=api.groups.filter(g=>g.panels[0]?.params.__loc==='main');mains[0].api.setActive();window.rightGroup=mains[1].id;window.hiddenMemory={panel:mains[1].activePanel,el:mains[1].activePanel.view.content.element};hiddenMemory.scroll=hiddenMemory.el.querySelector('.probe-scroll');hiddenMemory.scroll.scrollTop=444;mains[1].element.querySelector('.dv-new-tab').click()})
  assert(await page.evaluate(()=>probe.ws.getState().api.activePanel.group.id===rightGroup),'right-hand New tab stays in its originating group')
  const hidden=await page.evaluate(()=>({connected:hiddenMemory.el.isConnected,rects:hiddenMemory.el.getClientRects().length,inert:hiddenMemory.el.closest('.dv-render-overlay').inert}))
  assert(hidden.connected&&hidden.rects===0&&hidden.inert,'inactive retained Views are excluded from geometry, focus and shortcut visibility guards',hidden)
  const restoredTab=await page.evaluate(async()=>{const active=probe.ws.getState().api.activePanel;hiddenMemory.panel.api.setActive();await new Promise(r=>requestAnimationFrame(r));const top=hiddenMemory.scroll.scrollTop;active.api.setActive();return top})
  assert(restoredTab===444,'inactive tab keeps its reading position when reactivated',restoredTab)
  // Drag the divider between the two main groups; save a real user's proportion, not a constrained frame.
  const beforeDrag=await page.evaluate(()=>probe.coordinator().exportRatios())
  const divider=await page.evaluate(()=>{const mains=probe.ws.getState().api.groups.filter(g=>g.panels[0]?.params.__loc==='main').map(g=>g.element.getBoundingClientRect()).sort((a,b)=>a.x-b.x);return{x:mains[1].x,y:mains[1].y+100}})
  await page.mouse.move(divider.x,divider.y);await page.mouse.down();await page.mouse.move(divider.x-70,divider.y,{steps:8});await page.mouse.up();await page.waitForTimeout(220)
  const ratios=await page.evaluate(()=>probe.coordinator().exportRatios())
  assert(JSON.stringify(ratios)!==JSON.stringify(beforeDrag),'dragging the main sash records its preferred proportion')
  const dragged=(await state()).groups.filter(g=>g.loc==='main').map(g=>g.w)
  await page.evaluate(()=>probe.ws.getState().toggleSidebar('left'));await page.waitForTimeout(250)
  await page.evaluate(()=>probe.ws.getState().toggleSidebar('left'));await page.waitForTimeout(250)
  assert((await state()).groups.filter(g=>g.loc==='main').every((g,i)=>Math.abs(g.w-dragged[i])<2),'sidebar cycle restores the user-dragged main proportion')
  // Sidebar sashes: both directions, live content every frame, no reflow on release (11-17: sides were grow-only and content waited for release).
  const snap=()=>page.evaluate(()=>Object.fromEntries(probe.ws.getState().api.groups.filter(g=>g.api.isVisible).map(g=>{const o=document.querySelector(`.dv-render-overlay[data-lcl-visible="true"][data-lcl-group="${g.id}"]`)?.getBoundingClientRect(),c=g.element.querySelector('.dv-content-container').getBoundingClientRect();return[g.id,{loc:g.panels[0]?.params.__loc,w:g.api.width,h:g.api.height,off:o?Math.max(Math.abs(o.x-c.x),Math.abs(o.y-c.y),Math.abs(o.width-c.width),Math.abs(o.height-c.height)):99}]})))
  const sashAt=loc=>page.evaluate(loc=>{const g=probe.ws.getState().api.groups.find(g=>g.panels[0]?.params.__loc===loc),r=g.element.getBoundingClientRect(),vert=loc==='bottom',edge=loc==='left'?r.right:loc==='right'?r.left:r.top;let best=null;for(const s of document.querySelectorAll('.dv-sash')){const b=s.getBoundingClientRect();if(vert?(b.width<100||b.height>20):(b.height<100||b.width>20))continue;const d=Math.abs((vert?b.top+b.height/2:b.left+b.width/2)-edge);if(!best||d<best.d)best={d,x:b.left+b.width/2,y:b.top+b.height/2,id:g.id}}return best},loc)
  const dragSide=async(loc,dx,dy=0)=>{const s=await sashAt(loc),before=await snap(),frames=[];await page.mouse.move(s.x,s.y);await page.mouse.down();for(let i=1;i<=6;i++){await page.mouse.move(s.x+dx*i/6,s.y+dy*i/6);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));frames.push(await snap())}await page.mouse.up();await page.waitForTimeout(300);return{id:s.id,before,frames,after:await snap()}}
  const axisOf=loc=>loc==='bottom'?'h':'w'
  for(const [loc,dx,dy,grow] of [['left',110,0,true],['left',-80,0,false],['right',-100,0,true],['right',80,0,false],['bottom',0,-70,true],['bottom',0,50,false]]){
   if(loc==='bottom'&&!(await state()).groups.some(g=>g.loc==='bottom'&&g.visible)){await page.evaluate(()=>probe.ws.getState().toggleSidebar('bottom'));await page.waitForTimeout(400)}
   const r=await dragSide(loc,dx,dy),k=axisOf(loc),last=r.frames.at(-1)
   assert(grow?r.after[r.id][k]>r.before[r.id][k]+20:r.after[r.id][k]<r.before[r.id][k]-20,`${loc} sidebar ${grow?'grows':'shrinks'} from its sash`,{before:r.before[r.id],after:r.after[r.id]})
   assert(r.frames.every(f=>Object.values(f).every(v=>v.off<=1)),`${loc} drag keeps every View on its group each frame`,r.frames.map(f=>Object.values(f).map(v=>v.off)))
   assert(r.frames.some(f=>Math.abs(f[r.id][k]-r.before[r.id][k])>5&&Math.abs(f[r.id][k]-r.after[r.id][k])>5),`${loc} drag resizes live, not only on release`,r.frames.map(f=>f[r.id][k]))
   assert(Object.keys(r.after).every(id=>Math.abs(r.after[id].w-last[id].w)<=1&&Math.abs(r.after[id].h-last[id].h)<=1),`${loc} release keeps the dragged layout`,{last,after:r.after})
  }
  // A taller left column runs beside the bottom panel, not above it: it must not cap how tall the bottom can get (Codex review).
  await page.evaluate(()=>probe.ws.getState().openView('tall',{},'left'));await page.waitForTimeout(400)
  {const r=await dragSide('bottom',0,-420),k='h',vh=await page.evaluate(()=>document.querySelector('.wb-workspace-viewport').clientHeight)
   assert(r.after[r.id][k]>vh-560+140,'bottom panel room ignores a parallel taller sidebar',{after:r.after[r.id],vh})}
  await page.evaluate(()=>{const p=probe.ws.getState().api.panels.find(p=>p.params.__type==='tall');p?.api.close()});await page.waitForTimeout(400)
  await page.evaluate(()=>{const ws=probe.ws.getState();ws.toggleSidebar('bottom');ws.api.groups.find(g=>g.panels[0]?.params.__loc==='main').api.setActive()});await page.waitForTimeout(400)
  // The window changes while a sidebar sash is held (the shell squeezes the grid): release must not save the squeezed size.
  {const before=await page.evaluate(()=>probe.ws.getState().sideWidths.left),s=await sashAt('left')
   await page.mouse.move(s.x,s.y);await page.mouse.down();await page.mouse.move(s.x+30,s.y,{steps:3});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)))
   const held=(await snap())[s.id].w
   await page.setViewportSize({width:760,height:900});await page.waitForTimeout(350)
   const squeezed=(await snap())[s.id].w
   await page.mouse.up();await page.waitForTimeout(300)
   const saved=await page.evaluate(()=>probe.ws.getState().sideWidths.left)
   // No room left for the dragged-out part, but never the shell's squeeze to the minimum (220) saved over the remembered size.
   assert(squeezed>=before-1&&squeezed>220&&Math.abs(saved-squeezed)<=1,'a held sidebar is not squeezed when the window shrinks, and release saves what is on screen',{before,held,squeezed,saved})
   await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(400)}
  // Opening the bottom panel adds its own branch keys; the Main row that the person dragged keeps its proportion.
  const preferred=await page.evaluate(()=>probe.coordinator().exportRatios())
  assert(Object.keys(ratios).every(k=>JSON.stringify(preferred[k])===JSON.stringify(ratios[k])),'sidebar drags leave the Main proportion alone',{ratios,preferred})
  await page.setViewportSize({width:780,height:700});await page.waitForTimeout(350)
  const narrow=await state()
  assert(narrow.scrollWidth>narrow.viewport&&narrow.groups.filter(g=>g.loc==='main').every(g=>g.w>=320),'small window scrolls all splits side by side',narrow)
  assert(JSON.stringify(await page.evaluate(()=>probe.coordinator().exportRatios()))===JSON.stringify(preferred),'constrained geometry preserves preferred ratios')
  await page.evaluate(()=>document.querySelector('.wb-workspace-viewport').scrollLeft=200)
  assert(await page.evaluate(()=>document.querySelector('.probe-ribbon').getBoundingClientRect().x===0),'Ribbon remains fixed while workspace scrolls')
  for(const zoom of [1.1,1.25]){
   await page.evaluate(z=>{document.body.style.zoom=String(z)},zoom);await page.waitForTimeout(200)
   const aligned=await page.evaluate(()=>{const api=probe.ws.getState().api;return api.panels.filter(p=>p.api.isVisible).every(p=>{const a=p.group.element.querySelector('.dv-content-container').getBoundingClientRect(),b=p.view.content.element.closest('.dv-render-overlay').getBoundingClientRect();return Math.abs(a.x-b.x)<1&&Math.abs(a.width-b.width)<1})})
   assert(aligned,`content/native hit geometry agree at ${zoom*100}% zoom`,await state())
  }
  await page.evaluate(()=>document.body.style.zoom='1');await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(300)
  assert(await page.evaluate(()=>{const p=probe.ws.getState().api.activePanel,r=p.view.content.element.getBoundingClientRect();return probe.computeDropTarget(probe.ws.getState().api,r.x+r.width/2,r.y+r.height/2)?.group.id===p.group.id}),'drag targets resolve persistent content to native groups')
  // A structural split and both panel axes share the same coordinator clock.
  await page.evaluate(()=>{const ws=probe.ws.getState();ws.api.groups.find(g=>g.panels[0]?.params.__loc==='main').api.setActive();ws.splitActive('down');ws.toggleSidebar('bottom');ws.toggleSidebar('right')})
  await page.waitForTimeout(450)
  let nested=await state()
  assert(nested.groups.filter(g=>g.loc==='main').length===3&&nested.groups.filter(g=>g.loc==='main').every(g=>g.w>=320&&g.h>=180),'nested splits and bottom panel keep all main Views usable',nested)
  await page.evaluate(()=>{const ws=probe.ws.getState();ws.api.groups.find(g=>g.panels[0]?.params.__loc==='main').api.setActive();ws.splitActive('right')})
  await page.waitForTimeout(350)
  assert((await state()).groups.filter(g=>g.loc==='main').length===4,'four requested main Views stay visible')
  assert(await page.locator('.dv-sash.dv-enabled').count()>0,'sashes remain enabled after a layout transaction')
  await page.evaluate(()=>document.documentElement.dataset.theme='soft')
  assert(await page.evaluate(()=>{const e=document.querySelector('.dv-render-overlay[data-lcl-loc="main"][data-lcl-visible="true"]');return getComputedStyle(e).paddingLeft==='0px'&&getComputedStyle(e.firstElementChild).borderRadius==='0px'}),'Soft theme keeps its unified paper surface on stable content')
  await page.evaluate(()=>document.documentElement.dataset.theme='genesis-glass')
  assert(await page.evaluate(()=>{const e=document.querySelector('.dv-render-overlay[data-lcl-loc="main"][data-lcl-visible="true"]');return getComputedStyle(e).paddingLeft==='8px'&&getComputedStyle(e.firstElementChild).borderRadius!=='0px'}),'Genesis Glass theme keeps its inset rounded paper')
  await page.evaluate(()=>document.documentElement.dataset.theme='light')
  await page.emulateMedia({reducedMotion:'reduce'});await sample(false)
  assert(!(await state()).groups.find(g=>g.loc==='left').visible,'reduced motion reaches collapsed state')
  await page.screenshot({path:path.join(out,'workspace.png')})
  assert(!errors.length,'no uncaught runtime errors',errors)
  console.log(`Artifacts: ${out}`)
 }finally{await browser.close();server.close()}
}
run().catch(e=>{console.error(e);console.log(`Artifacts: ${out}`);process.exitCode=1})
