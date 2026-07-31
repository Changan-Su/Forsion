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

describe('paginate 字符截断续读指针(07-30 二轮:截断消息即导航指令)', () => {
  it('窗口超 char 上限被腰斩:给出能续读的 offset(= 保住的最后一行,可能不完整故重读)', () => {
    // 每行 ~1000 字符 × 200 行 >> 100k 上限 → trimmed 分支
    const big = Array.from({ length: 200 }, (_, i) => `L${i} ` + 'x'.repeat(1000)).join('\n');
    const out = paginate(big);
    const m = out.match(/truncated at \d+ chars; continue with offset:(\d+) and a smaller limit/);
    expect(m).toBeTruthy();
    const next = Number(m![1]);
    // 续读点必须落在已展示窗口内的最后一行(0-based),且小于总行数
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(200);
    // 从该 offset 续读的第一行,是截断输出里最后出现的那一行(内容完整版)
    const lastShownLineNo = next + 1; // 显示行号 1-based
    expect(out).toContain(`\n${String(lastShownLineNo).padStart(6)}\t`);
    const cont = paginate(big, next, 1);
    expect(cont).toContain(`L${next} `);
  });
});
