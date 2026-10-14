import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';
const win = new Window({settings:{enableJavaScriptEvaluation:true}}); win.structuredClone=structuredClone;
const files = new Map([['A.md','original A'],['B.md','original B']]);
let path='A.md', available=true;
const defs=new Map(), errors=[];
// Synthetic plugin isolates dispatch and navigation ordering. Original-package UI
// operations are independently covered by check-expanded and Electron acceptance.
const code=`const {Plugin,ItemView}=require('obsidian'); module.exports=class extends Plugin {
 onload(){
  this.registerView('fixture',leaf=>new ItemView(leaf));
  this.addCommand({id:'hold',name:'Hold',callback:async()=>{window.started();await window.gate;}});
  this.addCommand({id:'navigate',name:'Navigate',editorCallback:async editor=>{
   editor.replaceRange('EDIT ',{line:0,ch:0});
   await this.app.workspace.getLeaf(true).openFile(this.app.vault.getFileByPath('B.md'));
  }});
 }
}`;
try {
 win.eval(await readFile(new URL('./plugin/runtime.js',import.meta.url),'utf8'));
 const r=await win.ForsionObsidianBridge.start({
  locale:'en',vaultRoot:()=>'/fixture',loadData:async()=>null,saveData:async()=>{},onError:e=>errors.push(e.message),
  packageFiles:{list:async p=>p==='plugins'?['fixture']:['main.js','manifest.json'],readText:async p=>p.endsWith('main.js')?code:JSON.stringify({id:'fixture',name:'Fixture',version:'1'})},
  captureEditor(){
   if(!available)return null;
   const capturedPath=path,text=files.get(path);
   const current=()=>available&&path===capturedPath&&files.get(path)===text;
   return{path,text,anchor:0,head:0,isCurrent:current,apply:change=>{if(!current())return false;files.set(path,change.text);return true;}};
  },
  listPages:async()=>[...files.keys()],readFile:async p=>files.get(p),openNote:p=>{path=p},
  registerNativeView:def=>{defs.set(def.id,{def,el:win.document.createElement('div')});return()=>defs.delete(def.id)},
  openNativeView:id=>{const q=defs.get(id);q.cleanup=q.def.mount(q.el)},closeNativeView:id=>defs.get(id)?.cleanup?.(),
 });
 const plugin=r.app.plugins.plugins.fixture,leaf=plugin.app.workspace.getRightLeaf();
 await leaf.setViewState({type:'fixture'});
 let release;const started=new Promise(resolve=>{win.started=resolve});win.gate=new Promise(resolve=>{release=resolve});
 const blocking=r.run('fixture','hold');await started;
 available=false;
 const action=leaf.invoke(()=>plugin.app.workspace.getMostRecentLeaf()?.view.editor.replaceRange('WRONG ',{line:0,ch:0}));
 path='B.md';available=true;release();await blocking;await action;
 assert.equal(files.get('B.md'),'original B');
 path='A.md';await r.run('fixture','navigate');
 assert.equal(files.get('A.md'),'EDIT original A');assert.equal(path,'B.md');assert.deepEqual(errors,[]);
 const staleLeaf=plugin.app.workspace.getLeaf();r.dispose();
 assert.throws(()=>staleLeaf.openFile({path:'A.md'}),/disabled|disposed/i);
 assert.equal(path,'B.md');
 console.log('PASS view gesture keeps explicit no-editor capture; openFile follows commit; stale leaf navigation revoked');
}finally{await win.happyDOM.close()}
