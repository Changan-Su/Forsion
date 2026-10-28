import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSensitive, maskPayload, restoreText, restoreArgs, createStreamRestorer, withOutboundMasking, placeholderFor, allowValue, maskSpans, readMaskLog, DEFAULT_MASK_SETTINGS, MASKING_FAILED, type MaskSettings } from './outboundMask.js';
import { LlmError } from '../core/types.js';
import type { LlmBrain, StreamOpts } from '../seams/cloudBrain.js';

const KEY = 'sk-proj-7fQm2Lx9KpV3nR8sT1wY6bZc4dHj0aEu';
const PW = 'Xk9vQ2mLp7Rt';
const ENV = `DATABASE_URL=postgres://app:${PW}@db.internal:5432/app\nOPENAI_API_KEY=${KEY}\nONCALL=ops-oncall@forsion-demo.net\nLOG_LEVEL=debug`;
const ON: MaskSettings = DEFAULT_MASK_SETTINGS;

let home: string;
const prev = process.env.TANGU_HOME;
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'mask-')); process.env.TANGU_HOME = home; });
afterAll(() => { rmSync(home, { recursive: true, force: true }); if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev; });

describe('findSensitive', () => {
  it('finds keys and passwords in a .env, not emails unless personal is on', () => {
    expect(findSensitive(ENV).map((s) => [s.kind, s.value])).toEqual([['PASSWORD', PW], ['API_KEY', KEY]]);
    expect(findSensitive(ENV, { secrets: true, personal: true }).map((s) => s.kind)).toEqual(['PASSWORD', 'API_KEY', 'EMAIL']);
  });
  it('leaves look-alikes alone', () => {
    for (const t of ['sk-learn-model-runner-v2-abc', 'OPENAI_API_KEY=$OPENAI_API_KEY', 'password = process.env.DB_PASSWORD', 'token: <your token here>', 'icon@2x.png', 'order id 13800138000'])
      expect(findSensitive(t, { secrets: true, personal: true })).toEqual([]);
  });
  it('checks checksums for cards and ID numbers', () => {
    const p = { secrets: false, personal: true };
    expect(findSensitive('card 4111 1111 1111 1111', p).map((s) => s.kind)).toEqual(['BANK_CARD']);
    expect(findSensitive('card 4111 1111 1111 1112', p)).toEqual([]);
    expect(findSensitive('身份证 11010519491231002X', p).map((s) => s.kind)).toEqual(['ID_CARD']);
  });
});

describe('maskPayload / restore', () => {
  it('masks every string in the payload, keeps the input untouched and placeholders stable', () => {
    const msgs = [{ role: 'tool', tool_call_id: 'call_1', content: ENV }, { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `curl -H "Authorization: Bearer ${KEY}" https://api.openai.com` }) } }] }];
    const payload = { model: 'gpt', messages: msgs, __tangu_direct: true };
    const a = maskPayload(payload, ON);
    const b = maskPayload(payload, ON);
    expect(JSON.stringify(a.payload)).not.toContain(KEY);
    expect(JSON.stringify(a.payload)).not.toContain(PW);
    expect(JSON.stringify(a.payload)).toContain(placeholderFor('API_KEY', KEY));
    expect(a.payload).toEqual(b.payload); // 同值同占位符:缓存不断
    expect(a.payload.__tangu_direct).toBe(true);
    expect(msgs[0].content).toBe(ENV); // 不改入参
    expect(a.hits.map((h) => [h.kind, h.head, h.len])).toEqual([['PASSWORD', 'Xk9v', 12], ['API_KEY', 'sk-p', KEY.length]]);
    // 工具参数仍是合法 JSON
    expect(() => JSON.parse(a.payload.messages[1].tool_calls[0].function.arguments)).not.toThrow();
  });
  it('masks a value seen before wherever it shows up again, even without context', () => {
    maskPayload({ messages: [{ content: ENV }] }, ON);
    const r = maskPayload({ messages: [{ content: `the db password is ${PW} btw` }] }, ON);
    expect(r.payload.messages[0].content).toBe(`the db password is ${placeholderFor('PASSWORD', PW)} btw`);
  });
  it('masks a JSON tool argument even when the same value was already hit in an earlier message', () => {
    const args = JSON.stringify({ command: `curl -H "Authorization: Bearer ${KEY}" https://x.test`, note: 'tools' });
    const r = maskPayload({ messages: [{ content: ENV }, { tool_calls: [{ function: { arguments: args } }] }, { content: JSON.stringify({ id: KEY, tools: [KEY] }) }] }, ON);
    expect(JSON.parse(r.payload.messages[1].tool_calls[0].function.arguments).command).toContain(placeholderFor('API_KEY', KEY));
    expect(r.payload.messages[2].content).not.toContain(KEY); // 跳过的字段名只在 payload 结构上认,工具结果 JSON 里的 id / tools 照样遮
  });
  it('leaves vendor-signed thinking blocks as written', () => {
    const block = { type: 'thinking', thinking: `key ${KEY}`, signature: 'sig' };
    expect(maskPayload({ messages: [{ content: [block] }] }, ON).payload.messages[0].content[0]).toBe(block);
  });
  it('warn finds but does not replace', () => {
    const r = maskPayload({ messages: [{ content: ENV }] }, { ...ON, action: 'warn' });
    expect(r.payload.messages[0].content).toBe(ENV);
    expect(r.hits.length).toBe(2);
  });
  it('restores placeholders the way models rewrite them, and JSON args with awkward values', () => {
    const r = maskPayload({ m: `k=${KEY}` }, ON);
    const ph = placeholderFor('API_KEY', KEY);
    expect(restoreText(`use ${ph} and {{ ${ph.slice(2, -2).toLowerCase().replace(/^api_key/, 'API_KEY')} }}`, r.map)).toBe(`use ${KEY} and ${KEY}`);
    const map = new Map([['{{PASSWORD_aaaaaaaa}}', 'a"b\\c\nd']]);
    expect(JSON.parse(restoreArgs(JSON.stringify({ cmd: 'echo {{PASSWORD_aaaaaaaa}}' }), map)).cmd).toBe('echo a"b\\c\nd');
  });
  it('holds a placeholder split across stream deltas', () => {
    const map = new Map([['{{API_KEY_abcdefgh}}', KEY]]);
    const s = createStreamRestorer(map);
    const out = ['export K={', '{API_KE', 'Y_abcd', 'efgh}} done {not one'].map((d) => s.push(d)).join('') + s.flush();
    expect(out).toBe(`export K=${KEY} done {not one`);
  });
});

describe('review fixes', () => {
  it('stays fast on long unbroken input', () => {
    const t0 = Date.now();
    findSensitive('a'.repeat(200_000) + ' ' + 'x@'.repeat(50_000), { secrets: true, personal: true });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('masks a JSON leaf by its field name, and a short data: string', () => {
    const p = { messages: [{ role: 'tool', content: JSON.stringify({ user: 'app', password: 'AbCd123456', next_page_token: 'Zz9yXx8wVv7u' }) }, { role: 'user', content: `data:text/plain,${KEY}` }] };
    const out = JSON.stringify(maskPayload(p, ON).payload);
    expect(out).not.toContain('AbCd123456');
    expect(out).toContain('Zz9yXx8wVv7u');
    expect(out).not.toContain(KEY);
  });
  it('keeps one placeholder per value and drops remembered personal values when personal is off', () => {
    const v = 'Qw3rTy7UiOp9';
    const a = maskPayload({ m: `postgres://u:${v}@h/db` }, ON);
    const b = maskPayload({ m: `client_secret=${v}` }, ON);
    expect(a.map.size && [...a.map.keys()]).toEqual([...b.map.keys()]);
    const mail = 'someone.real@forsion-demo.net';
    maskPayload({ m: `contact ${mail}` }, { ...ON, personal: true });
    expect(JSON.stringify(maskPayload({ m: `again ${mail}` }, ON).payload)).toContain(mail);
    expect(maskSpans(`again ${mail}`, ON)).toEqual([]);
  });
  it('flags spans in warn mode', () => {
    expect(maskSpans(ENV, { ...ON, action: 'warn' }).every((m) => m.warn)).toBe(true);
    expect(maskSpans(ENV, ON).some((m) => m.warn)).toBe(false);
  });
  it('restores \\u007b-escaped placeholders in args', () => {
    const { map } = maskPayload({ m: KEY }, ON);
    const ph = [...map.keys()][0];
    const esc = JSON.stringify({ k: ph }).replace(/\{/g, '\\u007b').replace('\\u007b"k"', '{"k"');
    expect(JSON.parse(restoreArgs(esc, map)).k).toBe(KEY);
  });
});

describe('withOutboundMasking', () => {
  const fake = (capture: (o: StreamOpts) => void, reply: string, args: string): LlmBrain => ({
    resolveModelAndKey: async () => ({}) as any,
    buildProviderPayload: async () => ({}),
    streamProviderCompletion: async (o) => {
      capture(o);
      for (const ch of reply.match(/.{1,5}/gs) || []) o.onToken?.(ch);
      return { content: reply, reasoning: '', toolCalls: [{ id: 't', type: 'function', function: { name: 'bash', arguments: args } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    },
  });
  it('sends placeholders out and hands real values back to the loop', async () => {
    let sent: any;
    const ph = placeholderFor('API_KEY', KEY);
    const llm = withOutboundMasking(fake((o) => { sent = o.payload; }, `Set it to ${ph}.`, JSON.stringify({ command: `echo ${ph}` })), () => ON);
    let streamed = '';
    const hits: any[] = [];
    const res = await llm.streamProviderCompletion({ apiKey: '', baseUrl: '', payload: { messages: [{ content: ENV }] }, onToken: (d) => { streamed += d; }, onMasked: (h) => hits.push(...h), maskScope: 's1' });
    expect(JSON.stringify(sent)).not.toContain(KEY);
    expect(streamed).toBe(`Set it to ${KEY}.`);
    expect(res.content).toBe(`Set it to ${KEY}.`);
    expect(JSON.parse(res.toolCalls[0].function.arguments).command).toBe(`echo ${KEY}`);
    expect(hits.length).toBe(2);
    const log = readMaskLog();
    expect(log.at(-1)?.sid).toBe('s1');
    expect(readFileSync(join(home, 'masking', 'log.jsonl'), 'utf8')).not.toContain(KEY);
  });
  it('blocks the turn instead of sending it as written when masking cannot run', async () => {
    let called = false;
    const llm = withOutboundMasking(fake(() => { called = true; }, '', '{}'), () => { return { ...ON, get secrets() { throw new Error('boom'); } } as any; });
    await expect(llm.streamProviderCompletion({ apiKey: '', baseUrl: '', payload: { m: ENV } })).rejects.toThrow();
    const bad = withOutboundMasking(fake(() => { called = true; }, '', '{}'), () => ON);
    const circular: any = { m: ENV }; circular.self = circular;
    const err = await bad.streamProviderCompletion({ apiKey: '', baseUrl: '', payload: circular }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain(MASKING_FAILED);
    expect(called).toBe(false);
  });
  it('never-mask list sends a value as written', async () => {
    const r = maskPayload({ m: ENV }, ON);
    expect(r.hits.some((h) => h.kind === 'API_KEY')).toBe(true);
    const spans = maskSpans(ENV);
    expect(spans.map((x) => ENV.slice(x.s, x.e))).toEqual([PW, KEY]);
    allowValue(KEY, 'API_KEY');
    expect(maskSpans(ENV).map((x) => ENV.slice(x.s, x.e))).toEqual([PW]);
    expect(maskPayload({ m: ENV }, ON).payload.m).toContain(KEY);
    expect(readFileSync(join(home, 'masking', 'allow.json'), 'utf8')).not.toContain(KEY);
  });
});
