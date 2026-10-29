/** Continuous selection paint: actual mouse/keyboard in isolated Electron, real note/plugin/clipboard.
 * npm run build && npm run check:selectionlines (also ZOOM=1.1). Rendering-only: no model account.
 */
const fs=require('node:fs'),path=require('node:path')
const {startStubEngine}=require('./lib/stub-engine.cjs')
const {skipOnboarding}=require('./lib/skip-onboarding.cjs')
const {launch,cardDone,shot,until}=require('./selection-bar.check.cjs')
const {SOURCE,PLUGIN,dragParagraph}=require('./translation-rich.check.cjs')
const tail='This is an intrinsic property of a particle, not literally the particle spinning around in space. It can be an integer or a half-integer. The quantum number stays fixed for a given elementary particle. '
const source=SOURCE.replace('For an electron, ',tail+'For an electron, ')
const plugin=PLUGIN.replace('For an electron, ',tail+'For an electron, ').replace('window.__rich.bar = bar;','window.__rich.bar = bar; window.__rich.element = el;')
const PM='.unified-body .ProseMirror'
const mod=process.platform==='darwin'?'Meta':'Control'
const results=[]
function check(name,ok,detail=''){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${detail?' | '+detail:''}`)}
const snapshot=win=>win.evaluate(()=>{
 const s=getSelection(),root=s?.anchorNode?.parentElement?.closest('[data-line-selection]')
 const layer=root&&document.querySelector(`.line-selection-layer[data-owner="${root.dataset.lineSelection}"]`)
 return {text:s?.toString(),anchor:s?.anchorOffset,focus:s?.focusOffset,collapsed:s?.isCollapsed,
  owner:root?.dataset.lineSelection,root:root?.className,zoom:document.body.style.zoom,
  mode:layer?.getAttribute('data-mode'),outside:layer?.parentElement===document.documentElement,
  pointer:layer&&getComputedStyle(layer).pointerEvents,
  rects:layer?Array.from(layer.children,r=>{const b=r.getBoundingClientRect();return{x:b.x,y:b.y,w:b.width,h:b.height}}):[],
  layers:document.querySelectorAll('.line-selection-layer').length,
 }
})
const painted=win=>until(async()=>{const s=await snapshot(win);return s.rects.length?s:null})
const clear=async win=>{await win.evaluate(()=>getSelection().removeAllRanges());await until(async()=>(await snapshot(win)).layers===0)}
async function main(){
 const errors=[],now=Date.now()
 const stub=await startStubEngine({sessions:[{id:'lines',title:'Physics selection',model_id:'m',created_at:now,updated_at:now,projectless:true}],messages:[{id:'a',role:'model',content:source+'\n'+Array.from({length:24},(_,i)=>`Paragraph ${i}: ${tail}`).join('\n\n'),timestamp:now}],models:[{id:'m',name:'Scripted',provider:'stub'}],modelsMeta:{translateModels:[{id:'mt',name:'Scripted MT',provider:'stub'}]},handle:async({path:r,method,body})=>{
  if(r==='/agent/runs')return{runs:[]}
  if(r==='/api/brain/users/me')return{id:'lines',username:'Selection tester'}
  if(r==='/agent/inline'&&method==='POST'){const req=await body(),text=req.selection.replaceAll('Spin','自旋');return{__buffer:Buffer.from(`data: ${JSON.stringify({type:'delta',text})}\n\ndata: ${JSON.stringify({type:'done',content:text})}\n\n`),contentType:'text/event-stream'}}
 }})
 let app,win,home,shots
 try{
  ({app,win,home}=await launch(stub.url,{tangu_locale:'zh'},{pluginMain:plugin,notes:{'Math.md':source}}))
  shots=path.join(home,'line-shots');fs.mkdirSync(shots)
  win.on('pageerror',e=>errors.push(e.message))
  check('isolated application ready',await skipOnboarding(win))
  await win.addStyleTag({content:'.sync-setup-backdrop{display:none!important}'})
  await win.locator('.t2s-srow',{hasText:'Physics selection'}).first().click()
  await win.locator('.t2-content .katex').first().waitFor({timeout:30000})
  await win.evaluate(()=>document.fonts.ready)
  await until(()=>win.evaluate(()=>!!window.__rich),15000)
  await dragParagraph(win,'[data-chat-surface="chat"] .t2-content')
  const a=await painted(win)
  check('mouse-selected wrapped math uses uniform continuous bands',a?.rects.length>=2&&Math.max(...a.rects.map(r=>r.h))-Math.min(...a.rects.map(r=>r.h))<1,JSON.stringify(a?.rects))
  check('paint lives outside content, with no pointer interception',a?.outside&&a.pointer==='none')
  await win.waitForTimeout(180)
  const stable=await snapshot(win)
  check('paint preserves native text and selection endpoints',stable.text===a.text&&stable.anchor===a.anchor&&stable.focus===a.focus)
  await shot(win,path.join(shots,'chat-light.png'))
  const forward=await snapshot(win)
  // A genuine reverse drag, then native keyboard extension.
  const ends=await win.evaluate(()=>{const r=getSelection().getRangeAt(0),a=r.cloneRange(),b=r.cloneRange();a.setEnd(a.startContainer,a.startOffset+1);b.setStart(b.endContainer,b.endOffset-1);const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();getSelection().removeAllRanges();return{x0:x.left+1,y0:x.top+x.height/2,x1:y.right-1,y1:y.top+y.height/2}})
  await win.mouse.move(ends.x1,ends.y1);await win.mouse.down();await win.mouse.move(ends.x0,ends.y0,{steps:24});await win.mouse.up()
  await win.waitForTimeout(180);const reversed=await painted(win)
  check('reverse mouse drag has the same selected text and geometry',reversed?.text===forward.text&&reversed.rects.length===forward.rects.length&&reversed.rects.every((r,i)=>['x','y','w','h'].every(k=>Math.abs(r[k]-forward.rects[i][k])<0.6)),JSON.stringify({forward:forward.rects,reverse:reversed?.rects}))
  await win.keyboard.press('Shift+ArrowRight');await win.waitForTimeout(120)
  const shifted=await snapshot(win)
  check('native Shift-arrow selection still changes its focus',!shifted.collapsed&&shifted.rects.length>0&&shifted.text!==reversed.text)
  const scrolled=await win.evaluate(()=>{let el=getSelection().anchorNode.parentElement;while(el&&el.scrollHeight<=el.clientHeight+10)el=el.parentElement;if(!el)return null;const scale=el.getBoundingClientRect().width/el.offsetWidth,before=el.scrollTop;el.scrollTop+=24;return{before,after:el.scrollTop,delta:(el.scrollTop-before)*scale}})
  await win.waitForTimeout(180);const afterScroll=await snapshot(win)
  check('scroll repaints at the new source position',scrolled?.after>scrolled.before&&afterScroll.rects.length>0&&Math.abs(afterScroll.rects[0].y-shifted.rects[0].y+scrolled.delta)<2,JSON.stringify(scrolled))
  await win.keyboard.press(mod+'+=');await win.waitForTimeout(250)
  const zoomed=await snapshot(win)
  check('actual zoom shortcut keeps bands aligned and native text intact',zoomed.zoom!==a.zoom&&zoomed.text===shifted.text&&zoomed.rects.length>0)
  await win.keyboard.press(mod+'+-');await win.waitForTimeout(200)
  await clear(win);check('clear selection removes every paint layer',(await snapshot(win)).layers===0)

  await win.evaluate(()=>window.__rich.open());await win.locator('#rich-plugin').waitFor()
  await dragParagraph(win,'#rich-plugin');const p=await painted(win)
  check('plugin host uses the same painter',p?.outside&&p.rects.length>=2&&Math.max(...p.rects.map(r=>r.h))-Math.min(...p.rects.map(r=>r.h))<1)
  await shot(win,path.join(shots,'plugin-light.png'))
  await win.locator('[data-testid="selection-translate"]').click();await cardDone(win)
  await dragParagraph(win,'[data-testid="inline-ai-preview"]','自旋');const preview=await painted(win)
  check('translation preview shares the painter and owns its selection',preview?.root.includes('am-ai-preview')&&preview.layers===1)
  check('preview paint is above its opaque result card',await win.evaluate(()=>{const el=document.querySelector('[data-testid="inline-ai-preview"]'),layer=document.querySelector(`[data-owner="${el.dataset.lineSelection}"]`),panel=el.closest('[data-testid="inline-ai-panel"]');return Number(getComputedStyle(layer).zIndex)>Number(getComputedStyle(panel).zIndex)}))
  await shot(win,path.join(shots,'preview-selected-light.png'))
  await win.locator('[data-testid="inline-ai-panel"] [data-act="copy"]').click()
  check('copy still returns translated Markdown and original TeX',await until(async()=>(await app.evaluate(({clipboard})=>clipboard.readText())).includes(String.raw`\frac{1}{2}`)))
  await shot(win,path.join(shots,'preview-light.png'))
  await win.keyboard.press('Escape');await clear(win)

  await win.evaluate(()=>window.__rich.note());await win.locator(PM).first().waitFor({timeout:30000})
  await win.locator(PM+' p').first().click();await win.keyboard.press(mod+'+A');await win.waitForTimeout(200)
  const note=await painted(win)
  check('note text selection uses continuous bands outside ProseMirror',note?.root.includes('ProseMirror')&&note.outside&&note.rects.length>0)
  check('selection paint leaves saved Markdown untouched',fs.readFileSync(path.join(home,'vault/Math.md'),'utf8')===source)
  const noteState=()=>win.locator(PM).first().evaluate(el=>{const s=getSelection();return JSON.stringify({doc:el.pmViewDesc.node.toJSON(),anchor:s.anchorOffset,focus:s.focusOffset,text:s.toString()})})
  const before=await noteState()
  // Compare the real editor's own clipboard path with and without the paint layer.
  await win.locator(PM).first().evaluate(el=>{el.setAttribute('data-native-selection','');document.dispatchEvent(new Event('selectionchange'))})
  await until(async()=>(await snapshot(win)).layers===0)
  await win.keyboard.press(mod+'+C');const plainCopy=await app.evaluate(({clipboard})=>clipboard.readText())
  await win.locator(PM).first().evaluate(el=>{el.removeAttribute('data-native-selection');document.dispatchEvent(new Event('selectionchange'))})
  await painted(win);await win.keyboard.press(mod+'+C')
  check('native editor copy is byte-identical with paint enabled',(await app.evaluate(({clipboard})=>clipboard.readText()))===plainCopy&&plainCopy.length>20)
  check('paint refresh does not alter the editor document or selection',await noteState()===before)
  await shot(win,path.join(shots,'note-light.png'))
  await win.locator(PM).first().dispatchEvent('compositionstart',{data:''});await win.waitForTimeout(40)
  check('composition event suspends custom paint',(await snapshot(win)).layers===0)
  await win.locator(PM).first().dispatchEvent('compositionend',{data:''});await win.waitForTimeout(80)
  await win.evaluate(()=>document.dispatchEvent(new Event('selectionchange')))
  check('composition end restores paint without changing content',!!(await painted(win))&&await noteState()===before)
  await win.locator(PM).first().dispatchEvent('mouseup')
  await win.locator('[data-testid="inline-toolbar"] [data-act="translate"]').click();await cardDone(win)
  const retained=await win.locator(PM).first().evaluate(el=>({paint:!!el.dataset.lineSelection,collapsed:getSelection().isCollapsed,svg:el.querySelectorAll('svg.line-selection-layer').length}))
  check('pending note AI target stays painted after native selection collapses',retained.paint&&retained.collapsed&&retained.svg===0,JSON.stringify(retained))
  check('retained paint never writes the note',fs.readFileSync(path.join(home,'vault/Math.md'),'utf8')===source)
  await shot(win,path.join(shots,'note-target.png'))
  await win.locator(PM+' p').last().evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r)})
  await painted(win)
  check('selecting another passage preserves the pending AI target decoration',await win.locator(PM).first().evaluate(el=>{const target=el.querySelector('.am-ai-target');return target&&!el.hasAttribute('data-line-selection-retained')&&getComputedStyle(target).backgroundColor!=='rgba(0, 0, 0, 0)'&&getComputedStyle(target).backgroundColor!=='transparent'}))
  await win.keyboard.press('Escape');await clear(win)
  // A DOM plugin can explicitly keep its own native/custom selection; input controls stay native.
  await win.evaluate(()=>window.__rich.open());await win.locator('#rich-plugin').waitFor()
  await win.locator('#rich-plugin').evaluate(el=>el.insertAdjacentHTML('beforeend','<input id="native-input" value="native input selection"><div data-native-selection id="custom-selection">Custom editor selection</div><table><tr><td id="cell-a">Cell A</td><td style="padding-left:100px" id="cell-b">Cell B</td></tr></table><p dir="rtl" id="rtl">עברית English 123 טקסט</p>'))
  await win.locator('#native-input').focus();await win.keyboard.press(mod+'+A');await win.waitForTimeout(120)
  check('input selection retains the native rendering',(await snapshot(win)).layers===0)
  await win.locator('#custom-selection').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r)})
  await win.waitForTimeout(120);check('custom selection opt-out keeps native rendering',(await snapshot(win)).layers===0)
  await win.locator('#custom-selection').evaluate(el=>{const r=document.createRange();r.setStart(document.querySelector('#rich-plugin p').firstChild,0);r.setEnd(el.firstChild,el.firstChild.length);getSelection().removeAllRanges();getSelection().addRange(r)})
  await win.waitForTimeout(120);check('mixed ordinary/custom selection keeps native rendering',(await snapshot(win)).layers===0)
  await win.locator('#cell-a').evaluate(el=>{const r=document.createRange();r.setStart(el.firstChild,0);r.setEnd(document.querySelector('#cell-b').firstChild,6);getSelection().removeAllRanges();getSelection().addRange(r)})
  const cells=await painted(win)
  check('table cell bands do not fill the gap between cells',cells?.rects.length===2&&cells.rects[1].x>cells.rects[0].x+cells.rects[0].w+50,JSON.stringify(cells?.rects))
  await win.locator('#rtl').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r)})
  const rtl=await painted(win);check('RTL selection paints without changing native text',rtl?.rects.length>0&&rtl.text.includes('עברית'))
  await win.evaluate(()=>{window.__rich.element.style.height='20px';window.__rich.element.style.overflow='visible'})
  await win.waitForTimeout(100);const overflow=await snapshot(win)
  check('visible descendants outside the root box remain painted',overflow.rects.length>0&&await win.evaluate(()=>getSelection().getRangeAt(0).getBoundingClientRect().top>window.__rich.element.getBoundingClientRect().bottom))
  await win.evaluate(()=>{window.__rich.element.style.height='100%';window.__rich.element.style.overflow=''})
  const cdp=await win.context().newCDPSession(win)
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await win.evaluate(()=>document.dispatchEvent(new Event('selectionchange')))
  await win.waitForTimeout(100)
  check('coarse pointer retains native selection paint',await win.evaluate(()=>matchMedia('(pointer: coarse)').matches)&&(await snapshot(win)).layers===0)
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await win.evaluate(()=>document.dispatchEvent(new Event('selectionchange')));await painted(win);await cdp.detach()
  await win.evaluate(()=>window.__rich.bar.dispose());await win.waitForTimeout(160)
  check('plugin dispose clears paint and native-hiding attribute',(await snapshot(win)).layers===0&&await win.locator('#rich-plugin [data-line-selection]').count()===0)
  await clear(win)
  await app.close()
  const dark=await launch(stub.url,{tangu_locale:'zh',forsion_theme_pref:'dark',forsion_theme:'dark'},{pluginMain:plugin});app=dark.app;win=dark.win
  win.on('pageerror',e=>errors.push(e.message));await skipOnboarding(win)
  await win.addStyleTag({content:'.sync-setup-backdrop{display:none!important}'})
  await until(()=>win.evaluate(()=>!!window.__rich),15000)
  await win.evaluate(()=>window.__rich.open());await win.locator('#rich-plugin').waitFor();await dragParagraph(win,'#rich-plugin')
  const d=await painted(win);check('dark theme selects its own paint blend mode',d?.mode==='dark')
  await shot(win,path.join(shots,'plugin-dark.png'))
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(360,500);w.setSize(390,850)})
  await win.waitForTimeout(600);const narrow=await snapshot(win)
  check('window resize redraws and clips bands inside the viewport',narrow.rects.length>0&&narrow.rects.every(r=>r.x>=-1&&r.y>=-1&&r.x+r.w<=391&&r.y+r.h<=851))
  await shot(win,path.join(shots,'narrow-dark.png'))
  await clear(win);check('final clear leaves no ghost layers',(await snapshot(win)).layers===0)
  check('no renderer exceptions',errors.length===0,errors.join('\n'))
 }catch(e){if(win&&shots)await win.screenshot({path:path.join(shots,'failure.png')}).catch(()=>{});throw e}
 finally{fs.writeFileSync(path.join(home||'/tmp','selection-lines-report.json'),JSON.stringify({results,errors,shots},null,2));if(app)await app.close().catch(()=>{});await stub.close();console.log(`SCREENSHOTS ${shots}\n${results.filter(r=>r.ok).length}/${results.length} passed`);if(results.some(r=>!r.ok))process.exitCode=1}
}
main().catch(e=>{console.error(e);process.exitCode=1})
