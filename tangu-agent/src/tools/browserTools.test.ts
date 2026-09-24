import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTanguProfile } from '../profiles/index.js';
import { __browserToolInternals, browserTabsProvider, userBrowserEndpoint } from './builtin/browserTools.js';
import { toolNeedsApproval } from '../services/approvals.js';
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

describe('user browser attach (Chrome remote debugging)', () => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const ctxOf = (extra: Partial<ToolContext> = {}): ToolContext => ({ userId: 'u1', sessionId: 's-attach', appId: profile.appId, profile, execMode: 'host', approvalMode: 'auto-edit', ...extra });
  const saved = { cdp: process.env.TANGU_BROWSER_CDP, bin: process.env.TANGU_AGENT_BROWSER_BIN, sock: process.env.TANGU_BROWSER_SOCKET_DIR, priv: process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS };
  afterEach(() => {
    for (const [k, v] of [['TANGU_BROWSER_CDP', saved.cdp], ['TANGU_AGENT_BROWSER_BIN', saved.bin], ['TANGU_BROWSER_SOCKET_DIR', saved.sock], ['TANGU_BROWSER_ALLOW_PRIVATE_URLS', saved.priv]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('finds the endpoint only when DevToolsActivePort is well-formed and its port is alive', async () => {
    const srv = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as any).port as number;
    const root = mkdtempSync(join(tmpdir(), 'tangu-devtools-'));
    const dir = (n: string, body?: string): string => { const d = join(root, n); mkdirSync(d); if (body !== undefined) writeFileSync(join(d, 'DevToolsActivePort'), body); return d; };
    const missing = dir('missing');
    const bad = dir('bad', 'not-a-port\n/devtools/browser/x');
    const stale = dir('stale', '1\n/devtools/browser/dead'); // Chrome 退出不删文件:端口已死必须跳过
    const live = dir('live', `${port}\n/devtools/browser/abc-123\n`);
    try {
      expect(await __browserToolInternals.findUserBrowser([missing, bad, stale, live])).toBe(`ws://127.0.0.1:${port}/devtools/browser/abc-123`);
      expect(await __browserToolInternals.findUserBrowser([missing, bad, stale])).toBeNull();
    } finally { srv.close(); }
  });

  it('never attaches for background runs or when switched off', async () => {
    process.env.TANGU_BROWSER_CDP = 'ws://127.0.0.1:1/devtools/browser/x';
    expect(await userBrowserEndpoint({})).toBe('ws://127.0.0.1:1/devtools/browser/x');
    expect(await userBrowserEndpoint({ muse: true })).toBeNull();
    expect(await userBrowserEndpoint({ approvalDeferral: 'queue' })).toBeNull();
    process.env.TANGU_BROWSER_CDP = 'off';
    expect(await userBrowserEndpoint({})).toBeNull();
  });

  it('picks a tab by exact id, else by a unique title/URL substring', () => {
    const tabs = [
      { tab: 't1', title: 'forgejo', url: 'https://forgejo.org/' },
      { tab: 't2', title: '天禄五环 测评 - 哔哩哔哩', url: 'https://www.bilibili.com/video/BV1' },
      { tab: 't3', title: '搜索', url: 'https://search.bilibili.com/all?keyword=x' },
    ];
    expect(__browserToolInternals.pickTabs(tabs, 't3').map((t) => t.tab)).toEqual(['t3']);
    expect(__browserToolInternals.pickTabs(tabs, 'BILIBILI.com/video').map((t) => t.tab)).toEqual(['t2']);
    expect(__browserToolInternals.pickTabs(tabs, '哔哩').map((t) => t.tab)).toEqual(['t2']);
    expect(__browserToolInternals.pickTabs(tabs, 'bilibili')).toHaveLength(2); // 歧义不猜
    expect(__browserToolInternals.pickTabs(tabs, 'youtube')).toHaveLength(0);
  });

  it('browser_tabs explains the one-time setup when not connected', async () => {
    process.env.TANGU_BROWSER_CDP = 'off';
    const out = JSON.parse(String(await browserTabsProvider.tools()[0].execute({}, ctxOf())));
    expect(out).toMatchObject({ success: false, connected: false });
    expect(out.error).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
  });

  it('gates clicks/typing only while driving the user\'s browser, and never in full-auto', () => {
    expect(toolNeedsApproval('browser_click', 'auto-edit')).toBe(false);
    expect(toolNeedsApproval('browser_click', 'auto-edit', { userBrowser: true })).toBe(true);
    expect(toolNeedsApproval('browser_console', 'readonly', { userBrowser: true })).toBe(true);
    expect(toolNeedsApproval('browser_click', 'full-auto', { userBrowser: true })).toBe(false);
    expect(toolNeedsApproval('browser_snapshot', 'auto-edit', { userBrowser: true })).toBe(false);
  });

  // 假 agent-browser:把每次的 argv 记进日志,按子命令回答(sh 脚本,Windows 上跳过,同上面 navigate 用例)
  const fakeBin = (hasOwnTab: boolean): { dir: string; log: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'tangu-fakebr-attach-'));
    const log = join(dir, 'argv.log');
    const bin = join(dir, 'agent-browser');
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      'case "$*" in',
      `  *"tab tangu"*) ${hasOwnTab ? `echo '{"success":true,"data":{"tabId":"t9","label":"tangu"}}'` : `echo '{"success":false,"error":"No tab with label \`tangu\`; run \`agent-browser tab\` to list open tabs"}'`};;`,
      `  *"tab new"*) echo '{"success":true,"data":{"tabId":"t9","label":"tangu","url":"http://127.0.0.1/x"}}';;`,
      `  *" open "*) echo '{"success":true,"data":{"url":"http://127.0.0.1/x","title":"X"}}';;`,
      `  *"tab list"*) echo '{"success":true,"data":{"tabs":[{"tabId":"t1","active":true,"title":"GitHub","url":"https://github.com/"},{"tabId":"t2","active":false,"title":"Video - bilibili","url":"https://www.bilibili.com/video/BV1"}]}}';;`,
      `  *"tab t2"*) echo '{"success":true,"data":{"tabId":"t2","title":"Video - bilibili","url":"https://www.bilibili.com/video/BV1"}}';;`,
      `  *"get text"*) echo '{"success":true,"data":{"text":"Best pick: No. 3"}}';;`,
      `  *snapshot*) echo '{"success":true,"data":{"snapshot":"- link \\"No. 3\\" [ref=e1]","refs":{"e1":{}}}}';;`,
      `  *) echo '{"success":false,"error":"unexpected"}';;`,
      'esac',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.TANGU_AGENT_BROWSER_BIN = bin;
    process.env.TANGU_BROWSER_SOCKET_DIR = dir;
    process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';
    process.env.TANGU_BROWSER_CDP = 'ws://127.0.0.1:9/devtools/browser/fake';
    return { dir, log };
  };
  const calls = (log: string): string[] => readFileSync(log, 'utf8').trim().split('\n');

  it.skipIf(process.platform === 'win32')('navigate opens a new Tangu-labelled tab instead of replacing the user\'s tab', async () => {
    const { log } = fakeBin(false);
    const out = await __browserToolInternals.navigate(ctxOf(), 'http://127.0.0.1/x');
    expect(out.success).toBe(true);
    const argv = calls(log);
    expect(argv.every((a) => a.includes('--cdp ws://127.0.0.1:9/devtools/browser/fake') && /--session tangu_chrome_[0-9a-f]{10} /.test(a))).toBe(true);
    expect(argv.some((a) => a.includes('tab new --label tangu http://127.0.0.1/x'))).toBe(true);
    expect(argv.some((a) => / open /.test(` ${a} `))).toBe(false); // open 会覆盖用户正看着的那个标签
  });

  it.skipIf(process.platform === 'win32')('navigate reuses Tangu\'s own tab when it already exists', async () => {
    const { log } = fakeBin(true);
    await __browserToolInternals.navigate(ctxOf(), 'http://127.0.0.1/x');
    const argv = calls(log);
    expect(argv[0]).toMatch(/tab tangu$/);
    expect(argv[1]).toMatch(/--json open http:\/\/127\.0\.0\.1\/x$/);
    expect(argv.some((a) => a.includes('tab new'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('browser_tabs lists tabs, refuses to guess, and reads the one selected', async () => {
    fakeBin(false);
    const tool = browserTabsProvider.tools()[0];
    const listed = JSON.parse(String(await tool.execute({}, ctxOf())));
    expect(listed.tabs.map((t: any) => t.tab)).toEqual(['t1', 't2']);
    const ambiguous = JSON.parse(String(await tool.execute({ select: 'http' }, ctxOf())));
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.tabs).toHaveLength(2);
    const read = JSON.parse(String(await tool.execute({ select: 'bilibili' }, ctxOf())));
    expect(read).toMatchObject({ success: true, tab: 't2', url: 'https://www.bilibili.com/video/BV1', text: 'Best pick: No. 3' });
    expect(read.refs).toContain('ref=e1');
  });
});
