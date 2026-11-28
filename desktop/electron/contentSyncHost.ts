import { readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,realpathSync,openSync,closeSync,unlinkSync,lstatSync,readdirSync,constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename,dirname,join,parse as parsePath,relative,resolve as resolvePath,sep } from 'node:path'
import { diff3Merge } from 'node-diff3'
import { withDbLock } from './amadeus/fs/dbLock'
import { withTextWriteLock } from './amadeus/fs/vaultHandlers'
import { forsionHomeDir } from './forsionHome'
import { mergeDbFile } from '../../tangu-agent/src/contracts/dbRowMerge'
import { mergeText3With,splitLogBlocks,mergeBlocks,mergeLogHeaders } from '../../tangu-agent/src/contracts/contentMerge'
import { isMemoryDetailPath } from '../../tangu-agent/src/contracts/memoryLayers'
import { contentOwnsOf,withContentOwns,type ContentOwns } from '../../tangu-agent/src/contracts/contentSyncOwner'
import type { SyncOwnershipV2 } from './amadeus/settings'
import { agentSlugLocalOnly,dropForgottenFacts,mergeAgentSyncContent,mergeTombstoneLists,parseAgentContentPath,parseTombstones,sameTombstones,serializeTombstones,validAgentSyncSlug,MEMORY_TOMBSTONES,type WireTombstone } from '../../tangu-agent/src/contracts/agentSyncRules'
const mergeText3=(ours:string,base:string,theirs:string)=>mergeText3With(ours,base,theirs,diff3Merge)
const sha256=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')

/** Same account key and private state file as Extend; no token is persisted here. */
export function contentSyncOwned(account:string|null):boolean {
  if(!account)return false
  const name=createHash('sha256').update(account).digest('hex')+'.json'
  try{return JSON.parse(readFileSync(join(forsionHomeDir(),'content-sync',name),'utf8')).owned===true}catch{return false}
}
/** 同上,严格版:没有文件 = false;读不了 / 坏了就抛(ownership.get 用:读失败 ≠ 没认领)。 */
export function contentSyncOwnedStrict(account:string|null):boolean {
  if(!account)return false
  const name=createHash('sha256').update(account).digest('hex')+'.json'
  let raw:string
  try{raw=readFileSync(join(forsionHomeDir(),'content-sync',name),'utf8')}catch(e:any){if(e?.code==='ENOENT')return false;throw e}
  return JSON.parse(raw)?.owned===true
}

/** 本机库根的比较口径(契约实现期修订 H-1 第 5 条):realpath.native(mac 上纠正大小写、解开符号链接),不存在就 resolve,去尾斜杠。 */
export function canonRoot(p:string):string{
  let r:string
  try{r=realpathSync.native(p)}catch{r=resolvePath(p)}
  return r!==parsePath(r).root?r.replace(/[\\/]+$/,''):r
}
/** 这个账号的按根认领读成什么:v2 = 有 syncOwnershipV2;none = 没有(走老的 .owned);unknown = 配置读不了。 */
export type OwnershipRead={kind:'v2';value:SyncOwnershipV2}|{kind:'none'}|{kind:'unknown'}
/** 宿主递给 Extend 旧在线引擎的 readConfig 遮罩(amadeus/ipc.ts)。磁盘上的配置一条不动,只改这份读数。
 *  - 读不了(unknown)或老的全局认领(.owned)= 整份遮掉:镜像停、条目同步一个不起(和第 2 步之前新同步开着时一样);
 *  - 有 syncOwnershipV2:只滤掉接手的那几个根,镜像照 mirror(keep = 照用户的开关);
 *  - 都没有:原样。 */
export function maskAmadeusConfig<T extends {cloudSync?:{enabled?:boolean};entrySync?:Array<{vaultRoot:string}>}>(cfg:T,own:OwnershipRead,legacyOwned:boolean):T{
  if(own.kind==='unknown'||legacyOwned)return {...cfg,cloudSync:{...cfg.cloudSync,enabled:false},entrySync:[]}
  if(own.kind==='none')return cfg
  const roots=new Set(own.value.entryRoots.map(canonRoot))
  return {...cfg,...(own.value.mirror==='off'?{cloudSync:{...cfg.cloudSync,enabled:false}}:{}),entrySync:(cfg.entrySync??[]).filter(v=>!roots.has(canonRoot(v.vaultRoot)))}
}
/** 宿主对新同步(Forsion Extend contentSync)的能力声明:这些可选族 merge() 会按它们自己的规则合并(契约 agentSyncRules)。
 *  'settings' = 随账号走的设置文件 human/Settings/<name>.db 走 mergeSettingsDb(恒有结果、不出冲突副本、本机独有的行不丢)。
 *  Extend 走 npm 单独更新、会跑在老桌面上:只有看到这里列了某个族才碰它;老宿主的 contentSync 里没有这个成员 = 没声明 = 那个族整个不动。
 *  只增不改:哪天规则换了不兼容的写法,换一个新名字,别改旧名字的意思。 */
export const CONTENT_MERGE_FAMILIES:readonly string[]=Object.freeze(['settings'])
/** 新同步两边都改了:agents/、human/ 走和旧同步同一份规则(contracts/agentSyncRules.ts);memoryBase 给了的话,
 *  Agent 的记忆(和记忆详情)合完再按本机墓碑滤一遍(第一次见面取并集时,别把这台忘掉的事实从对方那份带回来、再传上云)。 */
export function mergeSyncContent(path:string,ours:string,base:string|null,theirs:string,memoryBase?:string):{content:string;conflict:boolean}|null {
  const agent=parseAgentContentPath(path)
  if(agent){
    // 记忆仓库提交到一半:盘上那份 MEMORY.md 是旧的,照它合出来的会先传上云(落盘那道检查在上传之后)。这一轮先不合,调用方记错、下一轮再来
    if(memoryBase&&agent.rel==='MEMORY.md'&&(agent.area==='human'||agent.slug&&validAgentSyncSlug(agent.slug)))refuseMidCommit(agent.area==='human'?join(memoryBase,'human'):join(memoryBase,'agents',agent.slug!))
    // 画像(human/SOUL.md)和记忆详情(Library/memory/*.md)按条合 —— 合并器在契约里,和引擎的旧同步同一份(11-09 记忆分层)
    const merged=mergeAgentSyncContent(path,ours,base,theirs,{diff3:diff3Merge})
    if(!merged||!memoryBase||agent.area!=='agents'||!agent.slug||!(agent.rel==='MEMORY.md'||isMemoryDetailPath(agent.rel))||!validAgentSyncSlug(agent.slug))return merged
    const forgotten=localTombstones(join(memoryBase,'agents',agent.slug))
    return forgotten.length?{...merged,content:dropForgottenFacts(merged.content,forgotten,sha256)}:merged
  }
  if(path.toLowerCase().endsWith('.db'))return mergeDbFile(ours,base,theirs,{fieldColumns:/(^|\/)WidgetData\/[^/]+\/data\.db$/.test(path)})
  if(/\/LOG\/\d{4}-\d{2}-\d{2}\.md$/.test(path)){
    const a=splitLogBlocks(ours),b=splitLogBlocks(theirs),blocks=mergeBlocks(a.blocks,b.blocks).merged,header=mergeLogHeaders(a.header,b.header).header
    return {content:header.trimEnd()+'\n\n'+blocks.map(x=>x+'\n').join('\n'),conflict:false}
  }
  if(!/\.(md|txt|toml|json|yaml|yml|csv|html|xml|js|ts|py)$/i.test(path)||base===null)return null
  const content=mergeText3(ours,base,theirs);return content===null?null:{content,conflict:false}
}

export async function withContentWriteLock(abs:string|string[],memoryBase:string,commit:()=>void):Promise<void>{
  const paths=[...new Set(typeof abs==='string'?[abs]:abs)].sort()
  const bases=[...new Set(paths.flatMap(p=>{const rel=relative(memoryBase,p).split(sep),base=rel[0]==='human'?join(memoryBase,'human'):rel[0]==='agents'&&rel[1]?join(memoryBase,'agents',rel[1]):null;return base&&existsSync(base)?[base]:[]}))].sort()
  // 记忆仓库提交到一半断了(状态写了、MEMORY.md 还没换):这时盘上那份是旧的,照它合出来的写下去,引擎下次读会判成要人工恢复。
  // 先不写,等引擎自己补完那半(它下次读记忆时就补),下一轮重读重合
  const memoryFiles=paths.filter(p=>basename(p)==='MEMORY.md'&&bases.includes(dirname(p)))
  const memory=()=>bases.reduceRight<()=>void>((next,base)=>()=>withContentMemoryLock(base,next),()=>{for(const p of memoryFiles)refuseMidCommit(dirname(p));commit()})()
  const databases=paths.filter(p=>/\.db$/i.test(p)&&!bases.some(b=>p.startsWith(b+sep)))
  const db=()=>databases.reduceRight<()=>Promise<void>>((next,p)=>()=>withDbLock(p,next),async()=>memory())()
  await withTextWriteLock(paths,db)
}

/** External-engine mode has no running local engine. Persist the same ownership
 * flag before it can later start; never send a local ownership command remotely. */
const ownerScope=(identity:string):string=>{
  const split=identity.lastIndexOf('::');if(split<0)throw Error('Invalid cloud identity')
  return createHash('sha256').update(JSON.stringify([identity.slice(0,split),identity.slice(split+2)])).digest('hex')
}
/** owned = true / false:老 claim,两位一起(第 2 步之前的写法);{human?, agents?}:只改给的那位(契约 contracts/contentSyncOwner.ts)。 */
export function setOfflineContentOwner(memoryBase:string,identity:string,owned:boolean|Partial<ContentOwns>):void{
  const scope=ownerScope(identity),dir=join(memoryBase,'agents'),file=join(dir,'.cloudsync-default.json')
  mkdirSync(dir,{recursive:true});withContentMemoryLock(dir,()=>{
    let state:{accounts:Record<string,any>}={accounts:{}}
    try{state=JSON.parse(readFileSync(file,'utf8'))}catch(e:any){if(e.code!=='ENOENT')throw e}
    if(!state||typeof state!=='object'||!state.accounts||typeof state.accounts!=='object')throw Error('content sync owner file is malformed')
    state.accounts[scope]=withContentOwns(state.accounts[scope],typeof owned==='boolean'?{human:owned,agents:owned}:owned)
    const temp=file+`.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,JSON.stringify(state),{mode:0o600});renameSync(temp,file)
  })
}
/** external 引擎模式下读回两位:没有文件 = 都归引擎;读不了 / 坏了就抛。 */
export function readOfflineContentOwns(memoryBase:string,identity:string):ContentOwns{
  const scope=ownerScope(identity),file=join(memoryBase,'agents','.cloudsync-default.json')
  let raw:string;try{raw=readFileSync(file,'utf8')}catch(e:any){if(e?.code==='ENOENT')return {human:false,agents:false};throw e}
  const state=JSON.parse(raw);if(!state||typeof state!=='object'||(state.accounts!==undefined&&(typeof state.accounts!=='object'||state.accounts===null)))throw Error('content sync owner file is malformed')
  return contentOwnsOf(state.accounts?.[scope])
}

interface ContentSyncOwnershipHost {
  accountId(): string | null
  ensureBackend(): Promise<void>
  backendStatus(): { state: string; url: string | null }
  engineToken(): string
  loadConfig(): Promise<{ mode: string }>
  dataDir(): string
  stopSync(): Promise<void> | undefined
  restartSync(): Promise<void> | undefined
}

export function contentSyncOwnership(host: ContentSyncOwnershipHost) {
  function assertAccount(identity: string | null): asserts identity is string {
    if (!identity || host.accountId() !== identity) throw Error('account_changed')
  }

  function writeManagedOwner(url: string, owned: boolean, identity: string): Promise<Response> {
    assertAccount(identity)
    return fetch(url.replace(/\/+$/, '') + '/agent/sync/content-owner', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${host.engineToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: owned, expectedAccount: identity }),
      signal: AbortSignal.timeout(15000),
    })
  }

  return {
    async claim(owned: boolean, identity = host.accountId()) {
      assertAccount(identity)
      await host.ensureBackend()
      assertAccount(identity)
      const status = host.backendStatus()
      if (status.state !== 'ready' || !status.url) {
        const config = await host.loadConfig()
        assertAccount(identity)
        if (config.mode !== 'external') throw Error('Local engine unavailable')
        setOfflineContentOwner(host.dataDir(), identity, owned)
      } else {
        const response = await writeManagedOwner(status.url, owned, identity)
        assertAccount(identity)
        if (!response.ok) throw Error(`Content sync ownership failed (${response.status})`)
      }
      if (owned) await host.stopSync()
      else await host.restartSync()
      assertAccount(identity)
    },
    async changed(identity = host.accountId()) {
      assertAccount(identity)
      const status = host.backendStatus()
      if (status.state !== 'ready' || !status.url) return
      const response = await writeManagedOwner(status.url, true, identity)
      assertAccount(identity)
      if (!response.ok) throw Error('Content sync refresh failed')
    },
  }
}

/** 契约 §3.7 的按根认领(新 Extend 用,替代全局的 claim / changed)。宿主侧落盘在 amadeus-config 账号下的 syncOwnershipV2。 */
export interface SyncOwnershipHost extends ContentSyncOwnershipHost {
  readV2(account:string):Promise<SyncOwnershipV2|null>
  writeV2(account:string,next:SyncOwnershipV2|null):Promise<void>
  /** 这个账号磁盘上的条目同步根(不遮罩)。 */
  entryRoots(account:string):Promise<string[]>
  /** 老的全局认领(新同步状态文件的 .owned),严格读。 */
  legacyOwned(account:string):boolean
  log?(m:string):void
}

const validOwnership=(o:unknown):o is SyncOwnershipV2=>{
  const v=o as SyncOwnershipV2
  return !!v&&typeof v==='object'&&Array.isArray(v.entryRoots)&&v.entryRoots.every(r=>typeof r==='string'&&r.length>0)
    &&(v.mirror==='keep'||v.mirror==='off')&&(v.human==='engine'||v.human==='content')
}
const normalizeOwnership=(o:SyncOwnershipV2):SyncOwnershipV2=>({entryRoots:[...new Set(o.entryRoots.map(canonRoot))].sort(),mirror:o.mirror,human:o.human})

export function contentSyncOwnershipV2(host:SyncOwnershipHost){
  function assertAccount(identity:string|null|undefined):asserts identity is string{if(!identity||host.accountId()!==identity)throw Error('account_changed')}
  const ownerUrl=(url:string)=>url.replace(/\/+$/,'')+'/agent/sync/content-owner'
  const headers=()=>({Authorization:`Bearer ${host.engineToken()}`,'Content-Type':'application/json'})

  /** 引擎里两位的当前值。托管引擎走 GET(老引擎没有这个口 → 抛,不猜);external 模式直接读文件。 */
  async function engineOwns(identity:string):Promise<ContentOwns>{
    const status=host.backendStatus()
    if(status.state==='ready'&&status.url){
      const r=await fetch(ownerUrl(status.url)+'?expectedAccount='+encodeURIComponent(identity),{headers:headers(),signal:AbortSignal.timeout(15000)})
      assertAccount(identity)
      if(r.status===404)throw Error('engine_owner_unverifiable')
      if(!r.ok)throw Error(`Content sync ownership read failed (${r.status})`)
      const j=await r.json() as Partial<ContentOwns>
      if(typeof j?.human!=='boolean'||typeof j?.agents!=='boolean')throw Error('engine_owner_unverifiable')
      return {human:j.human,agents:j.agents}
    }
    const config=await host.loadConfig();assertAccount(identity)
    if(config.mode!=='external')throw Error('Local engine unavailable')
    return readOfflineContentOwns(host.dataDir(),identity)
  }
  /** 只改 human 那一位,改完读回核对;读回对不上就抛。 */
  async function setEngineHuman(identity:string,human:boolean):Promise<void>{
    await host.ensureBackend();assertAccount(identity)
    const status=host.backendStatus()
    if(status.state==='ready'&&status.url){
      const r=await fetch(ownerUrl(status.url),{method:'PUT',headers:headers(),body:JSON.stringify({human,expectedAccount:identity}),signal:AbortSignal.timeout(15000)})
      assertAccount(identity)
      if(r.status===404)throw Error('engine_owner_unverifiable')
      if(!r.ok)throw Error(`Content sync ownership failed (${r.status})`)
    }else{
      const config=await host.loadConfig();assertAccount(identity)
      if(config.mode!=='external')throw Error('Local engine unavailable')
      setOfflineContentOwner(host.dataDir(),identity,{human})
    }
    if((await engineOwns(identity)).human!==human)throw Error('engine_owner_mismatch')
  }

  async function get(identity:string|null|undefined=host.accountId()):Promise<SyncOwnershipV2>{
    assertAccount(identity)
    const v2=await host.readV2(identity);assertAccount(identity)
    if(v2)return normalizeOwnership(v2)
    if(host.legacyOwned(identity))return normalizeOwnership({entryRoots:await host.entryRoots(identity),mirror:'off',human:'content'})
    return {entryRoots:[],mirror:'keep',human:'engine'}
  }

  return {
    get,
    /** 先撤掉失去所有权的一方,再给得到的一方;中途失败回滚已做的那半再抛,不留半截(契约 §3.7、实现期修订 H-1 第 5 条)。
     *  human 没变就不碰引擎(条目同步接手发生在启动那一刻,不能依赖引擎已经起来)。最后让旧引擎按新遮罩重建。 */
    async set(o:SyncOwnershipV2,identity:string|null|undefined=host.accountId()):Promise<void>{
      if(!validOwnership(o))throw Error('invalid ownership')
      assertAccount(identity)
      const next=normalizeOwnership(o)
      const prevV2=await host.readV2(identity);assertAccount(identity)
      const cur=await get(identity)
      if(next.human!==cur.human){
        if(next.human==='content'){
          await setEngineHuman(identity,true)
          try{await host.writeV2(identity,next)}
          catch(e){await setEngineHuman(identity,false).catch(err=>host.log?.(`[content-sync] ownership rollback failed: ${err instanceof Error?err.message:err}`));throw e}
        }else{
          await host.writeV2(identity,next)
          try{await setEngineHuman(identity,false)}
          catch(e){await host.writeV2(identity,prevV2).catch(err=>host.log?.(`[content-sync] ownership rollback failed: ${err instanceof Error?err.message:err}`));throw e}
        }
      }else await host.writeV2(identity,next)
      assertAccount(identity)
      await host.restartSync()
      assertAccount(identity)
    },
    /** 新同步动过盘:只通知,不写 owner(老 changed() 每次都把 owner 写成 true)。老引擎没有这个口 → 不报错。 */
    async touched(identity:string|null|undefined=host.accountId()):Promise<void>{
      assertAccount(identity)
      const status=host.backendStatus()
      if(status.state!=='ready'||!status.url)return
      const r=await fetch(status.url.replace(/\/+$/,'')+'/agent/sync/content-touched',{method:'POST',headers:headers(),body:JSON.stringify({expectedAccount:identity}),signal:AbortSignal.timeout(15000)})
      assertAccount(identity)
      if(r.status===404)return
      if(!r.ok)throw Error(`Content sync refresh failed (${r.status})`)
    },
  }
}

/** Mirrors the engine's .memory.lock protocol, like the existing dbLock host
 * adapter. Keep filename, exclusive/no-follow flags and fail-on-busy semantics aligned. */
function atomicWrite(abs:string,text:string):void{
  if(existsSync(abs)&&!lstatSync(abs).isFile())throw Error('Not a regular file')
  const temp=abs+`.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,text,{mode:0o600});renameSync(temp,abs)
}
function withContentMemoryLock<T>(base:string,fn:()=>T):T{
  mkdirSync(base,{recursive:true});const root=realpathSync(base),lock=join(root,'.memory.lock');let fd:number
  try{fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)}
  catch(e:any){if(e.code==='EEXIST')throw Error('Memory directory is locked by another writer');throw e}
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:Date.now()}));return fn()}
  finally{closeSync(fd);unlinkSync(lock)}
}

function refuseMidCommit(dir:string):void{
  let raw:string;try{raw=readFileSync(join(dir,'.memory-state.json'),'utf8')}catch(e:any){if(e?.code==='ENOENT')return;throw e}
  let pending:unknown;try{pending=JSON.parse(raw)?.projectionPending}catch{throw Error('Memory state unreadable; retry after the engine opens it')}
  if(pending!==false)throw Error('Memory is finishing a commit; retry next round')
}
/** 记忆仓库(.memory-state.json)里的墓碑:没有仓库 = [];读不了 / 坏了 = null(不知道)。 */
function stateTombstones(dir:string):WireTombstone[]|null{
  let raw:string;try{raw=readFileSync(join(dir,'.memory-state.json'),'utf8')}catch(e:any){return e?.code==='ENOENT'?[]:null}
  try{const t=JSON.parse(raw)?.tombstones;return Array.isArray(t)?parseTombstones(JSON.stringify({schemaVersion:1,tombstones:t})):null}catch{return null}
}
/** 盘上的投影 .memory-tombstones.json:没有 = [];读不了 / 坏了 = null。 */
function diskTombstones(dir:string):WireTombstone[]|null{
  let raw:string;try{raw=readFileSync(join(dir,MEMORY_TOMBSTONES),'utf8')}catch(e:any){return e?.code==='ENOENT'?[]:null}
  return parseTombstones(raw)
}
/** 这台已知的墓碑:仓库里的并上盘上的(同一条取较晚的那次、恢复时间取最晚,和引擎同一个口径)。读不到的那份当没有:只用来多滤几行。 */
function localTombstones(dir:string):WireTombstone[]{
  return mergeTombstoneLists(stateTombstones(dir)??[],diskTombstones(dir)??[])
}

/**
 * 新同步(Forsion Extend contentSync)对 Agent 文件夹多要的两件事(2026-11-05,方案 ⑤ 第 1–3 步)。老 Extend 不认这些成员。
 * - prepare:每轮扫描前,把每个 Agent 记忆仓库里的墓碑并进 agents/<slug>/.memory-tombstones.json(和旧同步上传的字节一样),
 *   新同步才看得见、传得上去。盘上已有的(别的设备传下来的)由引擎的记忆仓库下次读时并进去,这里不碰仓库、不拿记忆锁
 *   (引擎的 remember 撞上锁直接报错,不重试)。MEMORY.md 本身照常经 withContentWriteLock 落盘,引擎按外部修改收下、按墓碑滤。
 * - baseline:第一次接手账号时,旧同步(引擎 agentFileSync)记下的影子 .cloudsync-<账号>.json:本机没改过就直接拉云端,可合并文件拿它的原文当基线。
 * 宿主只引契约目录(check:tanguboundary):记忆仓库的文件格式在这里只读,写只写投影那一个文件。
 */
export interface AgentFileBaseline { seq:number; hash:string; base?:string; pending:boolean }
export function agentContentHooks(memoryBase:string,identity:()=>string|null){
  const agentsRoot=join(memoryBase,'agents')
  /** 要写的投影;不用写 / 拿不准(读不了、坏了)= null。盘上那份已经包含仓库里的全部(语义上)就不写,省得每轮重传。 */
  const projection=(dir:string):string|null=>{
    const state=stateTombstones(dir),disk=diskTombstones(dir)
    if(!state||!disk)return null
    const merged=mergeTombstoneLists(state,disk)
    return merged.length&&!sameTombstones(merged,disk)?serializeTombstones(merged):null
  }
  return {
    async prepare():Promise<void>{
      let names:string[]=[];try{names=readdirSync(agentsRoot)}catch{return}
      for(const slug of names){
        if(!validAgentSyncSlug(slug)||agentSlugLocalOnly(slug))continue
        const dir=join(agentsRoot,slug),abs=join(dir,MEMORY_TOMBSTONES)
        try{
          if(!lstatSync(dir).isDirectory()||projection(dir)===null)continue
          await withTextWriteLock(abs,async()=>{const want=projection(dir);if(want!==null)atomicWrite(abs,want)}) // 和新同步落这个文件同一把锁
        }catch(e){console.warn('[content-sync] memory tombstones not projected:',slug,e instanceof Error?e.message:e)}
      }
    },
    async baseline(path:string):Promise<AgentFileBaseline|null>{
      const id=identity(),split=id?.lastIndexOf('::')??-1;if(!id||split<0)return null
      const scope=sha256(JSON.stringify([id.slice(0,split),id.slice(split+2)]))
      const at=parseAgentContentPath(path);if(!at||!at.rel)return null
      const dir=at.area==='human'?join(memoryBase,'human'):at.slug&&validAgentSyncSlug(at.slug)?join(agentsRoot,at.slug):null
      if(!dir)return null
      let raw:string;try{const file=join(dir,`.cloudsync-${scope}.json`);if(!lstatSync(file).isFile())return null;raw=readFileSync(file,'utf8')}catch{return null}
      let entry:any;try{entry=JSON.parse(raw)?.files?.[at.rel]}catch{return null}
      if(!entry||!Number.isSafeInteger(entry.seq)||entry.seq<1||typeof entry.hash!=='string'||!/^[a-f0-9]{64}$/.test(entry.hash))return null
      const base=typeof entry.base==='string'&&sha256(Buffer.from(entry.base))===entry.hash?entry.base:undefined
      return {seq:entry.seq,hash:entry.hash,...(base!==undefined?{base}:{}),pending:entry.pending!=null}
    },
  }
}
