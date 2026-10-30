/** Space switches and renderer reloads must retain file reading state.
 * Run after build: npm run check:fileviewmemory. Uses only an isolated vault/profile. */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const DESK = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-file-view-'))
const vault = path.join(home, 'Vault'), ud = path.join(home, 'userdata')
const out = process.env.OUT_DIR || path.join(home, 'evidence')
fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(out, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail ?? '')}`) }
const drawing = (x) => ['---', 'excalidraw-plugin: parsed', '---', '', '## Drawing', '```json', JSON.stringify({ type: 'excalidraw', version: 2, elements: [{id:'rect', type:'rectangle', x, y:1600, width:300, height:180, version:1, versionNonce:1, seed:1}], appState:{}, files:{} }), '```', '%%'].join('\n')
fs.writeFileSync(path.join(vault, 'Board.excalidraw.md'), drawing(2400))
fs.writeFileSync(path.join(vault, 'Other.excalidraw.md'), drawing(500))
fs.writeFileSync(path.join(vault, 'Read.md'), '# Read\n\n[[Audio.wav#t=2]]\n\n' + Array.from({length:120}, (_,i) => `Paragraph ${i}. Keep reading here.\n\n`).join(''))
fs.writeFileSync(path.join(vault, 'Image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="2000"><rect width="2400" height="2000" fill="#c0d8c0"/><text x="500" y="600" font-size="80">Reading position</text></svg>')
fs.writeFileSync(path.join(vault, 'Paper.pdf'), require('./lib/tiny-pdf.cjs').tinyPdf(Array.from({length:8},(_,i)=>`Reading page ${i+1}`)))
const wav=Buffer.alloc(44+16000*12);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);fs.writeFileSync(path.join(vault,'Audio.wav'),wav)
for (const d of [ud, ud+'-dev']) { fs.mkdirSync(d, {recursive:true}); for (const f of ['amadeus-config.json','amadeus-config.dev.json']) fs.writeFileSync(path.join(d,f), JSON.stringify({lastVault:vault,localVault:vault})) }
const engineState = (win, patch) => win.evaluate((p) => {
  const el = [...document.querySelectorAll('.amx-drawview .excalidraw')].find(e=>e.offsetParent)
  let f=el[Object.keys(el).find(k=>k.startsWith('__reactFiber'))]
  while(f && !f.stateNode?.state?.zoom) f=f.return
  const a=f.stateNode
  if(p) a.setState({scrollX:p.x,scrollY:p.y,zoom:{value:p.z}})
  const s=a.state; return {x:s.scrollX,y:s.scrollY,z:s.zoom.value}
},patch)
const closeTo = (a,b) => Math.abs(a.x-b.x)<1 && Math.abs(a.y-b.y)<1 && Math.abs(a.z-b.z)<.0001
;(async()=>{
 const stub=await startStubEngine()
 const app=await electron.launch({args:[`--user-data-dir=${ud}`,'--lang=zh-CN',DESK],cwd:DESK,env:{...process.env,TANGU_HOME:home,TANGU_BACKEND_URL:stub.url,TANGU_HARNESS_QUIET:'1',PI_CU_SOCKET_PATH:path.join(home,'bridge.sock')}})
 let win
 try {
  win=await app.firstWindow()
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1400,900))
  await win.waitForSelector('.dv-groupview',{timeout:30000,state:'attached'}); await skipOnboarding(win)
  const space=async(name)=>{await win.locator(`.rb-space[aria-label="${name}"]`).filter({visible:true}).first().click();await win.waitForTimeout(800)}
  await space('笔记')
  const open=async(name,selector)=>{await win.locator('.t2s-srow').filter({has:win.locator('.t2s-srow-title',{hasText:new RegExp(`^${name}$`)})}).first().click();await win.locator(selector).filter({visible:true}).first().waitFor({timeout:30000});await win.waitForTimeout(1200)}
  const board=()=>open('Board.excalidraw','.amx-drawview .excalidraw canvas.interactive')
  const cycle=async()=>{await space('Tangu');await space('笔记')}
  await board()
  check('new board starts at 100%',Math.abs((await engineState(win)).z-1)<.0001,await engineState(win))
  await engineState(win,{x:-2100,y:-1500,z:.75});await win.waitForTimeout(200)
  const before=await engineState(win)
  await cycle()
  const after=await engineState(win)
  check('board zoom/pan survives Space switch',closeTo(before,after),{before,after})
  await win.screenshot({path:path.join(out,'board-return.png')})
  await open('Other.excalidraw','.amx-drawview .excalidraw canvas.interactive')
  await engineState(win,{x:-100,y:-1200,z:1.25});await win.waitForTimeout(200)
  await board()
  check('different boards keep separate viewports',closeTo(before,await engineState(win)),await engineState(win))
  await win.reload();await win.waitForTimeout(1500);await space('笔记');await board()
  check('board view survives renderer reload',closeTo(before,await engineState(win)),await engineState(win))
  const scene=JSON.parse(fs.readFileSync(path.join(vault,'Board.excalidraw.md'),'utf8').split('```json')[1].split('```')[0])
  check('camera does not leak into drawing content',!('zoom' in scene.appState) && !('scrollX' in scene.appState) && !('scrollY' in scene.appState) && scene.elements.filter(e=>!e.isDeleted).length===1)
  await open('Read','.unified-page')
  const pane=win.locator('.amx-pane').filter({has:win.locator('.unified-page')}).filter({visible:true}).first()
  await pane.evaluate(e=>{e.scrollTop=650});await win.waitForTimeout(200)
  const noteBefore=await pane.evaluate(e=>e.scrollTop)
  await cycle();await win.waitForTimeout(500)
  const noteAfter=await pane.evaluate(e=>e.scrollTop)
  check('Markdown reading position still survives',noteBefore>300 && Math.abs(noteAfter-noteBefore)<2,{noteBefore,noteAfter})
  await open('Image.svg','.amx-imgview-img')
  await win.locator('.amx-imgview-img').filter({visible:true}).click()
  await win.locator('.amx-imgview-scroll.actual').evaluate(e=>{e.scrollTop=450;e.scrollLeft=300})
  await win.waitForTimeout(300);await cycle()
  const image=await win.locator('.amx-imgview-scroll').filter({visible:true}).evaluate(e=>({actual:e.classList.contains('actual'),top:e.scrollTop,left:e.scrollLeft}))
  check('image size and pan survive Space switch',image.actual && Math.abs(image.top-450)<2 && Math.abs(image.left-300)<2,image)
  await open('Paper.pdf','.pdfa-pageinput')
  await win.locator('.pdfa-zoomsel').filter({visible:true}).selectOption('1.5')
  await win.locator('.pdfa-pageinput').filter({visible:true}).fill('4');await win.locator('.pdfa-pageinput').filter({visible:true}).press('Enter')
  await win.waitForTimeout(500)
  const pdfState=()=>win.locator('.pdfa-container').filter({visible:true}).evaluate(e=>({top:e.scrollTop,left:e.scrollLeft,scale:e.closest('.pdfa-root').querySelector('.pdfa-zoomsel').value,page:Number(e.closest('.pdfa-root').querySelector('.pdfa-pageinput').value)}))
  const pdfBefore=await pdfState();await cycle();await win.waitForTimeout(900);const pdfAfter=await pdfState()
  check('PDF page/zoom/position survive Space switch',pdfBefore.page===4 && pdfAfter.page===4 && pdfAfter.scale===pdfBefore.scale && Math.abs(pdfAfter.top-pdfBefore.top)<2,{pdfBefore,pdfAfter})
  await win.locator('.pdfa-zoomsel').filter({visible:true}).selectOption('page-width');await win.waitForTimeout(600)
  const fitBefore=await pdfState();await space('Tangu')
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1150,900));await space('笔记');await win.waitForTimeout(700)
  const fitAfter=await pdfState();check('PDF reading page survives pane width change',fitAfter.page===fitBefore.page && fitAfter.scale==='page-width',{fitBefore,fitAfter})
  await open('Read','.unified-page')
  await win.locator('.wikilink').filter({hasText:'Audio.wav'}).filter({visible:true}).first().click()
  await win.locator('.amx-mediaview audio').filter({visible:true}).waitFor({timeout:15000})
  await win.waitForTimeout(800)
  const audio=win.locator('.amx-mediaview audio').filter({visible:true})
  await audio.evaluate(e=>{e.currentTime=7;e.playbackRate=1.5});await win.waitForTimeout(300);await cycle();await win.waitForTimeout(600)
  const media=await audio.evaluate(e=>({time:e.currentTime,rate:e.playbackRate,paused:e.paused}))
  check('media time/rate survive Space switch without autoplay',Math.abs(media.time-7)<.1 && media.rate===1.5 && media.paused,media)
 } catch(e) { check('harness completed',false,String(e.stack||e)); if(win) {await win.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.txt'),await win.locator('body').innerText().catch(()=>''))} }
 finally {await app.close();await stub.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('Evidence:',out);process.exitCode=results.some(r=>!r.ok)?1:0}
})().catch(e=>{console.error(e);process.exitCode=1})
