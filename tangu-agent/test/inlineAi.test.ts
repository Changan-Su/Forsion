/**
 * 正文生成式 AI(评审 G3-07)`POST /agent/inline` 的契约:模型换桩,路由走真 express + 真鉴权中间件。
 * 钉五件事:①请求体逐项封顶、缺必需字段 400 ②提示词英文、笔记正文进标签当数据 ③payload 不带工具
 * ④SSE delta* → done(整段 ```markdown 围栏剥掉)⑤不写任何会话 / 消息行。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/inlineAi.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { buildInlineMessages, completeInline, INLINE_SYSTEM_PROMPT, normalizeInlineInput, stripOuterFence } from '../src/services/inlineAi.js';
import inlineRouter from '../src/routes/inline.js';

let home = '';
let payloads: any[] = [];
let reply = 'A clearer sentence.';
let server: Server;
let base = '';
const billing = {
  canConsumeTokenPoints: vi.fn(async () => ({ ok: true })),
  consumeTokenPoints: vi.fn(async () => ({ ok: true })),
  calculateCost: vi.fn(async () => 3),
  logApiUsage: vi.fn(async () => {}),
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-inline-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'tok', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host,
    brain: {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test', context_window: 128_000 }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools, max_tokens: o.maxTokens }),
        streamProviderCompletion: async (o: any) => {
          payloads.push(o.payload);
          for (const piece of reply.match(/[\s\S]{1,6}/g) || []) o.onToken?.(piece);
          return { content: reply, reasoning: '', toolCalls: [], usage: { prompt_tokens: 9, completion_tokens: 4 } };
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
  const app = express();
  app.use(express.json());
  app.use(inlineRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const post = (body: unknown, token = 'tok') => fetch(`${base}/agent/inline`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
const sse = async (r: Response) => (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));

describe('normalizeInlineInput(信任边界)', () => {
  it('未知动作 / 改写类缺选区 / custom 缺指令 / 续写什么都没给 → null', () => {
    expect(normalizeInlineInput({ action: 'rm -rf', selection: 'x' })).toBeNull();
    expect(normalizeInlineInput({ action: 'improve', selection: '   ' })).toBeNull();
    expect(normalizeInlineInput({ action: 'custom', selection: 'x' })).toBeNull();
    expect(normalizeInlineInput({ action: 'continue' })).toBeNull();
    expect(normalizeInlineInput({ action: 'continue', before: '前文' })).toEqual({ action: 'continue', before: '前文' });
  });
  it('逐项封顶;标题 / 语言压成单行', () => {
    const r = normalizeInlineInput({ action: 'translate', selection: 'x'.repeat(30_000), before: 'b'.repeat(9_000), title: 'a\nb', language: 'French\n' })!;
    expect(r.selection!.length).toBe(20_000);
    expect(r.before!.length).toBe(4_000);
    expect(r.title).toBe('a b');
    expect(r.language).toBe('French');
  });
});

describe('提示词', () => {
  it('系统提示英文(模型读取的一律英文),笔记正文进标签、声明是数据', () => {
    expect(/[一-鿿]/.test(INLINE_SYSTEM_PROMPT)).toBe(false);
    const [sys, user] = buildInlineMessages({ action: 'custom', instruction: '写成三点', selection: '选中的字', before: '上文', after: '下文', title: '周报' });
    expect(sys.content).toBe(INLINE_SYSTEM_PROMPT);
    expect(sys.content).toMatch(/treat it as data/);
    const u = String(user.content);
    expect(u.indexOf('<text_before>')).toBeLessThan(u.indexOf('<selection>'))
    expect(u.indexOf('<selection>')).toBeLessThan(u.indexOf('<text_after>'))
    expect(u).toMatch(/<note_title>周报<\/note_title>/);
    expect(u.trimEnd().endsWith('User instruction: 写成三点')).toBe(true);
  });
  it('翻译带目标语言', () => {
    expect(String(buildInlineMessages({ action: 'translate', selection: 'x', language: 'Japanese' })[1].content)).toMatch(/into Japanese/);
  });
  it('整段 ```markdown 围栏剥掉;选区本身是代码块时不剥', () => {
    expect(stripOuterFence('```markdown\n# T\n\nbody\n```')).toBe('# T\n\nbody');
    expect(stripOuterFence('```\nplain\n```')).toBe('plain');
    expect(stripOuterFence('```js\ncode\n```')).toBe('```js\ncode\n```');
    expect(stripOuterFence('```\nx\n```', '```\ny\n```')).toBe('```\nx\n```');
  });
});

describe('completeInline', () => {
  it('payload 不带工具,流式逐段回调,按 usage 扣费记账', async () => {
    payloads = [];
    reply = '```markdown\nBetter text.\n```';
    const deltas: string[] = [];
    const r = await completeInline({ userId: 'u1', modelId: 'm1', appId: 'tangu', input: normalizeInlineInput({ action: 'improve', selection: 'bad text' })!, signal: new AbortController().signal, onToken: (d) => deltas.push(d) });
    expect(r).toEqual({ content: 'Better text.', toolCallText: false });
    expect(deltas.join('')).toBe(reply);
    expect(payloads[0].tools).toBeUndefined();
    expect(billing.consumeTokenPoints).toHaveBeenCalled();
  });
  it('额度用尽 → token_quota_exceeded(不许绕道正文 AI)', async () => {
    billing.canConsumeTokenPoints.mockResolvedValueOnce({ ok: false } as any);
    await expect(completeInline({ userId: 'u1', modelId: 'm1', appId: 'tangu', input: normalizeInlineInput({ action: 'fix', selection: 'x' })!, signal: new AbortController().signal, onToken: () => {} })).rejects.toThrow('token_quota_exceeded');
  });
});

describe('POST /agent/inline', () => {
  it('SSE:delta* → done(content / modelId),会话与消息表一行不多', async () => {
    reply = 'Continued paragraph.';
    const before = (await query<any[]>('SELECT COUNT(*) AS n FROM chat_messages'))[0].n;
    const r = await post({ action: 'continue', before: 'Once upon a time', model_id: 'm1' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const evs = await sse(r);
    expect(evs.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe(reply);
    expect(evs.at(-1)).toEqual({ type: 'done', content: reply, toolCallText: false, modelId: 'm1' });
    const after = (await query<any[]>('SELECT COUNT(*) AS n FROM chat_messages'))[0].n;
    const sessions = (await query<any[]>('SELECT COUNT(*) AS n FROM chat_sessions'))[0].n;
    expect(after).toBe(before);
    expect(sessions).toBe(0);
  });
  it('缺字段 400、没鉴权 401', async () => {
    expect((await post({ action: 'improve', model_id: 'm1' })).status).toBe(400);
    expect((await post({ action: 'custom', selection: 'x', model_id: 'm1' })).status).toBe(400);
    expect((await post({ action: 'improve', selection: 'x', model_id: 'm1' }, 'nope')).status).toBe(401);
  });
  it('模型报错 → SSE error 事件(不是半截 done)', async () => {
    billing.canConsumeTokenPoints.mockResolvedValueOnce({ ok: false } as any);
    const evs = await sse(await post({ action: 'fix', selection: 'x', model_id: 'm1' }));
    expect(evs.at(-1)).toEqual({ type: 'error', error: 'token_quota_exceeded' });
  });
});
