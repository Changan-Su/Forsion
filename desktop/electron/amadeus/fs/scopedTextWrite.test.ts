import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expect, it, vi } from 'vitest'
import { textFingerprint } from '@amadeus-shared/writeConflict'
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
  return {a,b,vault,write,handlers}
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

it('strict existing writes reject removed files, changed text and invalid create requests', async () => {
  const t = await setup()
  try {
    const options = { expectedRoot: t.a, base: textFingerprint('old'), strictExisting: true }
    expect(await t.write('note.md', 'new', options)).toEqual({ ok: false, current: null })
    await expect(t.write('note.md', 'new', { ...options, create: true })).rejects.toThrow()
    await fs.writeFile(path.join(t.a, 'note.md'), 'other')
    expect(await t.write('note.md', 'new', options)).toEqual({ ok: false, current: 'other' })
    expect(await t.write('note.md', 'new', { ...options, base: textFingerprint('other') })).toEqual({ ok: true })
  } finally {
    await fs.rm(t.a, { recursive: true, force: true })
    await fs.rm(t.b, { recursive: true, force: true })
  }
})

it('a queued folder operation cannot run on a newly active vault', async () => {
  const t = await setup()
  await fs.writeFile(path.join(t.a, 'A.md'), 'old')
  await fs.mkdir(path.join(t.b, 'Projects'))
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const real = t.vault.writeTextFile.bind(t.vault)
  const spy = vi.spyOn(t.vault, 'writeTextFile').mockImplementation(async (...args) => { await real(...args); await gate })
  try {
    const saving = t.write('A.md', 'new', { strictExisting: true, expectedRoot: t.a, base: textFingerprint('old') })
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    const trash = t.handlers.get(IPC.trashEntry)!(null, 'Projects')
    t.vault.setRoot(t.b)
    release()
    await Promise.all([expect(saving).rejects.toThrow('Vault changed'), expect(trash).rejects.toThrow('Vault changed')])
    expect((await fs.stat(path.join(t.b, 'Projects'))).isDirectory()).toBe(true)
  } finally {
    release()
    await fs.rm(t.a, { recursive: true, force: true })
    await fs.rm(t.b, { recursive: true, force: true })
  }
})

it('serializes a byte save against an already validated replacement on the same note', async () => {
  const t = await setup()
  const file = 'A.md'
  await fs.writeFile(path.join(t.a, file), 'reviewed')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const real = t.vault.writeTextFile.bind(t.vault)
  const paused = vi.spyOn(t.vault, 'writeTextFile').mockImplementation(async (...args) => { await gate; await real(...args) })
  try {
    const replacement = t.write(file, 'replacement', { strictExisting: true, expectedRoot: t.a, base: textFingerprint('reviewed') })
    await vi.waitFor(() => expect(paused).toHaveBeenCalled())
    const bytes = t.handlers.get(IPC.saveVaultBytes)!(null, file, Buffer.from('later edit'))
    release()
    expect(await replacement).toEqual({ ok: true })
    await bytes
    expect(await fs.readFile(path.join(t.a, file), 'utf8')).toBe('later edit')
  } finally {
    release()
    await fs.rm(t.a, { recursive: true, force: true })
    await fs.rm(t.b, { recursive: true, force: true })
  }
})
