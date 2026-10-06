import {it,expect} from 'vitest';
import {TaskProjectQueue} from './taskProjectQueue.js';
it('serializes different sessions of one project, and cancellation never releases another run',async()=>{
 const q=new TaskProjectQueue(),a=new AbortController(),b=new AbortController(),c=new AbortController();
 const offA=await q.acquire('/project',a.signal);let entered=false;
 const next=q.acquire('/project',b.signal);const rejected=expect(next).rejects.toThrow();
 const third=q.acquire('/project',c.signal).then(off=>{entered=true;return off;});
 b.abort();await rejected;await Promise.resolve();expect(entered).toBe(false);
 const offOther=await q.acquire('/other',new AbortController().signal);offOther();
 offA();const offC=await third;expect(entered).toBe(true);offA();offC();
 const offAgain=await q.acquire('/project',a.signal);offAgain();
});
