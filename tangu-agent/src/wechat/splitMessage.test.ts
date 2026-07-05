import { describe, it, expect } from 'vitest';
import { splitMessage } from './splitMessage.js';

describe('splitMessage', () => {
  it('empty / whitespace → []', () => {
    expect(splitMessage('')).toEqual([]);
    expect(splitMessage('   \n  ')).toEqual([]);
  });

  it('single short line stays one segment', () => {
    expect(splitMessage('你好呀')).toEqual(['你好呀']);
  });

  it('splits on blank lines and single newlines', () => {
    expect(splitMessage('第一句\n\n第二句')).toEqual(['第一句', '第二句']);
    expect(splitMessage('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('does NOT split code blocks or tables', () => {
    const code = 'see:\n```\ncode\nhere\n```';
    expect(splitMessage(code)).toEqual([code]);
    const table = 'x\n| a | b |\n| - | - |';
    expect(splitMessage(table)).toEqual([table]);
  });

  it('splits a long single line by sentence boundaries', () => {
    const long = '这是第一句话。' + '然后这是很长很长很长很长很长很长很长很长的第二句话。';
    const segs = splitMessage(long, { maxSeg: 12 });
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.join('')).toContain('第一句话');
  });

  it('caps segment count and merges the tail', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const segs = splitMessage(many, { maxSegments: 5 });
    expect(segs.length).toBe(5);
    expect(segs[4]).toContain('line19'); // remainder merged into last
  });

  it('joins ASCII sentences with a space, not CJK', () => {
    const en = 'Hello world. Second one here. Third sentence now.';
    const segs = splitMessage(en, { maxSeg: 24 });
    expect(segs.every((s) => !/[a-z]\.[A-Z]/.test(s))).toBe(true); // no "word.Next" glue
  });
});
