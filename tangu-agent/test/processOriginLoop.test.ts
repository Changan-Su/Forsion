/**
 * P1 · K2 §3.7 × 真 loop(内存 SQLite + 真 agentLoop + 脚本化 fake llm):后台进程的来源标签取**这条 run 自己**的引擎自写字段
 * (与 runCategory 同口径),不取会话级的 channelSession 旗标。
 *   会话连着微信(tangu_wechat_bindings 活跃绑定)时,用户在桌面上敲的 run 仍是本机 run:它起的 dev server 标 local,
 *   急停(killProcessesWhere(p => p.origin !== 'local' …))不杀;同一会话里真从微信来的 run(input.source.channel)标 channel。
 * 负对照(独立评审 P2,实跑记在 K2 交付报告):processOriginOf 仍看 ctx.channelSession → 本机 run 的进程被标 channel,第一条红。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { enqueueRun } from '../src/services/agentLoop.js';
import { channelHub } from '../src/channels/hub.js';
import { listProcesses, disposeAllProcesses } from '../src/tools/processRegistry.js';

const USER = 'u1';
let home: string;
let script: Array<() => any>;

const bg = (cmd: string) => () => ({ content: '', reasoning: '', toolCalls: [{ id: `bg-${Math.random()}`, type: 'function', function: { name: 'run_background', arguments: JSON.stringify({ command: cmd }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' });
const final = (text = 'ok') => () => ({ content: text, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-proc-origin-'));
  process.env.TANGU_HOME = home;
  script = [];
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        return (script.shift() ?? final('script exhausted'))();
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  // 这个会话连着微信
  await query(`INSERT INTO tangu_wechat_bindings (id, user_id, channel, account_id, peer_id, session_id, is_active) VALUES ('b1', ?, 'wechat', 'acc', 'peer', 'S', TRUE)`, [USER]);
});
afterEach(() => disposeAllProcesses());
afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
async function run(extra: Record<string, unknown>): Promise<string> {
  const runId = `PO${++seq}`;
  await createRun({
    id: runId, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `${runId}-a`,
    input: { message: 'go', userMessageId: `${runId}-u`, attachments: [], agentConfig: { execMode: 'host', cwd: home, approvalMode: 'full-auto' }, ...extra },
  });
  const off = subscribe(runId, (ev) => { if (ev.type === 'approval_request') resolveApproval(ev.payload.approvalId, { action: 'approve' }); });
  enqueueRun('S', runId);
  const t0 = Date.now();
  try {
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) { expect(r.status).toBe('done'); return runId; }
      if (Date.now() - t0 > 15_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally { off(); }
}

describe('后台进程来源 × 连着通道的会话', () => {
  it('会话连着微信,用户在桌面敲的 run 起的进程标 local(不是 channel);同会话里微信来的 run 起的标 channel', async () => {
    expect(await channelHub.isChannelSession(USER, 'S')).toBe(true); // 前提:会话级旗标为真
    script = [bg('sleep 30'), final()];
    const local = await run({ origin: 'client' });
    script = [bg('sleep 31'), final()];
    const fromWechat = await run({ source: { channel: 'wechat', accountId: 'acc', openid: 'peer', messageId: 'm1' } });
    const procs = listProcesses('S').map((p) => [p.runId, p.origin, p.command]);
    expect(procs).toEqual(expect.arrayContaining([[local, 'local', 'sleep 30'], [fromWechat, 'channel', 'sleep 31']]));
    expect(procs).toHaveLength(2);
  }, 40_000);
});
