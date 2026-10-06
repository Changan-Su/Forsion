import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export async function dispatchLive({api, run, until, workspace, model, home}) {
  const prefix='/extensions/forsion-plugin-dispatch/dispatch-core';
  const post=(path,body)=>api(prefix+path,{method:'POST',body:JSON.stringify(body)});
  assert.equal((await api(prefix+'/snapshot')).tasks.length,0);
  await assert.rejects(api(prefix+'/snapshot',{headers:{'x-forsion-remote':'true'}}),/403/);
  const chief=await run(`live-dispatch-chief-${Date.now()}`,
    `Use dispatch_task_create exactly once to create a task titled Dispatch live. The absolute cwd is ${workspace}. Description: Write a file dispatch-result.txt in the project with exactly DISPATCH_NATIVE_OK followed by a newline. Then call dispatch_task_start once with modelId ${model} and instructions to use write_file without a shell. I authorize starting this one synthetic task, and will approve the native request. Finally call dispatch_task_list. Do not call any other tools.`,
    180000,{agentSlug:'dispatch-chief',approvalMode:'auto-edit'});
  assert.equal(chief.error,null,chief.error);assert.equal(chief.done,true);
  assert.ok(chief.toolCalls.includes('dispatch_task_create'),chief.content);
  assert.ok(chief.toolCalls.every(n=>['dispatch_task_create','dispatch_task_start','dispatch_task_list','dispatch_task_get','ask_user'].includes(n)));
  let snapshot=await api(prefix+'/snapshot');assert.equal(snapshot.tasks.length,1);
  assert.ok(chief.toolCalls.includes('dispatch_task_start'));assert.ok(chief.approvals>=1,'Chief task_start did not require approval');
  const task=snapshot.tasks[0];
  const done=await until(async()=>{
    const t=(await api(prefix+'/snapshot')).tasks.find(t=>t.id===task.id);
    if(t.phase==='failed')throw new Error(t.run?.error||t.dispatchError||'task failed');
    return t.phase==='review'?t:null;
  },180000,1000);
  assert.ok(done,'task did not reach review');
  assert.equal(readFileSync(join(workspace,'dispatch-result.txt'),'utf8').trim(),'DISPATCH_NATIVE_OK');
  assert.equal(done.sessionId,task.sessionId);assert.equal(done.attempts.length,1);
  await post('/task-finish',{id:task.id});assert.equal((await api(prefix+'/snapshot')).tasks[0].phase,'done');
  // Native follow-up must reopen the task and retain its project lease while asking the user.
  const follow=await api('/agent/runs',{method:'POST',body:JSON.stringify({session_id:task.sessionId,model_id:model,message:'Use ask_user to ask the user whether this synthetic test should continue. Wait for their answer. Do not change any files.',approval_tray:true,agent_config:{execMode:'host',cwd:workspace}})});
  const waiting=await until(async()=>{const t=(await api(prefix+'/snapshot')).tasks[0];return t.run?.runId===follow.runId&&t.phase==='waiting'?t:null;},90000,1000);
  assert.ok(waiting,'native continuation was not tracked as waiting');
  const second=await post('/task-create',{title:'Queued task',description:'Reply QUEUE_OK. Do not use tools.',cwd:workspace});
  await post('/task-start',{id:second.id,modelId:model});
  assert.equal((await api(prefix+'/snapshot')).tasks.find(t=>t.id===second.id).phase,'queued');
  await assert.rejects(post('/task-finish',{id:task.id}),/Stop/);
  await post('/task-stop',{id:task.id});
  assert.ok(await until(async()=>{const t=(await api(prefix+'/snapshot')).tasks.find(t=>t.id===second.id);return t.phase==='review'?t:null;},90000,1000),'queue did not advance');
  const {default:Database}=await import('better-sqlite3');const db=new Database(join(home,'state.db'),{readonly:true});
  try {
    const row=db.prepare('SELECT kind, parent_session_id, agent_config FROM chat_sessions WHERE id = ?').get(task.sessionId);
    assert.equal(row.kind,'task');assert.equal(JSON.parse(row.agent_config).pluginOwner,'dispatch-core');
    const input=JSON.parse(db.prepare('SELECT input FROM agent_runs WHERE id = ?').get(done.attempts[0].runId).input);
    assert.equal(input.approvalTray,true);assert.equal(input.origin,'client');
    assert.ok(await until(async()=>db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?').get(row.parent_session_id)?.n>=2,30000,250),'Chief follow-up missing');
    assert.ok((await api(prefix+'/snapshot')).tasks.find(t=>t.id===task.id).usage.tokens>0);
    // External MCP is opt-in and uses native pending approvals, including edit and Stop.
    assert.equal((await api('/agent/plugins/external-tools')).tools.length,0);
    await post('/desktop-mcp',{enabled:true});
    assert.ok((await api('/agent/plugins/external-tools')).tools.some(t=>t.name==='dispatch_task_create'));
    const waitingCall=async title=>{
      const pending=api('/agent/plugins/external-tools/call',{method:'POST',body:JSON.stringify({name:'dispatch_task_create',arguments:{title,description:'Synthetic MCP task',cwd:workspace}})}).then(value=>({value}),error=>({error:error.message}));
      const event=await until(async()=>{
        const rows=db.prepare("SELECT e.run_id,e.payload FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id JOIN chat_sessions s ON s.id=r.session_id WHERE s.title='Desktop MCP · dispatch_task_create' AND e.type='approval_request' ORDER BY r.created_at DESC,e.seq DESC").all();
        return rows.map(r=>({...JSON.parse(r.payload),runId:r.run_id})).find(r=>JSON.parse(r.arguments).title===title);
      },15000,100);assert.ok(event,'No native Desktop MCP approval');return {pending,event};
    };
    const edited=await waitingCall('MCP original');
    await api(`/agent/runs/${edited.event.runId}/approvals/${edited.event.approvalId}`,{method:'POST',body:JSON.stringify({action:'approve',argsOverride:{title:'MCP approved edit',description:'Edited by user',cwd:workspace}})});
    assert.ok((await edited.pending).value);snapshot=await api(prefix+'/snapshot');assert.ok(snapshot.tasks.some(t=>t.title==='MCP approved edit'));assert.ok(!snapshot.tasks.some(t=>t.title==='MCP original'));
    const cancelled=await waitingCall('MCP cancelled');
    await api(`/agent/runs/${cancelled.event.runId}/abort`,{method:'POST',body:'{}'});assert.ok((await cancelled.pending).error);
    await assert.rejects(api(`/agent/runs/${cancelled.event.runId}/approvals/${cancelled.event.approvalId}`,{method:'POST',body:JSON.stringify({action:'approve'})}),/410/);
    assert.ok(!(await api(prefix+'/snapshot')).tasks.some(t=>t.title==='MCP cancelled'));
    const revoked=await waitingCall('MCP revoked');await post('/desktop-mcp',{enabled:false});
    await api(`/agent/runs/${revoked.event.runId}/approvals/${revoked.event.approvalId}`,{method:'POST',body:JSON.stringify({action:'approve'})});assert.match((await revoked.pending).error,/no longer available/);
    await post('/task-schedule',{id:second.id,enabled:true,frequency:'hour'});assert.ok((await api(prefix+'/snapshot')).tasks.find(t=>t.id===second.id).schedule.enabled);
    await post('/task-schedule',{id:second.id,enabled:false});assert.equal((await api(prefix+'/snapshot')).tasks.find(t=>t.id===second.id).schedule,null);
    const planned=await post('/task-create',{title:'Plan approval',description:'Call exit_plan_mode with a short plan to write dispatch-plan.txt containing PLAN_OK. Do not write before approval. After approval, finish this planning turn.',cwd:workspace});
    await post('/task-start',{id:planned.id,modelId:model,planMode:true});
    const planTask=await until(async()=>{const t=(await api(prefix+'/snapshot')).tasks.find(t=>t.id===planned.id);return t.phase==='confirm'?t:null;},90000,500);assert.ok(planTask,'plan did not reach confirmation');
    assert.equal(existsSync(join(workspace,'dispatch-plan.txt')),false);
    const inquiry=JSON.parse(db.prepare("SELECT payload FROM agent_run_events WHERE run_id=? AND type='inquiry_request' ORDER BY seq DESC LIMIT 1").get(planTask.run.runId).payload);
    await api(`/agent/runs/${planTask.run.runId}/inquiries/${inquiry.inquiryId}`,{method:'POST',body:JSON.stringify({answer:'批准,退出计划模式(手动开始)'})});
    assert.ok(await until(async()=>{const t=(await api(prefix+'/snapshot')).tasks.find(t=>t.id===planned.id);return t.phase==='review'?t:null;},90000,500));
    await post('/task-start',{id:planned.id,modelId:model,planMode:false,message:'Execute the approved plan now: use write_file to write dispatch-plan.txt with PLAN_OK. Do not ask another question.'});
    assert.ok(await until(async()=>{const t=(await api(prefix+'/snapshot')).tasks.find(t=>t.id===planned.id);return t.phase==='review'?t:null;},90000,500));
    assert.equal(readFileSync(join(workspace,'dispatch-plan.txt'),'utf8').trim(),'PLAN_OK');await post('/task-finish',{id:planned.id});
  }finally{db.close();}
  return {ok:true,detail:'Real Chief create + native-approved start → worker file evidence → acceptance; Chief follow-up, usage, queued continuation, native Stop, MCP opt-in/edited arguments/cancel/revoke, schedule save/remove, real plan approval and execution, remote rejection',output:chief.content,toolCalls:chief.toolCalls};
}
