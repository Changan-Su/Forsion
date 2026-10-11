import { describe, expect, it } from 'vitest';
import { stringifyWellFormed, wellFormed } from './wellFormedJson.js';
import { clip, snippetAround } from '../services/sessionSearch.js';

describe('stringifyWellFormed', () => {
  it('落单代理项不进请求体', () => {
    const cut = 'a😀'.slice(0, 2); // 按码元截断,留下半个 emoji
    const body = { messages: [{ role: 'tool', content: cut }, { role: 'user', content: '😀'.slice(1) + 'b' }] };
    expect(JSON.stringify(body)).toMatch(/\\ud83d/); // 负对照:原生序列化确实带出落单转义
    const wire = stringifyWellFormed(body);
    expect(wire).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(wire).messages.map((m: any) => m.content)).toEqual(['a�', '�b']);
  });

  it('成对的代理项、字面量反斜杠文本原样保留', () => {
    const s = '完整 😀 𝑡 与字面量 \\ud83d';
    expect(wellFormed(s)).toBe(s);
    expect(stringifyWellFormed({ s })).toBe(JSON.stringify({ s }));
  });
});

describe('会话搜索摘录不切开代理对', () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  it('clip / snippetAround 的截断点落在 emoji 中间', () => {
    expect(clip('ab😀cd', 3)).not.toMatch(lone);
    // 命中词前留 30 码元、后留 90:两头各摆一个会被切开的 emoji
    const content = '😀' + 'x'.repeat(29) + '关键词' + 'y'.repeat(89) + '😀尾巴';
    expect(snippetAround(content, '关键词')).not.toMatch(lone);
  });
});
