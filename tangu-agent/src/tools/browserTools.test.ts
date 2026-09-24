import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTanguProfile } from '../profiles/index.js';
import { __browserToolInternals, browserTabsProvider, browserToolsProvider, userBrowserEndpoint } from './builtin/browserTools.js';
import { toolNeedsApproval } from '../services/approvals.js';
import { getToolCapabilities, getToolDefinitions } from './registry.js';
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
    delete process.env.PID_FILE_VALUE;
    __browserToolInternals.clearBindings(); // 绑定是模块级状态,用例之间不许串
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

  it('never attaches for background runs (Muse, automations, deferred approvals) or when switched off', async () => {
    process.env.TANGU_BROWSER_CDP = 'ws://127.0.0.1:1/devtools/browser/x';
    expect(await userBrowserEndpoint({})).toBe('ws://127.0.0.1:1/devtools/browser/x');
    expect(await userBrowserEndpoint({ muse: true })).toBeNull();
    expect(await userBrowserEndpoint({ approvalDeferral: 'queue' })).toBeNull();
    expect(await userBrowserEndpoint({ automationOrigin: 'rule:daily' })).toBeNull(); // Codex 09-24 #1:自动化 run 是 full-auto、没人看着
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

  it('browser_tabs is hidden from background runs (Muse runs plan mode, which whitelists it)', () => {
    const names = (extra: Partial<ToolContext>): string[] => getToolDefinitions(ctxOf(extra)).map((t: any) => t.function.name);
    expect(names({})).toContain('browser_tabs');
    expect(names({ muse: true, planMode: true })).not.toContain('browser_tabs');
    expect(names({ approvalDeferral: 'queue' })).not.toContain('browser_tabs');
    expect(names({ automationOrigin: 'rule:daily' })).not.toContain('browser_tabs');
  });

  it('browser_tabs explains the one-time setup when not connected', async () => {
    process.env.TANGU_BROWSER_CDP = 'off';
    const out = JSON.parse(String(await browserTabsProvider.tools()[0].execute({}, ctxOf())));
    expect(out).toMatchObject({ success: false, connected: false });
    expect(out.error).toMatch(/chrome:\/\/inspect\/#remote-debugging/);
  });

  it('gates clicks/typing/back only while driving the user\'s browser, and never in full-auto', () => {
    expect(toolNeedsApproval('browser_click', 'auto-edit')).toBe(false);
    expect(toolNeedsApproval('browser_click', 'auto-edit', { userBrowser: true })).toBe(true);
    expect(toolNeedsApproval('browser_back', 'auto-edit', { userBrowser: true })).toBe(true);
    expect(toolNeedsApproval('browser_console', 'readonly', { userBrowser: true })).toBe(true);
    expect(toolNeedsApproval('browser_click', 'full-auto', { userBrowser: true })).toBe(false);
    expect(toolNeedsApproval('browser_snapshot', 'auto-edit', { userBrowser: true })).toBe(false);
  });

  // 假 agent-browser(sh,Windows 跳过):argv 记日志、按子命令回答;像真的一样在 socket 目录写 <session>.pid
  // (pid 取 PID_FILE_VALUE,改它 = 模拟守护进程闲置退出后重开)。endpoint 含 "refuse" 时一律报连不上 CDP。
  const fakeBin = (hasOwnTab: boolean, endpoint = 'ws://127.0.0.1:9/devtools/browser/fake'): { dir: string; log: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'tangu-fakebr-attach-'));
    const log = join(dir, 'argv.log');
    const bin = join(dir, 'agent-browser');
    writeFileSync(bin, [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      'prev=""; for a in "$@"; do [ "$prev" = "--session" ] && echo "$PID_FILE_VALUE" > "$AGENT_BROWSER_SOCKET_DIR/$a.pid"; prev="$a"; done',
      'case "$*" in',
      `  *refuse*) echo '{"success":false,"error":"CDP WebSocket connect failed: IO error: Connection refused (os error 61)"}';;`,
      `  *"tab tangu-"*) ${hasOwnTab ? `echo '{"success":true,"data":{"tabId":"t9","label":"tangu-x"}}'` : `echo '{"success":false,"error":"No tab with label \`tangu-x\`; run \`agent-browser tab\` to list open tabs"}'`};;`,
      `  *"tab new"*) echo '{"success":true,"data":{"tabId":"t9","label":"tangu-x","url":"http://127.0.0.1/x"}}';;`,
      `  *" open "*) echo '{"success":true,"data":{"url":"http://127.0.0.1/x","title":"X"}}';;`,
      `  *"tab list"*) CUR=$(cat "$AGENT_BROWSER_SOCKET_DIR/current" 2>/dev/null || echo t1); A1=false; A2=false; [ "$CUR" = t1 ] && A1=true; [ "$CUR" = t2 ] && A2=true; echo '{"success":true,"data":{"tabs":[{"tabId":"t1","active":'$A1',"title":"GitHub","url":"https://github.com/"},{"tabId":"t2","active":'$A2',"title":"Video - bilibili","url":"https://www.bilibili.com/video/BV1"}]}}';;`,
      `  *"tab t2"*) echo t2 > "$AGENT_BROWSER_SOCKET_DIR/current"; echo '{"success":true,"data":{"tabId":"t2","title":"Video - bilibili","url":"https://www.bilibili.com/video/BV1"}}';;`,
      `  *"get text"*) echo '{"success":true,"data":{"text":"Best pick: No. 3"}}';;`,
      `  *snapshot*) echo '{"success":true,"data":{"snapshot":"- link \\"No. 3\\" [ref=e1]","refs":{"e1":{}}}}';;`,
      `  *" click "*) echo '{"success":true,"data":{}}';;`,
      `  *) echo '{"success":false,"error":"unexpected"}';;`,
      'esac',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.TANGU_AGENT_BROWSER_BIN = bin;
    process.env.TANGU_BROWSER_SOCKET_DIR = dir;
    process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';
    process.env.TANGU_BROWSER_CDP = endpoint;
    process.env.PID_FILE_VALUE = String(process.pid); // 守护进程 pid 要指向活着的进程(实现会核活性)
    return { dir, log };
  };
  const calls = (log: string): string[] => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const tool = (name: string): any => [...browserToolsProvider.tools(), ...browserTabsProvider.tools()].find((t) => t.name === name);
  const exec = async (name: string, args: any, ctx: ToolContext): Promise<any> => JSON.parse(String(await tool(name).execute(args, ctx)));

  it.skipIf(process.platform === 'win32')('navigate opens a per-conversation Tangu tab instead of replacing the user\'s tab', async () => {
    const { log } = fakeBin(false);
    const out = await __browserToolInternals.navigate(ctxOf(), 'http://127.0.0.1/x');
    expect(out.success).toBe(true);
    const argv = calls(log);
    expect(argv.every((a) => a.includes('--cdp ws://127.0.0.1:9/devtools/browser/fake') && /--session tangu_chrome_[0-9a-f]{10} /.test(a))).toBe(true);
    expect(argv.some((a) => /tab new --label tangu-[0-9a-f]{6} http:\/\/127\.0\.0\.1\/x$/.test(a))).toBe(true);
    expect(argv.some((a) => / open /.test(` ${a} `))).toBe(false); // open 会覆盖用户正看着的那个标签
  });

  it.skipIf(process.platform === 'win32')('navigate reuses this conversation\'s own tab when it already exists', async () => {
    const { log } = fakeBin(true);
    await __browserToolInternals.navigate(ctxOf(), 'http://127.0.0.1/x');
    const argv = calls(log);
    expect(argv[0]).toMatch(/tab tangu-[0-9a-f]{6}$/);
    expect(argv[1]).toMatch(/--json open http:\/\/127\.0\.0\.1\/x$/);
    expect(argv.some((a) => a.includes('tab new'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('browser_tabs lists tabs, refuses to guess, and reads the one selected', async () => {
    fakeBin(false);
    const listed = await exec('browser_tabs', {}, ctxOf());
    expect(listed.tabs.map((t: any) => t.tab)).toEqual(['t1', 't2']);
    const ambiguous = await exec('browser_tabs', { select: 'http' }, ctxOf());
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.tabs).toHaveLength(2);
    const read = await exec('browser_tabs', { select: 'bilibili' }, ctxOf());
    expect(read).toMatchObject({ success: true, tab: 't2', url: 'https://www.bilibili.com/video/BV1', text: 'Best pick: No. 3' });
    expect(read.refs).toContain('ref=e1');
  });

  it.skipIf(process.platform === 'win32')('control tools act only on the tab this conversation selected, without re-switching (refs survive)', async () => {
    const { log } = fakeBin(false);
    // 没选过标签:不许作用在守护进程随手绑的那个(可能是用户的任意标签)
    const blind = await exec('browser_click', { ref: 'e1' }, ctxOf({ sessionId: 's-other' }));
    expect(blind.success).toBe(false);
    expect(blind.error).toMatch(/browser_tabs/);
    expect(calls(log).some((a) => / click /.test(` ${a} `))).toBe(false);
    // 选中 t2 后点击:游标本来就在 t2 → 只核一眼不切(agent-browser 的 tab 切换哪怕切到当前标签也会清空 refs,
    // 09-24 dev 实翻「Unknown ref: e149」)
    await exec('browser_tabs', { select: 't2' }, ctxOf());
    const before = calls(log).length;
    const clicked = await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(clicked.success).toBe(true);
    expect(calls(log).slice(before).map((a) => a.replace(/^.* --json /, ''))).toEqual(['tab list', 'click @e1']);
  });

  it.skipIf(process.platform === 'win32')('a tab bound by id is not satisfied by another tab whose label equals that id', async () => {
    const { log } = fakeBin(false);
    await exec('browser_tabs', { select: 't2' }, ctxOf());
    // 伪造:当前游标在一个 label 恰好叫 "t2" 的别的标签上(tab list 报 tabId t9 / label t2 为 active)
    const bin = process.env.TANGU_AGENT_BROWSER_BIN!;
    writeFileSync(bin, readFileSync(bin, 'utf8').replace(`*"tab list"*)`, `*"tab list"*) echo '{"success":true,"data":{"tabs":[{"tabId":"t9","label":"t2","active":true,"title":"x","url":"https://x/"},{"tabId":"t2","active":false,"title":"Video","url":"https://www.bilibili.com/video/BV1"}]}}';; *"tab list-orig"*)`));
    const before = calls(log).length;
    await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(calls(log).slice(before).map((a) => a.replace(/^.* --json /, ''))).toEqual(['tab list', 'tab t2', 'click @e1']); // 必须切回真正的 t2
  });

  it('keeps separate agent-browser daemons per engine home (dev / release / CLI never share a cursor)', () => {
    const saved = process.env.TANGU_HOME;
    try {
      process.env.TANGU_HOME = '/Users/x/.forsion/tangu';
      const release = __browserToolInternals.attachSessionName('ws://127.0.0.1:9222/devtools/browser/a');
      process.env.TANGU_HOME = '/Users/x/.forsion-dev/tangu';
      const dev = __browserToolInternals.attachSessionName('ws://127.0.0.1:9222/devtools/browser/a');
      expect(release).not.toBe(dev);
      expect(release).toMatch(/^tangu_chrome_[0-9a-f]{10}$/);
    } finally { if (saved === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = saved; }
  });

  it.skipIf(process.platform === 'win32')('if another conversation moved the cursor, switch back before acting', async () => {
    const { dir, log } = fakeBin(false);
    await exec('browser_tabs', { select: 't2' }, ctxOf());
    writeFileSync(join(dir, 'current'), 't1'); // 别的会话把共享游标切到了 t1
    const before = calls(log).length;
    await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(calls(log).slice(before).map((a) => a.replace(/^.* --json /, ''))).toEqual(['tab list', 'tab t2', 'click @e1']);
  });

  it.skipIf(process.platform === 'win32')('a restarted agent-browser daemon invalidates the selection (tab ids are renumbered)', async () => {
    const { log } = fakeBin(false);
    await exec('browser_tabs', { select: 't2' }, ctxOf());
    process.env.PID_FILE_VALUE = String(process.ppid); // 下一条命令起守护进程「换了一个」(另一个活进程)
    await exec('browser_tabs', {}, ctxOf()); // 触发一次写 pid
    const before = calls(log).length;
    const out = await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/browser_tabs/);
    expect(calls(log).length).toBe(before); // 连 tab 切换都没发:旧 id 可能已指向别的标签
  });

  it.skipIf(process.platform === 'win32')('a crashed daemon that left its old pid file also invalidates the selection', async () => {
    const { spawn } = await import('node:child_process');
    const { log } = fakeBin(false);
    const doomed = spawn('sleep', ['30']);
    process.env.PID_FILE_VALUE = String(doomed.pid); // 绑定时的守护进程
    await exec('browser_tabs', { select: 't2' }, ctxOf());
    doomed.kill('SIGKILL'); // 进程没了,pid 文件内容还是它(Codex 复审 P1:只比文件内容会放行,新守护进程里 t2 是别的标签)
    await new Promise((r) => doomed.once('exit', r));
    const before = calls(log).length;
    const out = await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/browser_tabs/);
    expect(calls(log).length).toBe(before);
  });

  it.skipIf(process.platform === 'win32')('without a verifiable daemon pid, control tools refuse (reading still works)', async () => {
    const { log } = fakeBin(false);
    process.env.PID_FILE_VALUE = ''; // pid 文件是空的 = 无从核验守护进程有没有换过
    const read = await exec('browser_tabs', { select: 't2' }, ctxOf());
    expect(read.success).toBe(true); // 读不受影响
    const before = calls(log).length;
    const out = await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/can't be verified/);
    expect(calls(log).length).toBe(before); // 失败即关闭:连 tab 切换都不发(Codex 三轮:空 pid 曾被放行)
  });

  it.skipIf(process.platform === 'win32')('a refused connection cools down that endpoint only', async () => {
    const { log } = fakeBin(false, 'ws://127.0.0.1:9/devtools/browser/refuse-a');
    const first = await exec('browser_tabs', {}, ctxOf());
    expect(first.error).toMatch(/Allow/);
    const n = calls(log).length;
    const second = await exec('browser_tabs', {}, ctxOf());
    expect(second.error).toBe(first.error);
    expect(calls(log).length).toBe(n); // 冷却期内不再发起连接(每次连接 Chrome 都弹一次框)
    process.env.TANGU_BROWSER_CDP = 'ws://127.0.0.1:9/devtools/browser/other-b'; // 换了实例的 Chrome 不受旧冷却连累
    const other = await exec('browser_tabs', {}, ctxOf());
    expect(other.success).toBe(true);
  });
});
