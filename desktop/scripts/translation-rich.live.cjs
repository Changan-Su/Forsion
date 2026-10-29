/** Opt-in: real standalone engine + account MT and Codex, isolated data. Never prints/copies credentials into reports.
 * npm run check:translationlive; archive the printed OUT with harness-runs/archive.mjs add.
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { pathToFileURL } = require('node:url')
const { transform } = require('sucrase')
const ROOT = path.resolve(__dirname, '..')
const SOURCE = String.raw`The spin quantum number $s$ can be an integer or a half-integer: $s=0,\frac{1}{2},1,\frac{3}{2},\ldots$. For an electron, $s=\frac{1}{2}$.

$$
S^2|s,m\rangle=\hbar^2s(s+1)|s,m\rangle
$$

- Keep ` + '`spin()`' + ` unchanged.\n- Read [the manual](https://example.org/physics).\n- See [Reference][].\n\n[Reference]: https://example.org/reference\n`
async function main() {
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'forsion-translation-live-'))
  const startedAt=new Date().toISOString()
  const home=path.join(out,'forsion','tangu');fs.mkdirSync(home,{recursive:true})
  const auth=JSON.parse(fs.readFileSync(process.env.FORSION_TRANSLATION_AUTH||path.join(os.homedir(),'.forsion-dev/auth.json'),'utf8'))
  const provider=path.join(os.homedir(),'.forsion-dev/provider-auth.json')
  const link=path.join(out,'forsion/provider-auth.json')
  if(fs.existsSync(provider))fs.symlinkSync(provider,link)
  const moduleFile=path.join(ROOT,'out/translationContent-live.mjs')
  fs.writeFileSync(moduleFile,transform(fs.readFileSync(path.join(ROOT,'frontend/src/services/translationContent.ts'),'utf8'),{transforms:['typescript']}).code)
  const {protectTranslation}=await import(pathToFileURL(moduleFile).href)
  const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
  const child=spawn(process.execPath,[path.join(ROOT,'../tangu-agent/dist/standalone/main.js'),'--port',String(port),'--host','127.0.0.1','--data-dir',path.join(home,'state.db'),'--cloud-url',auth.cloudUrl,'--token',auth.token],{env:{...process.env,TANGU_HOME:home,TANGU_BROWSER_CDP:'off',TANGU_BROWSER_EXTENSION:'0',FORSION_DESKTOP_CONFIG:path.join(out,'absent-desktop.json')},stdio:['ignore','pipe','pipe']})
  // Logs stay local until the archive's credential scan. The script itself prints only sanitized results.
  child.stdout.on('data',d=>fs.appendFileSync(path.join(out,'engine.log'),d))
  child.stderr.on('data',d=>fs.appendFileSync(path.join(out,'engine.log'),d))
  const base='http://127.0.0.1:'+port
  const headers={Authorization:'Bearer '+auth.token,'Content-Type':'application/json'}
  const rows=[]
  try {
    let ready=false
    for(let i=0;i<120;i++) {try{const r=await fetch(base+'/agent/models',{headers,signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}
    if(!ready)throw new Error('Isolated engine did not become ready')
    const catalog=await(await fetch(base+'/agent/models?app_id=tangu',{headers})).json()
    const mt=catalog.translateModels?.find(m=>/qwen.*flash/i.test(m.apiModelId||m.name))||catalog.translateModels?.[0]
    if(!mt)throw new Error('Account has no machine translation model in its catalog')
    for(const model of [mt.id,'codex/gpt-6-luna']) {
      const p=protectTranslation(SOURCE)
      let raw='',restored=null,error=null,attempts=0;const t0=Date.now()
      try {
        for(;attempts<2;attempts++) {
          const response=await fetch(base+'/agent/inline',{method:'POST',headers,body:JSON.stringify({model_id:model,action:'translate',selection:p.text,language:'Chinese (Simplified)',app_id:'tangu'}),signal:AbortSignal.timeout(180000)})
          if(!response.ok)throw new Error('HTTP '+response.status)
          const events=(await response.text()).split('\n').filter(s=>s.startsWith('data:')).map(s=>{try{return JSON.parse(s.slice(5))}catch{return null}}).filter(Boolean)
          const fail=events.find(e=>e.type==='error');if(fail)throw new Error(String(fail.error))
          raw=events.find(e=>e.type==='done')?.content||''
          restored=p.restore(raw)
          if(restored!=null){attempts++;break}
        }
      }catch(e){error=e.message}
      const ok=restored!=null&&/[\u4e00-\u9fff]/.test(restored)&&restored.includes(String.raw`$s=\frac{1}{2}$`)&&restored.includes('`spin()`')&&restored.includes('https://example.org/physics')&&restored.includes('][Reference]')&&restored.includes('[Reference]: https://example.org/reference')
      rows.push({key:'translation-rich-'+(model===mt.id?'mt':'codex'),name:model,ok,ms:Date.now()-t0,detail:`attempts=${attempts}; source spans ${restored!=null?'intact':'lost'}${error?'; '+error:''}`,output:restored||raw})
      console.log(`${ok?'PASS':'FAIL'} ${model}: ${rows.at(-1).detail}`)
    }
  }finally {
    child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!=null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve()},3000).unref()})
    if(fs.existsSync(link))fs.unlinkSync(link)
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({model:rows.map(r=>r.name).join(', '),only:rows.map(r=>r.key),startedAt,finishedAt:new Date().toISOString(),results:rows},null,2))
    fs.writeFileSync(path.join(out,'report.md'),'# Translation source integrity live\n\n'+rows.map(r=>`${r.ok?'PASS':'FAIL'} ${r.name}: ${r.detail}\n\n${r.output}`).join('\n\n'))
    console.log('OUT '+out)
  }
  if(!rows.length||rows.some(r=>!r.ok))process.exitCode=1
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
