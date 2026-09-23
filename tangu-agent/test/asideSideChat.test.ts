/**
 * 旁聊(/btw)的接线:真内存 SQLite + 真 hydrateHistory,只把模型换成桩。
 * 钉四件事:①主会话内容进了系统提示的转写 ②payload 不带工具 ③旁聊往返按序接在后面 ④主会话一行都不多。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/asideSideChat.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
import { answerAside, normalizeAsideInput, ASIDE_MAX_TURNS } from '../src/services/aside.js';

let home = '';
let payloads: any[] = [];
const billing = {
  canConsumeTokenPoints: vi.fn(async () => ({ ok: true })),
  consumeTokenPoints: vi.fn(async () => ({ ok: true })),
  calculateCost: vi.fn(async () => 7),
  logApiUsage: vi.fn(async () => {}),
};
let reply = 'The codename is AZURE-FALCON.';

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-aside-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host,
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', context_window: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools, max_tokens: o.maxTokens }),
        streamProviderCompletion: async (o: any) => {
          payloads.push(o.payload);
          for (const piece of reply.match(/.{1,8}/g) || []) o.onToken?.(piece);
          return { content: reply, reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
        },
      },
      users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
      memory: { getMemory: async () => ({ content: '' }) },
      models: { hasDirectModel: () => false },
    } as any,
    billing: billing as any,
    profile: createTanguProfile({ sandboxMode: 'none' }),
  });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', 'u1', 'tangu', 't', 'm1', 'user')`);
  const rows: Array<[string, string]> = [
    ['user', 'Please remember: my project codename is AZURE-FALCON.'],
    ['assistant', 'Noted, AZURE-FALCON it is.'],
    ['user', 'Now refactor the parser.'], // 主 run 在飞:这条之后的回复还没落库
  ];
  for (const [i, [role, content]] of rows.entries()) {
    await query(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, 'S', ?, ?, ?)`, [`m${i}`, role, content, 1000 + i]);
  }
});

afterAll(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ask = (body: any, onToken: (d: string) => void = () => {}) =>
  answerAside({ sessionId: 'S', userId: 'u1', modelId: 'm1', appId: 'tangu', input: normalizeAsideInput(body)!, signal: new AbortController().signal, onToken });

describe('旁聊 /btw:带主会话上下文、不带工具、不写回', () => {
  it('转写进系统提示,旁聊往返按序接在后面,本次问题(带引用)收尾;payload 无工具', async () => {
    payloads = [];
    const deltas: string[] = [];
    const r = await ask({ question: 'What is the codename?', quote: 'AZURE-FALCON it is.', thread: [{ question: 'q0', answer: 'a0' }] }, (d) => deltas.push(d));
    expect(r).toEqual({ content: reply, toolCallText: false });
    expect(deltas.join('')).toBe(reply);
    const msgs = payloads[0].messages;
    expect(payloads[0].tools).toBeUndefined();
    expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[0].content).toContain('<main_conversation>');
    expect(msgs[0].content).toContain('my project codename is AZURE-FALCON');
    expect(msgs[0].content).toContain('Now refactor the parser.');
    expect(msgs[1].content).toBe('q0');
    expect(msgs[2].content).toBe('a0');
    expect(msgs[3].content).toBe('About this excerpt:\n> AZURE-FALCON it is.\n\nWhat is the codename?');
  });

  it('主会话一行都不多(不落用户问题、不落回答)', async () => {
    const before = (await query<any[]>(`SELECT COUNT(*) AS n FROM chat_messages`))[0].n;
    await ask({ question: 'Anything else?' });
    expect((await query<any[]>(`SELECT COUNT(*) AS n FROM chat_messages`))[0].n).toBe(before);
    expect((await query<any[]>(`SELECT COUNT(*) AS n FROM chat_sessions`))[0].n).toBe(1);
  });

  it('模型把工具调用写成文本 → toolCallText,由客户端补「什么都没执行」', async () => {
    reply = 'Let me check.\n<invoke name="read_file">\n<parameter name="path">a.ts</parameter>\n</invoke>';
    try { expect((await ask({ question: 'read a.ts' })).toolCallText).toBe(true); }
    finally { reply = 'The codename is AZURE-FALCON.'; }
  });

  it('额度:预检不过 → token_quota_exceeded 且不调模型;过了 → 按实际 usage 扣费并记用量(与主循环同口径)', async () => {
    payloads = [];
    billing.canConsumeTokenPoints.mockResolvedValueOnce({ ok: false } as any);
    await expect(ask({ question: 'blocked?' })).rejects.toThrow('token_quota_exceeded');
    expect(payloads).toHaveLength(0);
    billing.consumeTokenPoints.mockClear(); billing.logApiUsage.mockClear();
    await ask({ question: 'allowed?' });
    expect(billing.consumeTokenPoints).toHaveBeenCalledWith('u1', 7);
    expect(billing.logApiUsage).toHaveBeenCalledWith('u', 'm1', 'test', 'test', 5, 5, true, undefined, 'tangu', 7, 0, undefined);
  });

  it('输入消毒:没有问题 → null;往返封顶最近 N 轮且丢掉残缺的', () => {
    expect(normalizeAsideInput({ question: '   ' })).toBeNull();
    expect(normalizeAsideInput({ quote: 'only a quote' })).toBeNull();
    const thread = Array.from({ length: ASIDE_MAX_TURNS + 5 }, (_, i) => ({ question: `q${i}`, answer: i === ASIDE_MAX_TURNS + 4 ? '' : `a${i}` }));
    const n = normalizeAsideInput({ question: 'x', thread })!;
    expect(n.thread.length).toBe(ASIDE_MAX_TURNS - 1); // 最近 20 轮里最后一轮没有回答,被丢
    expect(n.thread[0].question).toBe('q5');
  });
});
