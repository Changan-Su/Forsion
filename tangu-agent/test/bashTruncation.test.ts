/**
 * run_bash 截断落盘(借 pi,07-30 归因轮):截断不再是信息湮灭——
 * 全量落盘临时文件、路径回传模型可回头 grep;标注总行数(借 Codex 截断元数据)。
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { truncateBashOutput } from '../src/tools/hostExec.js';

describe('truncateBashOutput', () => {
  it('未超限:原样返回,不落盘', async () => {
    const s = 'short output';
    expect(await truncateBashOutput(s)).toBe(s);
  });

  it('超限:保头尾 + 标注省略量与总行数 + 全量落盘临时文件(内容逐字节一致)', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i} ${'x'.repeat(20)}`);
    const big = lines.join('\n');
    const out = await truncateBashOutput(big, 400, 200);
    expect(out.startsWith(big.slice(0, 400))).toBe(true);
    expect(out.endsWith(big.slice(-200))).toBe(true);
    expect(out).toContain('(500 lines total)');
    const m = out.match(/captured output saved to (\S+\.log)/);
    expect(m).toBeTruthy();
    const saved = await fs.readFile(m![1], 'utf-8');
    expect(saved).toBe(big);
    await fs.rm(m![1], { force: true });
  });
});
