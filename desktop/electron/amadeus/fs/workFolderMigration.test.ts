import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { migrateWorkFolder } from './workFolderMigration'
import { VaultManager } from './vaultManager'
import type { WorkFolderMigration } from '@amadeus-shared/ipc'
const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true})})
async function setup(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-upgrade-'));roots.push(root)
 const vault=new VaultManager();vault.setRoot(root)
 const before='[]',after='[{"folder":"Plugins/Previous/Record"}]'
 const source='Previous',target='Plugins/Previous'
 const write=async(rel:string,body:string|Buffer)=>{const abs=path.join(root,rel);await fs.mkdir(path.dirname(abs),{recursive:true});await fs.writeFile(abs,body)}
 await write('Previous/.index.json','[{"folder":"Previous/Record"}]')
 await write('Previous/Record/.record.json','{"folder":"Previous/Record"}')
 await write('Previous/Record/audio.m4a',Buffer.from([0,255,1,42]))
 await write('Previous/Record/transcript.md','# My transcript')
 await write('Plugins/Previous/.index.json',before)
 await write('Plugins/Previous/new-audio.m4a','already here')
 const request:WorkFolderMigration={id:'previous-v1',expectedRoot:root,source,target,plan:{index:{path:'.index.json',before,after},edits:[{path:'.index.json',before:'[{"folder":"Previous/Record"}]',after},{path:'Record/.record.json',before:'{"folder":"Previous/Record"}',after:'{"folder":"Plugins/Previous/Record"}'}],requiredFiles:['Record/audio.m4a']}}
 const lock=async<T>(_rel:string[],fn:()=>Promise<T>)=>fn()
 return {root,vault,request,write,run:()=>migrateWorkFolder(vault,request,lock),status:()=>migrateWorkFolder(vault,{...request,plan:undefined},lock)}
}
it('copies hidden records, notes and exact media bytes, preserving originals and existing target assets',async()=>{
 const t=await setup();expect((await t.status()).status).toBe('needed');expect((await t.run()).status).toBe('complete')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/Record/audio.m4a'))).toEqual(Buffer.from([0,255,1,42]))
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/Record/.record.json'),'utf8')).toContain('Plugins/Previous')
 expect(await fs.readFile(path.join(t.root,'Previous/Record/.record.json'),'utf8')).toBe('{"folder":"Previous/Record"}')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/new-audio.m4a'),'utf8')).toBe('already here')
 await t.write('Plugins/Previous/.index.json','[]');await fs.rm(path.join(t.root,'Plugins/Previous/Record'),{recursive:true})
 expect((await t.status()).status).toBe('complete');expect((await t.run()).status).toBe('complete')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/.index.json'),'utf8')).toBe('[]')
})
it('retries an interrupted copy and refuses conflicting files without publishing the index',async()=>{
 const t=await setup();await t.write('Plugins/Previous/Record/audio.m4a','user media')
 await expect(t.run()).rejects.toThrow('conflict')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/.index.json'),'utf8')).toBe('[]')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/Record/audio.m4a'),'utf8')).toBe('user media')
 await fs.rm(path.join(t.root,'Plugins/Previous/Record/audio.m4a'));expect((await t.run()).status).toBe('complete')
})
it('recovers a crash after index publication before the completion marker',async()=>{
 const t=await setup();await t.run()
 const file=path.join(t.root,'.forsion/plugin-migrations/previous-v1.json'),journal=JSON.parse(await fs.readFile(file,'utf8'))
 journal.complete=false;await fs.writeFile(file,JSON.stringify(journal))
 expect((await t.status()).status).toBe('complete');expect(JSON.parse(await fs.readFile(file,'utf8')).complete).toBe(true)
})
it('rejects missing/empty media, stale source snapshots and changed target indexes',async()=>{
 const t=await setup();await t.write('Previous/Record/audio.m4a','');await expect(t.run()).rejects.toThrow('Missing')
 await t.write('Previous/Record/audio.m4a','audio');await t.write('Previous/.index.json','changed');await expect(t.run()).rejects.toThrow('source changed')
 await t.write('Previous/.index.json',t.request.plan!.edits[0].before);await t.write('Plugins/Previous/.index.json','user data');await expect(t.run()).rejects.toThrow('target index')
})
it('checks the vault again inside the index lock and cannot write into the new library',async()=>{
 const t=await setup(),other=await fs.mkdtemp(path.join(os.tmpdir(),'plugin-other-'));roots.push(other)
 await expect(migrateWorkFolder(t.vault,t.request,async(_rel,fn)=>{t.vault.setRoot(other);return fn()})).rejects.toThrow('Vault changed')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/.index.json'),'utf8')).toBe('[]');expect(await fs.readdir(other)).toEqual([])
})
it('rejects traversal and symlinked sources',async()=>{
 const t=await setup();await expect(migrateWorkFolder(t.vault,{...t.request,source:'../outside'},async(_r,f)=>f())).rejects.toThrow('path')
 await fs.symlink(path.join(t.root,'Previous/Record/audio.m4a'),path.join(t.root,'Previous/link'))
 await expect(t.run()).rejects.toThrow('symlinks')
})
it('rejects index edits that occur while waiting for the shared write lock',async()=>{
 const t=await setup()
 await expect(migrateWorkFolder(t.vault,t.request,async(_rel,fn)=>{await t.write('Plugins/Previous/.index.json','concurrent edit');return fn()})).rejects.toThrow('target index')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/.index.json'),'utf8')).toBe('concurrent edit')
})

it('rejects source edits made while waiting for all source/destination write locks',async()=>{
 const t=await setup()
 await expect(migrateWorkFolder(t.vault,t.request,async(paths,fn)=>{
  expect(paths).toContain('Previous/Record/transcript.md')
  expect(paths).toContain('Plugins/Previous/Record/transcript.md')
  await t.write('Previous/Record/transcript.md','Latest user edit');return fn()
 })).rejects.toThrow('source changed')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/.index.json'),'utf8')).toBe('[]')
 expect(await fs.readFile(path.join(t.root,'Previous/Record/transcript.md'),'utf8')).toBe('Latest user edit')
})
it('status queries can resume a migration using a different legacy folder alias',async()=>{
 const t=await setup();await t.write('Plugins/Previous/Record/audio.m4a','conflict');await expect(t.run()).rejects.toThrow('conflict')
 expect((await migrateWorkFolder(t.vault,{...t.request,source:'OtherAlias',plan:undefined},async(_p,f)=>f())).status).toBe('needed')
 await fs.rm(path.join(t.root,'Plugins/Previous/Record/audio.m4a'));await t.run()
 expect((await migrateWorkFolder(t.vault,{...t.request,source:'OtherAlias',plan:undefined},async(_p,f)=>f())).status).toBe('complete')
})

it('prevents folder move/delete/trash during publication, without deadlocking file locks',async()=>{
 const t=await setup()
 await migrateWorkFolder(t.vault,t.request,async(_paths,fn)=>{
  await expect(t.vault.moveEntry('Plugins/Previous','Moved')).rejects.toThrow('migration is in progress')
  await expect(t.vault.removeEntry('Plugins/Previous')).rejects.toThrow('migration is in progress')
  await expect(t.vault.trashEntry('Previous')).rejects.toThrow('migration is in progress')
  return fn()
 })
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/Record/transcript.md'),'utf8')).toBe('# My transcript')
 await t.vault.moveEntry('Plugins/Previous','Moved')
 expect(await fs.readFile(path.join(t.root,'Moved/Record/transcript.md'),'utf8')).toBe('# My transcript')
})

it('rebases relative Markdown attachments at the new depth, preserving the original note',async()=>{
 const t=await setup();await t.write('Outside.pdf','pdf bytes');const note='[Reference](../../Outside.pdf)\n![Local](audio.m4a)'
 await t.write('Previous/Record/transcript.md',note);await t.run()
 expect(await fs.readFile(path.join(t.root,'Previous/Record/transcript.md'),'utf8')).toBe(note)
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/Record/transcript.md'),'utf8')).toBe('[Reference](../../../Outside.pdf)\n![Local](audio.m4a)')
})

it('migrates a previous Plugins/<display name> folder and rejects overlapping/case-only roots', async () => {
 const t=await setup()
 await fs.rename(path.join(t.root,'Previous'),path.join(t.root,'Plugins','旧目录'))
 const request={...t.request,source:'Plugins/旧目录'}
 expect((await migrateWorkFolder(t.vault,request,async(_r,f)=>f())).status).toBe('complete')
 expect(await fs.readFile(path.join(t.root,'Plugins/Previous/Record/audio.m4a'))).toEqual(Buffer.from([0,255,1,42]))
 expect(await fs.readFile(path.join(t.root,'Plugins/旧目录/Record/.record.json'),'utf8')).toBe('{"folder":"Previous/Record"}')
 for(const source of ['Plugins','Plugins/Previous','Plugins/previous','Plugins/Previous.','Plugins/Previous ','Plugins/旧目录/nested']) {
  await expect(migrateWorkFolder(t.vault,{...request,id:'overlap',source},async(_r,f)=>f())).rejects.toThrow('folders')
 }
})

it('preserves resolved user media beside the note, archived media, and code examples', async () => {
 const t=await setup()
 await t.write('Previous/recording.wav','beside note');await t.write('Previous/assets/archive.wav','archived');await t.write('Elsewhere/outside.wav','outside source')
 await t.write('Previous/Record/transcript.md','![[recording.wav]]\n![[archive.wav#t=1|Audio]]\n`![[recording.wav]]`\n```md\n![[recording.wav]]\n```\n\n`example\n![[recording.wav]]\n`\n\n![[outside.wav]]')
 await t.run()
 const note=await fs.readFile(path.join(t.root,'Plugins/Previous/Record/transcript.md'),'utf8')
 expect(note).toContain('![[Plugins/Previous/recording.wav]]')
 expect(note).toContain('![[Plugins/Previous/assets/archive.wav#t=1|Audio]]')
 expect(note).toContain('`![[recording.wav]]`');expect(note).toContain('```md\n![[recording.wav]]\n```');expect(note).toContain('`example\n![[recording.wav]]\n`');expect(note).toContain('![[Elsewhere/outside.wav]]')
})
