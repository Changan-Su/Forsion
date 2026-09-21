/**
 * 审批档现读会话存值(09-21 Windows 反馈:团队会话选了「完全通行」依然逐次弹审批,工作区内的写入被当成越界):
 * 团队 run 一跑几小时,成员子 run 各自冻着启动那刻的档 —— 用户中途切档整场不动。真内存 SQLite + 真 loop + fake llm,钉四件:
 *   ① 客户端发起的 run:快照 auto-edit、会话存值已是 full-auto → 越界写不弹;
 *   ② run 中途把会话切到 full-auto → 下一次工具调用当场生效;
 *   ③ 不是输入区直接发起的 run(通道 / 自动化 / 带着继承来的 desktop 标签的派生 run)只认自己的快照,绝不被会话存值放开;
 *   ④ 团队成员子 run 带 followSessionMode → 跟团队会话;不带 → 快照。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { resolveApproval } from '../src/services/approvals.js';
import { enqueueRun, approvalModeSessionId } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
let ws: string;
let outside: string;
let script: Array<() => any>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-livemode-'));
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  outside = join(home, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  script = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      // 只有主循环带 onToken;Historian 起标题等后台调用不吃脚本(否则上一条 run 的后台调用会偷走下一条的出招)。
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        const step = script.shift();
        if (!step) throw new Error('脚本耗尽');
        return step();
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  for (const id of ['S', 'T']) {
    await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [id, USER]);
  }
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const setStoredMode = (sessionId: string, approvalMode: string): Promise<unknown> =>
  query(`UPDATE chat_sessions SET agent_config = ? WHERE id = ?`, [JSON.stringify({ approvalMode }), sessionId]);
const writeStep = (file: string) => () => ({
  content: '', reasoning: '',
  toolCalls: [{ id: `w-${file}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: join(outside, file), content: 'x' }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
});
const finalStep = () => () => ({ content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });

/** 跑一个 run 到终态;每条 approval_request 交给 onApproval 决定(缺省拒绝),返回收到的审批请求。
 *  fromClient = POST /agent/runs 的形状(origin:'client' + client 标签);否则只带 client 标签 —— 派生 run 从 createRun 继承到的就是这个。 */
let runSeq = 0;
async function run(agentConfig: Record<string, any>, fromClient: boolean, onApproval: (p: any) => Promise<'approve' | 'reject'> = async () => 'reject'): Promise<any[]> {
  const asked: any[] = [];
  const runId = `R${++runSeq}`; // 事件总线按 runId 留回放,复用同一个 id 会把上一条 run 的审批再收一遍
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'auto-edit', ...agentConfig }, client: 'desktop/2.11.2', ...(fromClient ? { origin: 'client' } : {}) },
  });
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request') return;
    asked.push(ev.payload);
    void onApproval(ev.payload).then((action) => resolveApproval(ev.payload.approvalId, { action }));
  });
  enqueueRun('S', runId);
  const t0 = Date.now();
  try {
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) {
        expect(r.status).toBe('done');
        return asked;
      }
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally {
    off();
  }
}

describe('审批档现读会话存值', () => {
  it('① 客户端 run:快照 auto-edit、会话已是 full-auto → 越界写直接放行', async () => {
    await setStoredMode('S', 'full-auto');
    script = [writeStep('a.txt'), finalStep()];
    expect(await run({}, true)).toEqual([]);
    expect(existsSync(join(outside, 'a.txt'))).toBe(true);
  });

  it('② run 中途把会话切到 full-auto → 下一次越界写不再问', async () => {
    await setStoredMode('S', 'auto-edit');
    script = [writeStep('a.txt'), writeStep('b.txt'), finalStep()];
    const asked = await run({}, true, async () => { await setStoredMode('S', 'full-auto'); return 'approve'; });
    expect(asked.length).toBe(1);
    expect(asked[0].reason).toMatchObject({ kind: 'escalate', mode: 'auto-edit' });
    expect(existsSync(join(outside, 'b.txt'))).toBe(true);
  });

  it('③ 非输入区发起的 run(哪怕继承了 desktop 标签)只认快照:会话存值 full-auto 也照问', async () => {
    await setStoredMode('S', 'full-auto');
    script = [writeStep('a.txt'), finalStep()];
    const asked = await run({}, false);
    expect(asked.length).toBe(1);
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
  });

  it('④ 团队成员子 run:followSessionMode → 跟团队会话 T 的 full-auto;不带标记 → 快照 auto-edit 照问', async () => {
    await setStoredMode('T', 'full-auto');
    script = [writeStep('a.txt'), finalStep()];
    expect(await run({ teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo', followSessionMode: true } }, false)).toEqual([]);
    script = [writeStep('b.txt'), finalStep()];
    expect((await run({ teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo' } }, false)).length).toBe(1);
  });

  it('approvalModeSessionId:输入区发起的跟本会话、带标记的团队成员跟团队会话;其余与沙箱一律不跟', () => {
    const base = { execMode: 'host', sessionId: 'S', fromClient: false };
    expect(approvalModeSessionId({ ...base, fromClient: true })).toBe('S');
    expect(approvalModeSessionId(base)).toBeUndefined();
    expect(approvalModeSessionId({ ...base, execMode: 'sandbox', fromClient: true })).toBeUndefined();
    expect(approvalModeSessionId({ ...base, teamMember: { teamSessionId: 'T', followSessionMode: true } })).toBe('T');
    expect(approvalModeSessionId({ ...base, teamMember: { teamSessionId: 'T' } })).toBeUndefined();
    // 成员会话里直接追问(输入区发起):听这个输入区的
    expect(approvalModeSessionId({ ...base, fromClient: true, teamMember: { teamSessionId: 'T', followSessionMode: true } })).toBe('S');
  });
});
