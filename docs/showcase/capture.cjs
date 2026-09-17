/** Real v2.11 Electron UI, isolated public fixtures; no model calls or user data.
 * Build desktop, then: node docs/showcase/capture.cjs [note|blocks|memory|team|muse]
 * Requires the repository's desktop/node_modules and a GUI session.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const {execFileSync} = require('node:child_process')
const REPO = path.resolve(__dirname, '../..')
const ROOT = path.join(REPO, 'desktop')
const { _electron: electron } = require(path.join(ROOT, 'node_modules/playwright-core'))
const { startStubEngine } = require(path.join(ROOT, 'scripts/lib/stub-engine.cjs'))
const OUT = process.env.SHOWCASE_OUT || path.join(os.tmpdir(), 'forsion-showcase-v211')
const scene = process.argv[2] || 'note'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-public-showcase-'))
const vault = path.join(home, '研究分享')
const at = '2026-09-17 10:00:00'
const stamp = Date.parse('2026-09-17T10:00:00Z')
const note = `# 把一次思考，变成下一次的起点

用一篇项目笔记，连接资料、判断与下一步。

> [!note] 研究分享 · 公开演示项目
> 目标：准备一场 15 分钟的分享，说明知识如何参与持续工作。

## 已有材料

- [[研究问题]] — 为什么存下的资料，下次还是用不上？
- [[分享提纲]] — 从记录、讨论到行动的三个场景
- **工作约定**：先给结论，再列来源；把待核实的内容单独标出来。

## 团队分工

| 成员 | 负责什么 | 交付物 |
| --- | --- | --- |
| Aria | 展开表达方向 | 两种分享开场 |
| Recita | 检查证据与假设 | 论证缺口与核查清单 |
| Arioso | 权衡与组织 | 分享提纲与下一步 |

## 下一步

- [x] 整理项目目标与参考资料
- [x] 明确团队成员的职责
- [ ] 审阅提纲，补齐来源
- [ ] 让 Muse 在分享前复查待确认项

`;
for (const d of [OUT,vault,path.join(home,'userData'),path.join(home,'userData-dev')]) fs.mkdirSync(d,{recursive:true})
fs.writeFileSync(path.join(vault,'研究分享.md'),note)
fs.writeFileSync(path.join(vault,'研究问题.md'),'# 研究问题\n\n如何让收集的资料接上下一次工作？\n\n观察：背景要重复交代，结论留在聊天，后续容易遗忘。\n')
fs.writeFileSync(path.join(vault,'分享提纲.md'),'# 分享提纲\n\n## 记录\n把材料连接起来。\n\n## 思考\n让不同角色检查判断。\n\n## 行动\n保存成果，安排后续复查。\n')
const people=[['xyra','Arioso','综合判断 · 组织提纲'],['aria','Aria','探索表达 · 展开可能'],['recita','Recita','核查证据 · 审视假设']]
const agents=people.map(([slug,name,description])=>({slug,name,description,createdBy:'user',avatar:'avatar.jpg',model:'m1',tools:[],systemPrompt:description,soul:description,libraryDir:path.join(home,'agents',slug,'Library')}))
for(const a of agents)fs.mkdirSync(a.libraryDir,{recursive:true})
const team={slug:'research-team',name:'研究分享 TEAM',description:'展开方向，检查依据，把结论带回项目。',avatar:'',lead:'xyra',members:people.map(([slug,,role])=>({slug,role})),doc:'# 共同目标\n\n完成一场有依据、可继续推进的研究分享。\n\n## 协作约定\n\n- 每项结论保留来源。\n- 分开事实、推断与待核实项。\n- 公开同步发现，将产物写回项目。',createdAt:at,libraryDir:path.join(home,'teams/research-team/Library')}
fs.mkdirSync(team.libraryDir,{recursive:true})
fs.writeFileSync(path.join(home,'teams/research-team/TEAM.md'),team.doc)
const base={summary:'',archived:false,model_id:'m1',created_at:at,updated_at:at,project_path:vault,project_name:'研究分享',projectless:false}
const config={groupChat:true,groupAgents:people.map(x=>x[0]),teamSlug:team.slug,teamDoc:team.doc,teamRoles:Object.fromEntries(team.members.map(m=>[m.slug,m.role])),execMode:'host',cwd:vault}
const main={...base,id:'showcase-team',title:'研究分享 · 分工与成果',agent_config:config}
const solo={...base,id:'showcase-memory',title:'偏好与项目背景',agent_config:{agentSlug:'xyra',execMode:'host',cwd:vault}}
const children=people.map(([slug,name])=>({...base,id:`showcase-${slug}`,title:`${name} · 研究分享`,agent_config:{agentSlug:slug,execMode:'host',cwd:vault,teamMember:{teamSessionId:main.id}}}))
const messages=[{id:'u1',role:'user',content:'请一起准备研究分享：Aria 展开表达方向，Recita 检查依据，Arioso 整理提纲。把待确认项与下一步留在项目里。',timestamp:stamp},
 {id:'a1',role:'model',agent_slug:'aria',content:'**🗣 Aria**\n\n建议从一个具体问题开始：**收藏了那么多资料，下一步呢？**\n\n沿着同一个项目，依次展示资料如何进入笔记、改变判断，再成为可继续使用的成果。',timestamp:stamp+1000},
 {id:'r1',role:'model',agent_slug:'recita',content:'**🗣 Recita**\n\n需要分开两个主张：**资料被保存**，以及**资料真的参与了工作**。\n\n建议保留文件变化作为证据；尚未核查的引用放进待确认清单。',timestamp:stamp+2000},
 {id:'s1',role:'model',agent_slug:'xyra',content:'**🗣 Arioso**\n\n提纲按“记录 → 思考 → 行动”组织。先审阅两个开场，再把选定方向和证据补回 [[分享提纲]]。',timestamp:stamp+3000}]
const childMessages=[{id:'c1',role:'user',content:'检查研究分享的论证与证据。',timestamp:stamp}, {id:'c2',role:'model',agent_slug:'recita',content:'## 先区分材料与判断\n\n**已知材料**\n- 项目目标：一场 15 分钟研究分享。\n- 开场方向：从收藏资料后的下一步说起。\n\n**需要补齐的证据**\n1. 展示笔记文件的实际变化。\n2. 打开记忆面板核对一条已确认偏好。\n3. 将待核实引用保留在项目清单。\n\n**建议的修改**\n把“AI 总能记住”改为“重要背景可以检查、修订，再用于后续工作”。',timestamp:stamp+1000}]
const facts=['做研究时，先给结论，再列来源；不确定的内容单独标出。','当前项目：准备 15 分钟研究分享，围绕记录、思考与行动组织提纲。','审阅后把提纲、依据和下一步写回项目笔记，保留来源链接。']
const memory={version:'7f0e215b-public-fixture',content:facts.map(x=>'- '+x).join('\n'),entries:facts.map((content,i)=>({id:`public-memory-${i+1}`,content,source:{kind:i===1?'manual':'explicit'},evidenceIds:[],createdAt:stamp,updatedAt:stamp})),tombstones:[],updatedAt:stamp}
const body='分享前还有两项值得复查：**来源是否支持结论**，以及**提纲是否说明下一步**。\n\n## 本次跟进\n\n| 项目 | 待检查内容 |\n| --- | --- |\n| 分享提纲 | 每个核心判断保留依据 |\n| 项目笔记 | 待确认项有明确负责人 |\n\n你可以交给我继续检查，也可以开新会话调整范围。\n\n```forsion-task\ntitle: 复查分享提纲的来源与待确认项\ntodo: public-followup\n---\n读取研究分享项目的笔记与提纲，列出缺少依据的判断和待确认项。保留已有内容，将复查结果补回项目。\n```'
const mails=[{id:'public-muse',title:'研究分享：还有两项待确认',body,sender_kind:'agent',sender_id:'muse',origin_broadcast_id:null,read_at:null,archived_at:null,created_at:at}, {id:'public-muse-2',title:'资料整理：下一次从这里继续',body:'已整理的项目材料可以从研究分享笔记进入。',sender_kind:'agent',sender_id:'muse',read_at:at,archived_at:null,created_at:'2026-09-16 16:00:00'}]
// Serve the shipped portraits through the same binary endpoint the app uses.
// Read the canonical source rather than copying artwork into the fixture.
const portraitSource = fs.readFileSync(path.join(REPO,'tangu-agent/src/agents/builtinAvatars.ts'),'utf8')
const portraits = Object.fromEntries(people.map(([slug]) => {
 const match = slug === 'xyra'
  ? fs.readFileSync(path.join(REPO,'tangu-agent/src/agents/defaultAvatar.ts'),'utf8').match(/DEFAULT_AGENT_AVATAR_B64\s*=\s*['"]([^'"]+)['"]/)
  : portraitSource.match(new RegExp(slug + ": '([^']+)'"))
 if(!match) throw Error('Missing built-in portrait: '+slug)
 return [slug, Buffer.from(match[1],'base64')]
}))
async function mainRun(){
 const requests=[]
 const stub=await startStubEngine({agents,sessions:[main,solo],messages,models:[{id:'m1',name:'公开演示 · 无模型调用',provider:'fixture',contextWindow:128000}],override:async({path:p,method,url,body:readBody})=>{
  requests.push(`${method} ${p}`)
  if(p==='/agent/sessions'&&method==='GET')return {sessions:url.searchParams.get('archived')==='true'||url.searchParams.get('archived')==='1'?[]:[main,solo]}
  if(p==='/agent/agents-meta')return {defaultSlug:'xyra',order:people.map(x=>x[0])}
  if(p===`/agent/teams/${team.slug}/session/open`)return {session:main,created:false}
  if(p==='/agent/teams')return {teams:[team]}
  if(p===`/agent/teams/${team.slug}`)return {team}
  if(p.endsWith('/memory/dream'))return {config:{enabled:false,modelId:'',timeoutMs:60000,maxOutputTokens:4096,intervalHours:6},status:{state:'idle',running:false},candidates:0}
  if(p.endsWith('/memory/revisions'))return {revisions:[]}
  if(p.endsWith('/memory')&&method==='GET')return memory
  if(p==='/agent/runs'&&method==='GET')return {runs:[]}
  if(p.endsWith('/background'))return {background:p.includes(main.id)?children.map(c=>({sessionId:c.id,kind:'teamwork',title:c.title,agentSlug:c.agent_config.agentSlug,runId:`public-${c.id}`,runStatus:'completed'})):[]}
  if(p.startsWith('/agent/sessions/')){const id=p.split('/')[3],s=[main,solo,...children].find(s=>s.id===id)||main;if(p.endsWith('/detail'))return {session:s};if(p.endsWith('/config'))return {agent_config:s.agent_config};if(p.endsWith('/messages'))return {messages:children.some(c=>c.id===id)?childMessages:messages}}
  if(p==='/agent/sync/status')return {available:false,running:false,lastAt:null,lastResult:null}
  if(p==='/agent/inbox'){const filter=url.searchParams.get('filter');const rows=filter==='archived'?[]:filter==='unread'?mails.filter(m=>!m.read_at):mails;return {messages:rows,total:rows.length}}
  if(p==='/agent/inbox/unread-count')return {count:1,latestId:'public-muse'}
  if(p==='/agent/inbox/pull')return {pulled:false,added:0}
  if(p.startsWith('/agent/inbox/')&&method==='PATCH'){const patch=await readBody();const mail=mails.find(m=>m.id===p.split('/').pop());if(mail&&patch.read)mail.read_at=at;return {ok:true}}
  if(p==='/agent/special/muse/todos/public-followup')return {todo:{id:'public-followup',title:'复查分享提纲的来源与待确认项',status:'pending'}}
  if(p==='/agent/special/muse/todos')return {todos:[]}
  if(p==='/agent/special/approvals')return {approvals:[]}
  if(p==='/agent/special/config')return {config:{historian:{enabled:false},muse:{enabled:false}}}
 }})
 const avatarRequests = new Set()
 const gateway = http.createServer((req,res)=>{
  const slug = /^\/agent\/agents\/([^/]+)\/avatar$/.exec(new URL(req.url,'http://local').pathname)?.[1]
  if(req.method==='GET'&&portraits[slug]) {
   avatarRequests.add(slug);res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(portraits[slug]);return
  }
  const forward=http.request(new URL(req.url,stub.url),{method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res)})
  forward.on('error',()=>{res.writeHead(502);res.end()});req.pipe(forward)
 })
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve))
 const backendUrl='http://127.0.0.1:'+gateway.address().port
 for(const d of ['userData','userData-dev']){fs.writeFileSync(path.join(home,d,'tangu-desktop-config.json'),JSON.stringify({mode:'external',backendUrl,token:'public-showcase',defaultWorkspaceDir:vault}));fs.writeFileSync(path.join(home,d,'amadeus-config.dev.json'),JSON.stringify({localVault:vault,lastVault:vault}))}
 let app,win
 try{
  app=await electron.launch({args:[`--user-data-dir=${path.join(home,'userData')}`,'--lang=zh-CN',ROOT],cwd:ROOT,env:{...process.env,TANGU_HOME:home,TANGU_BACKEND_URL:backendUrl},timeout:45000})
  win=await app.firstWindow();win.setDefaultTimeout(18000);await win.setViewportSize({width:1600,height:1000});await win.waitForSelector('#root');await win.waitForTimeout(2000)
  for(const label of ['跳过引导','Skip']){const b=win.getByText(label,{exact:true}).first();if(await b.isVisible().catch(()=>false)){await b.click();break}}
  await win.waitForSelector('.dv-groupview')
  await win.evaluate(()=>{localStorage.setItem('forsion_default_space','tangu');localStorage.setItem('forsion_theme_pref','light');localStorage.setItem('tangu_locale','zh');localStorage.setItem('forsion.ntf.prefs',JSON.stringify({enabled:true,osEnabled:false,events:{'sync.error':false}}));localStorage.setItem('forsion.sb.prefs',JSON.stringify({enabled:true,hidden:['sync.status'],order:[]}))})
  await win.reload();await win.waitForSelector('.dv-groupview');await win.waitForTimeout(1500)
  const space=async(name)=>{const button=win.locator('button.rb-space').filter({hasText:new RegExp(name)}).first();if(await button.isVisible().catch(()=>false))await button.click();else {const hit=await win.evaluate(n=>{const b=[...document.querySelectorAll('button.rb-space')].find(x=>new RegExp(n,'i').test(x.title||x.textContent));if(b)b.click();return !!b},name);if(!hit)throw Error('Space missing '+name)}await win.waitForTimeout(1200)}
  const assertImages=async()=>{
   await win.waitForFunction(()=>[...document.images].filter(i=>i.getBoundingClientRect().width>0).every(i=>i.complete&&i.naturalWidth>0))
   for(const [slug] of people)if(!avatarRequests.has(slug))throw Error('Portrait not requested: '+slug)
   if(scene==='memory')await win.locator('[data-agent-profile="xyra"] .agent-portrait img').waitFor()
   if(scene==='team')for(const [slug] of people)await win.locator(`[data-team-desk="status"] [data-slug="${slug}"] img`).waitFor({state:"attached"})
  }
  if(scene==='note'||scene==='blocks'){
   await space('Note');await win.locator('.t2s-srow').filter({hasText:'研究分享'}).first().click();await win.locator('.unified-body .ProseMirror h1').first().waitFor(); if(scene==='blocks'){const lead=win.locator('.unified-body .ProseMirror p').filter({hasText:'用一篇项目笔记'}).first();await lead.click();await win.keyboard.press('End');await win.keyboard.press('Enter');await win.waitForTimeout(700);await win.keyboard.type('/',{delay:80});await win.waitForTimeout(300);await win.keyboard.type('h',{delay:80});await win.locator('.slash-menu').waitFor()}
  }else if(scene==='memory'){
   await space('Agents');await win.locator('[data-agents-space]').waitFor();await win.locator('.agents-roster-item').filter({hasText:'Arioso'}).first().click();await win.locator('[data-agent-profile="xyra"]').getByRole('tab',{name:'记忆',exact:true}).click();await win.locator('[data-memory-entry-id]').first().waitFor()
  }else if(scene==='team'){
   await win.locator('.t2s-srow, .t2o-row').filter({hasText:team.name}).first().click();await win.locator('[data-team-desk="status"]').waitFor();await win.waitForTimeout(600);await assertImages();await win.screenshot({path:path.join(OUT,'team-overview.png'),animations:'disabled',scale:'css'});await win.locator('[data-team-desk="status"] [data-slug="recita"]').click();await win.locator('.child-chat-panel').waitFor()
  }else if(scene==='muse'){
   await space('收件箱|Inbox');await win.locator('.t2sw-plug-list .t2s-srow').filter({hasText:mails[0].title}).click();await win.getByRole('button',{name:'交给 Muse 执行',exact:true}).waitFor();await win.getByText('查看任务书',{exact:true}).click()
  }else throw Error('Unknown scene '+scene)
  await win.waitForTimeout(1000);if(await win.locator('.ntf-error').count())throw Error('Unexpected UI error: '+await win.locator('.ntf-error').allTextContents());await win.mouse.move(1580,980)
  await assertImages()
  await win.screenshot({path:path.join(OUT,scene+'.png'),animations:'disabled',scale:'css'})
  fs.writeFileSync(path.join(OUT,scene+'.json'),JSON.stringify({scene,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:REPO,encoding:'utf8'}).trim(),version:require(path.join(ROOT,'package.json')).version,home,requests,avatarRequests:[...avatarRequests],liveModelCalls:0,publicFixtures:true,viewport:await win.evaluate(()=>({width:innerWidth,height:innerHeight})),bodyText:await win.locator('body').innerText()},null,2))
  console.log(JSON.stringify({ok:true,scene,out:OUT,home}))
 }catch(e){if(win){await win.screenshot({path:path.join(OUT,scene+'-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(OUT,scene+'-failure.txt'),await win.locator('body').innerText().catch(()=>''))}console.error(e);process.exitCode=1}
 finally{if(app)await app.close().catch(()=>{});await new Promise(resolve=>gateway.close(resolve));await stub.close()}
}
mainRun().catch(e=>{console.error(e);process.exitCode=1})
