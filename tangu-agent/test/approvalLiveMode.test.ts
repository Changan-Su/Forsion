/**
 * 审批档现读会话存值(09-21 Windows 反馈:团队会话选了「完全通行」依然逐次弹审批,工作区内的写入被当成越界):
 * 团队 run 一跑几小时,成员子 run 各自冻着启动那刻的档 —— 用户中途切档整场不动。真内存 SQLite + 真 loop + fake llm,钉四件:
 *   ① 客户端发起的 run:快照 auto-edit、会话存值已是 full-auto → 越界写不弹;
 *   ② run 中途把会话切到 full-auto → 下一次工具调用当场生效;
 *   ③ 不是输入区直接发起的 run(通道 / 自动化 / 带着继承来的 desktop 标签的派生 run)只认自己的快照,绝不被会话存值放开;
 *   ④ 团队成员子 run 带 followSessionMode → 跟团队会话;不带 → 快照。
 *   ⑤ 团队成员一律听团队会话(子聊天里直接追问也算,老成员会话没标记也算):成员会话里上次激活抄过去的旧档不作数(Codex 09-21 P1);
 *   ⑥ 现读失败 → 按只读问,绝不回落到可能更宽的启动快照;custom 的 deny 照样生效(Codex 09-21 两轮);
 *   ⑦ run 起跑时补 preset / agentSlug 的那次回写不许把期间切的档整份盖回去(Codex 09-21 P1)。
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
import { enqueueRun, approvalModeSessionId } from '../src/services/agentLoop.js';

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
let toolResults: Array<{ name: string; result: string }> = []; // 最近一次 run() 的工具结果
async function run(agentConfig: Record<string, any>, fromClient: boolean, onApproval: (p: any) => Promise<'approve' | 'reject'> = async () => 'reject'): Promise<any[]> {
  const asked: any[] = [];
  const runId = `R${++runSeq}`; // 事件总线按 runId 留回放,复用同一个 id 会把上一条 run 的审批再收一遍
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
    input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: { execMode: 'host', cwd: ws, approvalMode: 'auto-edit', ...agentConfig }, client: 'desktop/2.11.2', ...(fromClient ? { origin: 'client' } : {}) },
  });
  toolResults = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type === 'tool_result') toolResults.push({ name: String(ev.payload?.name), result: String(ev.payload?.result) });
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

  it('⑤ 团队成员只听团队会话:团队已降到自动编辑、成员会话还存着上次激活抄过去的完全通行 → 照问;老成员会话没标记、子聊天里直接追问也听团队', async () => {
    await setStoredMode('T', 'auto-edit'); await setStoredMode('S', 'full-auto');
    script = [writeStep('a.txt'), finalStep()];
    const asked = await run({ teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo', followSessionMode: true } }, true);
    expect(asked.length).toBe(1);
    expect(asked[0].reason).toMatchObject({ kind: 'escalate', mode: 'auto-edit' });
    script = [writeStep('b.txt'), finalStep()];
    expect((await run({ teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo' } }, true)).length).toBe(1); // 2.11.2 建的成员会话没有 followSessionMode
    // 成员会话里存的档不参与判定(子聊天里单独调严不作数,桌面侧另做钳制):团队完全通行就放行
    await setStoredMode('T', 'full-auto'); await setStoredMode('S', 'readonly');
    script = [writeStep('c.txt'), finalStep()];
    expect(await run({ teamMember: { teamSessionId: 'T', name: 'Bo', roster: '- Bo', followSessionMode: true } }, true)).toEqual([]);
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

  it('⑥b 读失败兜底不绕过 custom:deny 照拒(只读档本身管不到 list_dir),allow 不放行(越界写照问)', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: { base: 'full-auto', allow: ['write_file'], ask: [], deny: ['list_dir'] } }));
    await setStoredMode('S', 'custom');
    script = [async () => {
      await query(`UPDATE chat_sessions SET agent_config = ? WHERE id = 'S'`, ['{not json']);
      return { content: '', reasoning: '', toolCalls: [{ id: 'ls1', type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: ws }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' };
    }, writeStep('a.txt'), finalStep()];
    const asked = await run({ approvalMode: 'custom' }, true);
    expect(toolResults.find((r) => r.name === 'list_dir')?.result).toContain('Denied by approval rule: list_dir');
    expect(asked.map((x) => x.name)).toEqual(['write_file']);
    expect(asked[0].reason?.mode).toBe('readonly');
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

  it('approvalModeSessionId:团队成员听团队(引擎起的要带标记,子聊天里直接追问不必);其余输入区发起的跟本会话;非输入区与沙箱不跟', () => {
    const base = { execMode: 'host', sessionId: 'S', fromClient: false };
    expect(approvalModeSessionId({ ...base, fromClient: true })).toBe('S');
    expect(approvalModeSessionId(base)).toBeUndefined();
    expect(approvalModeSessionId({ ...base, execMode: 'sandbox', fromClient: true })).toBeUndefined();
    expect(approvalModeSessionId({ ...base, teamMember: { teamSessionId: 'T', followSessionMode: true } })).toBe('T');
    expect(approvalModeSessionId({ ...base, teamMember: { teamSessionId: 'T' } })).toBeUndefined(); // TUI / 通道起的团队 run
    expect(approvalModeSessionId({ ...base, fromClient: true, teamMember: { teamSessionId: 'T' } })).toBe('T');
    expect(approvalModeSessionId({ ...base, fromClient: true, teamMember: { teamSessionId: 'T', followSessionMode: true } })).toBe('T');
  });
});
