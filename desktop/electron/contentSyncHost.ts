import { readFileSync,existsSync,mkdirSync,writeFileSync,renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join,relative,sep } from 'node:path'
import { withMemoryDirectoryLock } from '../../tangu-agent/src/services/memoryRepository'
import { withDbLock } from './amadeus/fs/dbLock'
import { withTextWriteLock } from './amadeus/fs/vaultHandlers'
import { forsionHomeDir } from './forsionHome'
import { cloudAccountScope } from '../../tangu-agent/src/services/cloudSyncAccount'
import { mergeDbFile } from '../../tangu-agent/src/services/dbRowMerge'
import { mergeText3,splitLogBlocks,mergeBlocks,mergeLogHeaders } from '../../tangu-agent/src/services/memorySync'

/** Same account key and private state file as Extend; no token is persisted here. */
export function contentSyncOwned(account:string|null):boolean {
  if(!account)return false
  const name=createHash('sha256').update(account).digest('hex')+'.json'
  try{return JSON.parse(readFileSync(join(forsionHomeDir(),'content-sync',name),'utf8')).owned===true}catch{return false}
}
export function mergeSyncContent(path:string,ours:string,base:string|null,theirs:string):{content:string;conflict:boolean}|null {
  if(path.toLowerCase().endsWith('.db'))return mergeDbFile(ours,base,theirs)
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
  const memory=()=>bases.reduceRight<()=>void>((next,base)=>()=>withMemoryDirectoryLock(base,next),commit)()
  const databases=paths.filter(p=>/\.db$/i.test(p)&&!bases.some(b=>p.startsWith(b+sep)))
  const db=()=>databases.reduceRight<()=>Promise<void>>((next,p)=>()=>withDbLock(p,next),async()=>memory())()
  await paths.reduceRight<()=>Promise<void>>((next,p)=>()=>withTextWriteLock(p,next),db)()
}

/** External-engine mode has no running local engine. Persist the same ownership
 * flag before it can later start; never send a local ownership command remotely. */
export function setOfflineContentOwner(memoryBase:string,identity:string,owned:boolean):void{
  const split=identity.lastIndexOf('::');if(split<0)throw Error('Invalid cloud identity')
  const scope=cloudAccountScope(identity.slice(0,split),identity.slice(split+2)),dir=join(memoryBase,'agents'),file=join(dir,'.cloudsync-default.json')
  mkdirSync(dir,{recursive:true});withMemoryDirectoryLock(dir,()=>{
    let state:{accounts:Record<string,{enabled:boolean;revision:number;owner?:'content'}>}={accounts:{}}
    try{state=JSON.parse(readFileSync(file,'utf8'))}catch(e:any){if(e.code!=='ENOENT')throw e}
    const old=state.accounts[scope];state.accounts[scope]={enabled:old?.enabled??false,revision:(old?.revision??0)+1,...(owned?{owner:'content' as const}:{})}
    const temp=file+`.tmp-${process.pid}-${Date.now()}`;writeFileSync(temp,JSON.stringify(state),{mode:0o600});renameSync(temp,file)
  })
}
