import { readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,realpathSync,openSync,closeSync,unlinkSync,lstatSync,readdirSync,constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename,dirname,join,relative,sep } from 'node:path'
import { diff3Merge } from 'node-diff3'
import { withDbLock } from './amadeus/fs/dbLock'
import { withTextWriteLock } from './amadeus/fs/vaultHandlers'
import { forsionHomeDir } from './forsionHome'
import { mergeDbFile } from '../../tangu-agent/src/contracts/dbRowMerge'
import { mergeText3With,splitLogBlocks,mergeBlocks,mergeLogHeaders } from '../../tangu-agent/src/contracts/contentMerge'
import { agentSlugLocalOnly,dropForgottenFacts,mergeAgentSyncContent,mergeTombstoneLists,parseAgentContentPath,parseTombstones,sameTombstones,serializeTombstones,validAgentSyncSlug,MEMORY_TOMBSTONES,type WireTombstone } from '../../tangu-agent/src/contracts/agentSyncRules'
const mergeText3=(ours:string,base:string,theirs:string)=>mergeText3With(ours,base,theirs,diff3Merge)
const sha256=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex')

/** Same account key and private state file as Extend; no token is persisted here. */
export function contentSyncOwned(account:string|null):boolean {
  if(!account)return false
  const name=createHash('sha256').update(account).digest('hex')+'.json'
  try{return JSON.parse(readFileSync(join(forsionHomeDir(),'content-sync',name),'utf8')).owned===true}catch{return false}
}
/** 新同步两边都改了:agents/、human/ 走和旧同步同一份规则(contracts/agentSyncRules.ts);memoryBase 给了的话,
 *  Agent 的记忆合完再按本机墓碑滤一遍(第一次见面取并集时,别把这台忘掉的事实从对方那份带回来、再传上云)。 */
export function mergeSyncContent(path:string,ours:string,base:string|null,theirs:string,memoryBase?:string):{content:string;conflict:boolean}|null {
  const agent=parseAgentContentPath(path)
  if(agent){
    // 记忆仓库提交到一半:盘上那份 MEMORY.md 是旧的,照它合出来的会先传上云(落盘那道检查在上传之后)。这一轮先不合,调用方记错、下一轮再来
    if(memoryBase&&agent.rel==='MEMORY.md'&&(agent.area==='human'||agent.slug&&validAgentSyncSlug(agent.slug)))refuseMidCommit(agent.area==='human'?join(memoryBase,'human'):join(memoryBase,'agents',agent.slug!))
    const merged=mergeAgentSyncContent(path,ours,base,theirs,{diff3:diff3Merge})
    if(!merged||!memoryBase||agent.area!=='agents'||!agent.slug||agent.rel!=='MEMORY.md'||!validAgentSyncSlug(agent.slug))return merged
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
  await paths.reduceRight<()=>Promise<void>>((next,p)=>()=>withTextWriteLock(p,next),db)()
}

/** External-engine mode has no running local engine. Persist the same ownership
 * flag before it can later start; never send a local ownership command remotely. */
export function setOfflineContentOwner(memoryBase:string,identity:string,owned:boolean):void{
  const split=identity.lastIndexOf('::');if(split<0)throw Error('Invalid cloud identity')
  const scope=createHash('sha256').update(JSON.stringify([identity.slice(0,split),identity.slice(split+2)])).digest('hex'),dir=join(memoryBase,'agents'),file=join(dir,'.cloudsync-default.json')
  mkdirSync(dir,{recursive:true});withContentMemoryLock(dir,()=>{
    let state:{accounts:Record<string,{enabled:boolean;revision:number;owner?:'content'}>}={accounts:{}}
    try{state=JSON.parse(readFileSync(file,'utf8'))}catch(e:any){if(e.code!=='ENOENT')throw e}
    const old=state.accounts[scope];state.accounts[scope]={enabled:old?.enabled??false,revision:(old?.revision??0)+1,...(owned?{owner:'content' as const}:{})}
    const temp=file+`.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,JSON.stringify(state),{mode:0o600});renameSync(temp,file)
  })
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
