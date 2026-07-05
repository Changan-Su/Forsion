import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, looksLikeToolCallText } from './textToolCalls.js';

describe('parseTextToolCalls — Anthropic <invoke>/<parameter>', () => {
  it('extracts a tool call and cleans surrounding prose', () => {
    const content = 'before <invoke name="read_file"><parameter name="path">/tmp/a.txt</parameter></invoke> after';
    const r = parseTextToolCalls(content);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ path: '/tmp/a.txt' });
    expect(r.cleaned).toContain('before');
    expect(r.cleaned).toContain('after');
    expect(r.cleaned).not.toContain('<invoke');
  });

  it('parses string="false" params as JSON', () => {
    const content = '<invoke name="f"><parameter name="count" string="false">5</parameter></invoke>';
    const r = parseTextToolCalls(content);
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ count: 5 });
  });

  it('tolerates a missing </invoke> close tag (truncation)', () => {
    const content = '<invoke name="read_file"><parameter name="path">/tmp/a.txt';
    const r = parseTextToolCalls(content);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ path: '/tmp/a.txt' });
  });
});

describe('parseTextToolCalls — Kimi K2', () => {
  it('parses functions.NAME:IDX + argument json', () => {
    const content = '<|tool_call_begin|>functions.search:0<|tool_call_argument_begin|>{"q":"hi"}<|tool_call_end|>';
    const r = parseTextToolCalls(content);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe('search');
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ q: 'hi' });
  });
});

describe('parseTextToolCalls — DeepSeek native', () => {
  it('parses sep NAME + json fence', () => {
    const BAR = '｜'; // ｜
    const LOW = '▁'; // ▁
    const begin = `<${BAR}tool${LOW}call${LOW}begin${BAR}>`;
    const sep = `<${BAR}tool${LOW}sep${BAR}>`;
    const end = `<${BAR}tool${LOW}call${LOW}end${BAR}>`;
    const content = `${begin}function${sep}list_dir \`\`\`json {"path":"."} \`\`\`${end}`;
    const r = parseTextToolCalls(content);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].function.name).toBe('list_dir');
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ path: '.' });
  });
});

describe('parseTextToolCalls — safety', () => {
  it('returns empty for plain prose', () => {
    const r = parseTextToolCalls('just a normal sentence with no tool calls');
    expect(r.toolCalls).toHaveLength(0);
    expect(r.cleaned).toBe('just a normal sentence with no tool calls');
  });
  it('bails on >200KB input without parsing (ReDoS guard)', () => {
    const huge = '<'.repeat(200_001);
    const r = parseTextToolCalls(huge);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.cleaned).toBe(huge);
  });
});

describe('looksLikeToolCallText', () => {
  it('is true for marker-bearing text', () => {
    expect(looksLikeToolCallText('<invoke name="x">')).toBe(true);
    expect(looksLikeToolCallText('<|tool_call_begin|>')).toBe(true);
  });
  it('is false for prose merely mentioning the words', () => {
    expect(looksLikeToolCallText('we should invoke the function later')).toBe(false);
    expect(looksLikeToolCallText('hello world')).toBe(false);
  });
});
