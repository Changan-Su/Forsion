import { expect, it, vi } from 'vitest'
import { renameAtomic } from './renameAtomic'
it('retries transient Windows replacement errors without deleting the destination',async()=>{
 const busy=Object.assign(new Error('sharing violation'),{code:'EPERM'}),rename=vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(undefined),pause=vi.fn().mockResolvedValue(undefined)
 await renameAtomic('draft.tmp','note.md','win32',rename,pause)
 expect(rename.mock.calls).toEqual([['draft.tmp','note.md'],['draft.tmp','note.md']]);expect(pause).toHaveBeenCalledWith(20)
})
it('bounds Windows retries and propagates permanent/other-platform failures',async()=>{
 const busy=Object.assign(new Error('busy'),{code:'EPERM'}),rename=vi.fn().mockRejectedValue(busy),pause=vi.fn().mockResolvedValue(undefined)
 await expect(renameAtomic('a','b','win32',rename,pause)).rejects.toBe(busy);expect(rename).toHaveBeenCalledTimes(5)
 rename.mockClear();await expect(renameAtomic('a','b','darwin',rename,pause)).rejects.toBe(busy);expect(rename).toHaveBeenCalledTimes(1)
 const denied=Object.assign(new Error('missing'),{code:'ENOENT'});rename.mockReset().mockRejectedValue(denied)
 await expect(renameAtomic('a','b','win32',rename,pause)).rejects.toBe(denied);expect(rename).toHaveBeenCalledTimes(1)
})
