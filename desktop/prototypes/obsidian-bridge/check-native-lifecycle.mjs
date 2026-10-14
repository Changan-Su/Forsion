import { Window } from 'happy-dom';
import { readFile,readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const pkg=join(dirname(fileURLToPath(import.meta.url)),'plugin');
const tick=()=>new Promise(r=>setImmediate(r));
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw new Error('Condition timed out')};
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
let lease=false,saved=null,root='/first',releaseWrite,writeStarted=false;
const commands=new Map();
Object.defineProperty(win.navigator,'locks',{value:{async request(_name,_opts,fn){if(lease)return fn(null);lease=true;try{await fn({})}finally{lease=false}}}});
win.__ctx={getLocale:()=> 'en',registerView(){},registerCommand(c){commands.set(c.id,c);return()=>commands.delete(c.id)},
 packageFiles:{readText:async p=>{const code=await readFile(join(pkg,p),'utf8');return p==='runtime.js'?'window.structuredClone=parent.structuredClone;\n'+code:code},list:p=>readdir(join(pkg,p)).then(rows=>p==='plugins'?rows.filter(x=>!['obsidian-linter','note-refactor-obsidian','table-editor-obsidian'].includes(x)):rows)},
 loadData:async()=>saved,saveData:async value=>{writeStarted=true;await new Promise(r=>releaseWrite=r);saved=value},
 app:{vaultRoot:()=>root,captureEditor:()=>null,notify(){}},
};
try{
 const dispose=win.eval('(function(ctx){'+await readFile(join(pkg,'main.js'),'utf8')+'\n})(window.__ctx)');
 const frame=win.document.querySelector('iframe');await until(()=>!!frame.contentWindow.bridge);
 assert.equal(commands.size,20);assert.ok(lease);assert.equal(frame.contentWindow.document.querySelector('.cm-editor'),null);
 // A vault transition recreates child state but retains a single runtime and lease.
 root='/second';await commands.get('obsidian-bridge-open').run();await until(()=>frame.contentWindow.bridge?.diagnostics().vaultKey==='/second');
 assert.equal(commands.size,20);assert.ok(lease);
 const child=frame.contentWindow;child.bridge.showSettings('obsidian-plugin-toc');
 const input=child.document.querySelector('input[aria-label="Title"]');input.value='Saved native title';input.dispatchEvent(new child.Event('input'));
 await until(()=>writeStarted);dispose();await tick();assert.ok(lease);assert.equal(commands.size,1); // parent command is host-owned
 releaseWrite();await until(()=>!lease);assert.ok(JSON.stringify(saved).includes('Saved native title'));
 assert.equal(win.document.querySelector('iframe'),null);
 console.log('PASS native service lifecycle: vault refresh, command disposal, accepted save drains before Web Lock release');
}finally{await win.happyDOM.close()}
