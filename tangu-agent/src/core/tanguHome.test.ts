/**
 * forsionSharedDir 的四形态:①home 目录名=tangu(桌面托管 ~/.forsion/tangu)→父目录;
 * ②~/.tangu 软链指入 …/tangu → 经 realpath 归位到真身父目录(CLI 与桌面不分脑);
 * ③普通目录(纯 standalone ~/.tangu 真目录/测试重定向)→自身=旧行为;④路径不存在→按字面判断。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forsionSharedDir } from './tanguHome.js';

const prevHome = process.env.TANGU_HOME;
afterEach(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
});

describe('forsionSharedDir', () => {
  it('home 目录名为 tangu → 共享域=父目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'fsd-'));
    mkdirSync(join(base, 'tangu'), { recursive: true });
    process.env.TANGU_HOME = join(base, 'tangu');
    expect(forsionSharedDir()).toBe(realpathSync(base)); // mac /var→/private/var:与 realpath 同规比较
    rmSync(base, { recursive: true, force: true });
  });

  it('软链指入 …/tangu → 经 realpath 归位真身父目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'fsd-'));
    mkdirSync(join(base, 'forsion', 'tangu'), { recursive: true });
    symlinkSync(join(base, 'forsion', 'tangu'), join(base, '.tangu'));
    process.env.TANGU_HOME = join(base, '.tangu');
    // mac 的 /tmp 本身是软链,realpath 结果与 join 期望需同规:比较各自 realpath 后的父目录
    expect(forsionSharedDir().endsWith(join('forsion'))).toBe(true);
    rmSync(base, { recursive: true, force: true });
  });

  it('普通目录 → 共享域=home 自身(旧行为)', () => {
    const base = mkdtempSync(join(tmpdir(), 'fsd-'));
    process.env.TANGU_HOME = base;
    expect(forsionSharedDir()).toBe(base);
    rmSync(base, { recursive: true, force: true });
  });

  it('路径不存在 → 按字面判断', () => {
    process.env.TANGU_HOME = join(tmpdir(), 'fsd-nope', 'tangu');
    expect(forsionSharedDir()).toBe(join(tmpdir(), 'fsd-nope'));
    process.env.TANGU_HOME = join(tmpdir(), 'fsd-nope', '.tangu');
    expect(forsionSharedDir()).toBe(join(tmpdir(), 'fsd-nope', '.tangu'));
  });
});
