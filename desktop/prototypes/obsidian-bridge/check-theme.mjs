import {Window} from 'happy-dom';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('Timed out')};
const code=`const {Plugin,MarkdownView}=require('obsidian');module.exports=class extends Plugin {onload(){
 window.atLoad=document.body.classList.contains('theme-dark');window.themeEvents=[];window.deferredViews=[];
 this.registerEvent(this.app.workspace.on('css-change',()=>{
 const probe=()=>window.deferredViews.push(!!this.app.workspace.getActiveViewOfType(MarkdownView));
 setTimeout(probe,25);this.app.workspace.onLayoutReady(probe);
 const interval=setInterval(()=>{clearInterval(interval);probe()},30);
 window.themeEvents.push({
 color:getComputedStyle(document.documentElement).getPropertyValue('--text'),
 mode:document.body.classList.contains('theme-dark')?'dark':'light',
 editableView:!!this.app.workspace.getActiveViewOfType(MarkdownView)
 });}));
 return new Promise(resolve=>window.finishLoad=resolve);
}};`;
let lease=false,dispose;
try{
 win.document.documentElement.dataset.mode='dark';win.document.documentElement.style.setProperty('--text','#eeeeee');
 Object.defineProperty(win.navigator,'locks',{value:{async request(_name,_opts,fn){if(lease)return fn(null);lease=true;try{await fn({})}finally{lease=false}}}});
 const bundle=await readFile(new URL('./plugin/runtime.js',import.meta.url),'utf8');
 win.__ctx={getLocale:()=> 'en',registerView(){},registerCommand(){return()=>{}},loadData:async()=>null,saveData:async()=>{},
 app:{vaultRoot:()=>'/fixture',captureEditor:()=>({path:'Other.md',text:'Keep',anchor:0,head:0,isCurrent:()=>true,apply:()=>{throw Error('Unexpected edit')}}),listPages:async()=>['Other.md'],readFile:async()=> 'Keep',notify(){}},
 packageFiles:{list:async p=>p==='plugins'?['fixture']:['manifest.json','main.js'],readText:async p=>p==='runtime.js'?bundle:p.endsWith('main.js')?code:JSON.stringify({id:'fixture',name:'Fixture',version:'1'})}};
 dispose=win.eval('(function(ctx){'+await readFile(new URL('./plugin/main.js',import.meta.url),'utf8')+'\n})(window.__ctx)');
 const frame=win.document.querySelector('iframe');const child=frame.contentWindow;await until(()=>!!child.finishLoad);
 assert.equal(child.atLoad,true);assert.equal(child.themeEvents.length,0);
 child.document.documentElement.style.setProperty('--plugin-owned','kept');
 win.document.documentElement.dataset.mode='light';win.document.documentElement.style.setProperty('--text','#111111');
 await until(()=>child.document.documentElement.dataset.mode==='light');child.finishLoad();
 await until(()=>!!child.bridge);await until(()=>child.themeEvents.length===1);
 await until(()=>child.deferredViews.length===3);assert.ok(child.deferredViews.every(v=>!v));
 assert.deepEqual(JSON.parse(JSON.stringify(child.themeEvents[0])),{color:'#111111',mode:'light',editableView:false});
 win.document.documentElement.dataset.skin='same-tokens';await new Promise(r=>setTimeout(r,25));assert.equal(child.themeEvents.length,1);
 win.document.documentElement.style.removeProperty('--text');await until(()=>child.themeEvents.length===2);assert.equal(child.themeEvents[1].color,'');
 assert.equal(child.document.documentElement.style.getPropertyValue('--plugin-owned'),'kept');
 child.bridge.dispose();win.document.documentElement.dataset.mode='dark';await new Promise(r=>setTimeout(r,25));assert.equal(child.themeEvents.length,2);
 dispose();dispose=null;await until(()=>!lease);
 console.log('PASS theme classes at plugin load, startup css-change replay after token sync, deferred timers/layout callbacks retain no-editor context, removed tokens and disposal');
}finally{dispose?.();await win.happyDOM.close()}
