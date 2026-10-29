const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict')
const { build } = require('esbuild')
const electron = require('./lib/launch-electron.cjs')
const desk = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-vault-integrity-'))
const out = process.env.OUT_DIR || temp
fs.mkdirSync(out, { recursive: true })
// Protocol harness: real Electron processes, production drawingStore, localVault,
// and Unit HTTP RPC. The view displays store state, not Excalidraw pointer input.
async function main() {
 const alias = { '@amadeus-shared': path.join(desk,'shared/amadeus'), '@': path.join(desk,'frontend/src') }
 await build({ stdin: { contents: `
  import { useDrawStore as store } from './frontend/src/amadeus/store/drawingStore';
  const ref='board.excalidraw.md'; const render=()=>document.body.textContent=JSON.stringify(store.getState().seedFor(ref));
  store.subscribe(render);
  window.integrity={
   load:async()=>{await store.getState().load(ref,ref);render()},
   add:id=>{const old=store.getState().seedFor(ref)||{};store.getState().save(ref,JSON.stringify({...old,elements:[...(old.elements||[]),{id,version:1,versionNonce:1}]}))},
   flush:async()=>{await store.getState().flushAll(true);render()},
   seed:()=>store.getState().seedFor(ref),
  };
 `, resolveDir:desk,loader:'ts'},outfile:path.join(temp,'renderer.js'),bundle:true,format:'iife',platform:'browser',alias,plugins:[{name:'vault-context',setup(b){
  b.onResolve({filter:/^\.\/pageStore$/},a=>a.importer.endsWith('drawingStore.ts')?{path:'context',namespace:'test'}:null)
  b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:"export const usePageStore={getState:()=>({vaultRoot:'/isolated'}),subscribe:()=>()=>{}};export const onNotePathGone=()=>()=>{};",loader:'js'}))
 }}]})
 fs.writeFileSync(path.join(temp,'preload.cjs'),`
  const {contextBridge,ipcRenderer}=require('electron');
  const invoke=(ch,...args)=>ipcRenderer.invoke('integrity:invoke',ch,args);
  contextBridge.exposeInMainWorld('amadeus',{
   readDrawing:(...a)=>invoke('drawing:read',...a),writeDrawing:(...a)=>invoke('drawing:write',...a),
   onExternalChange:fn=>{const cb=(_e,p)=>fn(p);ipcRenderer.on('page:external-change',cb);return()=>ipcRenderer.removeListener('page:external-change',cb)},
  });contextBridge.exposeInMainWorld('vaultCall',invoke);
 `)
 fs.writeFileSync(path.join(temp,'index.html'),'<!doctype html><meta charset="utf-8"><title>Vault integrity protocol</title><body><script src="renderer.js"></script>')
 await build({stdin:{contents:`
  import {app,BrowserWindow,ipcMain} from 'electron';import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';import v8 from 'node:v8';import vm from 'node:vm';
  import {createLocalVault} from '../unit/localVault';import {startUnitWeb} from './electron/unitWeb';import {VaultManager} from './electron/amadeus/fs/vaultManager';import {blankDrawing} from './shared/amadeus/excalidraw/format';import {IPC} from './shared/amadeus/ipc';
  const temp=process.env.INTEGRITY_TEMP!;app.setPath('userData',path.join(temp,'user-data'));
  const windows=new Map();let face,web,held=0,gate,release;
  app.whenReady().then(async()=>{
   const root=path.join(temp,'vault');face=await createLocalVault({root,stateDir:path.join(temp,'state')});
   await fs.writeFile(path.join(root,'board.excalidraw.md'),blankDrawing(JSON.stringify({elements:[]})));
   web=await startUnitWeb({
    getEngine:()=>({url:null,token:''}),confirmPair:async()=>false,
    pairedDevices:{list:()=>[{id:'integrity',name:'integrity',tokenHash:createHash('sha256').update('isolated-test-token').digest('hex'),createdAt:Date.now()}],add:async()=>{}},
    readPlugins:async()=>[],readSpaces:async()=>[],readConfig:async()=>({}),writeConfig:async p=>p,readProviders:async()=>[],
    readHostFile:async()=>null,readHostDir:async()=>null,readHostStat:async()=>null,meta:{instanceId:'integrity',name:'integrity',version:'test'},webDistDir:()=>null,vault:()=>face,log:()=>{}
   },{port:0,bindHost:'127.0.0.1'});
   face.onEvent((ch,payload,origin)=>{for(const w of BrowserWindow.getAllWindows())if(origin!=='window:'+w.webContents.id)w.webContents.send(ch,payload)});
   ipcMain.handle('integrity:invoke',async(e,ch,args)=>{
    const origin='window:'+e.sender.id;let result;
    if(windows.get(e.sender.id)){
     const r=await fetch('http://127.0.0.1:'+web.port+'/vault/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer isolated-test-token'},body:JSON.stringify({ch,client:origin,args:args.map(a=>a instanceof Uint8Array?{__u8:Buffer.from(a).toString('base64')}:a)})});
     const data=await r.json();if(!r.ok||!data.ok)throw Error(JSON.stringify(data));result=data.result;
    }else result=await face.call(ch,args,origin);
    if(gate&&ch===IPC.drawingRead&&++held<=2){if(held===2)release();await gate}return result;
   });
   globalThis.integrityHost={
    arm:()=>{held=0;gate=new Promise(r=>release=r)},channels:IPC,
    window:async(unit=false)=>{const w=new BrowserWindow({show:false,webPreferences:{preload:path.join(temp,'preload.cjs'),contextIsolation:true,sandbox:false}});windows.set(w.webContents.id,unit);await w.loadFile(path.join(temp,'index.html'))},
    file:p=>fs.readFile(path.join(root,p),'utf8'),
    seedTrash:async()=>{for(let i=0;i<20;i++){await fs.mkdir(path.join(root,'source-'+i),{recursive:true});await fs.writeFile(path.join(root,'source-'+i,'same.md'),'body-'+i)}},
    heap:async output=>{
     const manager=new VaultManager();manager.setRoot(path.join(temp,'heap-vault'));await fs.mkdir(manager.getRoot(),{recursive:true});
     const sources=Array.from({length:20},()=>('heap-ledger-body:'+randomUUID()+'X'.repeat(150000)));
     for(let i=0;i<20;i++)await manager.writeTextFile('folder/'+i+'.md',sources[i]);
     v8.setFlagsFromString('--expose_gc');vm.runInNewContext('gc')();
     const controlSnapshot=v8.writeHeapSnapshot(path.join(output,'electron-held-control.heapsnapshot'));
     sources.length=0;
     await manager.removeEntry('folder');manager.setRoot(path.join(temp,'other-vault'));await new Promise(r=>setTimeout(r,0));
     v8.setFlagsFromString('--expose_gc');vm.runInNewContext('gc')();
     const rssBytes=process.memoryUsage().rss,snapshot=v8.writeHeapSnapshot(path.join(output,'electron-after-cleanup.heapsnapshot'));
     return {entries:manager['lastWritten'].size,rssBytes,snapshot,controlSnapshot};
    },close:async()=>{await web.close();await face.close()},
   };
  }).catch(e=>{console.error(e);app.exit(1)});
 `,resolveDir:desk,loader:'ts'},outfile:path.join(temp,'main.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],alias})
 const app=await electron.launch({args:[path.join(temp,'main.cjs')],cwd:desk,env:{...process.env,INTEGRITY_TEMP:temp,TANGU_HOME:temp},timeout:60000})
 const report={platform:process.platform,temp,checks:[]}; console.log('Electron launched',temp)
 try{
  await app.evaluate(async()=>{for(let i=0;!globalThis.integrityHost;i++){if(i>200)throw Error('host did not initialize');await new Promise(r=>setTimeout(r,50))}})
  await app.evaluate(async()=>{await globalThis.integrityHost.window();await globalThis.integrityHost.window();await globalThis.integrityHost.window(true)})
  const [a,b,unit]=app.windows(),windows=[a,b,unit]; for(const w of windows) w.setDefaultTimeout(15000); console.log('Three renderer windows ready')
  const channels=await app.evaluate(()=>globalThis.integrityHost.channels)
  await Promise.all([a,b].map(w=>w.evaluate(()=>window.integrity.load())))
  await a.evaluate(()=>window.integrity.add('A'));await b.evaluate(()=>window.integrity.add('B'));await app.evaluate(()=>globalThis.integrityHost.arm())
  await Promise.all([a,b].map(w=>w.evaluate(()=>window.integrity.flush())));console.log('Concurrent CAS committed')
  for(const w of [a,b])await w.waitForFunction(()=>window.integrity.seed().elements.length===2)
  await unit.evaluate(()=>window.integrity.load());await unit.evaluate(()=>window.integrity.add('Unit'));await unit.evaluate(()=>window.integrity.flush())
  for(const w of windows)await w.waitForFunction(()=>window.integrity.seed().elements.length===3)
  report.checks.push({name:'two Electron renderer CAS barrier + Unit HTTP converges all three stores',passed:true,elements:await a.evaluate(()=>window.integrity.seed().elements.map(e=>e.id))})
  const imports=await Promise.all(Array.from({length:20},(_,i)=>windows[i%3].evaluate(({ch,i})=>window.vaultCall(ch,'N.md','中文 同名.excalidraw.md',new TextEncoder().encode('attachment-'+i),{mode:'attachments',folder:''}),{ch:channels.saveAttachment,i})))
  assert.equal(new Set(imports.map(r=>r.pageRel)).size,20)
  for(let i=0;i<imports.length;i++)assert.equal(await app.evaluate((_,p)=>globalThis.integrityHost.file(p),imports[i].pageRel),'attachment-'+i)
  report.checks.push({name:'20 concurrent attachment imports through two Electron windows and Unit HTTP retain every byte',passed:true})
  await app.evaluate(()=>globalThis.integrityHost.seedTrash())
  await Promise.all(Array.from({length:20},(_,i)=>windows[i%3].evaluate(({ch,i})=>window.vaultCall(ch,'source-'+i+'/same.md'),{ch:channels.trashEntry,i})))
  const trashed=await a.evaluate(ch=>window.vaultCall(ch),channels.listTrash);assert.equal(trashed.length,20)
  await Promise.all(trashed.map((item,i)=>windows[i%3].evaluate(({ch,name})=>window.vaultCall(ch,name),{ch:channels.restoreTrash,name:item.name})))
  for(let i=0;i<20;i++)assert.equal(await app.evaluate((_,p)=>globalThis.integrityHost.file(p),'source-'+i+'/same.md'),'body-'+i)
  report.checks.push({name:'20 concurrent trash imports across two Electron windows and Unit HTTP restore every byte',passed:true})
  report.heap=await app.evaluate((_,out)=>globalThis.integrityHost.heap(out),out)
  const control=JSON.parse(fs.readFileSync(report.heap.controlSnapshot,'utf8'));
  report.heap.controlLargeProbeStrings=control.strings.filter(s=>s.startsWith('heap-ledger-body:')&&s.length>1000).length;
  assert.equal(report.heap.controlLargeProbeStrings,20);
  const snapshot=JSON.parse(fs.readFileSync(report.heap.snapshot,'utf8'))
  report.heap.retainedLargeProbeStrings=snapshot.strings.filter(s=>s.startsWith('heap-ledger-body:')&&s.length>1000).length
  assert.equal(report.heap.retainedLargeProbeStrings,0);assert.equal(report.heap.entries,0)
  fs.writeFileSync(path.join(out,'vault-integrity-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
 }finally{await app.evaluate(()=>globalThis.integrityHost?.close()).catch(()=>{});await app.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
