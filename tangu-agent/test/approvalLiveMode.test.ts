/**
 * 审批档现读会话存值(09-21 Windows 反馈:团队会话选了「完全通行」依然逐次弹审批,工作区内的写入被当成越界):
 * 团队 run 一跑几小时,成员子 run 各自冻着启动那刻的档 —— 用户中途切档整场不动。真内存 SQLite + 真 loop + fake llm,钉四件:
 *   ① 客户端发起的 run:快照 auto-edit、会话存值已是 full-auto → 越界写不弹;
 *   ② run 中途把会话切到 full-auto → 下一次工具调用当场生效;
 *   ③ 不是输入区直接发起的 run(通道 / 自动化 / 带着继承来的 desktop 标签的派生 run)只认自己的快照,绝不被会话存值放开;
 *   ④ 团队成员子 run 带 followSessionMode → 跟团队会话;不带 → 快照。
 *   ⑤ 团队成员取 [团队会话, 成员会话] 里最严的:团队降档压过成员会话里的旧宽档,成员子聊天单独调严也算数(Codex 09-21 P1);
 *   ⑥ 现读失败 → 按只读问,绝不回落到可能更宽的启动快照(Codex 09-21 P1);
 *   ⑦ run 起跑时补 preset / agentSlug 的那次回写不许把期间切的档整份盖回去(Codex 09-21 P1);
 *   ⑧ 最严比较里 custom 按它的 base 算:团队 custom(base=full-auto)压不过成员子聊天里的自动编辑。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { resolveApproval } from '../src/services/approvals.js';
import { enqueueRun, approvalModeSessionIds } from '../src/services/agentLoop.js';

const USER = 'u1';
let home: string;
let ws: string;
let outside: string;
let script: Array<() => any | Promise<any>>;

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

  it('⑤ 团队成员取最严:团队已降到自动编辑、成员会话还是上次激活写进去的完全通行 → 照问;团队完全通行、成员子聊天调成只读 → 也照问', async () => {
    const member = { teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo', followSessionMode: true } };
    await setStoredMode('T', 'auto-edit'); await setStoredMode('S', 'full-auto');
    script = [writeStep('a.txt'), finalStep()];
    const asked = await run(member, true); // 成员子聊天里直接追问 = 输入区发起 + 带着成员标记
    expect(asked.length).toBe(1);
    expect(asked[0].reason).toMatchObject({ kind: 'escalate', mode: 'auto-edit' });
    await setStoredMode('T', 'full-auto'); await setStoredMode('S', 'readonly');
    script = [writeStep('b.txt'), finalStep()];
    expect((await run(member, true))[0]?.reason?.mode).toBe('readonly');
  });

  it('⑥ 会话配置读不出来 → 按只读问,不回落到启动快照的完全通行', async () => {
    // run 起跑时配置是好的(坏配置在起跑处另有闸);模型发出写调用的这一轮才把它弄坏,只打审批闸现读那一下。
    await setStoredMode('S', 'full-auto');
    script = [async () => { await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, ['{not json']); return writeStep('a.txt')(); }, finalStep()];
    const asked = await run({ approvalMode: 'full-auto' }, true);
    expect(asked.length).toBe(1);
    expect(asked[0].reason?.mode).toBe('readonly');
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
  });

  it('⑦ 起跑补 preset 的回写与用户切档撞车:切成只读的档不许被旧对象盖回完全通行', async () => {
    // 老会话缺 preset 键 → runLoop 读存值、数消息(await)、再回写补丁;用户恰在数消息那一下切了档。
    await setStoredMode('S', 'full-auto');
    const state: any = deps().state;
    const count = state.countSessionMessages.bind(state);
    let fired = false; // 只撞第一次(起跑那次);之后 Historian 等也会数消息,别让桩反复写
    state.countSessionMessages = async (sid: string) => {
      if (!fired) {
        fired = true;
        const [r] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = 'S'`);
        await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, [JSON.stringify({ ...JSON.parse(r.agent_config), approvalMode: 'readonly' })]);
      }
      return count(sid);
    };
    script = [finalStep()];
    try { await run({ approvalMode: 'full-auto' }, true); } finally { state.countSessionMessages = count; }
    const [row] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = 'S'`);
    expect(JSON.parse(row.agent_config)).toMatchObject({ approvalMode: 'readonly', preset: null });
  });

  it('⑧ 团队选 custom 且 base 是 full-auto、成员子聊天调成自动编辑 → 按自动编辑问(custom 按 base 算宽度)', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: { base: 'full-auto', allow: [], ask: [], deny: [] } }));
    const member = { teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo', followSessionMode: true } };
    await setStoredMode('T', 'custom'); await setStoredMode('S', 'auto-edit');
    script = [writeStep('a.txt'), finalStep()];
    const asked = await run(member, true);
    expect(asked.length).toBe(1);
    expect(asked[0].reason).toMatchObject({ kind: 'escalate', mode: 'auto-edit' });
    // 反过来:成员子聊天也是 custom → 平手留 custom(base full-auto)→ 不问
    await setStoredMode('S', 'custom');
    script = [writeStep('b.txt'), finalStep()];
    expect(await run(member, true)).toEqual([]);
  });

  it('approvalModeSessionIds:带标记的团队成员 = [团队, 成员];其余输入区发起的跟本会话;非输入区与沙箱一律不跟', () => {
    const base = { execMode: 'host', sessionId: 'S', fromClient: false };
    expect(approvalModeSessionIds({ ...base, fromClient: true })).toEqual(['S']);
    expect(approvalModeSessionIds(base)).toBeUndefined();
    expect(approvalModeSessionIds({ ...base, execMode: 'sandbox', fromClient: true })).toBeUndefined();
    expect(approvalModeSessionIds({ ...base, teamMember: { teamSessionId: 'T', followSessionMode: true } })).toEqual(['T', 'S']);
    expect(approvalModeSessionIds({ ...base, fromClient: true, teamMember: { teamSessionId: 'T', followSessionMode: true } })).toEqual(['T', 'S']);
    expect(approvalModeSessionIds({ ...base, teamMember: { teamSessionId: 'T' } })).toBeUndefined();
  });
});
