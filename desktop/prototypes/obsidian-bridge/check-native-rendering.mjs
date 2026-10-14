import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
const defs=new Map(), errors=[];
const code=`const {Plugin,MarkdownRenderChild,Component}=require('obsidian');
class Child extends MarkdownRenderChild {
 async onload(){window.started=true;await window.childGate;
 class Nested extends Component {onload(){window.nested++;} onunload(){if(window.nested)window.nested--;}}
 this.addChild(new Nested());this.allocated=true;window.resources++;this.containerEl.createDiv({text:'Ready'});}
 onunload(){if(this.allocated){window.resources--;this.allocated=false;}this.containerEl.empty();}
}
module.exports=class extends Plugin {onload(){
 this.registerMarkdownCodeBlockProcessor('fixture',async(source,el,ctx)=>{window.source=source;window.sourcePath=ctx.sourcePath;ctx.addChild(new Child(el));});
 this.registerMarkdownCodeBlockProcessor('reload',(source,el,ctx)=>{
 const app=this.app;
 class ReloadChild extends MarkdownRenderChild {
 constructor(el){super(el);this.reload=this.reload.bind(this);window.reloadChild=this;}
 async onload(){if(this.loaded){window.reloadStarted=true;await window.childGate;}this.loaded=true;
 this.allocated=true;window.reloadResources++;app.workspace.on('css-change',this.reload);}
 reload(){this.onunload();this.onload();}
 onunload(){if(this.allocated){window.reloadResources--;this.allocated=false;}app.workspace.off('css-change',this.reload);}
 }
 ctx.addChild(new ReloadChild(el));
 });
 this.addCommand({id:'probe',name:'Probe',callback:()=>{window.commands=(window.commands||0)+1;}});
 this.registerMarkdownCodeBlockProcessor('deferred',(source,el,ctx)=>{this.app.workspace.onLayoutReady(()=>ctx.addChild(new Child(el)));});
 this.registerMarkdownCodeBlockProcessor('pending',async()=>{window.started=true;await window.childGate;});
 this.registerMarkdownCodeBlockProcessor('broken',()=>{throw Error('Fixture render failure');});
}};`;
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('Timed out')};
try{
 win.eval(await readFile(new URL('./plugin/runtime.js',import.meta.url),'utf8'));
 let resolve;win.resources=0;win.nested=0;win.childGate=new Promise(r=>resolve=r);
 const r=await win.ForsionObsidianBridge.start({locale:'en',vaultRoot:()=>'/fixture',captureEditor:()=>({path:"Source.md",text:"Kept",anchor:0,head:0,isCurrent:()=>true,apply:()=>{throw Error("Unexpected editor write")}}),loadData:async()=>null,saveData:async()=>{},listPages:async()=>['Source.md'],readFile:async()=>'',onError:e=>errors.push(e.message),
 packageFiles:{list:async p=>p==='plugins'?['fixture']:['manifest.json','main.js'],readText:async p=>p.endsWith('main.js')?code:JSON.stringify({id:'fixture',name:'Fixture',version:'1'})},
 registerCodeBlockRenderer:def=>{defs.set(def.language,def);return()=>defs.delete(def.language)},
 });
 assert.equal(defs.size,5);
 const controller=new win.AbortController(),el=win.document.createElement('div');win.document.body.append(el);
 const mounting=defs.get('fixture').mount(el,{source:'unchanged source',language:'fixture',pagePath:'Source.md',signal:controller.signal});
 await until(()=>win.started);controller.abort();
 let completed=false;const queued=r.run('fixture','probe').then(()=>completed=true);
 await until(()=>completed); // Gate remains unresolved: abort must free the shared queue.
 await mounting;assert.equal(win.commands,1);
 resolve();await queued;await until(()=>win.resources===0);
 // onLayoutReady may add a child in a separate invocation. Its tracked load
 // needs the same cancellation; cancelling only the processor is insufficient.
 for(const language of ['deferred','pending']) {
   win.started=false;win.childGate=new Promise(r=>resolve=r);
   const abort=new win.AbortController(),target=win.document.createElement('div');
   const task=defs.get(language).mount(target,{source:'',language,pagePath:'Source.md',signal:abort.signal});
   await until(()=>win.started);abort.abort();
   completed=false;const next=r.run('fixture','probe').then(()=>completed=true);
   await until(()=>completed);await task;resolve();await next;
   await until(()=>win.resources===0);assert.equal(win.nested,0);assert.equal(target.shadowRoot.childNodes.length,0);
 }
 assert.equal(win.nested,0);assert.equal(win.source,'unchanged source');assert.equal(win.sourcePath,'Source.md');assert.equal(el.shadowRoot.childNodes.length,0);
 win.reloadResources=0;win.childGate=new Promise(r=>resolve=r);
 const reloadAbort=new win.AbortController();
 const reloadOff=await defs.get('reload').mount(win.document.createElement('div'),{source:'',language:'reload',pagePath:'Source.md',signal:reloadAbort.signal});
 const listenerCount=()=>[...r.app.workspace.refs].filter(x=>x.name==='css-change').length;
 assert.equal(listenerCount(),1);assert.equal(win.reloadResources,1);
 r.notifyCssChange();await until(()=>win.reloadStarted);reloadAbort.abort();assert.equal(listenerCount(),0);
 resolve();await new Promise(r=>setTimeout(r,20));assert.equal(listenerCount(),0);assert.equal(win.reloadResources,0);
 win.reloadChild.reload();await new Promise(r=>setTimeout(r,10));assert.equal(listenerCount(),0);assert.equal(win.reloadResources,0);reloadOff();
 const broken=defs.get('broken');await assert.rejects(broken.mount(win.document.createElement('div'),{source:'kept',language:'broken',pagePath:'Source.md',signal:new win.AbortController().signal}),/Fixture render failure/);
 r.dispose();assert.equal(defs.size,0);assert.equal(win.resources,0);
 assert.ok(errors.every(e=>e==='Fixture render failure'));
 console.log('PASS native rendering context, async processor and deferred-child cancellation unblock commands, late-child cleanup, async theme reload cannot restore stale listeners, render errors and processor disposal');
}finally{await win.happyDOM.close()}
