/**
 * agent_runs / agent_steps / agent_run_events 的存取层。
 */
import { query, getOlderThanSql } from '../core/db.js';

export interface AgentRun {
  id: string;
  session_id: string;
  user_id: string;
  app_id: string;
  status: string;
  current_step: number;
  model_id: string | null;
  sandbox_id: string | null;
  assistant_message_id: string | null;
  input: any;
  result: any;
  error: string | null;
  tokens_total: number;
}

export async function createRun(run: {
  id: string;
  sessionId: string;
  userId: string;
  appId: string;
  modelId: string;
  assistantMessageId: string;
  input: any;
}): Promise<void> {
  await query(
    `INSERT INTO agent_runs (id, session_id, user_id, app_id, status, model_id, assistant_message_id, input)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    [
      run.id,
      run.sessionId,
      run.userId,
      run.appId,
      run.modelId,
      run.assistantMessageId,
      JSON.stringify(run.input ?? null),
    ],
  );
}

export async function getRun(id: string): Promise<AgentRun | null> {
  const rows = await query<any[]>(`SELECT * FROM agent_runs WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

/** ownership 校验版：只返回属于该用户的 run。 */
export async function getRunForUser(id: string, userId: string): Promise<AgentRun | null> {
  const rows = await query<any[]>(
    `SELECT * FROM agent_runs WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId],
  );
  return rows[0] || null;
}

export async function updateRunStatus(
  id: string,
  status: string,
  extra?: { result?: any; error?: string; currentStep?: number; tokensTotal?: number },
): Promise<void> {
  const sets: string[] = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
  const params: any[] = [status];
  if (extra?.result !== undefined) {
    sets.push('result = ?');
    params.push(JSON.stringify(extra.result));
  }
  if (extra?.error !== undefined) {
    sets.push('error = ?');
    params.push(extra.error);
  }
  if (extra?.currentStep !== undefined) {
    sets.push('current_step = ?');
    params.push(extra.currentStep);
  }
  if (extra?.tokensTotal !== undefined) {
    sets.push('tokens_total = ?');
    params.push(extra.tokensTotal);
  }
  params.push(id);
  await query(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`, params);
}

export async function appendStep(step: {
  id: string;
  runId: string;
  stepNo: number;
  llmRequest?: any;
  llmResponse?: any;
  toolCalls?: any;
  toolResults?: any;
  stateDelta?: any;
}): Promise<void> {
  await query(
    `INSERT INTO agent_steps (id, run_id, step_no, llm_request, llm_response, tool_calls, tool_results, state_delta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, step_no) DO NOTHING`,
    [
      step.id,
      step.runId,
      step.stepNo,
      JSON.stringify(step.llmRequest ?? null),
      JSON.stringify(step.llmResponse ?? null),
      JSON.stringify(step.toolCalls ?? null),
      JSON.stringify(step.toolResults ?? null),
      JSON.stringify(step.stateDelta ?? null),
    ],
  );
}

export async function listEventsFrom(
  runId: string,
  fromSeq: number,
): Promise<Array<{ seq: number; type: string; payload: any }>> {
  const rows = await query<any[]>(
    `SELECT seq, type, payload FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`,
    [runId, fromSeq],
  );
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    payload: typeof r.payload === 'string' ? safeParse(r.payload) : r.payload,
  }));
}

/** 列出某 run 的所有步骤（含 llm 输出/工具调用/结果），供 admin 查看会话输出内容。 */
export async function listSteps(runId: string): Promise<Array<{
  stepNo: number;
  llmResponse: any;
  toolCalls: any;
  toolResults: any;
  createdAt: string | null;
}>> {
  const rows = await query<any[]>(
    `SELECT step_no, llm_response, tool_calls, tool_results, created_at
     FROM agent_steps WHERE run_id = ? ORDER BY step_no ASC`,
    [runId],
  );
  return rows.map((r) => ({
    stepNo: Number(r.step_no) || 0,
    llmResponse: typeof r.llm_response === 'string' ? safeParse(r.llm_response) : r.llm_response,
    toolCalls: typeof r.tool_calls === 'string' ? safeParse(r.tool_calls) : r.tool_calls,
    toolResults: typeof r.tool_results === 'string' ? safeParse(r.tool_results) : r.tool_results,
    createdAt: r.created_at || null,
  }));
}

export async function listActiveRunsBySession(
  sessionId: string,
  userId: string,
): Promise<Array<{ id: string; status: string; assistant_message_id: string | null }>> {
  // 在飞优先（queued/running），其次最近完成；供前端刷新恢复。
  const rows = await query<any[]>(
    `SELECT id, status, assistant_message_id FROM agent_runs
     WHERE session_id = ? AND user_id = ?
     ORDER BY (status IN ('queued','running')) DESC, updated_at DESC
     LIMIT 5`,
    [sessionId, userId],
  );
  return rows;
}

/** 进程重启自愈用：列出所有仍在飞（queued/running）的 run，按 session+created_at 排序，供 recoverQueuedRuns 重新入队。
 *  注意：须在 failStaleRuns() 之后调用，否则会捡到即将被标 failed 的陈旧行。 */
export async function listPendingRunsForRecovery(): Promise<Array<{ id: string; session_id: string }>> {
  const rows = await query<any[]>(
    `SELECT id, session_id FROM agent_runs
     WHERE status IN ('queued','running')
     ORDER BY session_id ASC, created_at ASC`,
  );
  return rows.map((r) => ({ id: r.id, session_id: r.session_id }));
}

/** 启动时把超时仍 running 的 run 标 failed（进程重启自愈）。 */
export async function failStaleRuns(olderThanMinutes = 30): Promise<number> {
  const rows = await query<any[]>(
    `UPDATE agent_runs SET status = 'failed', error = 'stale: process restarted', updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('queued','running')
       AND ${getOlderThanSql('updated_at', olderThanMinutes)}
     RETURNING id`,
  );
  return Array.isArray(rows) ? rows.length : 0;
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
