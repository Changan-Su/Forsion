/**
 * 主 loop「等待网络」仪器(中断任务续跑方案 6.7,11-20):
 *   ① 首帧前 ENOTFOUND:每次探网确认断了就等,网回来同一轮接着发;整 run 免费重发至多 2 次,之后扣次数(×5 done、×6 failed)
 *   ② 等网时用户点停 → aborted(不等满 30 分钟),整轮落过库就补打断标记
 *   ③ 中流断线:探网确认断过的续写整 run 至多 3 次免费,之后扣 MIDSTREAM_MAX_RESUMES
 *   ④ 每次真重发 / 续写之前复查 run 成本闸(失败尝试已知的用量也记进成本)
 *   ⑤ 中流的 Retry-After:>60s 不续写,≤60s 照它等
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
import { enqueueRun, abortRun, enqueueSteer, expediteSteer, TURN_INTERRUPTED_MARKER } from '../src/services/agentLoop.js';
import { MIDSTREAM_MAX_FREE_RESUMES, RUN_MAX_FREE_RETRIES } from '../src/llm/retry.js';
import { subscribe } from '../src/services/eventBus.js';
import { __setNetworkProbeForTests } from '../src/llm/netWait.js';
import { LlmError } from '../src/core/types.js';

const USER = 'u1';
/** 每条用例一个 run id:run 结束 30s 后 eventBus.cleanup 会摘掉该 id 的全部订阅,同名复用会把后面用例的订阅摘掉。 */
let RID = 'R0';
let ridSeq = 0;
let home: string;
let llmPayloads: any[];
let script: Array<(o: any) => any>;
/** 探网的开关:false = 断网。每次探网之后由 onProbe 决定下一次。 */
let online = true;
let probes = 0;
let onProbe: (() => void) | undefined;
/** buildProviderPayload 的出招:有就先执行(可抛),再照常返回 payload。 */
let buildScript: Array<() => void>;
/** 计费:缺省 0;成本闸用例按 token 数计。 */
let costOf: (tin: number, tout: number) => number;

beforeEach(async () => {
  RID = `R${++ridSeq}`;
  home = mkdtempSync(join(tmpdir(), 'tangu-netwait-'));
  process.env.TANGU_HOME = home;
  llmPayloads = [];
  script = [];
  online = true;
  probes = 0;
  onProbe = undefined;
  buildScript = [];
  costOf = () => 0;
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
    billing: { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async (_m: string, tin: number, tout: number) => costOf(tin || 0, tout || 0), logApiUsage: async () => {} } as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});

afterEach(() => {
  __setNetworkProbeForTests(null);
  delete process.env.TANGU_HOME;
  delete process.env.TANGU_MAX_RUN_COST;
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

async function runToSettled(timeoutMs = 15_000): Promise<{ run: any; statuses: any[]; errors: any[] }> {
  const statuses: any[] = [];
  const errors: any[] = [];
  const off = subscribe(RID, (ev) => { if (ev.type === 'status') statuses.push(ev.payload); if (ev.type === 'error') errors.push(ev.payload); });
  try {
    await createRun({
      id: RID, sessionId: 'S', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1',
      input: { message: '干活', userMessageId: 'U1', attachments: [], agentConfig: {} },
    });
    enqueueRun('S', RID);
    const t0 = Date.now();
    for (;;) {
      const r = await getRun(RID);
      if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return { run: r, statuses, errors };
      if (Date.now() - t0 > timeoutMs) throw new Error(`run 未结束(status=${r?.status})`);
      await new Promise((res) => setTimeout(res, 25));
    }
  } finally { off(); }
}

describe('等待网络 · 首帧前', () => {
  it(`ENOTFOUND × 5 → 每次都等网;前 ${RUN_MAX_FREE_RETRIES} 次网回来免费重发,后 3 次扣次数,第 6 次成功,run done`, async () => {
    script = [...Array.from({ length: 5 }, offlineStep), finalStep('网回来了，接着做完。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(6);
    const waits = statuses.filter((s) => s.phase === 'llm_wait_network');
    const backs = statuses.filter((s) => s.phase === 'llm_network_back');
    expect(waits.length).toBe(5);
    expect(backs.length).toBe(5);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(waits[0]).toMatchObject({ stage: 'request', since: expect.any(Number), error: 'fetch failed' });
    expect(backs[0]).toMatchObject({ stage: 'request', waitedMs: expect.any(Number) });
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
    expect(rows.map((r) => String(r.content)).join('\n')).toContain('网回来了');
  }, 20_000);

  it('ENOTFOUND × 6(断断续续)→ 免费 2 次 + 普通 3 次用完,run failed(不再无限免费重发)', async () => {
    script = [...Array.from({ length: 6 }, offlineStep), finalStep('不该走到这里。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('failed');
    expect(llmPayloads.length).toBe(6);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1, 2, 3]);
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
    const off = subscribe(RID, (ev) => { if (ev.type === 'status' && ev.payload?.phase === 'llm_wait_network') setTimeout(() => abortRun(RID, { byUser: true }), 50); });
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

describe('等待网络 · 插话', () => {
  it('等网时立即插话 → 叫醒等待,插话落库并进下一次请求,run done', async () => {
    script = [() => {
      online = false; // 一直断:只有插话能叫醒
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example.com'), { code: 'ENOTFOUND', hostname: 'api.example.com' }) });
    }, finalStep('按新思路做完。')];
    const off = subscribe(RID, (ev) => {
      if (ev.type === 'status' && ev.payload?.phase === 'llm_wait_network') setTimeout(() => {
        enqueueSteer(RID, { id: 'M2', content: '换个思路' });
        expediteSteer(RID);
      }, 30);
    });
    try {
      const t0 = Date.now();
      const { run } = await runToSettled();
      expect(run.status).toBe('done');
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(llmPayloads.length).toBe(2);
      expect(JSON.stringify(llmPayloads[1].messages)).toContain('换个思路');
      const users = await query<any[]>(`SELECT id, content FROM chat_messages WHERE session_id = 'S' AND role = 'user'`);
      expect(users.some((u) => u.id === 'M2' && String(u.content).includes('换个思路'))).toBe(true);
    } finally { off(); }
  }, 20_000);
});

describe('等待网络 · build-payload', () => {
  it('build-payload 断网 × 4 → 每次等网;前 2 次免费,后 2 次扣次数,run done', async () => {
    buildScript = Array.from({ length: 4 }, offlineStep);
    script = [finalStep('上下文送出去了。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(1);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network' && s.stage === 'build_payload').length).toBe(4);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1, 2]);
  }, 20_000);

  it('build-payload 与首帧前共用整 run 的免费额度:build-payload 用掉 2 次后,请求断网就扣次数', async () => {
    buildScript = Array.from({ length: 2 }, offlineStep);
    script = [offlineStep(), finalStep('好了。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(statuses.filter((s) => s.phase === 'llm_wait_network').map((s) => s.stage)).toEqual(['build_payload', 'build_payload', 'request']);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1]);
  }, 20_000);
});

describe('等待网络 · 中流续写', () => {
  it(`吐过字后断网 × 4 → 每次先落库再等网;前 ${MIDSTREAM_MAX_FREE_RESUMES} 次续写免费,第 4 次扣续写次数,run done`, async () => {
    script = [midstreamDropStep('第一段,'), midstreamDropStep('第二段,'), midstreamDropStep('第三段,'), midstreamDropStep('第四段,'), finalStep('收尾。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(5);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network' && s.stage === 'midstream').length).toBe(4);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1]);
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model' ORDER BY timestamp ASC`);
    const all = rows.map((r) => String(r.content)).join('\n');
    for (const t of ['第一段', '第四段', '收尾']) expect(all).toContain(t);
  }, 20_000);

  it('等网前半截已经落库(等网期间引擎被强杀也不丢屏上那截)', async () => {
    script = [(o: any) => {
      o.onToken?.('已经写出来的半句');
      online = false; // 一直断
      throw new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    }];
    let rowsDuringWait: any[] | null = null;
    const off = subscribe(RID, (ev) => {
      if (ev.type === 'status' && ev.payload?.phase === 'llm_wait_network') {
        void query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model'`).then((r) => { rowsDuringWait = r; abortRun(RID, { byUser: true }); });
      }
    });
    try {
      const { run } = await runToSettled();
      expect(run.status).toBe('aborted');
      expect(rowsDuringWait!.map((r) => String(r.content)).join('\n')).toContain('已经写出来的半句');
      // 等网时按停:新段是空的,但整轮已经落过库 → 照样补打断标记(后续 run 才知道这轮没做完)
      const users = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'user'`);
      expect(users.some((u) => String(u.content) === TURN_INTERRUPTED_MARKER)).toBe(true);
    } finally { off(); }
  }, 20_000);

  it('续写次数用完的那次断线也先落库:网一直通、第 4 次断线失败,四截正文都在', async () => {
    const drop = (text: string) => (o: any) => { o.onToken?.(text); throw new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }); };
    script = [drop('甲段,'), drop('乙段,'), drop('丙段,'), drop('丁段,')];
    const { run } = await runToSettled();
    expect(run.status).toBe('failed');
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
    const all = rows.map((r) => String(r.content)).join('\n');
    for (const t of ['甲段', '丁段']) expect(all).toContain(t);
  }, 30_000);

  it(`免费续写有上界:断网又恢复的抖动 × 7 → 前 ${MIDSTREAM_MAX_FREE_RESUMES} 次免费、再 3 次按次数,第 7 次失败`, async () => {
    script = Array.from({ length: 7 }, (_, i) => midstreamDropStep(`第${i + 1}段,`));
    const { run, statuses } = await runToSettled(30_000);
    expect(run.status).toBe('failed');
    expect(llmPayloads.length).toBe(7);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network').length).toBe(6);
    expect(statuses.filter((s) => s.phase === 'llm_retry').map((s) => s.attempt)).toEqual([1, 2, 3]);
  }, 40_000);

  it('中流 Retry-After 超过 60s(120s)→ 不续写,run failed', async () => {
    const raDrop = (text: string, ms: number) => (o: any) => {
      o.onToken?.(text);
      throw Object.assign(new LlmError(429, 'Rate limit reached'), { retryAfterMs: ms });
    };
    script = [raDrop('前半句,', 120_000), finalStep('不该续写。')];
    const long = await runToSettled();
    expect(long.run.status).toBe('failed');
    expect(llmPayloads.length).toBe(1);
  }, 20_000);

  it('中流 Retry-After 1.5s → 照它等再续写', async () => {
    script = [(o: any) => { o.onToken?.('前半句,'); throw Object.assign(new LlmError(429, 'Rate limit reached'), { retryAfterMs: 1_500 }); }, finalStep('后半句。')];
    const t0 = Date.now();
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
    const retry = statuses.find((s) => s.phase === 'llm_retry');
    expect(retry).toMatchObject({ attempt: 1, retryAfterMs: 1_500 });
    expect(retry.waitMs).toBeGreaterThanOrEqual(1_500);
  }, 20_000);

  it('中流的 overloaded_error 续写也标 overload(界面说「服务繁忙」)', async () => {
    script = [(o: any) => { o.onToken?.('半句,'); throw Object.assign(new LlmError(502, 'Overloaded'), { code: 'overloaded_error' }); }, finalStep('好。')];
    const { run, statuses } = await runToSettled();
    expect(run.status).toBe('done');
    expect(statuses.find((s) => s.phase === 'llm_retry')).toMatchObject({ attempt: 1, overload: true });
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

describe('重发前复查 run 成本闸', () => {
  /** 断流前已报过的用量(如 Anthropic message_start 之后断流):挂在报错的 partialUsage 上。 */
  const usage = { prompt_tokens: 150, completion_tokens: 10 };

  it('中流断网:失败尝试的已知用量记进成本,等网回来、续写之前越限 → run_cost_exceeded,不再发', async () => {
    process.env.TANGU_MAX_RUN_COST = '100';
    costOf = (tin, tout) => tin + tout;
    script = [(o: any) => {
      o.onToken?.('写了一半,');
      online = false;
      onProbe = () => { online = true; onProbe = undefined; };
      throw Object.assign(new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }), { partialUsage: usage });
    }, finalStep('不该续写。')];
    const { run, errors, statuses } = await runToSettled();
    expect(run.status).toBe('failed');
    expect(llmPayloads.length).toBe(1);
    expect(errors.some((e) => e.error === 'run_cost_exceeded')).toBe(true);
    expect(statuses.filter((s) => s.phase === 'llm_wait_network').length).toBe(1); // 确实等过网,网回来才判
    const rows = await query<any[]>(`SELECT content FROM chat_messages WHERE session_id = 'S' AND role = 'model'`);
    expect(rows.map((r) => String(r.content)).join('\n')).toContain('写了一半');
  }, 20_000);

  it('首帧前失败(已报用量、没吐字):退避完、重发之前越限 → run_cost_exceeded', async () => {
    process.env.TANGU_MAX_RUN_COST = '100';
    costOf = (tin, tout) => tin + tout;
    script = [() => { throw Object.assign(new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }), { partialUsage: usage }); }, finalStep('不该重发。')];
    const { run, errors } = await runToSettled();
    expect(run.status).toBe('failed');
    expect(llmPayloads.length).toBe(1);
    expect(errors.some((e) => e.error === 'run_cost_exceeded')).toBe(true);
  }, 20_000);

  it('对照:没越限照常重发、run done(上面两条不是因为别的原因停的)', async () => {
    process.env.TANGU_MAX_RUN_COST = '1000';
    costOf = (tin, tout) => tin + tout;
    script = [() => { throw Object.assign(new TypeError('terminated', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }), { partialUsage: usage }); }, finalStep('重发成功。')];
    const { run } = await runToSettled();
    expect(run.status).toBe('done');
    expect(llmPayloads.length).toBe(2);
  }, 20_000);
});
