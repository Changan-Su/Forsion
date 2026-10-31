import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
import { IPC } from '@amadeus-shared/ipc'
vi.mock('electron',()=>({dialog:{}}))
const {VaultManager}=await import('./vaultManager')
const {registerVaultHandlers}=await import('./vaultHandlers')

async function setup(){
  const a=await fs.mkdtemp(path.join(os.tmpdir(),'bluebird-vault-a-')),b=await fs.mkdtemp(path.join(os.tmpdir(),'bluebird-vault-b-'))
  const vault=new VaultManager();vault.setRoot(a)
  const handlers=new Map<string,(...args:any[])=>any>()
  registerVaultHandlers({vault,index:{update:async()=>{}} as any,handle:(key,fn)=>{handlers.set(key,fn)},rememberPage:async()=>{},notifyAll:()=>{}})
  const write=(name:string,text:string,opts?:any)=>handlers.get(IPC.writeTextFile)!(null,name,text,opts)
  return {a,b,vault,write}
}
it('rejects a stale vault after waiting for the file lock',async()=>{
  const t=await setup();await fs.writeFile(path.join(t.b,'index.json'),'vault B must stay intact')
  let entered!:()=>void,release!:()=>void
  const ready=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r})
  const real=t.vault.writeTextFile.bind(t.vault)
  const spy=vi.spyOn(t.vault,'writeTextFile').mockImplementation(async(...args)=>{await real(...args);entered();await gate})
  try{
    const first=t.write('index.json','first')
    await ready
    const late=t.write('index.json','stale A index',{expectedRoot:t.a})
    const rejection=expect(late).rejects.toThrow('Vault changed')
    t.vault.setRoot(t.b);release();await first;await rejection
    expect(await fs.readFile(path.join(t.b,'index.json'),'utf8')).toBe('vault B must stay intact')
  }finally{spy.mockRestore()}
})
it('create-only scoped writes cannot overwrite a note',async()=>{
  const t=await setup()
  expect(await t.write('note.md','user text',{expectedRoot:t.a,create:true})).toEqual({ok:true})
  expect(await t.write('note.md','replacement',{expectedRoot:t.a,create:true})).toEqual({ok:false,current:'user text'})
  expect(await fs.readFile(path.join(t.a,'note.md'),'utf8')).toBe('user text')
})
