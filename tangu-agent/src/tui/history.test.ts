/**
 * 输入历史的跨进程并发(Codex 评审 tui #3):两个 tangu 同时开,旧版「读 → 追加 → 原子替换整份」
 * 会让后 rename 的进程吞掉先写的那行。这里两层:
 *   - 确定性:在「我们读完盘」与「我们写盘」之间插一次别人的追加(包一层 readFileSync 钩子),别人的行必须还在;
 *   - 真并发:4 个子进程同时各记 150 条,一条都不能少(旧实现实测只剩 ~1/3)。
 * 其余规则(去重 / 密钥不落盘 / 仅本人可读)见 tui.commands.test.ts。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHistory, persistHistoryLine, serializeHistory } from './history.js';

const hook = vi.hoisted(() => ({ afterRead: null as null | ((file: string) => void) }));

// 只包 readFileSync:读到历史文件后跑一次钩子(模拟「别的进程恰好在这时追加了一行」),其余原样。
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof real.readFileSync>) => {
    const out = real.readFileSync(...args);
    const f = hook.afterRead;
    if (f && typeof args[0] === 'string' && /tui_history[^/\\]*$/.test(args[0]) && !args[0].endsWith('.tmp')) {
      hook.afterRead = null;
      f(args[0]);
    }
    return out;
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

describe('input history across processes', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tangu-tui-hist-conc-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const otherProcessAppends = (line: string) => (file: string): void => {
    appendFileSync(file, serializeHistory([line]));
  };

  it('a line another process appends between our read and our write survives', () => {
    const file = join(dir, 'tui_history_race');
    writeFileSync(file, serializeHistory(['old']));
    hook.afterRead = otherProcessAppends('from-other-tangu');
    persistHistoryLine('mine', file);
    expect(hook.afterRead).toBeNull(); // 钩子确实在我们读盘之后触发过
    expect(loadHistory(file)).toEqual(['old', 'from-other-tangu', 'mine']);
  });

  it('compacts to the newest `limit` entries once the file reaches 2×limit, but never over a concurrent append', () => {
    const file = join(dir, 'tui_history_compact');
    writeFileSync(file, serializeHistory(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']));
    persistHistoryLine('x', file, 3);
    expect(readFileSync(file, 'utf8')).toBe(serializeHistory(['e5', 'e6', 'x']));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);

    // 边界(文档口径「盘上最多约 2×limit 条」):还差一条到 2×limit 时只追加、不整理,文件恰好攒到 2×limit 条;下一条才整理。
    const edge = join(dir, 'tui_history_compact_edge');
    writeFileSync(edge, serializeHistory(['e1', 'e2', 'e3', 'e4', 'e5']));
    persistHistoryLine('x', edge, 3);
    expect(loadHistory(edge, 100)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'x']);
    persistHistoryLine('y', edge, 3);
    expect(loadHistory(edge, 100)).toEqual(['e5', 'x', 'y']);

    // 整理那一刻别人刚追加:这次不整理(否则拿旧快照盖掉人家的行),照常追加。
    const file2 = join(dir, 'tui_history_compact_race');
    writeFileSync(file2, serializeHistory(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']));
    hook.afterRead = otherProcessAppends('from-other-tangu');
    persistHistoryLine('y', file2, 3);
    expect(loadHistory(file2, 100)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'from-other-tangu', 'y']);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]); // 放弃整理不留临时文件
  });

  it('dedupes against the last line on disk; appending to a hand-edited file without a trailing newline stays line-safe', () => {
    const file = join(dir, 'tui_history_tail');
    writeFileSync(file, 'plain line');
    persistHistoryLine('next', file);
    persistHistoryLine('next', file);
    expect(loadHistory(file)).toEqual(['plain line', 'next']);
    // 两个进程撞车各记了一次同一条:读时折叠
    appendFileSync(file, serializeHistory(['next']));
    expect(loadHistory(file)).toEqual(['plain line', 'next']);
    expect(existsSync(file)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('4 concurrent processes × 150 lines: nothing is lost', async () => {
    const require = createRequire(import.meta.url);
    const viteNode = join(require.resolve('vite-node/package.json'), '..', 'vite-node.mjs');
    const historyTs = fileURLToPath(new URL('./history.ts', import.meta.url));
    const child = join(dir, 'child.ts');
    writeFileSync(
      child,
      `import { persistHistoryLine } from ${JSON.stringify(historyTs)};\n` +
        `const [file, tag, n] = process.argv.slice(2);\n` +
        `for (let i = 0; i < Number(n); i++) persistHistoryLine(tag + '-' + i, file, 100000);\n`,
    );
    const file = join(dir, 'tui_history_procs');
    const tags = ['a', 'b', 'c', 'd'];
    await Promise.all(
      tags.map(
        (tag) =>
          new Promise<void>((resolve, reject) =>
            execFile(process.execPath, [viteNode, child, file, tag, '150'], { timeout: 60_000 }, (err, _o, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve())),
          ),
      ),
    );
    const got = new Set(loadHistory(file, 100000));
    const missing = tags.flatMap((t) => Array.from({ length: 150 }, (_, i) => `${t}-${i}`)).filter((l) => !got.has(l));
    expect(missing).toEqual([]);
  }, 90_000);
});
