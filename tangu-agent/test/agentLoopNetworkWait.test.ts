/**
 * 主 loop「等待网络」仪器(中断任务续跑方案 6.7,11-20):
 *   ① 首帧前 ENOTFOUND × 7(超过 3 次 / 6 次两种上限):每次探网确认断了就等,不扣次数,网回来同一轮接着发 → done
 *   ② 等网时用户点停 → aborted(不等满 30 分钟)
 *   ③ 中流断线 × 4(超过 MIDSTREAM_MAX_RESUMES=3):探网确认断过的续写不扣次数 → done
 * 结构照抄 agentLoopFinishGates.test.ts:真内存 SQLite + 真 loop,fake llm 按脚本逐轮出招;探网换成脚本里的开关。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { enqueueRun, abortRun } from '../src/services/agentLoop.js';
import { subscribe } from '../src/services/eventBus.js';
import { __setNetworkProbeForTests } from '../src/llm/netWait.js';

const USER = 'u1';
let home: string;
let llmPayloads: any[];
let script: Array<(o: any) => any>;
/** 探网的开关:false = 断网。每次探网之后由 onProbe 决定下一次。 */
let online = true;
let probes = 0;
let onProbe: (() => void) | undefined;
/** buildProviderPayload 的出招:有就先执行(可抛),再照常返回 payload。 */
let buildScript: Array<() => void>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-netwait-'));
  process.env.TANGU_HOME = home;
  llmPayloads = [];
  script = [];
  online = true;
  probes = 0;
  onProbe = undefined;
  buildScript = [];
  __setNetworkProbeForTests(async () => { probes++; const r = online; onProbe?.(); return r; }, 10);

  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeLlm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'https://api.example.com/v1', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => { buildScript.shift()?.(); return { messages: o.messages.map((m: any) => ({ ...m })) }; },
    streamProviderCompletion: async (o: any) => {
      llmPayloads.push(o.payload);
      const step = script.shift();
      if (!step) throw new Error(`脚本耗尽:第 ${llmPayloads.length} 次 LLM 调用没有出招`);
      return step(o);
    },
  };
  configureTangu({
    host,
    brain: { llm: fakeLlm, users: { getUserById: async () => ({ id: USER, username: 'u' }) }, memory: { getMemory: async () => ({ content: '' }) }, models: { hasDirectModel: () => false } } as any,
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  __setNetworkProbeForTests(null);
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const finalStep = (content: string) => () => ({ content, reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' });
/** 断网:DNS 解析不了(undici 原样形状)。同时把探网拨成「断」,探一次后恢复。 */
const offlineStep = () => () => {
  online = false;
  onProbe = () => { online = true; onProbe = undefined; };
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'api.example.com' }) });
};
/** 吐了半句后连接被重置(中流断线没有 ENOTFOUND 这类码,只能靠探网认)。 */
const midstreamDropStep = (text: string) => (o: any) => {
  o.onToken?.(text);
  online = false;
  onProbe = () => { online = true; onProbe = undefined; };
  throw new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }) });
};

async function runToSettled(timeoutMs = 15_000): Promise<{ run: any; statuses: any[] }> {
  const statuses: any[] = [];
  const off = subscribe('R1', (ev) => { if (ev.type === 'status') statuses.push(ev.payload); });
  try {
    await createRun({
      id: 'R1', sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: {} },
    });
    enqueueRun('S', 'R1');
    const t0 = Date.now();
    for (;;) {
      const r = await getRun('R1');
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return { run: r, statuses };
      if (Date.now() - t0 > timeoutMs) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally { off(); }
}

describe('等待网络 · 首帧前', () => {
  it('ENOTFOUND × 7 → 每次等网(不扣次数),第 8 次成功,同一个 run done', async () => {
    script = [...Array.from({ length: 7 }, offlineStep), finalStep('网回来了，接着做完。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(8);
    const waits = statuses.filter((s) => s.phase === 'llm_wait_network');
    const backs = statuses.filter((s) => s.phase === 'llm_network_back');
    expect(waits.length).toBe(7);
    expect(backs.length).toBe(7);
    expect(statuses.filter((s) => s.phase === 'llm_retry').length).toBe(0); // 一次都没算进重试次数
    expect(waits[0]).toMatchObject({ stage: 'request', since: expect.any(Number), error: 'fetch failed' });
    expect(backs[0]).toMatchObject({ stage: 'request', waitedMs: expect.any(Number) });
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
    expect(rows.map((r) => String(r.content)).join('\n')).toContain('网回来了');
  }, 20_000);

  it('负对照:报错像断网但探得通 → 照常扣次数,4 次后失败', async () => {
    script = Array.from({ length: 4 }, () => () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND', hostname: 'api.example.com' }) }); });
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('failed');
    expect(llmPayloads.length).toBe(4);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network').length).toBe(0);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1, 2, 3]);
  }, 20_000);

  it('等网时用户点停 → aborted,不等满 30 分钟', async () => {
    script = [() => {
      online = false; // 一直断
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND', hostname: 'api.example.com' }) });
    }];
    const off = subscribe('R1', (ev) => { if (ev.type === 'status' && ev.payload?.phase === 'llm_wait_network') setTimeout(() => abortRun('R1', { byUser: true }), 50); });
    try {
      const t0 = Date.now();
      const { run } = await runToSettled();
      expect(run.status).toBe('aborted');
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(llmPayloads.length).toBe(1);
      expect(probes).toBeGreaterThan(1); // 确实在等(探了不止一次)
    } finally { off(); }
  }, 20_000);
});

describe('等待网络 · build-payload', () => {
  it('build-payload 断网 × 4(超过 3 次上限)→ 每次等网,不扣次数,run done', async () => {
    buildScript = Array.from({ length: 4 }, offlineStep);
    script = [finalStep('上下文送出去了。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(1);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network' && s.stage === 'build_payload').length).toBe(4);
    expect(statuses.filter((s) => s.phase === 'llm_retry').length).toBe(0);
  }, 20_000);
});

describe('等待网络 · 中流续写', () => {
  it('吐过字后断网 × 4(超过续写上限 3)→ 探网确认断过的续写不扣次数,run done', async () => {
    script = [midstreamDropStep('第一段,'), midstreamDropStep('第二段,'), midstreamDropStep('第三段,'), midstreamDropStep('第四段,'), finalStep('收尾。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(5);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network' && s.stage === 'midstream').length).toBe(4);
    expect(statuses.filter((s) => s.phase === 'llm_retry').length).toBe(0);
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model' ORDER BY timestamp ASC`);
    const all = rows.map((r) => String(r.content)).join('\n');
    for (const t of ['第一段', '第四段', '收尾']) expect(all).toContain(t);
  }, 20_000);

  it('负对照:网一直通的中流断线照旧扣续写次数,第 4 次断线失败', async () => {
    const drop = (text: string) => (o: any) => { o.onToken?.(text); throw new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); };
    script = [drop('一,'), drop('二,'), drop('三,'), drop('四,')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('failed');
    expect(llmPayloads.length).toBe(4);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1, 2, 3]);
  }, 30_000);
});
