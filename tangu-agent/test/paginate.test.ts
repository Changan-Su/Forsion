import { describe, it, expect } from 'vitest';
import { paginate } from '../src/tools/hostExec.js';

// read_file 现在返回 cat -n 风格:模型必须能从每行 "  N\t<raw>" 反推出原始行,才能命中 edit_file 的 old_string。
const stripPrefix = (line: string): string => line.replace(/^\s*\d+\t/, '');

describe('paginate (cat -n read_file output)', () => {
  it('numbers every line 1-based with a header, no "more" when whole file shown', () => {
    const out = paginate('alpha\nbeta\ngamma');
    const [header, ...lines] = out.split('\n');
    expect(header).toBe('[lines 1-3 of 3]');
    expect(lines).toEqual(['     1\talpha', '     2\tbeta', '     3\tgamma']);
    expect(out).not.toContain('more line');
    // 反推:去掉行号前缀 = 原始行(缩进/空白无损),这是 edit_file 唯一命中的前提
    expect(lines.map(stripPrefix)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('preserves leading whitespace exactly after stripping the prefix', () => {
    const raw = '\t  indented';
    const line = paginate(raw).split('\n')[1];
    expect(stripPrefix(line)).toBe(raw);
  });

  it('offset/limit paginates and points to the next offset', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    const out = paginate(text, 3, 2);
    expect(out.split('\n')[0]).toBe('[lines 4-5 of 10]');
    expect(out).toContain('     4\tL3');
    expect(out).toContain('     5\tL4');
    expect(out).toContain('read with offset:5'); // 5 more lines below, continue from line index 5
  });
});
