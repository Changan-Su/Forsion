import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Window} from 'happy-dom';
const win=new Window({settings:{enableJavaScriptEvaluation:true}});win.structuredClone=structuredClone;
const errors=[],defs=new Map(),opened=[];let resolveHtml;
const code=`const {Plugin,MarkdownRenderer,MarkdownRenderChild,MarkdownPreviewRenderer,addIcon,getIcon,getIconIds,removeIcon}=require('obsidian');
module.exports=class extends Plugin {onload(){
 window.oldPreviewApis ||= [];window.oldPreviewApis.push(MarkdownPreviewRenderer);
 window.renderedEl=document.createElement('div');document.body.append(window.renderedEl);
 const child=new MarkdownRenderChild(window.renderedEl);this.addChild(child);
 window.renderText=text=>MarkdownRenderer.render(this.app,text,window.renderedEl,'Folder/Source.md',child);
 window.iconApi={addIcon,getIcon,getIconIds,removeIcon};
 addIcon('fixture-icon','<path d="M0 0L10 10"/>');
 this.registerMarkdownCodeBlockProcessor('pending-html',(_source,el,ctx)=>{
 const child=new MarkdownRenderChild(el);ctx.addChild(child);window.target=el;
 return MarkdownRenderer.render(this.app,'pending',el,'A.md',child);
 });
 this.addCommand({id:'probe',name:'Probe',callback:()=>{window.commands=(window.commands||0)+1}});
}};`;
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('Timed out')};
try {
 win.eval(await readFile(new URL('./plugin/runtime.js',import.meta.url),'utf8'));
 const r=await win.ForsionObsidianBridge.start({locale:'en',vaultRoot:()=>'/fixture',captureEditor:()=>({path:'A.md',text:'Kept',anchor:0,head:0,isCurrent:()=>true,apply:()=>{throw Error('Unexpected editor write')}}),listPages:async()=>['A.md','Folder/Other.md','Other.md','Folder/100%.md'],openNote:async(...args)=>opened.push(args),readFile:async()=>'',loadData:async()=>null,saveData:async()=>{},onError:e=>errors.push(e),
 packageFiles:{list:async p=>p==='plugins'?['fixture']:['manifest.json','main.js'],readText:async p=>p.endsWith('main.js')?code:JSON.stringify({id:'fixture',name:'Fixture',version:'1'})},
 registerCodeBlockRenderer:def=>{defs.set(def.language,def);return()=>defs.delete(def.language)},
 renderMarkdown:text=>text==='pending'?new Promise(resolve=>{resolveHtml=resolve}):text,
 });
 await win.renderText('<p><a href="Other.md">Other</a></p>');win.renderedEl.querySelector('a').click();await until(()=>opened.length===1);assert.equal(opened[0][0],'Folder/Other.md');
 win.renderedEl.replaceChildren();await win.renderText('<p><a href="100%.md">Percent</a></p>');win.renderedEl.querySelector('a').click();await until(()=>opened.length===2);assert.equal(opened[1][0],'Folder/100%.md');
 win.renderedEl.replaceChildren();await win.renderText('<p><strong>Promoted</strong></p>');win.renderedEl.setChildrenInPlace([...win.renderedEl.firstChild.childNodes]);const promoted=win.renderedEl;
 assert.ok(win.iconApi.getIcon('lucide-pencil').querySelector('path'));
 assert.ok(win.iconApi.getIconIds().includes('fixture-icon'));
 const first=win.iconApi.getIcon('fixture-icon');first.remove();assert.notEqual(first,win.iconApi.getIcon('fixture-icon'));
 const fragment=win.createFragment(f=>f.createEl('strong',{text:'Fragment'}));const holder=win.createDiv({text:fragment});assert.equal(holder.firstChild.tagName,'STRONG');
 const kept=holder.firstChild,added=win.createSpan({text:'Added'});holder.setChildrenInPlace([added,kept]);assert.equal(holder.lastChild,kept);assert.ok(kept.instanceOf(win.HTMLElement));
 const el=win.createDiv(),abort=new win.AbortController();
 const mounting=defs.get('pending-html').mount(el,{source:'pending',pagePath:'A.md',signal:abort.signal});
 await until(()=>!!resolveHtml);abort.abort();let completed=false;
 const queued=r.run('fixture','probe').then(()=>completed=true);await until(()=>completed);await mounting;
 resolveHtml('<p>Late <a href="B.md">link</a></p>');await queued;await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(el.shadowRoot.childNodes.length,0);assert.equal(win.target.childNodes.length,0);
 win.document.querySelector('[data-action=toggle-plugin]').click();await until(()=>!r.diagnostics().plugins[0].alive);await r.flush();
 assert.equal(win.iconApi.getIcon('fixture-icon'),null);assert.throws(()=>win.iconApi.addIcon('stale',''),/disabled/);
 assert.equal(promoted.childNodes.length,0);
 win.document.querySelector('[data-action=toggle-plugin]').click();await until(()=>r.diagnostics().plugins[0].alive&&defs.size===1);await r.flush();
 win.oldPreviewApis[0].unregisterCodeBlockPostProcessor('pending-html');assert.equal(defs.size,1);
 win.oldPreviewApis[1].unregisterCodeBlockPostProcessor('pending-html');assert.equal(defs.size,0);
 r.dispose();assert.equal(errors.length,0);assert.equal(defs.size,0);
 console.log('PASS pending MarkdownRenderer cancellation unblocks native commands, rejects late DOM, owns icons, supplies DOM helpers, resolves source-relative/percent links, removes promoted DOM and revokes stale unregister callbacks');
} finally {await win.happyDOM.close()}
