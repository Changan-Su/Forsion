/**
 * 大工具输出落盘的 host 分支:host 模式必须落 OS tmpdir 并返回**绝对路径**——
 * sandbox 会话目录 + "/.agent/…" 相对路径对 host 的 read_file(真实 FS)不可达
 * (browser_* 是 host-only,超限输出全走这条分支;2026-08-22 修)。
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { persistLargeOutput } from './outputPersist.js';
import type { ToolContext } from './toolTypes.js';

const ctx = { execMode: 'host', runId: 'r-test', userId: 'u', appId: 'tangu', sessionId: 's' } as unknown as ToolContext;

describe('persistLargeOutput (host)', () => {
  it('小输出原样返回,不落盘', async () => {
    const r = await persistLargeOutput(ctx, 'unit', 'short');
    expect(r).toEqual({ preview: 'short', path: null });
  });

  it('超限输出落 tmpdir,返回可读回的绝对路径 + 头尾预览', async () => {
    const big = 'H'.repeat(3000) + 'M'.repeat(8000) + 'T'.repeat(500);
    const r = await persistLargeOutput(ctx, 'unit', big);
    expect(r.path).toBeTruthy();
    expect(path.isAbsolute(r.path!)).toBe(true);
    expect(await fs.readFile(r.path!, 'utf-8')).toBe(big); // 全文可读回
    expect(r.preview).toContain('H'.repeat(100)); // 头
    expect(r.preview).toContain('T'.repeat(100)); // 尾
    expect(r.preview.length).toBeLessThan(4000);
    await fs.rm(r.path!, { force: true });
  });
});
