import { afterEach, describe, expect, it } from 'vitest';
import { createTanguProfile } from '../profiles/index.js';
import { __browserToolInternals } from './builtin/browserTools.js';
import { getToolCapabilities } from './registry.js';
import type { ToolContext } from './toolTypes.js';

describe('browser tool URL safety', () => {
  const originalAllowPrivate = process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;

  afterEach(() => {
    if (originalAllowPrivate === undefined) delete process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;
    else process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = originalAllowPrivate;
  });

  it('blocks private and localhost URLs by default', async () => {
    delete process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS;

    await expect(__browserToolInternals.validateUrl('http://127.0.0.1:8787')).rejects.toThrow(/Private|reserved/i);
    await expect(__browserToolInternals.validateUrl('http://localhost:8787')).rejects.toThrow(/Localhost/i);
    await expect(__browserToolInternals.validateUrl('file:///tmp/x')).rejects.toThrow(/Only http and https/i);
  });

  it('allows private http URLs only when explicitly enabled', async () => {
    process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';

    await expect(__browserToolInternals.validateUrl('http://127.0.0.1:8787/path')).resolves.toBe('http://127.0.0.1:8787/path');
    await expect(__browserToolInternals.validateUrl('file:///tmp/x')).rejects.toThrow(/Only http and https/i);
  });
});

describe('tool capability metadata', () => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const ctx: ToolContext = {
    userId: 'u1',
    sessionId: 's1',
    appId: profile.appId,
    profile,
    execMode: 'host',
    approvalMode: 'auto-edit',
  };

  it('marks read-only tools parallel and browser tools serial', () => {
    expect(getToolCapabilities('get_datetime', ctx)).toMatchObject({ sideEffect: 'none', parallel: true });
    expect(getToolCapabilities('read_file', ctx)).toMatchObject({ sideEffect: 'read', parallel: true });
    expect(getToolCapabilities('browser_search', ctx)).toMatchObject({ sideEffect: 'browser', parallel: false, concurrencyKey: 'browser' });
  });

  it('keeps unknown external tools serial by default', () => {
    expect(getToolCapabilities('mcp__server__tool', ctx)).toMatchObject({ sideEffect: 'unknown', parallel: false });
  });
});

describe('navigate: snapshot failure is surfaced, not swallowed', () => {
  // 2026-09-11 实锤:Bing 跳转页让 snapshot 卡满 30s 超时,navigate 返回 success 且无 snapshot,
  // 模型以为搜到了却没内容,换关键词重搜又烧一轮。这里用假 agent-browser 复现「open 成功 / snapshot 失败」。
  const saved = { bin: process.env.TANGU_AGENT_BROWSER_BIN, priv: process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS, sock: process.env.TANGU_BROWSER_SOCKET_DIR };
  afterEach(() => {
    for (const [k, v] of [['TANGU_AGENT_BROWSER_BIN', saved.bin], ['TANGU_BROWSER_ALLOW_PRIVATE_URLS', saved.priv], ['TANGU_BROWSER_SOCKET_DIR', saved.sock]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // 假二进制是 sh 脚本,Windows 上 spawn 会 ENOENT(且显式 BIN 不走 npx 兜底),该分支与平台无关,跳过即可。
  it.skipIf(process.platform === 'win32')('returns snapshotError when open succeeds but snapshot fails', async () => {
    const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'tangu-fakebr-'));
    const bin = join(dir, 'agent-browser');
    writeFileSync(bin, [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in',
      '    open) echo \'{"success":true,"data":{"url":"http://127.0.0.1/x","title":"T"}}\'; exit 0;;',
      '    snapshot) echo \'{"success":false,"error":"browser command timed out after 30000ms"}\'; exit 0;;',
      '  esac',
      'done',
      'echo \'{"success":false,"error":"unexpected"}\'',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.TANGU_AGENT_BROWSER_BIN = bin;
    process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';
    process.env.TANGU_BROWSER_SOCKET_DIR = dir;

    const profile = createTanguProfile({ sandboxMode: 'none' });
    const ctx: ToolContext = { userId: 'u1', sessionId: 's-nav', appId: profile.appId, profile, execMode: 'host', approvalMode: 'auto-edit' };
    const out = await __browserToolInternals.navigate(ctx, 'http://127.0.0.1/x');
    expect(out.success).toBe(true);
    expect(out.snapshot).toBeUndefined();
    expect(out.snapshotError).toMatch(/timed out/);
  });
});
