/**
 * 外部引擎 MCP 导入 × 设备 MCP 保留命名空间(方案 2026-09-26 §4.6-3):
 *   - 名字占用保留命名空间(`dev_*` / `dev`)→ 拒绝导入并说明,不落盘;
 *   - 判「已导入 / 已存在」按磁盘视图 —— 运行时视图跳过保留名,拿它判重 = 每导一次多一份、列表永远显示「未导入」;
 *   - 锁内读改写不抹掉磁盘上别的(含保留名的)server。
 * 修复前(加载时改名为 user_<名>、判重看改名后的视图)实跑为红:同一个 dev_tools 连导三次都 ok、磁盘多出 user_dev_tools(_2)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importEngineMcp, listEngineAssets } from './assets.js';
import { getRawSection, saveSection } from '../core/config.js';

let dir: string;
let prev: { HOME?: string; TANGU_HOME?: string };
beforeEach(() => {
  prev = { HOME: process.env.HOME, TANGU_HOME: process.env.TANGU_HOME };
  dir = mkdtempSync(join(tmpdir(), 'tangu-assets-'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'th'));
  process.env.HOME = join(dir, 'home'); // os.homedir() → ~/.claude.json 读这里
  process.env.TANGU_HOME = join(dir, 'th'); // Tangu 的 config.json(共享域 = home 自身)
  writeFileSync(join(dir, 'home', '.claude.json'), JSON.stringify({ mcpServers: {
    dev_tools: { command: 'evil-bin' }, dev: { url: 'http://x' }, ok: { command: 'ok-bin', args: ['-a'] },
  } }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ['HOME', 'TANGU_HOME'] as const) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const diskKeys = () => Object.keys(getRawSection('mcp')?.mcpServers ?? {}).sort();

describe('importEngineMcp × 保留命名空间', () => {
  it('保留名拒绝导入并说明原因,反复导入也不落盘', () => {
    for (let i = 0; i < 3; i++) {
      const r = importEngineMcp('claude-code', 'dev_tools');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('reserved');
    }
    expect(importEngineMcp('claude-code', 'dev').ok).toBe(false);
    expect(diskKeys()).toEqual([]);
  });

  it('普通名:第一次导入成功(enabled:false),第二次 already exists', () => {
    expect(importEngineMcp('claude-code', 'ok')).toEqual({ ok: true });
    expect(importEngineMcp('claude-code', 'ok')).toEqual({ ok: false, error: 'already exists' });
    expect(getRawSection('mcp').mcpServers.ok).toEqual({ enabled: false, command: 'ok-bin', args: ['-a'] });
  });

  it('磁盘上已有的保留名 server(旧版导进来的)不被读改写抹掉,列表按磁盘判「已导入」', () => {
    saveSection('mcp', { mcpServers: { dev_tools: { command: 'evil-bin', enabled: false } } });
    expect(importEngineMcp('claude-code', 'ok')).toEqual({ ok: true });
    expect(diskKeys()).toEqual(['dev_tools', 'ok']);
    const items = Object.fromEntries(listEngineAssets('claude-code').mcp.map((m) => [m.name, m]));
    expect(items.dev_tools).toMatchObject({ imported: true, reserved: true });
    expect(items.dev).toMatchObject({ imported: false, reserved: true });
    expect(items.ok.imported).toBe(true);
    expect(items.ok.reserved).toBeUndefined();
  });
});
