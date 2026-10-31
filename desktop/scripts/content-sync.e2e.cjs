/** Extend 同步管理方案：独立构建 × 隔离 home × 本机假云端 × 桩引擎。
 * 用一次性测试签名运行壳副本，现状为真 Penzor，方案只注入主区。
 * GENESIS_DESKTOP=<built desktop> EXTEND_PKG=<built Extend> \
 * node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Extend 同步方案" --eta=3 -- node <本文件>
 * 从「我的云盘统一方案」出图仪器复用假云端；不访问用户配置或真实服务。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

let ROOT = path.resolve(process.env.GENESIS_DESKTOP||path.join(__dirname,'..'))
let EXTEND = process.env.EXTEND_PKG?path.resolve(process.env.EXTEND_PKG):null
const RAW = process.env.SYNC_EVIDENCE || '/tmp/forsion-content-sync-evidence'
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
const electron = require(path.join(ROOT, 'scripts/lib/launch-electron.cjs'))
const { startStubEngine } = require(path.join(ROOT, 'scripts/lib/stub-engine.cjs'))
const { skipOnboarding } = require(path.join(ROOT, 'scripts/lib/skip-onboarding.cjs'))
const crypto=require('node:crypto')
const assert=require('node:assert/strict')

function installExtend(home) {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTEND, 'package.json'), 'utf8'))
  const dest = path.join(home, 'plugins', 'forsion-extend')
  for (const f of ['package.json', ...pkg.files]) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true })
    fs.copyFileSync(path.join(EXTEND, f), path.join(dest, f))
  }
}

// ── 假云端:四本账照 e2e:penzor;「我的云盘」= 应用文件里 app id penzor 那一份(现状就是真页面)──
const MB = 1024 * 1024
const now = Date.now()
const ago = (min) => now - min * 60_000
const day = (d, h = 12) => { const x = new Date(now); x.setDate(x.getDate() - d); x.setHours(h, 0, 0, 0); return x.getTime() }
function startFakeCloud() {
  const drive = [
    { id: 'd-contract', name: '合同与票据', fileType: 'directory', fileSize: 0, updatedAt: day(2), parentId: 'ROOT' },
    { id: 'd-photo', name: '照片 2026', fileType: 'directory', fileSize: 0, updatedAt: day(4), parentId: 'ROOT' },
    { id: 'd-course', name: '课程资料', fileType: 'directory', fileSize: 0, updatedAt: day(8), parentId: 'ROOT' },
    { id: 'f-prop', name: '项目提案_v4.pdf', fileType: 'file', fileSize: 6.8 * MB, updatedAt: ago(40), parentId: 'ROOT' },
    { id: 'f-kyoto', name: '旅行照片 京都.zip', fileType: 'file', fileSize: 46.1 * MB, updatedAt: day(1, 21), parentId: 'ROOT' },
    { id: 'f-rent', name: '租房合同 扫描.pdf', fileType: 'file', fileSize: 3.2 * MB, updatedAt: day(3), parentId: 'ROOT' },
    { id: 'f-budget', name: '家庭开支 2026.xlsx', fileType: 'file', fileSize: 240 * 1024, updatedAt: day(5), parentId: 'ROOT' },
    { id: 'f-cv', name: '简历_2026.pdf', fileType: 'file', fileSize: 420 * 1024, updatedAt: day(9), parentId: 'ROOT' },
    { id: 'f-talk', name: '读书会 讲稿.docx', fileType: 'file', fileSize: 88 * 1024, updatedAt: day(12), parentId: 'ROOT' },
  ]
  const trash = [
    { id: 't-avatar', appId: 'notebase', parentId: 'ROOT', parentName: null, name: '旧版头像.png', fileType: 'file', fileSize: 2.1 * MB, deletedAt: day(7) },
    { id: 't-mood', appId: 'ai-studio', parentId: 'ROOT', parentName: null, name: 'moodboard.png', fileType: 'file', fileSize: 9.4 * MB, deletedAt: day(18) },
  ]
  const wmos = [
    ...Array.from({ length: 38 }, (_, i) => ({ path: `论文/p${i}.pdf`, size: 8.2 * MB, mtimeMs: ago(30 + i), device: 'MacBook Pro' })),
    { path: '组会 10-16.pdf', size: 3.1 * MB, mtimeMs: ago(3), device: 'MacBook Pro' },
    { path: 'WMOS 演示录屏.mov', size: 48.6 * MB, mtimeMs: day(1, 21), device: '公司 iMac' },
  ].map((f, i) => ({ ...f, hash: `h${i}`, seq: 1 }))
  const namespaces=new Map(),devices=new Map([['E','设备 E'],['F','设备 F']]);const incoming=Buffer.alloc(20*1024*1024,7),nodeId=crypto.randomUUID()
  const h=crypto.createHash('sha256').update(incoming).digest('hex')
  namespaces.set('default',[{id:nodeId,parentId:'',name:'incoming.bin',path:'incoming.bin',kind:'file',revision:1,deleted:false,version:`1:${h}`,hash:h,size:incoming.length,bytes:incoming}])
  const server = http.createServer(async(req, res) => {
    const u = new URL(req.url || '/', 'http://x')
    const p = u.pathname
    const src = String(req.headers['x-project-source'] || '')
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if(p.startsWith('/api/remotesync/content/')){
      const parts=p.split('/').filter(Boolean),ns=decodeURIComponent(parts[3]);const clean=n=>{const {bytes,...v}=n;return v}
      if(ns==='devices'){if(req.method==='PUT'){let raw='';for await(const c of req)raw+=c;devices.set(parts[4],JSON.parse(raw).name);return json(200,{ok:true})}return json(200,{devices:[...devices].map(([id,name])=>({id,name}))})}
      const list=namespaces.get(ns)||[];namespaces.set(ns,list)
      if(parts.length===4)return json(200,{schemaVersion:1,namespace:ns,folder:ns==='default'?'Forsion':`Forsion-${ns.slice(7)}`,nodes:list.map(clean)})
      const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks),v=()=>JSON.parse(bytes.toString()||'{}')
      const paths=()=>{const of=n=>n.parentId?of(list.find(x=>x.id===n.parentId))+'/'+n.name:n.name;for(const n of list)n.path=of(n)}
      if(req.method==='POST'){const x=v(),same=list.find(n=>!n.deleted&&n.parentId===x.parentId&&n.name===x.name);if(same)return json(200,clean(same));const n={...x,id:x.id||crypto.randomUUID(),parentId:x.parentId||'',revision:1,deleted:false,path:''};list.push(n);paths();return json(200,clean(n))}
      const n=list.find(n=>n.id===parts[5]);if(!n)return json(404,{detail:'missing'})
      if(parts[6]==='content'){
        if(req.method==='GET'){res.writeHead(200,{'Content-Length':n.bytes.length});let offset=0;const timer=setInterval(()=>{if(res.destroyed||offset>=n.bytes.length){clearInterval(timer);if(!res.destroyed)res.end();return}res.write(n.bytes.subarray(offset,offset+64*1024));offset+=64*1024},25);return}
        if((n.version||'create')!==req.headers['x-content-version'])return json(409,{detail:'CAS'})
        n.bytes=bytes;n.hash=crypto.createHash('sha256').update(bytes).digest('hex');n.version=`${Number(n.version?.split(':')[0]||0)+1}:${n.hash}`;n.size=bytes.length;return json(200,{version:n.version,hash:n.hash,size:n.size})
      }
      const x=v();if(n.revision!==x.revision)return json(409,{detail:'revision'})
      if(req.method==='PATCH'){n.parentId=x.parentId;n.name=x.name;n.revision++;paths();return json(200,clean(n))}
      n.deleted=true;return json(200,{ok:true})
    }
    if (p === '/api/brain/users/me') return json(200, { id: 'u1', username: 'demo', nickname: '演示' })
    if (p === '/api/remotesync/vaults') return json(200, {
      vaults: [
        { vault: 'WMOSv11', files: 4812, bytes: 1086 * MB, updatedAt: new Date(ago(3)).toISOString(), device: 'MacBook Pro', devices: ['MacBook Pro', '公司 iMac'] },
        { vault: 'papers', files: 96, bytes: 96 * MB, updatedAt: new Date(day(9)).toISOString(), device: null, devices: [] },
      ],
      usedBytes: 1182 * MB, diagnosticsBytes: 0, maxBytes: 2048 * MB, maxFileBytes: 50 * MB,
    })
    if (p === '/api/remotesync/vaults/WMOSv11/manifest') return json(200, { files: wmos })
    if (/^\/api\/remotesync\/vaults\/[^/]+\/manifest$/.test(p)) return json(200, { files: [] })
    if (p === '/api/amadeus/vaults') return json(200, { vaults: [{ id: 'a1', name: '我的云端笔记', sizeBytes: 718 * MB, role: 'owner' }] })
    if (p === '/api/amadeus/vaults/a1/tree') return json(200, { entries: [] })
    if (p === '/api/amadeus/attachments') return json(200, { attachments: [], totalBytes: 0 })
    if (p === '/api/storage/quota') return json(200, { used: 1768 * MB, quota: 10240 * MB, percentage: 17 })
    if (p === '/api/storage/files-by-app') return json(200, {
      apps: [
        { appId: 'penzor', bytes: 126 * MB, files: 9, trashBytes: 0, trashFiles: 0 },
        { appId: 'ai-studio', bytes: 1260 * MB, files: 342, trashBytes: 9.4 * MB, trashFiles: 1 },
        { appId: 'photo-studio', bytes: 348 * MB, files: 61, trashBytes: 0, trashFiles: 0 },
        { appId: 'notebase', bytes: 34 * MB, files: 41, trashBytes: 2.1 * MB, trashFiles: 1 },
      ],
      largest: [],
    })
    if (p === '/api/files' && req.method === 'GET') return json(200, src === 'penzor' && !u.searchParams.get('parentId') ? drive.map((f) => ({ ...f, appId: src })) : [])
    if (/^\/api\/files\/[^/]+\/versions$/.test(p)) return json(200, [2, 1].map((n) => ({ versionNumber: n, fileSize: 6.8 * MB, createdAt: day(n * 2) })))
    if (p.startsWith('/api/exports/list')) return json(200, { files: [
      { fileId: 'e1', fileName: '读书笔记 导出.md', size: 42 * MB, createdAt: new Date(day(6)).toISOString(), appId: 'notebase' },
    ], total: 1, totalBytes: 42 * MB, page: 1, pageSize: 500, totalPages: 1 })
    if (p === '/api/trash' && req.method === 'GET') return json(200, trash)
    return json(404, { detail: 'not in fake cloud' })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, nodes:namespaces,close: () => server.close() })))
}

async function main(){
 if(!ROOT||!EXTEND)throw Error('Set GENESIS_DESKTOP and EXTEND_PKG to built isolated checkouts')
 const fixture=await require(path.join(ROOT,'scripts/lib/penzor-fixture.cjs')).preparePenzorFixture(ROOT,EXTEND);ROOT=fixture.app;EXTEND=fixture.extend
 fs.mkdirSync(RAW,{recursive:true});const cloud=await startFakeCloud(),home=fs.mkdtempSync(path.join(os.tmpdir(),'forsion-sync-ui-')),vault=path.join(home,'Vault'),workspace=path.join(home,'Workspace'),userData=path.join(home,'userdata')
 fs.mkdirSync(vault);fs.mkdirSync(workspace);fs.mkdirSync(path.join(home,'tangu/human'),{recursive:true})
 for(const name of ['A','B','C','D']){const dir=path.join(home,'tangu/agents',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'MEMORY.md'),`# ${name} memory`)}
 const token='header.'+Buffer.from(JSON.stringify({userId:'u1'})).toString('base64url')+'.signature'
 fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({cloudUrl:cloud.url,token}));installExtend(home)
 const stub=await startStubEngine({override:({path:p})=>p==='/agent/sync/content-owner'?{ok:true}:undefined})
 for(const d of [userData,userData+'-dev']){fs.mkdirSync(d,{recursive:true});for(const f of ['amadeus-config.json','amadeus-config.dev.json'])fs.writeFileSync(path.join(d,f),JSON.stringify({lastVault:vault,localVault:vault}));fs.writeFileSync(path.join(d,'tangu-desktop-config.json'),JSON.stringify({mode:'external',backendUrl:stub.url,token:'mock',cloudUrl:cloud.url}))}
 const app=await electron.launch({args:[`--user-data-dir=${userData}`,'--lang=zh-CN',ROOT],cwd:ROOT,env:{...process.env,TANGU_HOME:home,FORSION_WORKSPACE_DIR:workspace,TANGU_BACKEND_URL:stub.url,TANGU_HARNESS_QUIET:'1',PI_CU_SOCKET_PATH:path.join(home,'bridge.sock')},timeout:90000})
 const checks=[];const check=(name,v)=>{assert.ok(v,name);checks.push(name);console.log('PASS',name)}
 try{
  const win=await app.firstWindow({timeout:120000});win.on('pageerror',e=>console.log('pageerror',String(e)));await win.waitForSelector('#root');await skipOnboarding(win);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1512,950))
  await win.waitForTimeout(3000);const later=win.getByRole('button',{name:'稍后',exact:true});if(await later.count())await later.first().click()
  const btn=win.locator('.rb [aria-label="蓬洲云"]').first();if(!await btn.count())await win.locator('.rb-more[data-rb-more="top"]').click();await btn.click();await win.waitForSelector('.pz-total')
  // 2026-10-23 起同步页是「分类清单」(方案 2):第一次打开四类摆成所有设备共用,展开 Agents 逐个改「和谁共用」;规则表收进「···」→「高级」
  await win.locator('[data-row-key="sync-home"]').first().click();await win.waitForSelector('.pz-cs',{timeout:20000})
  check('category list loads through actual private IPC',await win.locator('.pz-cs .pz-sync-row [role=switch]').count()>=4)
  await win.locator('.pz-sync-row .pz-sync-main[aria-expanded]',{hasText:'Agents'}).click()
  const child=(n)=>win.locator(`.pz-cs-child[title="agents/${n}"]`)
  for(const [folder,name]of [['B','设备 E'],['C','设备 F']]){await child(folder).locator('.pz-scope').click();await win.locator('.pz-cs-menu').getByText(`只和 ${name} 共用`,{exact:true}).click()}
  await child('D').locator('[role=switch]').click()
  await win.waitForFunction(()=>/打开同步会上传/.test(document.querySelector('.pz-cs-bar')?.innerText||''),null,{timeout:20000})
  await win.screenshot({path:path.join(RAW,'rules-B-light.png')})
  check('per-agent destination overrides editable',(await child('B').innerText()).includes('设备 E')&&(await child('C').innerText()).includes('设备 F')&&(await child('D').locator('[role=switch]').getAttribute('aria-checked'))==='false')
  check('preview does not start content uploads',![...cloud.nodes.values()].flat().some(n=>n.path==='agents/A/MEMORY.md'))
  await win.locator('.pz-cs-bar').getByRole('button',{name:'开始同步',exact:true}).click()
  await win.waitForFunction(()=>/incoming\.bin/.test(document.querySelector('.pz-cs-act')?.innerText||''),null,{timeout:20000})
  await win.waitForTimeout(600);await win.screenshot({path:path.join(RAW,'transfers.png')})
  check('live download is visible with byte progress',/incoming\.bin[\s\S]*\/ 20 MB/.test(await win.locator('.pz-cs-act').innerText()))
  const samples=[];for(let attempt=0;attempt<200;attempt++){const r=await win.evaluate(()=>window.tangu.cloudInvoke('penzor:sync:get'));samples.push({running:r.value?.running,phase:r.value?.phase});if(r.ok&&!r.value.running&&fs.existsSync(path.join(workspace,'incoming.bin')))break;await win.waitForTimeout(100)}
  fs.writeFileSync(path.join(RAW,'sync-samples.json'),JSON.stringify(samples));
  check('A goes to default',cloud.nodes.get('default').some(n=>n.path==='agents/A/MEMORY.md'&&n.bytes))
  check('B goes to device E',cloud.nodes.get('device-E').some(n=>n.path==='agents/B/MEMORY.md'&&n.bytes))
  check('C goes to device F',cloud.nodes.get('device-F').some(n=>n.path==='agents/C/MEMORY.md'&&n.bytes))
  check('D stays local',![...cloud.nodes.values()].flat().some(n=>n.path==='agents/D/MEMORY.md'))
  check('download writes expected bytes',fs.readFileSync(path.join(workspace,'incoming.bin')).equals(Buffer.alloc(20*1024*1024,7)))
  await win.getByRole('button',{name:'最近记录'}).click();await win.waitForSelector('.pz-cs-log');await win.screenshot({path:path.join(RAW,'history.png')})
  await win.evaluate(()=>{document.documentElement.dataset.mode='dark';document.documentElement.classList.add('dark')});await win.screenshot({path:path.join(RAW,'rules-B-dark.png')})
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(480,400);w.setContentSize(620,850)});await win.waitForTimeout(300);check('narrow acceptance viewport is 620px',await win.evaluate(()=>innerWidth===620));await win.screenshot({path:path.join(RAW,'rules-B-narrow.png')})
  check('narrow sync controls stay inside viewport',await win.evaluate(()=>[...document.querySelectorAll('.pz-cs .pz-scope,.pz-cs [role=switch]')].every(x=>x.getBoundingClientRect().right<=innerWidth)))
  fs.writeFileSync(path.join(RAW,'result.json'),JSON.stringify({checks,context:'Built Electron + signed disposable Extend + real IPC/fs + local fake cloud + stub engine; no real account or installed app touched'},null,2))
 }catch(e){const win=app.windows()[0];await win?.screenshot({path:path.join(RAW,'failure.png')});console.error(await win?.evaluate(()=>document.body.innerText.slice(-5000)));throw e}
 finally{await app.windows()[0]?.evaluate(()=>window.tangu?.cloudInvoke?.('penzor:sync:pause',true)).catch(()=>{});await new Promise(r=>setTimeout(r,500));const closing=app.close().catch(()=>{});const timer=setTimeout(()=>{app.process()?.kill('SIGTERM')},5000);await closing;clearTimeout(timer);await stub.close();cloud.close();fs.rmSync(home,{recursive:true,force:true});fs.rmSync(fixture.root,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
