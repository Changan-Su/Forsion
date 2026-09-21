/**
 * 团队成员载体(services/teamRuns.ts)集成测试:真 SQLite(内存)+ 真注册表(TANGU_HOME 临时目录),mock agentLoop.enqueueRun / abortRun
 * (子 run 只落库不执行;mock 里模拟它的终态)。覆盖:工作会话首次建 kind='teamwork' + 父链接 + agent_config.agentSlug、再次复用同一条;
 * 子 run 输入形状(teamMember 段 / preset null / 临时定义 def / 成员审批档优先);先订阅再入队(事件转发到 onEvent);
 * 终态 done 读回 result.content;失败 → failed + error;团队中止 → abortRun(child) 并收成 aborted。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun, updateRunStatus } from '../src/services/runStore.js';
import { publish } from '../src/services/eventBus.js';
import { getAgent } from '../src/agents/agentRegistry.js';
import { activateMember, ensureMemberSession, memberRunConfig, TEAMWORK_KIND, type MemberActivation } from '../src/services/teamRuns.js';

vi.mock('../src/services/agentLoop.js', () => ({ enqueueRun: vi.fn(), abortRun: vi.fn() }));
import { enqueueRun, abortRun } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-teamruns-'));
  process.env.TANGU_HOME = home;
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'bo.md'), '---\nname: Bo\ncreated_by: user\n---\n你是 Bo。\n', 'utf8');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: { llm: {} } as any, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title) VALUES (?, ?, ?, ?)`, ['team-1', USER, 'tangu', 'Team']);
  (enqueueRun as any).mockReset(); (abortRun as any).mockReset();
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const base = async (over: Partial<MemberActivation> = {}): Promise<MemberActivation> => ({
  teamRunId: 'team-run-1', teamSessionId: 'team-1', userId: USER, appId: 'tangu', modelId: 'gpt-x',
  member: (await getAgent('bo'))!, inlineDef: false, delta: 'New remarks…', cycle: 1, roster: '- Bo(bo):——', teamDoc: '## Team\nx',
  execMode: 'host', cwd: '/tmp/work', approvalMode: 'auto-edit', signal: new AbortController().signal, ...over,
});

/** 模拟子 run:入队后一拍写终态 + 发 done。 */
function childFinishes(content: string, status: 'done' | 'failed' = 'done'): void {
  (enqueueRun as any).mockImplementation((_sid: string, runId: string) => {
    setTimeout(() => { void (async () => {
      if (status === 'done') { await updateRunStatus(runId, 'done', { result: { content } }); await publish(runId, 'done', { content }); }
      else { await updateRunStatus(runId, 'failed', { error: content }); await publish(runId, 'error', { error: content }); }
    })(); }, 5);
  });
}

describe('teamRuns', () => {
  it('工作会话:首次建 kind=teamwork + parent_session_id + agent_config.agentSlug;再次复用同一条(一人一条跨 run)', async () => {
    const a = await base();
    const id1 = await ensureMemberSession(a);
    const id2 = await ensureMemberSession(a);
    expect(id2).toBe(id1);
    const concurrent = await Promise.all([ensureMemberSession(a), ensureMemberSession(a)]);
    expect(concurrent).toEqual([id1, id1]);
    const rows = await query<any[]>(`SELECT kind, parent_session_id, agent_config, title FROM chat_sessions WHERE id = ?`, [id1]);
    expect(rows[0].kind).toBe(TEAMWORK_KIND);
    expect(rows[0].parent_session_id).toBe('team-1');
    expect(JSON.parse(rows[0].agent_config).agentSlug).toBe('bo');
    expect(rows[0].title).toContain('Bo');
    const all = await query<any[]>(`SELECT id FROM chat_sessions WHERE parent_session_id = ?`, ['team-1']);
    expect(all.length).toBe(1);
  });

  it('子 run 输入形状:teamMember 段(会话 / roster / teamDoc / cycle)、preset 显式 null、团队会话的审批档优先于成员定义、临时定义随 def 下发', async () => {
    const a = await base({ member: { ...(await getAgent('bo'))!, approvalMode: 'full-auto' } });
    const cfg: any = memberRunConfig(a);
    expect(cfg.agentSlug).toBe('bo');
    expect(cfg.preset).toBeNull();
    expect(cfg.approvalMode).toBe('auto-edit'); // 团队会话选了自动编辑 → Bo 定义里的 full-auto 不得借团队提权
    expect(cfg.teamMember).toMatchObject({ teamSessionId: 'team-1', teamRunId: 'team-run-1', name: 'Bo', roster: '- Bo(bo):——', teamDoc: '## Team\nx', cycle: 1 });
    expect(cfg.teamMember.def).toBeUndefined();
    expect(cfg.teamMember.followSessionMode).toBeUndefined();
    const temp: any = { slug: 'peer-1', name: 'Peer', systemPrompt: 'be a peer', approvalMode: '' };
    const cfg2: any = memberRunConfig(await base({ member: temp, inlineDef: true }));
    expect(cfg2.teamMember.def).toBe(temp);
    expect(cfg2.approvalMode).toBe('auto-edit'); // 临时成员没写 → 继承团队的
  });

  it('09-21 反馈:团队会话选了完全通行,成员 config.toml 写着 auto-edit → 子 run 仍是 full-auto;会话没设档才轮到成员定义(子 run 的 applyAgentActivation 补)', async () => {
    const member = { ...(await getAgent('bo'))!, approvalMode: 'auto-edit' as const };
    expect((memberRunConfig(await base({ member, approvalMode: 'full-auto' })) as any).approvalMode).toBe('full-auto');
    expect((memberRunConfig(await base({ member, approvalMode: undefined })) as any).approvalMode).toBeUndefined();
    // 客户端团队 run 下发「跟团队会话现读档位」的标记
    expect((memberRunConfig(await base({ followSessionMode: true })) as any).teamMember.followSessionMode).toBe(true);
  });

  it('activateMember:建会话 → createRun(输入含 delta 与 teamMember)→ onStarted 带 id → 先订阅再入队(子 run 事件转发)→ 终态 done 读回 result.content', async () => {
    childFinishes('接口好了\nDONE');
    const started: any[] = []; const forwarded: string[] = [];
    const out = await activateMember(await base({ onStarted: (ids) => started.push(ids), onEvent: (ev) => forwarded.push(ev.type) }));
    expect(out.status).toBe('done');
    expect(out.text).toBe('接口好了\nDONE');
    expect(started.length).toBe(1);
    expect(out.runId).toBe(started[0].runId);
    expect(out.sessionId).toBe(started[0].sessionId);
    expect((enqueueRun as any).mock.calls[0]).toEqual([started[0].sessionId, started[0].runId]);
    expect(forwarded).toContain('done');
    const run = await getRun(started[0].runId);
    const input = typeof run!.input === 'string' ? JSON.parse(run!.input) : run!.input;
    expect(input.message).toBe('New remarks…');
    expect(input.agentConfig.teamMember.teamSessionId).toBe('team-1');
    expect(input.agentConfig.cwd).toBe('/tmp/work');
    expect(run!.session_id).toBe(started[0].sessionId);
    // 第二次激活:同一条工作会话,新 run
    childFinishes('second');
    const out2 = await activateMember(await base());
    expect(out2.sessionId).toBe(out.sessionId);
    expect(out2.runId).not.toBe(out.runId);
    expect(out2.text).toBe('second');
  });

  it('followSessionMode:激活时按团队会话此刻的档写成员会话与子 run(团队 run 启动后才切的「完全通行」也跟上)', async () => {
    await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'team-1'`, [JSON.stringify({ approvalMode: 'full-auto' })]);
    childFinishes('ok');
    const started: any[] = [];
    await activateMember(await base({ approvalMode: 'auto-edit', followSessionMode: true, onStarted: (ids) => started.push(ids) }));
    const run = await getRun(started[0].runId);
    const input = typeof run!.input === 'string' ? JSON.parse(run!.input) : run!.input;
    expect(input.agentConfig.approvalMode).toBe('full-auto');
    const [row] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [started[0].sessionId]);
    expect(JSON.parse(row.agent_config).approvalMode).toBe('full-auto');
    // 没有标记(TUI / 通道起的团队 run):照快照,不读团队会话存值
    childFinishes('ok');
    const started2: any[] = [];
    await activateMember(await base({ approvalMode: 'auto-edit', onStarted: (ids) => started2.push(ids) }));
    const run2 = await getRun(started2[0].runId);
    expect((typeof run2!.input === 'string' ? JSON.parse(run2!.input) : run2!.input).agentConfig.approvalMode).toBe('auto-edit');
  });

  it('子 run 失败 → failed + error(绝不 reject)', async () => {
    childFinishes('boom', 'failed');
    const out = await activateMember(await base());
    expect(out.status).toBe('failed');
    expect(out.error).toBe('boom');
  });

  it('团队中止 → abortRun(child) 被调,子 run 收尾后收成 aborted', async () => {
    (enqueueRun as any).mockImplementation(() => { /* 子 run 一直跑着 */ });
    (abortRun as any).mockImplementation((runId: string) => {
      setTimeout(() => { void (async () => { await updateRunStatus(runId, 'aborted', { error: 'aborted' }); await publish(runId, 'error', { error: 'aborted', aborted: true }); })(); }, 5);
    });
    const ac = new AbortController();
    const p = activateMember(await base({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    const out = await p;
    expect(out.status).toBe('aborted');
    expect((abortRun as any).mock.calls[0][0]).toBe(out.runId);
  });
});


describe('legacy team output recovery', () => {
  it('recovers only announced child outputs, deduplicates concurrent loads, preserves deletions and session ordering', async () => {
    const { recoverTeamOutputs } = await import('../src/services/teamOutputs.js');
    const a = await base();
    const childId = await ensureMemberSession(a);
    await query("INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES ('user-legacy', 'team-1', 'user', 'draw', 1)");
    await createRun({ id: 'legacy-parent', sessionId: 'team-1', userId: USER, appId: 'tangu', modelId: 'm', assistantMessageId: 'unused', input: { userMessageId: 'user-legacy' } });
    const makeChild = async (id: string) => {
      await createRun({ id, sessionId: childId, userId: USER, appId: 'tangu', modelId: 'm', assistantMessageId: id + '-msg', input: {} });
      await publish(id, 'tool_call', { id: 'card', name: 'sketch', arguments: JSON.stringify({ html: '<h1>' + id + '</h1>' }) });
      await publish(id, 'tool_result', { id: 'card', result: 'Sketch card rendered.' });
      await publish(id, 'display_file', { name: 'report.pdf', path: '/tmp/report.pdf' });
    };
    await makeChild('announced');
    await makeChild('private-followup');
    await publish('legacy-parent', 'team_member', { phase: 'start', runId: 'announced', sessionId: childId, slug: 'bo', name: 'Bo' });
    await updateRunStatus('legacy-parent', 'done');
    await query("UPDATE chat_sessions SET updated_at = '2020-01-01 00:00:00' WHERE id = 'team-1'");
    await Promise.all([recoverTeamOutputs('team-1', USER), recoverTeamOutputs('team-1', USER)]);
    const rows = await query<any[]>("SELECT * FROM chat_messages WHERE session_id = 'team-1' AND role = 'model'");
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).toContain('announced');
    expect(JSON.stringify(rows)).not.toContain('private-followup');
    expect(JSON.parse(rows.find((r) => JSON.parse(r.display_files).length).display_files)[0].sourceSessionId).toBe(childId);
    expect((await query<any[]>("SELECT updated_at FROM chat_sessions WHERE id = 'team-1'"))[0].updated_at).toContain('2020-01-01');
    await query("DELETE FROM chat_messages WHERE session_id = 'team-1' AND role = 'model'");
    await recoverTeamOutputs('team-1', USER);
    expect(await query<any[]>("SELECT id FROM chat_messages WHERE session_id = 'team-1' AND role = 'model'")).toHaveLength(0);
  });
  it('does not restore rewound turns or read another owner', async () => {
    const { recoverTeamOutputs } = await import('../src/services/teamOutputs.js');
    await createRun({ id: 'deleted-parent', sessionId: 'team-1', userId: USER, appId: 'tangu', modelId: 'm', assistantMessageId: 'unused', input: { userMessageId: 'gone' } });
    await publish('deleted-parent', 'team_member', { phase: 'start', runId: 'untrusted' });
    await updateRunStatus('deleted-parent', 'done');
    await recoverTeamOutputs('team-1', 'other-user');
    expect(await query<any[]>("SELECT id FROM agent_run_events WHERE type = 'team_output_mode'")).toHaveLength(0);
    await recoverTeamOutputs('team-1', USER);
    expect(await query<any[]>("SELECT id FROM chat_messages WHERE session_id = 'team-1'")).toHaveLength(0);
  });
});
