/**
 * 旁聊(/btw)的接线:真内存 SQLite + 真 hydrateHistory,只把模型换成桩。
 * 钉四件事:①主会话内容进了系统提示的转写 ②payload 不带工具 ③旁聊往返按序接在后面 ④主会话一行都不多。
 * 附件(10-24):图片成 image parts 只在本问、追问不重发;大图不吃掉转写预算;文本 / PDF 抽成文字;
 * 主模型收不到原图 → 辅助视觉模型转写(失败退回原图);入参消毒(缩略图格式 / 长度 / 张数);落库只留记录不留内容。
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
import {
  answerAside, normalizeAsideInput, asideAttachmentsTooLarge, asideThinkingLevel, attachmentMetas, extractAttachmentText, saveAside,
  ASIDE_MAX_TURNS, ASIDE_MAX_ATTACH_CHARS, THUMB_MAX_CHARS,
} from '../src/services/aside.js';

let home = '';
let payloads: any[] = [];
/** 辅助视觉模型(图像识别)那次调用:按系统提示认出来,单独记、单独答。 */
let describePayloads: any[] = [];
let describeFails = false;
const isDescribe = (payload: any): boolean => String(payload?.messages?.[0]?.content || '').startsWith('You are an image-understanding assistant');
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
        buildProviderPayload: async (o: any) => ({ messages: structuredClone(o.messages), tools: o.tools, max_tokens: o.maxTokens, thinkingLevel: o.thinkingLevel }),
        streamProviderCompletion: async (o: any) => {
          if (isDescribe(o.payload)) {
            describePayloads.push(o.payload);
            if (describeFails) throw new Error('vision model down');
            return { content: 'A red square with the word KESTREL in white.', reasoning: '', toolCalls: [], usage: { prompt_tokens: 5, completion_tokens: 5 } };
          }
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

// 1×1 PNG(真图,能过 normalizeImageAttachments;小于 KEEP_BYTES,fitUserImages 原样放行)
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const THUMB_OK = `data:image/jpeg;base64,${'A'.repeat(64)}`;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
/** 手写一份单页文本 PDF(Helvetica,xref 偏移算准),给 LiteParse 当真文件解析。 */
function makePdf(line: string): Buffer {
  const content = `BT /F1 18 Tf 20 100 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const askWith = (body: any, extra: Record<string, unknown> = {}) =>
  answerAside({ sessionId: 'S', userId: 'u1', modelId: 'm1', appId: 'tangu', input: normalizeAsideInput(body)!, signal: new AbortController().signal, onToken: () => {}, ...extra });
const lastUser = (): any => payloads[payloads.length - 1].messages.at(-1);
const imageParts = (m: any): any[] => (Array.isArray(m?.content) ? m.content.filter((p: any) => p?.type === 'image_url') : []);

describe('旁聊附件(10-24 方案 A):只给这一问、主对话同一条图片路、文件抽成文字', () => {
  it('图片 → 本问的 image parts(与主对话 toImageParts 同形);追问时前一轮的图不再发,只报名字', async () => {
    payloads = [];
    const r = await askWith({ question: 'What is in the picture?', attachments: [{ name: 'shot.png', mimeType: 'image/png', data: PNG_1PX, size: 70 }] });
    const m = lastUser();
    expect(imageParts(m)).toHaveLength(1);
    expect(imageParts(m)[0].image_url.url).toBe(`data:image/png;base64,${PNG_1PX}`);
    expect(m.content[0]).toEqual({ type: 'text', text: 'What is in the picture?' });
    expect(r.attached).toEqual({ images: 1, files: [], transcribed: false });
    // 追问:客户端把前一轮的附件只当记录带上(就算夹带了 data / thumb 也收不进来)
    payloads = [];
    await askWith({ question: 'And its colour?', thread: [{ question: 'What is in the picture?', answer: 'A dot.', attachments: [{ name: 'shot.png', mimeType: 'image/png', data: PNG_1PX, thumb: THUMB_OK }] }] });
    const msgs = payloads[0].messages;
    expect(msgs.flatMap(imageParts)).toHaveLength(0);
    expect(msgs[1].content).toBe('What is in the picture?\n\n[Attached to this question: shot.png. Not shown again.]');
    expect(msgs.at(-1).content).toBe('And its colour?');
    expect(msgs[0].content).toContain('Attachments of earlier side questions are listed by name only');
  });

  it('大图不吃掉转写预算:附件 base64 不按字数估(旧口径会把主会话整段丢掉)', async () => {
    payloads = [];
    const big = 'A'.repeat(6_000_000); // ≈4.5MB「图」:不是能解码的图,fitUserImages 原样放行
    await askWith({ question: 'Codename?', attachments: [{ name: 'big.png', mimeType: 'image/png', data: big }] });
    expect(payloads[0].messages[0].content).toContain('my project codename is AZURE-FALCON');
    expect(imageParts(lastUser())).toHaveLength(1);
  });

  it('文本文件 → <attached_file> 正文在问题前;PDF 走 LiteParse 带页码;二进制如实说读不了', async () => {
    payloads = [];
    const r = await askWith({
      question: 'Summarise the notes.',
      attachments: [
        { name: 'notes.md', mimeType: 'text/markdown', data: b64('﻿# Notes\nThe vault key is ORCHID-7.') },
        { name: 'blob.bin', mimeType: 'application/octet-stream', data: Buffer.from([1, 0, 2, 0, 3]).toString('base64') },
        { name: 'logo.svg', mimeType: 'image/svg+xml', data: b64('<svg xmlns="http://www.w3.org/2000/svg"><title>LOGO-9</title></svg>') }, // SVG 按文本读,不当图发
      ],
    });
    const m = lastUser();
    expect(typeof m.content).toBe('string');
    expect(m.content).toContain('<attached_file name="logo.svg">\n<svg');
    expect(m.content).toContain('<attached_file name="notes.md">\n# Notes\nThe vault key is ORCHID-7.\n</attached_file>');
    expect(m.content).toContain('<attached_file name="blob.bin">\n(This is a binary file.');
    expect(m.content.endsWith('Summarise the notes.')).toBe(true);
    expect(r.attached).toEqual({ images: 0, files: ['notes.md', 'blob.bin', 'logo.svg'], transcribed: false });
    const pdf = await extractAttachmentText({ name: 'plan.pdf', mimeType: 'application/pdf', data: makePdf('ORCHID-LANTERN-93').toString('base64') });
    expect(pdf).toContain('--- page 1 ---');
    expect(pdf).toContain('ORCHID-LANTERN-93');
  });

  it('文件太长 → 截断并注明', async () => {
    const t = await extractAttachmentText({ name: 'a.txt', mimeType: 'text/plain', data: b64('x'.repeat(10)) });
    expect(t).toBe('x'.repeat(10));
    payloads = [];
    await askWith({ question: 'q', attachments: [{ name: 'long.txt', mimeType: 'text/plain', data: b64('y'.repeat(70_000)) }] });
    expect(lastUser().content).toContain('[… truncated: only the first 60,000 characters of this file are shown]');
  });

  it('主模型收不到原图(「总是转写」)→ 辅助视觉模型写成文字接在本问后面;转写失败 → 退回原图', async () => {
    payloads = []; describePayloads = [];
    const statuses: any[] = [];
    const r = await askWith(
      { question: 'What does it say?', attachments: [{ name: 'sign.png', mimeType: 'image/png', data: PNG_1PX }] },
      { visionMode: 'always', visionModelId: 'vis', onStatus: (e: any) => statuses.push(e) },
    );
    expect(describePayloads).toHaveLength(1);
    expect(imageParts(describePayloads[0].messages[1])).toHaveLength(1);
    const m = lastUser();
    expect(typeof m.content).toBe('string');
    expect(m.content).toContain('transcribed by the vision assistant model');
    expect(m.content).toContain('KESTREL');
    expect(r.attached).toEqual({ images: 1, files: [], transcribed: true });
    expect(statuses.map((s) => s.stage)).toEqual(['start', 'done']);
    payloads = []; describeFails = true;
    try {
      const r2 = await askWith({ question: 'Again?', attachments: [{ name: 'sign.png', mimeType: 'image/png', data: PNG_1PX }] }, { visionMode: 'always', visionModelId: 'vis' });
      expect(imageParts(lastUser())).toHaveLength(1);
      expect(r2.attached?.transcribed).toBe(false);
    } finally { describeFails = false; }
  });

  it('入参消毒:base64 不合法丢;缩略图只认 jpeg/png/webp、限长、每轮前 4 张;最多 8 个;合计过大由路由拒', () => {
    const img = (i: number, thumb?: string) => ({ name: `p${i}.png`, mimeType: 'image/png', data: PNG_1PX, ...(thumb ? { thumb } : {}) });
    const n = normalizeAsideInput({
      question: 'q',
      attachments: [
        { name: 'bad.png', mimeType: 'image/png', data: 'not base64!!' },
        img(1, THUMB_OK), img(2, 'data:image/svg+xml;base64,PHN2Zz4='), img(3, `data:image/png;base64,${'A'.repeat(THUMB_MAX_CHARS)}`),
        img(4, THUMB_OK), img(5, THUMB_OK), img(6, THUMB_OK), img(7, THUMB_OK), img(8, THUMB_OK),
      ],
    })!;
    expect(n.attachments.map((a) => a.name)).toEqual(['p1.png', 'p2.png', 'p3.png', 'p4.png', 'p5.png', 'p6.png', 'p7.png']); // 第 9 个被 8 个上限截掉,bad 被丢
    expect(n.attachments.map((a) => !!a.thumb)).toEqual([true, false, false, true, true, true, false]);
    const meta = normalizeAsideInput({ question: 'q', thread: [{ question: 'a', answer: 'b', attachments: [{ name: 'x\ny.png', mimeType: 'IMAGE/PNG', data: PNG_1PX, thumb: THUMB_OK, size: 12 }] }] })!;
    expect(meta.thread[0].attachments).toEqual([{ name: 'x y.png', mimeType: 'image/png', size: 12 }]);
    expect(asideAttachmentsTooLarge({ attachments: [{ data: 'A'.repeat(ASIDE_MAX_ATTACH_CHARS + 1) }] })).toBe(true);
    expect(asideAttachmentsTooLarge({ attachments: [{ data: PNG_1PX }] })).toBe(false);
    expect(asideThinkingLevel('medium')).toBe('medium');
    expect(asideThinkingLevel('off')).toBeUndefined();
    expect(asideThinkingLevel('turbo')).toBeUndefined();
  });

  it('思考档:给了才带(加推理余量),缺省照旧不带', async () => {
    payloads = [];
    await askWith({ question: 'q' });
    expect(payloads[0].thinkingLevel).toBeUndefined();
    await askWith({ question: 'q' }, { thinkingLevel: 'medium' });
    expect(payloads[1].thinkingLevel).toBe('medium');
  });

  it('落库只留记录(名字 / 类型 / 大小 / 缩略图),附件内容不进 chat_asides', async () => {
    const input = normalizeAsideInput({ question: 'What is this?', attachments: [{ name: 'shot.png', mimeType: 'image/png', data: PNG_1PX, size: 70, thumb: THUMB_OK }, { name: 'a.txt', mimeType: 'text/plain', data: b64('hello') }] })!;
    const metas = attachmentMetas(input.attachments);
    const saved = await saveAside({ sessionId: 'S', userId: 'u1', messageId: 'm1', turn: { question: input.question, answer: 'A dot.', attachments: metas }, thread: [] });
    const [row] = await query<any[]>(`SELECT turns FROM chat_asides WHERE id = ?`, [saved!.id]);
    expect(row.turns).not.toContain(PNG_1PX);
    expect(row.turns).not.toContain(b64('hello'));
    expect(JSON.parse(row.turns)[0].attachments).toEqual([
      { name: 'shot.png', mimeType: 'image/png', size: 70, thumb: THUMB_OK },
      { name: 'a.txt', mimeType: 'text/plain', size: 5 },
    ]);
    // 续写:之前那轮的记录原样留着(以库里为准),新的一轮追加
    await saveAside({ asideId: saved!.id, sessionId: 'S', userId: 'u1', turn: { question: 'More?', answer: 'No.' }, thread: [] });
    const [again] = await query<any[]>(`SELECT turns FROM chat_asides WHERE id = ?`, [saved!.id]);
    const turns = JSON.parse(again.turns);
    expect(turns).toHaveLength(2);
    expect(turns[0].attachments[0].thumb).toBe(THUMB_OK);
  });
});
