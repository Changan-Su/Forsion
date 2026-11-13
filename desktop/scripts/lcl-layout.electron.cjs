/** Built client acceptance: real notes/PDF + isolated vault, renderer and backend. */
const fs=require('node:fs'),path=require('node:path')
const {launch,boot,shotDir}=require('./lib/uiux-electron.cjs')
const out=shotDir('lcl-layout'),results=[]
const check=(name,ok,detail)=>{results.push({name,ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name} ${JSON.stringify(detail??'')}`)}
;(async()=>{
 const env=await launch({tag:'lcl-layout',beforeLaunch:({vault})=>{
  fs.writeFileSync(path.join(vault,'Layout.md'),'# Layout\n\n'+Array.from({length:150},(_,i)=>`Paragraph ${i}. Keep this reading position.\n\n`).join(''))
  fs.writeFileSync(path.join(vault,'Paper.pdf'),require('./lib/tiny-pdf.cjs').tinyPdf(Array.from({length:6},(_,i)=>`Layout page ${i+1}`)))
 }})
 const {app,win}=env
 try{
  await boot(app,win,{space:'amadeus',width:1440,height:900})
  const open=async(name,selector)=>{await win.locator('.t2s-srow').filter({has:win.locator('.t2s-srow-title',{hasText:new RegExp(`^${name}$`)})}).filter({visible:true}).first().click();await win.locator(selector).filter({visible:true}).first().waitFor({timeout:30000});await win.waitForTimeout(800)}
  await open('Layout','.unified-page')
  await win.evaluate(()=>{const page=[...document.querySelectorAll('.unified-page')].find(e=>e.checkVisibility()),pane=page.closest('.amx-pane');pane.scrollTop=650;const iframe=document.createElement('iframe');iframe.srcdoc='<script>window.marker="retained"</script>';iframe.style.cssText='position:absolute;width:20px;height:20px;right:0;bottom:0';page.append(iframe);window.layoutMemory={page,pane,iframe}})
  await win.waitForTimeout(250)
  const toggles=['.dv-prefix .dv-edge-toggle','.dv-edge-right','.dv-edge-bottom']
  for(const selector of toggles){
   for(let i=0;i<2;i++){await win.locator(selector).filter({visible:true}).first().click();await win.waitForTimeout(350)}
   const memory=await win.evaluate(()=>({node:layoutMemory.page.isConnected,top:layoutMemory.pane.scrollTop,marker:layoutMemory.iframe.contentWindow.marker}))
   check(`real note retains DOM/scroll/embedded state across ${selector}`,memory.node&&Math.abs(memory.top-650)<3&&memory.marker==='retained',memory)
  }
  const tab=win.locator('.wb-tab').filter({has:win.locator('.wb-tab-name',{hasText:'Layout'})}).first()
  await tab.click({button:'right'});await win.locator('[data-act="split-right"]').click();await win.waitForTimeout(500)
  const mainGroups=()=>win.locator('.dv-groupview').filter({has:win.locator('.dv-new-tab')})
  check('native context-menu split creates two main groups',await mainGroups().count()===2)
  const groups=mainGroups(),right=groups.nth(1)
  await groups.first().locator('.wb-tab').first().click()
  await right.locator('.dv-new-tab').click();await win.waitForTimeout(250)
  check('right New tab belongs to right group in built client',await right.locator('.wb-tab').count()===2)
  await win.keyboard.press('Meta+f');await win.locator('.amx-findbar input').first().fill('Paragraph');await win.waitForTimeout(250)
  check('Find from the right header searches the active launcher, not the retained note',await win.locator('.amx-findbar-count').textContent()==='0')
  await win.keyboard.press('Escape')
  await open('Paper.pdf','.pdfa-pageinput')
  const zoom=win.locator('.pdfa-zoomsel').filter({visible:true}).first(),pageInput=win.locator('.pdfa-pageinput').filter({visible:true}).first()
  await zoom.selectOption('1.5');await pageInput.fill('3');await pageInput.press('Enter');await win.waitForTimeout(600)
  await win.evaluate(()=>window.layoutPdf=[...document.querySelectorAll('.pdfa-root')].find(e=>e.checkVisibility()))
  for(let i=0;i<2;i++){await win.locator('.dv-edge-right').click();await win.waitForTimeout(350)}
  const pdf=await win.evaluate(()=>({connected:layoutPdf.isConnected,zoom:layoutPdf.querySelector('.pdfa-zoomsel').value,page:layoutPdf.querySelector('.pdfa-pageinput').value}))
  check('real PDF preserves mounted reader, zoom and page',pdf.connected&&pdf.zoom==='1.5'&&pdf.page==='3',pdf)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(800,720));await win.waitForTimeout(350)
  const overflow=await win.evaluate(()=>{const e=document.querySelector('.wb-workspace-viewport');return{client:e.clientWidth,scroll:e.scrollWidth,body:document.body.scrollWidth,window:innerWidth}})
  check('built shell scrolls workspace without expanding chrome',overflow.scroll>overflow.client&&overflow.body<=overflow.window+1,overflow)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));await win.waitForTimeout(350)
  await win.screenshot({path:path.join(out,'notes-and-pdf.png')})
  const count=await mainGroups().count()
  await win.reload();await win.waitForSelector('.wb-workspace-viewport');await win.waitForTimeout(1800)
  check('split layout restores after renderer reload',await mainGroups().count()===count)
  await win.screenshot({path:path.join(out,'restored.png')})
  // A restored layout can create overlays in any DOM order. A fixed menu / click-away layer opened in one pane
  // that spills across its edge must stay on top of the neighbouring pane, in both directions.
  const spill=await win.evaluate(()=>{
   const panes=[...document.querySelectorAll('.dv-render-overlay[data-lcl-group][data-lcl-visible="true"]')].map(o=>({o,r:o.getBoundingClientRect()})).filter(p=>p.r.width>40&&p.r.height>40)
   const out=[]
   for(const a of panes)for(const b of panes){
    if(a===b||Math.abs(a.r.right-b.r.left)>12||Math.min(a.r.bottom,b.r.bottom)-Math.max(a.r.top,b.r.top)<80)continue
    for(const [from,into] of [[a,b],[b,a]]){
     const top=Math.max(a.r.top,b.r.top)+40,edge=from===a?a.r.right:b.r.left,el=document.createElement('div')
     el.style.cssText=`position:fixed;left:${edge-30}px;top:${top}px;width:60px;height:30px;z-index:80;background:rgba(255,0,0,.01)`
     ;(from.o.querySelector('.dv-react-part')??from.o).append(el)
     const x=from===a?edge+20:edge-20,hit=document.elementFromPoint(x,top+15)
     out.push({from:from.o.dataset.lclLoc,into:into.o.dataset.lclLoc,ok:hit===el,hit:hit&&hit.className&&String(hit.className).slice(0,40)});el.remove()
    }
   }
   return out
  })
  check('fixed layers spilling out of a pane stay above the neighbouring pane (both directions)',spill.length>=2&&spill.every(s=>s.ok),spill)
 }catch(e){console.error(e);check('acceptance completes',false,String(e));await win.screenshot({path:path.join(out,'failure.png')}).catch(()=>{})}
 finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));await env.close();console.log(`Artifacts: ${out}`);if(results.some(r=>!r.ok))process.exitCode=1}
})().catch(e=>{console.error(e);process.exitCode=1})
