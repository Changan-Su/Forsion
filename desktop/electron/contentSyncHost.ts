import { readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,realpathSync,openSync,closeSync,unlinkSync,lstatSync,readdirSync,constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { join,relative,sep } from 'node:path'
import { diff3Merge } from 'node-diff3'
import { withDbLock } from './amadeus/fs/dbLock'
import { withTextWriteLock } from './amadeus/fs/vaultHandlers'
import { forsionHomeDir } from './forsionHome'
import { mergeDbFile } from '../../tangu-agent/src/contracts/dbRowMerge'
import { mergeText3With,splitLogBlocks,mergeBlocks,mergeLogHeaders } from '../../tangu-agent/src/contracts/contentMerge'
import { agentSlugLocalOnly,mergeAgentSyncContent,parseAgentContentPath,parseTombstones,serializeTombstones,validAgentSyncSlug,MEMORY_TOMBSTONES } from '../../tangu-agent/src/contracts/agentSyncRules'
// Agent 记忆仓库只引了 node 内置模块:新同步落 MEMORY.md / 墓碑时走同一个仓库提交(版本、墓碑过滤),锁也用它那把(可重入)
import { atomicWriteMemoryFile,createMemoryRepository,filterForgottenMemory,readMemoryFile,validateMemoryTombstones,withMemoryDirectoryLock,type MemoryTombstone } from '../../tangu-agent/src/services/memoryRepository'
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
    const merged=mergeAgentSyncContent(path,ours,base,theirs,{diff3:diff3Merge})
    if(!merged||!memoryBase||agent.area!=='agents'||!agent.slug||agent.rel!=='MEMORY.md'||!validAgentSyncSlug(agent.slug))return merged
    const forgotten=localTombstones(join(memoryBase,'agents',agent.slug))
    return forgotten.length?{...merged,content:filterForgottenMemory(merged.content,forgotten)}:merged
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
  const memory=()=>bases.reduceRight<()=>void>((next,base)=>()=>withContentMemoryLock(base,next),commit)()
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
function withContentMemoryLock<T>(base:string,fn:()=>T):T{
  mkdirSync(base,{recursive:true});const root=realpathSync(base),lock=join(root,'.memory.lock');let fd:number
  try{fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)}
  catch(e:any){if(e.code==='EEXIST')throw Error('Memory directory is locked by another writer');throw e}
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,createdAt:Date.now()}));return fn()}
  finally{closeSync(fd);unlinkSync(lock)}
}

/** 这台已知的墓碑:记忆仓库里的 + 已经落到盘上的 .memory-tombstones.json。只读,读不到 / 坏了当没有(只用来多滤几行)。 */
function localTombstones(dir:string):MemoryTombstone[]{
  const out:MemoryTombstone[]=[]
  try{const state=JSON.parse(readFileSync(join(dir,'.memory-state.json'),'utf8'));if(Array.isArray(state?.tombstones))out.push(...state.tombstones)}catch{}
  try{out.push(...(parseTombstones(readFileSync(join(dir,MEMORY_TOMBSTONES),'utf8'))??[]))}catch{}
  return out.filter(t=>t&&typeof t.fingerprint==='string'&&Number.isFinite(t.forgottenAt))
}

/**
 * 新同步(Forsion Extend contentSync)对 Agent 文件夹多要的三件事(2026-11-05,方案 ⑤ 第 1–3 步)。老 Extend 不认这些成员,照旧整份写。
 * - prepare:每轮扫描前,把每个 Agent 记忆仓库里的墓碑投影成 agents/<slug>/.memory-tombstones.json(和旧同步上传的字节一样),
 *   新同步才看得见、传得上去;盘上已有的(别的设备传下来的)先并进仓库。
 * - commit:MEMORY.md 落盘走记忆仓库提交(留版本、按墓碑滤),墓碑文件落盘先并进仓库再写投影。别的路径返回 false,调用方照常写。
 * - baseline:第一次接手账号时,旧同步(引擎 agentFileSync)记下的影子 .cloudsync-<账号>.json:本机没改过就直接拉云端,可合并文件拿它的原文当基线。
 */
export interface AgentFileBaseline { seq:number; hash:string; base?:string; pending:boolean }
export function agentContentHooks(memoryBase:string,identity:()=>string|null){
  const agentsRoot=join(memoryBase,'agents')
  const agentDir=(path:string):{dir:string;rel:string}|null=>{
    const at=parseAgentContentPath(path)
    if(!at||at.area!=='agents'||!at.slug||!validAgentSyncSlug(at.slug)||agentSlugLocalOnly(at.slug))return null
    return {dir:join(agentsRoot,at.slug),rel:at.rel}
  }
  const project=(dir:string):void=>{
    const repo=createMemoryRepository(dir),disk=readMemoryFile(dir,MEMORY_TOMBSTONES)
    if(disk!==null){const incoming=parseTombstones(disk);if(!incoming)throw Error('Invalid memory tombstones file');repo.mergeTombstones(validateMemoryTombstones(incoming))}
    const tombstones=repo.snapshot().tombstones
    if(!tombstones.length&&disk===null)return
    const want=serializeTombstones(tombstones)
    if(disk!==want)atomicWriteMemoryFile(dir,MEMORY_TOMBSTONES,want)
  }
  return {
    async prepare():Promise<void>{
      let names:string[]=[];try{names=readdirSync(agentsRoot)}catch{return}
      for(const slug of names){
        if(!validAgentSyncSlug(slug)||agentSlugLocalOnly(slug))continue
        const dir=join(agentsRoot,slug)
        try{
          if(!lstatSync(dir).isDirectory())continue
          if(!existsSync(join(dir,'.memory-state.json'))&&!existsSync(join(dir,MEMORY_TOMBSTONES)))continue
          withMemoryDirectoryLock(dir,()=>project(dir))
        }catch(e){console.warn('[content-sync] memory tombstones not projected:',slug,e instanceof Error?e.message:e)} // 引擎正拿着锁 / 仓库坏了:这一轮先不传它的墓碑
      }
    },
    async commit(path:string,bytes:Buffer,expected:string|null,guard:()=>void):Promise<boolean>{
      const at=agentDir(path);if(!at||(at.rel!=='MEMORY.md'&&at.rel!==MEMORY_TOMBSTONES))return false
      const abs=join(at.dir,at.rel)
      await withTextWriteLock(abs,async()=>{
        withMemoryDirectoryLock(at.dir,()=>{
          guard()
          const current=readMemoryFile(at.dir,at.rel)
          if((current===null?null:sha256(Buffer.from(current)))!==expected)throw Error('Local file changed during download')
          const repo=createMemoryRepository(at.dir)
          if(at.rel==='MEMORY.md'){
            const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw Error('MEMORY.md is not UTF-8 text')
            repo.commit({expectedVersion:repo.snapshot().version,content:text,source:{kind:'sync'}})
          }else{
            const incoming=parseTombstones(bytes.toString('utf8'));if(!incoming)throw Error('Invalid memory tombstones file')
            repo.mergeTombstones(validateMemoryTombstones(incoming))
            atomicWriteMemoryFile(at.dir,MEMORY_TOMBSTONES,serializeTombstones(repo.snapshot().tombstones))
          }
        })
      })
      return true
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
