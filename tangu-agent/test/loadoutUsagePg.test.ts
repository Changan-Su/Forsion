/**
 * collectLoadoutUsage 的 PostgreSQL 那一支(内嵌 PGlite 的 standalone / Unit 走这支):JSONB 取字段、JSON 布尔转文本、
 * 统计口径与 SQLite 那支一致(test/loadoutReview.test.ts)。只建查询用到的三张表的最小列。
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { configureTangu } from '../src/seams/runtime.js';
import { collectLoadoutUsage } from '../src/services/loadoutUsage.js';

let db: PGlite;
const exec = async (sql: string, params: any[] = []): Promise<any[]> => { let n = 0; return (await db.query(sql.replace(/\?/g, () => `$${++n}`), params)).rows; };
let seq = 0;
const session = (id: string, kind: string, config: unknown) => exec('INSERT INTO chat_sessions(id, user_id, kind, agent_config) VALUES (?, ?, ?, ?)', [id, 'u1', kind, config == null ? null : JSON.stringify(config)]);
async function run(sessionId: string, input: unknown, calls: Array<[string, string]>): Promise<void> {
  const id = `r${++seq}`;
  await exec('INSERT INTO agent_runs(id, session_id, user_id, input) VALUES (?, ?, ?, ?)', [id, sessionId, 'u1', JSON.stringify(input)]);
  let n = 0;
  for (const [name, args] of calls) await exec('INSERT INTO agent_run_events(run_id, seq, type, payload) VALUES (?, ?, ?, ?)', [id, ++n, 'tool_call', JSON.stringify({ id: `c${n}`, name, arguments: args })]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE chat_sessions(id TEXT PRIMARY KEY, user_id TEXT, kind TEXT DEFAULT 'user', agent_config JSONB);
    CREATE TABLE agent_runs(id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, input JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE agent_run_events(run_id TEXT, seq INTEGER, type TEXT, payload JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
  configureTangu({ host: { getDbType: () => 'postgres', query: exec }, brain: {}, billing: {}, profileStore: {}, profile: {} } as any);
  const W = { agentSlug: 'worker', execMode: 'host' };
  await session('s1', 'user', W);
  await run('s1', { agentConfig: W }, [['run_bash', '{}'], ['use_skill', '{"skill_id":"local:foo"}']]);
  await run('s1', {}, [['list_dir', '{}']]);                                      // 归属与 execMode 都靠会话存档
  await session('s-default', 'user', null);
  await run('s-default', { agentConfig: { execMode: 'host' } }, [['get_datetime', '{}']]); // 没写 slug → 默认 agent
  // 不该算进来的
  await run('s1', { agentConfig: { ...W, execMode: 'sandbox' } }, [['x_sandbox', '{}']]);
  await run('s1', { agentConfig: { ...W, groupChat: true } }, [['x_group_run', '{}']]);
  await session('s-chat', 'user', { ...W, preset: 'chat' });
  await run('s-chat', { agentConfig: W }, [['x_chat', '{}']]);
  await session('s-team', 'user', { ...W, groupChat: true });
  await run('s-team', { agentConfig: W }, [['x_group_session', '{}']]);
  await session('s-muse', 'muse', W);
  await run('s-muse', { agentConfig: W }, [['x_muse', '{}']]);
});
afterAll(async () => { await db?.close(); });

it('PostgreSQL:归属、口径、技能装载次数与 SQLite 那支一致', async () => {
  const usage = await collectLoadoutUsage('u1', 30);
  const worker = usage.get('worker')!;
  expect(worker.runs).toBe(2);
  expect([...worker.tools.keys()].sort()).toEqual(['list_dir', 'run_bash', 'use_skill']);
  expect(worker.tools.get('run_bash')).toMatchObject({ calls: 1, last: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:/) });
  expect([...worker.skills.entries()]).toEqual([['local:foo', expect.objectContaining({ calls: 1 })]]);
  expect(usage.get('xyra')).toMatchObject({ runs: 1 });
  expect(usage.get('xyra')!.tools.get('get_datetime')?.calls).toBe(1);
  expect([...usage.keys()].sort()).toEqual(['worker', 'xyra']);
});
