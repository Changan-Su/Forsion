import {beforeEach,expect,it,vi} from 'vitest';
import {createTanguProfile} from '../profiles/tangu.js';
const m=vi.hoisted(()=>({profile:null as any,decision:{action:'approve'} as any,gate:{action:'approve'} as any,exec:vi.fn(async()=>({result:'ok'})),controllers:new Map<string,AbortController>(),onApproval:null as any,hold:false,refuse:false}));
vi.mock('../seams/runtime.js',()=>({deps:()=>({profile:m.profile})}));
vi.mock('../seams/runContext.js',()=>({enterRunContext:vi.fn(),currentStandIn:()=>undefined}));
vi.mock('../core/db.js',()=>({query:vi.fn(async()=>[])}));
vi.mock('../core/config.js',()=>({configExists:()=>true,loadRawConfig:()=>({hostSandbox:{mode:'off'}}),getRawSection:()=>undefined}));
vi.mock('../services/runStore.js',()=>({createRun:vi.fn(),updateRunStatus:vi.fn()}));
vi.mock('../services/approvals.js',()=>({requestApproval:vi.fn(async(id:string)=>{await m.onApproval?.(id);return m.decision;}),gateToolCall:vi.fn(async()=>m.gate),setApprovalTray:vi.fn()}));
vi.mock('../tools/registry.js',()=>({executeTool:m.exec}));
vi.mock('../services/agentLoop.js',()=>({restartHoldActive:()=>m.hold,runControlledOperation:async(id:string,_sid:string,_signal:AbortSignal,work:any)=>{if(m.refuse)throw new Error('Run cannot start');const ac=new AbortController();m.controllers.set(id,ac);try{return await work(ac.signal);}finally{m.controllers.delete(id);}}}));
import {registerToolProvider} from '../tools/toolRegistry.js';
import {callPluginExternalTool,pluginExternalTools} from './externalTools.js';
import {gateToolCall} from '../services/approvals.js';
const tool=(name:string,externalMcp:boolean,enabled=true)=>({name,definition:{type:'function' as const,function:{name,description:'Test',parameters:{type:'object',properties:{}}}},execute:async()=>'',capabilities:{sideEffect:'write' as const,externalMcp},isEnabledFor:()=>enabled});
beforeEach(()=>{m.profile=createTanguProfile({sandboxMode:'none'});m.decision={action:'approve'};m.gate={action:'approve'};m.onApproval=null;m.hold=false;m.refuse=false;m.exec.mockClear();vi.mocked(gateToolCall).mockClear();registerToolProvider({id:'external-core',tools:()=>[tool('test_collision',false),tool('test_core_flag',true)]});registerToolProvider({id:'external-plugin',origin:'plugin',tools:()=>[tool('test_collision',true,false),tool('test_exposed',true)]});});
it('requires the resolved provider and the resolved tool to opt in, including same-name disabled plugins',()=>{expect(pluginExternalTools('u').map(t=>t.name)).toEqual(['test_exposed']);});
it('executes final approved parameters after the edited arguments pass the native gate',async()=>{m.decision={action:'approve',argsOverride:{id:'B'}};m.gate={action:'approve',argsOverride:{id:'C'}};await callPluginExternalTool('u','test_exposed',{id:'A'},new AbortController().signal);expect(JSON.parse(vi.mocked(gateToolCall).mock.calls[0][1].function.arguments)).toEqual({id:'B'});expect(JSON.parse(m.exec.mock.calls[0][0].function.arguments)).toEqual({id:'C'});});
it('rejects gate denial, revocation and cancellation before dispatch',async()=>{
 m.decision={action:'approve',argsOverride:{id:'B'}};m.gate={action:'reject'};expect((await callPluginExternalTool('u','test_exposed',{id:'A'},new AbortController().signal)).isError).toBe(true);expect(m.exec).not.toHaveBeenCalled();
 m.gate={action:'approve'};m.onApproval=(id:string)=>m.controllers.get(id)!.abort();await expect(callPluginExternalTool('u','test_exposed',{},new AbortController().signal)).rejects.toThrow();expect(m.exec).not.toHaveBeenCalled();
 m.onApproval=()=>registerToolProvider({id:'external-plugin',origin:'plugin',tools:()=>[]});await expect(callPluginExternalTool('u','test_exposed',{},new AbortController().signal)).rejects.toThrow(/no longer available/);expect(m.exec).not.toHaveBeenCalled();
});

it('restart hold: refuses before any run row exists, and a refused operation closes its row instead of leaving it queued',async()=>{
 const {createRun,updateRunStatus}=await import('../services/runStore.js');
 vi.mocked(createRun).mockClear();vi.mocked(updateRunStatus).mockClear();
 m.hold=true;await expect(callPluginExternalTool('u','test_exposed',{},new AbortController().signal)).rejects.toThrow(/restarting/);
 expect(createRun).not.toHaveBeenCalled();
 m.hold=false;m.refuse=true;await expect(callPluginExternalTool('u','test_exposed',{},new AbortController().signal)).rejects.toThrow(/cannot start/);
 const runId=vi.mocked(createRun).mock.calls[0][0].id;
 expect(vi.mocked(updateRunStatus).mock.calls).toEqual([[runId,'failed',{error:'Engine is restarting'}]]);
 expect(m.exec).not.toHaveBeenCalled();
});
