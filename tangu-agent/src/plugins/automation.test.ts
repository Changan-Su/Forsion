import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({run:undefined as string|undefined,remove:vi.fn(async()=>true)}));
vi.mock('../seams/runContext.js',()=>({currentRunId:()=>m.run}));
vi.mock('../seams/runtime.js',()=>({deps:()=>({profile:{capabilities:{hostExec:true}}})}));
vi.mock('../services/museTriggers.js',()=>({loadTriggers:async()=>[],validateTriggerInput:()=>({ok:true,value:{}}),upsertTrigger:async()=>({ok:true,trigger:{}}),removeTrigger:m.remove,nextRunAt:()=>0}));
vi.mock('../tools/builtin/inboxSend.js',()=>({sendInboxMessage:async()=>({ok:true})}));
import {createPluginAutomation} from './automation.js';
beforeEach(()=>{m.run=undefined;m.remove.mockClear();});
it('allows revocation from an approved task tool but cannot grant a schedule during a run',async()=>{
 const api=createPluginAutomation('dispatch-core',()=>true,()=>['tick']);m.run='native-approved-stop';
 await api.remove('task-id');expect(m.remove).toHaveBeenCalledWith('plugin:dispatch-core:task-id');
 await expect(api.save('task-id',{description:'Task',type:'every',interval:'1h',tool:'tick',args:{},enabled:true})).rejects.toThrow(/local user interface/);
 await expect(api.remove('../foreign')).rejects.toThrow(/Invalid/);
});
