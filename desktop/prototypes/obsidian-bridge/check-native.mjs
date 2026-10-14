// Original bundles exercise synchronous text APIs through command-local buffers (no editor DOM).
import { Window } from 'happy-dom';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
const pkg=join(dirname(fileURLToPath(import.meta.url)),'plugin');
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
let path='Native.md', saveBlocked=false, releaseSave, scanBlocked=false, releaseScan;

let text='Zebra\nApple\nBanana', cursor=0, commits=0, accept=true, commands=[];
try {
 win.eval(await readFile(join(pkg,'runtime.js'),'utf8'));
 const r=await win.ForsionObsidianBridge.start({locale:'en',vaultRoot:()=>'/fixture',loadData:async()=>null,saveData:async()=>{if(saveBlocked)await new Promise(resolve=>releaseSave=resolve)},
  packageFiles:{
   readText:p=>p==='plugins/async-probe/manifest.json'?Promise.resolve(JSON.stringify({id:'async-probe',name:'Async probe',version:'1'})):
    p==='plugins/async-probe/main.js'?Promise.resolve(`module.exports=class extends require('obsidian').Plugin {onload(){this.addCommand({id:'sleep',name:'Sleep',callback:async()=>{const editor=this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView).editor;await new Promise(r=>setTimeout(r,10));editor.replaceSelection('awake');}});this.addCommand({id:'late',name:'Late edit',callback:async()=>{const editor=this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView).editor;await new Promise(r=>window.resumeLate=r);editor.replaceSelection('late');}})}}`):readFile(join(pkg,p),'utf8'),
   list:async p=>{if(p==='plugins'&&scanBlocked)await new Promise(resolve=>releaseScan=resolve);return p==='plugins'?[...await readdir(join(pkg,p)).then(rows=>p==='plugins'?rows.filter(x=>['obsidian-sort-and-permute-lines','obsidian-plugin-toc','number-headings-obsidian'].includes(x)):rows),'async-probe']:p==='plugins/async-probe'?['manifest.json','main.js']:readdir(join(pkg,p)).then(rows=>p==='plugins'?rows.filter(x=>['obsidian-sort-and-permute-lines','obsidian-plugin-toc','number-headings-obsidian'].includes(x)):rows)},
  },
  onCommands:list=>commands=list,
  captureEditor:()=>{const before=text, at=cursor, file=path;const isCurrent=()=>before===text&&at===cursor&&file===path;return {path,text,anchor:cursor,head:cursor,isCurrent,apply:c=>{if(!accept||!isCurrent())return false;text=c.text;commits++;return true}}},
 });
 assert.equal(win.document.querySelector('.cm-editor'),null);assert.equal(commands.length,21);
 await r.run('obsidian-sort-and-permute-lines','sort-alphabetically');assert.equal(text,'Apple\nBanana\nZebra');assert.equal(commits,1);
 accept=false;await assert.rejects(r.run('obsidian-sort-and-permute-lines','permute-reverse'),/changed/);assert.equal(commits,1);accept=true;
 text='# Research\n\n\n## Introduction\n\n## Method\n\n### Preparation\n';cursor=12;
 await r.run('obsidian-plugin-toc','create-toc');assert.match(text,/\[\[#Introduction\|Introduction\]\]/);
 await r.run('number-headings-obsidian','number-headings');assert.match(text,/### 1\.2\.1 Preparation/);
 await assert.rejects(r.run('number-headings-obsidian','save-settings-to-front-matter'),/does not support/);
 await Promise.race([r.run('async-probe','sleep'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Timer deadlock')),2000))]);assert.ok(text.includes('awake'));
 // A blocked operation must not move the next original command to a newly active note.
 win.resumeLate=null;
 const held=r.run('async-probe','late');const heldRejected=assert.rejects(held,/changed/);
 while(!win.resumeLate)await new Promise(r=>setTimeout(r,1));
 const queued=r.run('obsidian-sort-and-permute-lines','sort-alphabetically');const queuedRejected=assert.rejects(queued,/changed while.*queued/);
 path='Other.md';text='Zulu\nBeta\nAlpha';const other=text;win.resumeLate();
 await heldRejected;await queuedRejected;assert.equal(text,other);assert.equal(path,'Other.md');
 console.log('PASS queued original command cannot follow a switched note');
 win.resumeLate=null;path='Native.md';
 const beforeLate=text, pending=r.run('async-probe','late');
 const rejected=assert.rejects(pending,/disabled or reloaded/);
 while(!win.resumeLate)await new Promise(r=>setTimeout(r,1));
 const toggle=()=>win.document.querySelector('[data-plugin="async-probe"] [data-action="toggle-plugin"]').click();
 toggle();await new Promise(r=>setTimeout(r,10));toggle();await new Promise(r=>setTimeout(r,10));
 await rejected;win.resumeLate();await new Promise(r=>setTimeout(r,10));assert.equal(text,beforeLate);await r.run('async-probe','sleep');assert.ok(text.includes('awake'));
 saveBlocked=true;
 win.document.querySelector('[data-plugin="obsidian-sort-and-permute-lines"] [data-action="toggle-plugin"]').click();
 while(!releaseSave)await new Promise(r=>setTimeout(r,1));
 assert.equal(commands.filter(c=>c.plugin==='obsidian-sort-and-permute-lines').length,0);
 releaseSave();saveBlocked=false;await new Promise(r=>setTimeout(r,10));
 console.log('PASS disabling removes native commands before persistence completes');
 win.document.querySelector('[data-plugin="obsidian-sort-and-permute-lines"] [data-action="toggle-plugin"]').click();
 await new Promise(r=>setTimeout(r,20));assert.equal(r.canRun('obsidian-sort-and-permute-lines','sort-alphabetically'),true);
 scanBlocked=true;const rescanning=r.scan();
 while(!releaseScan)await new Promise(r=>setTimeout(r,1));
 assert.equal(commands.length,0);assert.equal(r.canRun('obsidian-sort-and-permute-lines','sort-alphabetically'),false);
 releaseScan();scanBlocked=false;await rescanning;
 assert.equal(r.canRun('obsidian-sort-and-permute-lines','sort-alphabetically'),true);
 console.log('PASS rescan withdraws hotkeys before asynchronous package enumeration and restores only ready commands');
 r.dispose();assert.ok(r.diagnostics().plugins.every(p=>!p.alive && p.timers===0));
 console.log('PASS native command buffers: 3 original packages, no editor DOM, atomic commit, stale refusal, explicit unsupported API, cleanup');
}finally{await win.happyDOM.close()}
