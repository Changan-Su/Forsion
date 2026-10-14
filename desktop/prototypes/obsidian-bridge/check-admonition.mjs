import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
const compiled=await build({entryPoints:['shared/amadeus/publishing/publicMarkdown.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {renderPublicMarkdown,escapeHtml}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
const root=new URL('./plugin/',import.meta.url),defs=new Map(),errors=[],opened=[];
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('Timed out')};
try{
 win.eval(await readFile(new URL('runtime.js',root),'utf8'));
 const runtime=await win.ForsionObsidianBridge.start({locale:'en',vaultRoot:()=>'/fixture',captureEditor:()=>null,listPages:async()=>['Note.md'],openNote:async(...args)=>opened.push(args),readFile:async()=>'',loadData:async()=>null,saveData:async()=>{},onError:e=>{errors.push(e);console.error(e)},
 packageFiles:{list:async p=>p==='plugins'?['obsidian-admonition']:readdir(new URL(p+'/',root)),readText:p=>readFile(new URL(p,root),'utf8')},
 registerCodeBlockRenderer:def=>{defs.set(def.language,def);return()=>defs.delete(def.language)},
 renderMarkdown:text=>{const r=renderPublicMarkdown(text);return(r.title?'<h1>'+escapeHtml(r.title)+'</h1>':'')+r.html},
 });
 await until(()=>defs.has('ad-note'));assert.equal(defs.size,56);
 const abort=new win.AbortController(),el=win.document.createElement('div');win.document.body.append(el);
 const off=await defs.get('ad-note').mount(el,{source:'title: **Original title**\ncollapse: open\n\nRich **body** and [another note](Note.md).\n\n| Item | Count |\n| --- | --- |\n| Alpha | 3 |',pagePath:'Folder/Source.md',signal:abort.signal});
 await until(()=>el.shadowRoot?.querySelector('table'));assert.ok(el.shadowRoot.querySelector('.callout-icon svg path'));
 assert.equal(el.shadowRoot.querySelector('.admonition-content strong')?.textContent,'body');assert.equal(el.shadowRoot.querySelector('td')?.textContent,'Alpha');
 el.shadowRoot.querySelector('a').click();await until(()=>opened.length===1);assert.equal(opened[0][0],'Note.md');
 const title=el.shadowRoot.querySelector('.callout-title'),callout=el.shadowRoot.querySelector('.callout');title.click();assert.ok(callout.classList.contains('is-collapsed'));title.click();assert.ok(!callout.classList.contains('is-collapsed'));
 abort.abort();off();assert.equal(el.shadowRoot.childNodes.length,0);win.document.querySelector('[data-action=toggle-plugin]').click();await until(()=>!runtime.diagnostics().plugins[0].alive);await runtime.flush();assert.equal(defs.size,0);runtime.dispose();assert.equal(errors.length,0);
 console.log('PASS original Admonition renders native Markdown title/body/table and disposes');
}finally{await win.happyDOM.close()}
