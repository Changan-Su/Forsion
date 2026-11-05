import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
vi.mock('./amadeus/fs/vaultHandlers',()=>({withTextWriteLock:async(_p:string,fn:()=>Promise<void>)=>fn()}))
import {setOfflineContentOwner,mergeSyncContent,withContentWriteLock,agentContentHooks} from './contentSyncHost'
import {createMemoryRepository} from '../../tangu-agent/src/services/memoryRepository'
import {parseTombstones,serializeTombstones} from '../../tangu-agent/src/contracts/agentSyncRules'
import {cloudAccountScope,agentSyncDefault,setAgentSyncDefault} from '../../tangu-agent/src/services/cloudSyncAccount'
let home:string,prev:string|undefined
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'forsion-sync-host-'));prev=process.env.TANGU_HOME;process.env.TANGU_HOME=home})
afterEach(()=>{if(prev===undefined)delete process.env.TANGU_HOME;else process.env.TANGU_HOME=prev;rmSync(home,{recursive:true,force:true})})
it('external-engine mode persists the real engine ownership format without contacting a remote engine',()=>{
 const scope=cloudAccountScope('https://cloud.test/api','one');setAgentSyncDefault(scope,true)
 setOfflineContentOwner(home,'https://cloud.test/api::one',true);expect(agentSyncDefault(scope)).toBe(false)
 expect(JSON.parse(readFileSync(join(home,'agents/.cloudsync-default.json'),'utf8')).accounts[scope].owner).toBe('content')
 setOfflineContentOwner(home,'https://cloud.test/api::one',false);expect(agentSyncDefault(scope)).toBe(true)
})
it('local human writes use the same engine memory lock',async()=>{
 const dir=join(home,'human');mkdirSync(dir);writeFileSync(join(dir,'.memory.lock'),'busy')
 let committed=false;await expect(withContentWriteLock(join(dir,'CALENDAR.db'),home,()=>{committed=true})).rejects.toThrow('locked');expect(committed).toBe(false)
})
it('uses the real row merger for two independently edited calendars',()=>{
 const db=(ids:string[])=>JSON.stringify({version:2,name:'Calendar',columns:[{id:'n',name:'Name',type:'text'}],rows:ids.map(id=>({id,cells:{n:id}}))})
 const result=mergeSyncContent('human/CALENDAR.db',db(['base','E']),db(['base']),db(['base','F']))!
 expect(result.conflict).toBe(false);expect(JSON.parse(result.content).rows.map((r:any)=>r.id).sort()).toEqual(['E','F','base'])
})
it('new sync merges widget records by rows and never guesses a matching column',()=>{
 const db=(id:string,field:string)=>JSON.stringify({version:2,name:'Ledger',columns:[{id:field,name:field,type:'text'}],rows:[{id,cells:{[field]:id}}]})
 const result=mergeSyncContent('agents/xyra/WidgetData/w_1/data.db',db('E','place'),null,db('F','mood'))!
 expect(result.conflict).toBe(false);expect(JSON.parse(result.content).rows.map((r:any)=>r.cells)).toEqual([{mood:'F'},{place:'E'}])
})

describe('agent files on the new sync use the same rules and memory repository as the engine sync',()=>{
 it('merges agent memory by facts and drops what this device forgot',()=>{
  const repo=createMemoryRepository(join(home,'agents','xyra'));repo.add('- 养了一只猫');repo.add('- 住在伦敦')
  const cat=repo.snapshot().entries.find(e=>e.content.includes('猫'))!;repo.forget(cat.id)
  // 第一次见面(换引擎没带基线):并集,但这台忘掉的那条不从对方那份回来
  const merged=mergeSyncContent('agents/xyra/MEMORY.md','- 住在伦敦\n',null,'- 养了一只猫\n- 喜欢简短回复\n',home)!
  expect(merged.conflict).toBe(false);expect(merged.content).toContain('住在伦敦');expect(merged.content).toContain('喜欢简短回复');expect(merged.content).not.toContain('猫')
  // 有基线:两台各记一条,不出副本
  expect(mergeSyncContent('agents/xyra/MEMORY.md','- a\n- mac\n','- a\n','- a\n- win\n')).toEqual({content:'- a\n- mac\n- win\n',conflict:false})
 })
 it('commit writes MEMORY.md through the repository and imports tombstones before projecting them',async()=>{
  const dir=join(home,'agents','xyra');const repo=createMemoryRepository(dir);repo.add('- keep');repo.add('- gone')
  const hooks=agentContentHooks(home,()=>null),sha=(s:string)=>createHash('sha256').update(s).digest('hex')
  const before=repo.snapshot()
  expect(await hooks.commit('agents/xyra/MEMORY.md',Buffer.from('- keep\n- gone\n- from cloud\n'),sha(readFileSync(join(dir,'MEMORY.md'),'utf8')),()=>{})).toBe(true)
  const after=repo.snapshot();expect(after.version).not.toBe(before.version);expect(after.content).toContain('from cloud')
  // 别的设备忘了「gone」:墓碑文件落盘 → 并进仓库 → 记忆里那条跟着滤掉,投影照旧同步格式
  const other=createMemoryRepository(join(home,'agents','other'));other.add('- gone');other.forget(other.snapshot().entries[0].id)
  const wire=serializeTombstones(other.snapshot().tombstones)
  expect(await hooks.commit('agents/xyra/.memory-tombstones.json',Buffer.from(wire),null,()=>{})).toBe(true)
  expect(repo.snapshot().content).not.toContain('gone');expect(readFileSync(join(dir,'.memory-tombstones.json'),'utf8')).toBe(wire)
  // 本机新忘的一条:prepare 投影到盘上,新同步扫描时就能传上去
  repo.forget(repo.snapshot().entries.find(e=>e.content.includes('keep'))!.id);await hooks.prepare()
  expect(parseTombstones(readFileSync(join(dir,'.memory-tombstones.json'),'utf8'))!.length).toBe(2)
  expect(await hooks.commit('agents/xyra/config.toml',Buffer.from('x'),null,()=>{})).toBe(false)
  expect(await hooks.commit('agents/muse/MEMORY.md',Buffer.from('x'),null,()=>{})).toBe(false)
  // 写的时候本机又改了:不落盘
  await expect(hooks.commit('agents/xyra/MEMORY.md',Buffer.from('- x\n'),sha('stale'),()=>{})).rejects.toThrow('changed')
 })
 it('reads the engine sync shadow of the same account as the first baseline',async()=>{
  const dir=join(home,'agents','christen');mkdirSync(dir,{recursive:true})
  const scope=cloudAccountScope('https://cloud.test/api','one'),base='- a\n',hash=createHash('sha256').update(base).digest('hex')
  writeFileSync(join(dir,`.cloudsync-${scope}.json`),JSON.stringify({files:{'MEMORY.md':{seq:4,hash,base},'config.toml':{seq:2,hash:'b'.repeat(64)},'SOUL.md':{seq:3,hash:'c'.repeat(64),pending:{push:['d'.repeat(64)]}}}}))
  const hooks=agentContentHooks(home,()=>'https://cloud.test/api::one')
  expect(await hooks.baseline('agents/christen/MEMORY.md')).toEqual({seq:4,hash,base,pending:false})
  expect(await hooks.baseline('agents/christen/config.toml')).toEqual({seq:2,hash:'b'.repeat(64),pending:false})
  expect((await hooks.baseline('agents/christen/SOUL.md'))?.pending).toBe(true)
  expect(await agentContentHooks(home,()=>'https://cloud.test/api::two').baseline('agents/christen/MEMORY.md')).toBe(null)
 })
})
