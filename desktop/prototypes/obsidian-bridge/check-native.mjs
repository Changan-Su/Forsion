// Original bundles exercise synchronous text APIs through command-local buffers (no editor DOM).
import { Window } from 'happy-dom';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
const pkg=join(dirname(fileURLToPath(import.meta.url)),'plugin');
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
let text='Zebra\nApple\nBanana', cursor=0, commits=0, accept=true, commands=[];
try {
 win.eval(await readFile(join(pkg,'runtime.js'),'utf8'));
 const r=await win.ForsionObsidianBridge.start({locale:'en',vaultRoot:()=>'/fixture',loadData:async()=>null,saveData:async()=>{},
  packageFiles:{
   readText:p=>p==='plugins/async-probe/manifest.json'?Promise.resolve(JSON.stringify({id:'async-probe',name:'Async probe',version:'1'})):
    p==='plugins/async-probe/main.js'?Promise.resolve(`module.exports=class extends require('obsidian').Plugin {onload(){this.addCommand({id:'late',name:'Late edit',callback:async()=>{const editor=this.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView).editor;await new Promise(r=>window.resumeLate=r);editor.replaceSelection('late');}})}}`):readFile(join(pkg,p),'utf8'),
   list:async p=>p==='plugins'?[...await readdir(join(pkg,p)),'async-probe']:p==='plugins/async-probe'?['manifest.json','main.js']:readdir(join(pkg,p)),
  },
  onCommands:list=>commands=list,
  captureEditor:()=>({path:'Native.md',text,anchor:cursor,head:cursor,apply:c=>{if(!accept)return false;text=c.text;commits++;return true}}),
 });
 assert.equal(win.document.querySelector('.cm-editor'),null);assert.equal(commands.length,20);
 await r.run('obsidian-sort-and-permute-lines','sort-alphabetically');assert.equal(text,'Apple\nBanana\nZebra');assert.equal(commits,1);
 accept=false;await assert.rejects(r.run('obsidian-sort-and-permute-lines','permute-reverse'),/changed/);assert.equal(commits,1);accept=true;
 text='# Research\n\n\n## Introduction\n\n## Method\n\n### Preparation\n';cursor=12;
 await r.run('obsidian-plugin-toc','create-toc');assert.match(text,/\[\[#Introduction\|Introduction\]\]/);
 await r.run('number-headings-obsidian','number-headings');assert.match(text,/### 1\.2\.1 Preparation/);
 await assert.rejects(r.run('number-headings-obsidian','save-settings-to-front-matter'),/does not support/);
 const beforeLate=text, pending=r.run('async-probe','late');
 const rejected=assert.rejects(pending,/disabled or reloaded/);
 const toggle=()=>win.document.querySelector('[data-plugin="async-probe"] [data-action="toggle-plugin"]').click();
 toggle();await new Promise(r=>setTimeout(r,10));toggle();await new Promise(r=>setTimeout(r,10));
 win.resumeLate();await rejected;assert.equal(text,beforeLate);
 r.dispose();assert.ok(r.diagnostics().plugins.every(p=>!p.alive && p.timers===0));
 console.log('PASS native command buffers: 3 original packages, no editor DOM, atomic commit, stale refusal, explicit unsupported API, cleanup');
}finally{await win.happyDOM.close()}
