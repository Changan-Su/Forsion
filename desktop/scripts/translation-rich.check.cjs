/** Real Electron, isolated vault/plugin + scripted engine. Selection → public translation client → KaTeX → native clipboard/save.
 * npm run build && npm run check:translationrich (also ZOOM=1.1). No real account is used by this gate.
 */
const fs = require('node:fs')
const path = require('node:path')
const katex = require('katex')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { launch, cardDone, shot, until } = require('./selection-bar.check.cjs')
const SOURCE = String.raw`Spin $s$ takes $s=0,\frac{1}{2},1,\frac{3}{2},\ldots$. For an electron, $s=\frac{1}{2}$.

$$
S^2|s,m\rangle=\hbar^2s(s+1)|s,m\rangle
$$

- Keep ` + '`spin()`' + ` unchanged.\n\n| State | Value |\n| --- | --- |\n| Spin | $s$ |\n\n[Manual](https://example.org/physics)\n`
const INLINE_TEX = ['s', String.raw`s=0,\frac{1}{2},1,\frac{3}{2},\ldots`, String.raw`s=\frac{1}{2}`]
const html = '<p>Spin ' + katex.renderToString(INLINE_TEX[0]) + ' takes ' + katex.renderToString(INLINE_TEX[1]) + '. For an electron, ' + katex.renderToString(INLINE_TEX[2]) + '.</p>'
const PLUGIN = `
window.__rich = { note: () => ctx.app.openNote('Math.md'), translate: text => ctx.tangu.translate({text, language:'Chinese (Simplified)',modelId:'mt'}) };
ctx.registerView({id:'rich',title:'Rich translation probe',mount(el) {
 el.innerHTML = '<div id="rich-plugin" style="padding:100px 30px;font-size:15px;line-height:1.8">' + ${JSON.stringify(html)} + '</div>';
 const bar = ctx.ui.mountSelectionBar(el, {view:'rich'});
 window.__rich.bar = bar;
 return () => bar.dispose();
}});
window.__rich.open = () => ctx.openView('rich');
ctx.registerSelectionAction({id:'translate-rich',title:'Translate via plugin API',scope:'own',run:async cx => (await ctx.tangu.translate({text:cx.markdown,language:'Chinese (Simplified)'})).text});
`
const sse = (text) => ({ __buffer: Buffer.from([...text.matchAll(/[\s\S]{1,3}/g)].map(([text]) => `data: ${JSON.stringify({type:'delta',text})}\n\n`).join('') + `data: ${JSON.stringify({type:'done',content:text})}\n\n`), contentType:'text/event-stream' })
const results = []
function check(name, ok, detail = '') { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`) }
async function dragParagraph(win, root, needle='Spin') {
  const coords = async () => win.evaluate(({selector,needle}) => {
    const p = Array.from(document.querySelectorAll(selector + ' p')).find(el => el.textContent.includes(needle))
    if (!p) throw new Error('Physics paragraph not found: ' + selector)
    p.scrollIntoView({block:'center'})
    const first = p.firstChild; const last = p.lastChild
    const a=document.createRange(); a.setStart(first,0); a.setEnd(first,1)
    const b=document.createRange(); b.setStart(last,last.textContent.length-1); b.setEnd(last,last.textContent.length)
    const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect()
    window.getSelection().removeAllRanges()
    return {x0:ar.left+1,y0:ar.top+ar.height/2,x1:br.right-1,y1:br.top+br.height/2}
  }, {selector:root,needle})
  await coords(); await win.waitForTimeout(200); const r=await coords()
  await win.mouse.move(r.x0,r.y0); await win.mouse.down(); await win.mouse.move(r.x1,r.y1,{steps:24}); await win.mouse.up()
}
async function preview(win) {
  return win.locator('[data-testid="inline-ai-preview"]').evaluate(el => ({
    tex:Array.from(el.querySelectorAll('annotation[encoding="application/x-tex"]'), a=>a.textContent),
    text:el.textContent, code:el.querySelector('code')?.textContent, table:!!el.querySelector('table'),
    run:!!el.querySelector('[data-testid="code-run"]'),
  }))
}
async function close(win) { await win.keyboard.press('Escape'); await until(async()=>!(await win.locator('[data-testid="inline-ai-panel"]').count()),3000) }

async function main() {
  const requests=[]; let broken=false
  const now=Date.now()
  const stub=await startStubEngine({
    sessions:[{id:'rich',title:'Physics translation',model_id:'chat',created_at:now,updated_at:now,projectless:true}],
    messages:[{id:'a',role:'model',content:SOURCE,timestamp:now}],
    models:[{id:'chat',name:'Scripted chat',provider:'stub'}],
    modelsMeta:{translateModels:[{id:'mt',name:'Scripted MT',provider:'stub'}]},
    handle:async ({path:route,method,body})=>{
      if(route==='/agent/runs') return {runs:[]}
      if(route==='/api/brain/users/me') return {id:'rich',username:'Rich tester'}
      if(route==='/agent/inline'&&method==='POST') {
        const req=await body(); requests.push(req)
        return sse(broken ? 'missing protected content' : req.selection.replaceAll('Spin','自旋').replaceAll('takes','可取').replaceAll('For an electron','对于电子').replaceAll('Keep','保留').replaceAll('unchanged','不变').replaceAll('State','状态').replaceAll('Value','数值').replaceAll('Manual','手册'))
      }
    }
  })
  let app,win,home
  try {
    ({app,win,home}=await launch(stub.url,{tangu_locale:'zh'},{pluginMain:PLUGIN,notes:{'Math.md':SOURCE}}))
    const shots=path.join(home,'rich-shots');fs.mkdirSync(shots)
    win.on('pageerror',e=>console.log('PAGEERROR '+e.message))
    check('isolated application ready',await skipOnboarding(win))
    await win.addStyleTag({content:'.sync-setup-backdrop {display:none!important}'})
    await win.locator('.t2s-srow',{hasText:'Physics translation'}).first().click()
    await win.locator('.t2-content .katex').first().waitFor({timeout:30000})
    check('probe plugin loaded',await until(()=>win.evaluate(()=>!!window.__rich),15000))
    await dragParagraph(win,'[data-chat-surface="chat"] .t2-content')
    await win.locator('[data-testid="selection-translate"]').click()
    check('chat completes', (await cardDone(win))?.phase==='done')
    const chat=await preview(win)
    check('chat: exactly three intact source formulas, no duplicated layout',JSON.stringify(chat.tex)===JSON.stringify(INLINE_TEX),JSON.stringify(chat.tex))
    check('chat: request protects source before reaching MT',!requests.at(-1).selection.includes('frac')&&(requests.at(-1).selection.match(/ZXQ\w+?QXZ/g)||[]).length===3)
    await win.locator('[data-testid="inline-ai-panel"] [data-act="copy"]').click()
    await win.locator('[data-testid="inline-ai-panel"] [data-act="copy"]').filter({hasText:'已复制'}).waitFor()
    const copied=await app.evaluate(({clipboard})=>clipboard.readText())
    check('native clipboard keeps original LaTeX and translated prose',INLINE_TEX.every(tex=>copied.includes('$'+tex+'$'))&&copied.includes('自旋')&&!copied.includes('ZXQ'),copied)
    await shot(win,path.join(shots,'chat-light.png')); await close(win)

    await win.evaluate(()=>window.__rich.open())
    await win.locator('#rich-plugin').waitFor()
    await dragParagraph(win,'#rich-plugin')
    await win.locator('[data-testid="selection-translate"]').click()
    check('plugin DOM selection translates', (await cardDone(win))?.phase==='done'&&JSON.stringify((await preview(win)).tex)===JSON.stringify(INLINE_TEX))
    await close(win)
    const viaApi=await win.evaluate(source=>window.__rich.translate(source),SOURCE)
    check('ctx.tangu.translate shares protection for math/code/link destinations',viaApi.text.includes(String.raw`\frac{1}{2}`)&&viaApi.text.includes('`spin()`')&&viaApi.text.includes('https://example.org/physics')&&viaApi.text.includes('自旋'))
    await win.evaluate(source=>window.__rich.bar.show({text:source,markdown:source,rect:{left:300,right:600,top:300,bottom:330}}),SOURCE)
    await win.locator('[data-testid="selection-bar"] [data-act="more"]').click()
    await win.locator('[data-ai="plugin:selprobe:translate-rich"]').click()
    await cardDone(win)
    const plugin=await preview(win)
    check('plugin action preview renders block math/table/code with no run action',plugin.tex.length===5&&plugin.table&&plugin.code==='spin()'&&!plugin.run,JSON.stringify(plugin))
    await shot(win,path.join(shots,'plugin-rich.png')); await close(win)

    await win.evaluate(()=>window.__rich.note())
    const PM='.unified-body .ProseMirror'
    await win.locator(PM).first().waitFor({timeout:30000})
    // Focusing a live math node changes its layout. Select via the real editor shortcut rather than stale drag coordinates.
    await win.locator(PM+' p').first().click()
    await win.keyboard.press(process.platform==='darwin'?'Meta+A':'Control+A')
    await win.locator(PM).first().dispatchEvent('mouseup')
    await win.locator('[data-testid="inline-toolbar"] [data-act="translate"]').click()
    check('note serializer and preview preserve formulas',(await cardDone(win))?.phase==='done'&&JSON.stringify((await preview(win)).tex)===JSON.stringify(INLINE_TEX),JSON.stringify((await preview(win)).tex))
    check('preview does not write the note',fs.readFileSync(path.join(home,'vault/Math.md'),'utf8')===SOURCE)
    await win.locator('[data-testid="inline-ai-panel"] [data-act="below"]').click()
    check('confirm inserts translated Markdown with intact fraction source',await until(()=>{const disk=fs.readFileSync(path.join(home,'vault/Math.md'),'utf8');return disk.includes('自旋')&&(disk.match(/\\frac\{1\}\{2\}/g)||[]).length>=4},8000))

    // Missing/duplicated markers are errors, never an apparently successful result the user can apply.
    broken=true
    const before=requests.length
    const bad=await win.evaluate(async source=>{try{await window.__rich.translate(source);return ''}catch(e){return e.message}},SOURCE)
    check('plugin API rejects corrupt translation with one retry',/未完整保留/.test(bad)&&requests.length-before===2,bad)
    broken=false
    // A long source equation and a small window exercise the overlay's own horizontal scroll boundary.
    await app.close()
    const dark=await launch(stub.url,{tangu_locale:'zh',forsion_theme_pref:'dark',forsion_theme:'dark'},{pluginMain:PLUGIN})
    app=dark.app;win=dark.win
    await skipOnboarding(win)
    await win.addStyleTag({content:'.sync-setup-backdrop {display:none!important}'})
    await until(()=>win.evaluate(()=>!!window.__rich),15000)
    await win.evaluate(()=>window.__rich.open());await win.locator('#rich-plugin').waitFor()
    await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(360,500);w.setSize(390,850)})
    await win.waitForTimeout(800)
    const wide='Equation:\n\n$$\n'+Array.from({length:32},(_,i)=>'x_{'+i+'}').join('+')+'\n$$'
    await win.evaluate(source=>window.__rich.bar.show({text:source,markdown:source,rect:{left:80,right:420,top:300,bottom:330}}),wide)
    await win.locator('[data-testid="selection-translate"]').click();await cardDone(win)
    const geometry=await win.evaluate(()=>{const panel=document.querySelector('[data-testid="inline-ai-panel"]'),eq=panel.querySelector('.katex-display');const b=panel.getBoundingClientRect();return{left:b.left,right:b.right,vw:innerWidth,scroll:eq.scrollWidth,width:eq.clientWidth}})
    check('narrow view keeps long equation inside scrollable preview',geometry.left>=0&&geometry.right<=geometry.vw+1&&geometry.scroll>geometry.width,JSON.stringify(geometry))
    await shot(win,path.join(shots,'narrow-formula.png'))
    console.log(`SCREENSHOTS ${shots}\n${results.filter(Boolean).length}/${results.length} passed`)
    fs.writeFileSync(path.join(home,'rich-report.json'),JSON.stringify({results,requests:requests.map(r=>({action:r.action,model:r.model_id,selection:r.selection})),shots},null,2))
    if(results.some(ok=>!ok))process.exitCode=1
  } catch(e) {if(win)await win.screenshot({path:path.join(home,'rich-failure.png')}).catch(()=>{});throw e}
  finally {if(app)await app.close().catch(()=>{});await stub.close()}
}
module.exports={SOURCE,PLUGIN,INLINE_TEX,dragParagraph,preview}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
