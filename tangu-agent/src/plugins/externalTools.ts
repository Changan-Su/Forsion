/** Opt-in plugin tools exported through the existing Desktop MCP bridge. */
import { randomUUID } from 'node:crypto';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { enterRunContext } from '../seams/runContext.js';
import { resolveTools } from '../tools/toolRegistry.js';
import { executeTool } from '../tools/registry.js';
import { createRun, updateRunStatus } from '../services/runStore.js';
import { requestApproval, gateToolCall, setApprovalTray } from '../services/approvals.js';
import type { ToolContext } from '../tools/toolTypes.js';

const context=(userId:string):ToolContext=>({userId,sessionId:'',appId:deps().profile.appId,execMode:'host'});
export function pluginExternalTools(userId:string) {
  if(!deps().profile.capabilities.hostExec)return [];
  const origins=new Map<string,'plugin'|'core'>();
  return [...resolveTools(deps().profile,context(userId),origins).values()].filter(t=>origins.get(t.name)==='plugin'&&t.capabilities?.externalMcp===true);
}
export async function callPluginExternalTool(userId:string,name:string,args:Record<string,unknown>,signal:AbortSignal) {
  const tool=pluginExternalTools(userId).find(t=>t.name===name);if(!tool)throw new Error('Plugin has not exposed this tool');
  const call={id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}};
  if(tool.capabilities?.sideEffect==='none')return executeTool(call,context(userId));
  const sessionId=randomUUID(),runId=randomUUID(),assistantMessageId=randomUUID();
  await query(`INSERT INTO chat_sessions (id,user_id,app_id,title,kind,agent_config) VALUES (?,?,?,?,?,?)`,[sessionId,userId,deps().profile.appId,`Desktop MCP · ${name}`,'task',JSON.stringify({approvalMode:'ask'})]);
  await createRun({id:runId,sessionId,userId,appId:deps().profile.appId,modelId:'',assistantMessageId,input:{origin:'client',approvalTray:true,message:`Desktop MCP: ${name}`,agentConfig:{approvalMode:'ask'}}});
  const { runControlledOperation } = await import('../services/agentLoop.js');
  return runControlledOperation(runId,sessionId,signal,async runSignal=>{
    enterRunContext(userId,runId);setApprovalTray(runId,true);
    try {
      runSignal.throwIfAborted();await updateRunStatus(runId,'running');
      let decision=await requestApproval(runId,call,`Desktop MCP · ${name}\n${JSON.stringify(args).slice(0,12000)}`,runSignal);
      runSignal.throwIfAborted();
      let approved=call;
      if(decision.action!=='reject'&&decision.argsOverride){
        approved={...call,function:{...call.function,arguments:JSON.stringify(decision.argsOverride)}};
        decision=await gateToolCall(runId,approved,{sessionId,userId,execMode:'host',approvalMode:'readonly',modeSessionId:sessionId},runSignal,true);
        if(decision.argsOverride)approved={...approved,function:{...approved.function,arguments:JSON.stringify(decision.argsOverride)}};
      }
      runSignal.throwIfAborted();
      if(decision.action==='reject'){await updateRunStatus(runId,'aborted',{error:'User declined Desktop MCP request'});return {isError:true,result:'The user declined this request.'};}
      // Plugin disable/removal while approval was open revokes the call.
      if(!pluginExternalTools(userId).some(t=>t.name===name))throw new Error('Plugin tool is no longer available');
      const result=await executeTool(approved,{...context(userId),sessionId,runId,signal:runSignal});
      runSignal.throwIfAborted();
      await updateRunStatus(runId,result.isError?'failed':'done',{result:{content:String(result.result)}});return result;
    }catch(e:any){await updateRunStatus(runId,runSignal.aborted?'aborted':'failed',{error:e.message});throw e;}
    finally{setApprovalTray(runId,false);}
  });
}
