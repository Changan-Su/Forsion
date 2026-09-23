/**
 * 会话没存审批档时,引擎按「当前 Agent 定义」的档跑(applyAgentActivation 补会话缺省的键)—— 桌面药丸照同一条链显示
 * (Composer2:会话存值 → 当前 Agent 定义 → 替我批准)。09-22 反馈:私聊会话由引擎建、不带审批档,药丸兜底显示「替我批准」,
 * 引擎却按该 Agent 设的「只读」逐次弹审批。引擎这条优先级是设计如此(会话显式档 > Agent 缺省),本文件把它钉住:
 * 谁改了引擎的回退口径,得同时改桌面药丸的显示回退,否则药丸又会谎报。真内存 SQLite + 真 loop + fake llm。
 *   ① 私聊刚建 / 新会话(没存档):按 Agent 的只读问;
 *   ② 用户在药丸上切过档(存值):会话档压过 Agent 缺省;
 *   ③ 团队运行模式(会话没存档):成员跟的是会话钉住的那个 Agent 的缺省(团队 run 激活后下发),不是成员自己的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
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

const USER = 'u1';
let home: string;
let lib: string;

function agent(slug: string, approval: string): string {
  const dir = join(home, 'agents', slug);
  mkdirSync(join(dir, 'Library'), { recursive: true });
  writeFileSync(join(dir, 'config.toml'), `name = "${slug}"\napproval_mode = "${approval}"\n`);
  writeFileSync(join(dir, 'SOUL.md'), `You are ${slug}.`);
  return join(dir, 'Library');
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-agentdefault-'));
  process.env.TANGU_HOME = home;
  lib = agent('rdo', 'readonly');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      // 主循环(带 onToken)按对话状态出招:还没有工具结果 → 在工作区里写一个文件;有了 → 收尾(DONE 同时是团队成员的「我这边完了」)。
      // 按状态而不是按脚本序:团队成员并行跑,调用次序不定。后台调用(Historian 标题 / 团队摘要)不带 onToken。
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        if ((o.payload?.messages || []).some((m: any) => m.role === 'tool')) return { content: 'ok\nDONE', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
        const id = Math.random().toString(36).slice(2);
        return {
          content: '', reasoning: '',
          // 相对路径 = 落在本 run 自己的工作区(私聊 = Agent 的 Library,成员 = 团队目录):只看档位,不掺越界升级
          toolCalls: [{ id: `w-${id}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `${id}.txt`, content: 'x' }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
        };
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const session = (id: string, cfg: Record<string, unknown>): Promise<unknown> =>
  query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES (?, ?, 'tangu', 't', 'm1', 'user', 1, ?)`, [id, USER, JSON.stringify(cfg)]);
const stored = async (id: string): Promise<any> => JSON.parse((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [id]))[0].agent_config);

/** 输入区发起的 run(POST /agent/runs 的形状;agentConfig = 桌面随 run 发的本地会话配置 ≈ 存值)。审批一律拒,返回收到的审批请求。 */
let seq = 0;
async function run(sessionId: string): Promise<any[]> {
  const asked: any[] = [];
  const runId = `R${++seq}`;
  await createRun({
    id: runId, sessionId, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${seq}`,
    input: { message: 'go', userMessageId: `U${seq}`, attachments: [], agentConfig: await stored(sessionId), client: 'desktop/2.11.3', origin: 'client' },
  });
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request' || asked.some((x) => x.approvalId === ev.payload.approvalId)) return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: 'reject' });
  });
  enqueueRun(sessionId, runId);
  const t0 = Date.now();
  try {
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) {
        expect(r.status).toBe('done');
        return asked;
      }
      if (Date.now() - t0 > 20_000) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally {
    off();
  }
}

// 与 routes/solo.ts resolveSolo 建的会话同形:不带 approvalMode
const solo = (): Record<string, unknown> => ({ soloAgentSlug: 'rdo', agentSlug: 'rdo', execMode: 'host', cwd: lib, preset: null });

describe('会话没存审批档 → 按当前 Agent 定义的档', () => {
  it('① 私聊刚建:Agent 设了只读 → 自己 Library 里写也要批(桌面药丸须显示「询问我批准」)', async () => {
    await session('S', solo());
    const asked = await run('S');
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'mode', mode: 'readonly' }]);
  });

  it('② 药丸上切过「替我批准」(存值)→ 会话档压过 Agent 的只读', async () => {
    await session('S', { ...solo(), approvalMode: 'auto-edit' });
    expect(await run('S')).toEqual([]);
    expect(readdirSync(lib).filter((f) => f.endsWith('.txt')).length).toBe(1);
  });

  it('③ 团队运行模式、会话没存档:成员跟会话钉住的 Agent(只读),不跟成员自己的完全放行', async () => {
    agent('m1', 'full-auto'); agent('m2', 'full-auto');
    const grp = join(home, 'grp');
    mkdirSync(grp, { recursive: true });
    await session('G', { agentSlug: 'rdo', groupChat: true, groupAgents: ['m1', 'm2'], execMode: 'host', cwd: grp, preset: null });
    const asked = await run('G');
    expect(asked.length).toBe(2);
    expect(asked.map((x) => x.reason?.mode)).toEqual(['readonly', 'readonly']);
  });
});
