import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
export async function dispatchLive({api, run, until, workspace, model, home}) {
  const prefix='/extensions/forsion-plugin-dispatch/dispatch-core';
  const post=(path,body)=>api(prefix+path,{method:'POST',body:JSON.stringify(body)});
  assert.equal((await api(prefix+'/snapshot')).tasks.length,0);
  await assert.rejects(api(prefix+'/snapshot',{headers:{'x-forsion-remote':'true'}}),/403/);
  const chief=await run(`live-dispatch-chief-${Date.now()}`,
    `Use dispatch_task_create exactly once to create a task titled Dispatch live. The absolute cwd is ${workspace}. Description: Write a file dispatch-result.txt in the project with exactly DISPATCH_NATIVE_OK followed by a newline. Do not start it. Then use dispatch_task_list to verify it. Do not call any other tools.`,
    180000,{agentSlug:'dispatch-chief'});
  assert.equal(chief.error,null,chief.error);assert.equal(chief.done,true);
  assert.ok(chief.toolCalls.includes('dispatch_task_create'),chief.content);
  assert.ok(chief.toolCalls.every(n=>['dispatch_task_create','dispatch_task_list','dispatch_task_get','ask_user'].includes(n)));
  let snapshot=await api(prefix+'/snapshot');assert.equal(snapshot.tasks.length,1);
  const task=snapshot.tasks[0];assert.equal(task.phase,'todo');
  assert.equal(existsSync(join(workspace,'dispatch-result.txt')),false);
  await post('/task-start',{id:task.id,modelId:model,message:'Create the requested file using write_file. Do not use shell commands.'});
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
  }finally{db.close();}
  return {ok:true,detail:'Real Chief tools → persistent task → SDK-owned native run → file evidence → human acceptance; native continuation and project queue; remote route rejected',output:chief.content,toolCalls:chief.toolCalls};
}
