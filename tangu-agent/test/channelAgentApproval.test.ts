/**
 * 通道 run 的审批档 = 通道设置 × 绑定 × Agent 自己的档(设了才算)里最严的那个 —— 接线测试(真内存 SQLite + 真 loop + fake llm)。
 * 通道层(service.ts)建 run 时已把设置 × 绑定合进 agentConfig.approvalMode;这里只模拟它建出的 run 形状(input.source.channel),
 * 钉住 agentLoop 激活后按 Agent 的档收紧,且每条路径都走到:
 *   ① 普通通道消息(本体关了分身)② 多联系人通道 ③ 分身(缺省开着:自己的定义不带档,按本体的档)④ 通道里委派的子代理。
 * 对照:Agent 没设 → 照通道档;Agent 比通道松 → 仍按通道;Agent 是 custom → 只读。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ⑤ 读 Agent 定义抛错:按开关让 getAgentForRun 对某个 slug 抛(只换这一个导出,其余照真模块)
const readFail = vi.hoisted(() => ({ slug: '' }));
vi.mock('../src/agents/standIn.js', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, getAgentForRun: async (slug: string) => { if (slug === readFail.slug) throw new Error('EIO: simulated read failure'); return real.getAgentForRun(slug); } };
});
import { chmodSync, mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
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
let ws: string;

/** approval:'' = 没设档;standIn:false = 本体关掉所有通道的分身。 */
function agent(slug: string, approval: string, opts: { standIn?: boolean } = {}): void {
  const dir = join(home, 'agents', slug);
  mkdirSync(join(dir, 'Library'), { recursive: true });
  const lines = [`name = "${slug}"`];
  if (approval) lines.push(`approval_mode = "${approval}"`);
  if (opts.standIn === false) lines.push('stand_in_off = ["im", "plugin"]');
  writeFileSync(join(dir, 'config.toml'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'SOUL.md'), `You are ${slug}.`);
}

const text = (m: any): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-chagent-'));
  ws = mkdtempSync(join(tmpdir(), 'tangu-chagent-ws-')); // 引擎 home 之外:分身不许写引擎 home 底下
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      // 按对话状态出招:有工具结果 → 收尾;子代理(任务里带 SUBTASK)→ 写文件;主循环收到 go-delegate → 委派;否则写文件。
      // 相对路径 = 落在通道工作区里:只看档位,不掺越界升级(auto-edit 也免批)。后台调用(标题等)不带 onToken。
      streamProviderCompletion: async (o: any) => {
        if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
        const msgs: any[] = o.payload?.messages || [];
        if (msgs.some((m) => m.role === 'tool')) return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
        const users = msgs.filter((m) => m.role === 'user').map(text).join('\n');
        const id = Math.random().toString(36).slice(2);
        const call = !users.includes('SUBTASK') && users.includes('go-delegate')
          ? { name: 'delegate', arguments: JSON.stringify({ task: 'SUBTASK: write one file named sub.txt in the working directory and report back.' }) }
          : { name: 'write_file', arguments: JSON.stringify({ path: `${id}.txt`, content: 'x' }) };
        return { content: '', reasoning: '', toolCalls: [{ id: `c-${id}`, type: 'function', function: call }], usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop' };
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
  readFail.slug = '';
  delete process.env.TANGU_HOME;
  for (const d of [home, ws]) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
});

let seq = 0;
/**
 * 照 service.ts dispatchInbound 建出的通道 run 形状:agentConfig.approvalMode = 通道设置 × 绑定 合出的档,source.channel 标来源。
 * 审批一律拒,返回收到的审批请求。
 */
async function channelRun(slug: string, channelMode: string, opts: { message?: string; multiPeer?: boolean } = {}): Promise<any[]> {
  const sid = `S${++seq}`;
  const cfg = { agentSlug: slug, execMode: 'host', cwd: ws, approvalMode: channelMode };
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, project_path, agent_config) VALUES (?, ?, 'tangu', 't', 'm1', 'user', ?, ?)`, [sid, USER, ws, JSON.stringify({ agentSlug: slug, execMode: 'host', cwd: ws, approvalMode: 'full-auto' })]);
  const asked: any[] = [];
  const runId = `R${seq}`;
  await createRun({
    id: runId, sessionId: sid, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${seq}`,
    input: {
      message: opts.message ?? 'go', userMessageId: `U${seq}`, attachments: [], agentConfig: cfg,
      source: { channel: 'wechat', accountId: 'acc', openid: `peer-${seq}`, messageId: `M${seq}`, ...(opts.multiPeer ? { multiPeer: true } : {}) },
    },
  });
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request' || asked.some((x) => x.approvalId === ev.payload.approvalId)) return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: 'reject' });
  });
  enqueueRun(sid, runId);
  const t0 = Date.now();
  try {
    for (;;) {
      const r = await getRun(runId);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) {
        expect(r.error ?? null).toBeNull();
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

const written = (): string[] => readdirSync(ws).filter((f) => f.endsWith('.txt'));
const modes = (asked: any[]): unknown[] => asked.map((x) => x.reason?.mode);

describe('① 普通通道消息(本体,分身关着)', () => {
  it('Agent 只读、通道完全通行 → 写文件要批(只读),没批就没写', async () => {
    agent('rdo', 'readonly', { standIn: false });
    expect(modes(await channelRun('rdo', 'full-auto'))).toEqual(['readonly']);
    expect(written()).toEqual([]);
  });

  it('对照:Agent 没设档 → 照通道档(完全通行),不问就写', async () => {
    agent('plain', '', { standIn: false });
    expect(await channelRun('plain', 'full-auto')).toEqual([]);
    expect(written().length).toBe(1);
  });

  it('Agent 比通道松(完全通行 vs 通道只读)→ 仍按通道只读', async () => {
    agent('loose', 'full-auto', { standIn: false });
    expect(modes(await channelRun('loose', 'readonly'))).toEqual(['readonly']);
    expect(written()).toEqual([]);
  });

  it('Agent 是 custom → 通道里按只读', async () => {
    agent('cus', 'custom', { standIn: false });
    expect(modes(await channelRun('cus', 'auto-edit'))).toEqual(['readonly']);
    expect(written()).toEqual([]);
  });
});

describe('② 多联系人通道', () => {
  it('Agent 只读 → 只读;没设 → 照通道档', async () => {
    agent('rdo', 'readonly', { standIn: false });
    agent('plain', '', { standIn: false });
    expect(modes(await channelRun('rdo', 'full-auto', { multiPeer: true }))).toEqual(['readonly']);
    expect(written()).toEqual([]);
    expect(await channelRun('plain', 'full-auto', { multiPeer: true })).toEqual([]);
    expect(written().length).toBe(1);
  });
});

describe('③ 分身(缺省开着)', () => {
  it('本体只读 → 分身也只读(分身自己的定义不带档)', async () => {
    agent('body', 'readonly');
    expect(modes(await channelRun('body', 'full-auto', { multiPeer: true }))).toEqual(['readonly']);
    expect(written()).toEqual([]);
    // 真换成了分身(会话归分身)
    const [row] = await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [`S${seq}`]);
    expect(String(JSON.parse(row.agent_config).agentSlug)).toMatch(/^body-standin-/);
  });

  it('对照:本体没设档 → 分身照通道档', async () => {
    agent('body2', '');
    expect(await channelRun('body2', 'full-auto')).toEqual([]);
    expect(written().length).toBe(1);
  });
});

describe('④ 通道里委派的子代理', () => {
  it('Agent 只读 → 子代理写文件也按只读要批', async () => {
    agent('rdo', 'readonly', { standIn: false });
    const asked = await channelRun('rdo', 'full-auto', { message: 'go-delegate' });
    expect(modes(asked)).toEqual(['readonly']);
    expect(asked[0].name).toBe('write_file');
    expect(written()).toEqual([]);
  });

  it('对照:Agent 没设档 → 子代理照通道档直接写', async () => {
    agent('plain', '', { standIn: false });
    expect(await channelRun('plain', 'full-auto', { message: 'go-delegate' })).toEqual([]);
    expect(written().length).toBe(1);
  });
});

describe('⑤ 读 Agent 定义抛错 ≠ 没设档', () => {
  // 只有缺省 Agent 读失败时 run 还能跑下去(激活兜底到缺省身份);别的 slug 读失败 run 直接失败,本来就不会放宽
  it('读抛错 → 通道 run 按只读收紧', async () => {
    agent('xyra', '', { standIn: false });
    readFail.slug = 'xyra';
    expect(modes(await channelRun('xyra', 'full-auto'))).toEqual(['readonly']);
    expect(written()).toEqual([]);
  });

  it('对照:同一个 Agent 读得到、没设档 → 照通道档', async () => {
    agent('xyra', '', { standIn: false });
    expect(await channelRun('xyra', 'full-auto')).toEqual([]);
    expect(written().length).toBe(1);
  });
});

describe('⑥ 真实读取链:config.toml 在但读不出来 / 解析不了 ≠ 没设档', () => {
  // 注册表把这两种都吞成「没设」(激活照常成功);通道 run 用只读探针分清,按只读
  const cfgPath = (slug: string): string => join(home, 'agents', slug, 'config.toml');

  it('解析不了的 config.toml → 只读', async () => {
    agent('broken', '', { standIn: false });
    writeFileSync(cfgPath('broken'), 'name = "broken\nstand_in_off = ["im", "plugin"]\n[[[\n');
    expect(modes(await channelRun('broken', 'full-auto'))).toEqual(['readonly']);
    expect(written()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('读 config.toml 报 EACCES → 只读', async () => {
    agent('locked', '', { standIn: false });
    chmodSync(cfgPath('locked'), 0o000);
    try {
      expect(modes(await channelRun('locked', 'full-auto'))).toEqual(['readonly']);
      expect(written()).toEqual([]);
    } finally { chmodSync(cfgPath('locked'), 0o600); }
  });

  it('分身:本体的 config.toml 解析不了 → 只读', async () => {
    agent('body3', '');
    writeFileSync(cfgPath('body3'), 'name = "body3\n[[[\n');
    expect(modes(await channelRun('body3', 'full-auto', { multiPeer: true }))).toEqual(['readonly']);
    expect(written()).toEqual([]);
  });

  it('对照:读得到、没设档 → 照通道档', async () => {
    agent('fine', '', { standIn: false });
    expect(await channelRun('fine', 'full-auto')).toEqual([]);
    expect(written().length).toBe(1);
  });
});
