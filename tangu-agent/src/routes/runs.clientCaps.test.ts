/**
 * 客户端能力握手的消毒(normalizeClientCapabilities)与回执文本消毒(sanitizeMultilineText / normalizeClientResult)。
 * 信任边界:能力决定哪些 phone_* 工具进模型的工具面;回执文本会被格式化进模型上下文。
 */
import { describe, it, expect } from 'vitest';
import { normalizeClientCapabilities, normalizeClientResult, sanitizeMultilineText } from './runs.js';

describe('normalizeClientCapabilities', () => {
  it('非数组 / 缺席 → undefined(老客户端:不落 input)', () => {
    for (const v of [undefined, null, 'phone.intents', { 0: 'phone.intents' }, 42]) expect(normalizeClientCapabilities(v)).toBeUndefined();
  });

  it('空数组或全不合法 → undefined', () => {
    expect(normalizeClientCapabilities([])).toBeUndefined();
    expect(normalizeClientCapabilities(['', 'PHONE.intents', 'phone', '.intents', 'phone.', 42, null])).toBeUndefined();
  });

  it('去重 + 排序;不合法项静默丢', () => {
    expect(normalizeClientCapabilities(['phone.ui', 'phone.intents', 'phone.ui', 'bad cap', '__proto__.x'])).toEqual(['phone.intents', 'phone.ui']);
  });

  it('形态:ns ≤24、name ≤16、只收小写字母数字与连字符', () => {
    expect(normalizeClientCapabilities([`a${'b'.repeat(23)}.c`])).toEqual([`a${'b'.repeat(23)}.c`]);
    expect(normalizeClientCapabilities([`a${'b'.repeat(24)}.c`])).toBeUndefined();
    expect(normalizeClientCapabilities([`phone.${'x'.repeat(16)}`])).toHaveLength(1);
    expect(normalizeClientCapabilities([`phone.${'x'.repeat(17)}`])).toBeUndefined();
    expect(normalizeClientCapabilities(['phone.in_tents', 'phone.in tents', '1phone.x', 'phone.a.b'])).toBeUndefined();
    expect(normalizeClientCapabilities(['my-ns.x-1'])).toEqual(['my-ns.x-1']);
  });

  it('≤16 项:只看前 16 个', () => {
    const many = Array.from({ length: 20 }, (_, i) => `ns${i}.x`);
    expect(normalizeClientCapabilities(many)).toHaveLength(16);
  });
});

describe('sanitizeMultilineText', () => {
  it('保留 \\n \\t,\\r\\n → \\n,剥其余控制字符 / 零宽 / bidi,截断', () => {
    expect(sanitizeMultilineText('a\r\nb\rc\td\u0000e\u001Bf​g‮h⁦i j', 100)).toBe('a\nb\nc\tdefghij');
    expect(sanitizeMultilineText('x'.repeat(10), 4)).toBe('xxxx');
  });
});

describe('normalizeClientResult', () => {
  it('ok 只认字面量 true;空串字段不落', () => {
    expect(normalizeClientResult({ ok: 1, app: '   ', error: '' })).toEqual({ ok: false });
    expect(normalizeClientResult({ ok: true })).toEqual({ ok: true });
  });
  it('code 必须 /^[a-z_]{1,32}$/', () => {
    expect(normalizeClientResult({ ok: false, code: 'needs_foreground' }).code).toBe('needs_foreground');
    for (const c of ['NEEDS', 'a-b', 'x'.repeat(33), '', 3]) expect(normalizeClientResult({ ok: false, code: c }).code).toBeUndefined();
  });
  it('image 只收 jpeg / png 的 base64 data URL,且有体积上限', () => {
    expect(normalizeClientResult({ ok: true, image: 'data:image/jpeg;base64,/9j/4AAQ' }).image).toBe('data:image/jpeg;base64,/9j/4AAQ');
    for (const img of ['data:image/gif;base64,R0lG', 'https://x/y.png', 'data:image/png;base64,<script>', `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`]) {
      expect(normalizeClientResult({ ok: true, image: img }).image).toBeUndefined();
    }
  });
  it('app ≤80 单行、error ≤500 单行', () => {
    const r = normalizeClientResult({ ok: true, app: `A\nB${'x'.repeat(100)}`, error: 'e\n'.repeat(400) });
    expect(r.app).toHaveLength(80);
    expect(r.app).not.toContain('\n');
    expect(r.error!.length).toBeLessThanOrEqual(500);
    expect(r.error).not.toContain('\n');
  });
});
