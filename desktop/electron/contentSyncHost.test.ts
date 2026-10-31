import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
vi.mock('./amadeus/fs/vaultHandlers',()=>({withTextWriteLock:async(_p:string,fn:()=>Promise<void>)=>fn()}))
import {setOfflineContentOwner,mergeSyncContent,withContentWriteLock} from './contentSyncHost'
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
