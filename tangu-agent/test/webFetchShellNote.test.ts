/**
 * web_fetch 抓到「正文由脚本渲染」的页面时,工具结果要自己说:正文没拿到、怎么读到、重抓没用。
 * 走真 execute:本地起 http server,只把「只许公网地址」那道解析换掉(连接 / 抽取 / 壳判定 / 尾注都是真的);
 * 浏览器工具在不在场按真注册表判 —— 没有它的会话里,尾注一个字不许提它。
 * 背景:2026-10-09 真模型台架 user-research(GPT-6 Luna)6 次里 4 次没从 obsidian.md 取到正文 —— 结果只有标题、
 * 没有任何说明,模型反复重抓同一个地址。判定条件的单项用例在 webFetch.test.ts 的 isLikelyJsShell 一节。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../src/core/util/urlSafety.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/util/urlSafety.js')>()),
  resolvePublicHttpUrl: async (raw: string) => ({ url: new URL(raw), addresses: ['127.0.0.1'] }),
}));

import '../src/tools/registry.js'; // 副作用:注册全部内置 provider(browser_navigate 在不在场靠它)
import { webFetchProvider, jsShellNote, browserReach } from '../src/tools/builtin/webFetch.js';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
const profile = createTanguProfile({ sandboxMode: 'none' });
configureTangu({ host: stub, brain: stub, billing: stub, profile });
const tool = webFetchProvider.tools()[0];

// 本机桌面会话(work 预设):browser_navigate 常驻
const host = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' } as any;
// coding 预设:浏览器整族在按需目录里,得先 load_tools
const coding = { ...host, preset: 'coding', unlockTools: () => {} };
// 没有浏览器工具的三种会话:chat 预设(host 工具整族不给)、云端沙箱形态、限定工具集的 agent(tools_strict,名单里没它)
const chat = { ...host, preset: 'chat' };
const sandbox = { ...host, execMode: 'sandbox' };
const strict = { ...host, toolsStrict: true, toolsList: ['web_fetch', 'web_search'] };

const TITLE = 'How Obsidian stores data - Obsidian Help';
const PAGES: Record<string, [type: string, body: string]> = {
  // 壳:<title> + 外链脚本,body 里只有一个转圈的 svg(obsidian.md/help 的结构)
  '/shell': ['text/html; charset=utf-8', `<!doctype html><html><head><script defer src="/app.js"></script><title>${TITLE}</title></head>`
    + '<body class="theme-light"><div class="preload"><svg viewBox="0 0 100 100"><path d="M73,50"/></svg></div></body></html>'],
  // 正常的短页面:一段话 + 一个外链脚本(example.com 的结构)
  '/short': ['text/html', '<!doctype html><html><head><title>Example Domain</title></head><body>'
    + '<p>This domain is for use in documentation examples without needing permission.</p><script src=/s.js></script></body></html>'],
  '/one-line': ['text/html', '<html><head><title>Status</title><script async src="/stats.js"></script></head><body><p>网站建设中</p></body></html>'],
  // 纯文本接口:不是 HTML,不做壳判定
  '/ip': ['text/plain', '203.0.113.7\n'],
  '/api': ['application/json', '{"ok":true}'],
};

let srv: Server;
let origin = '';
beforeAll(async () => {
  srv = createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    if (!page) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': page[0] });
    res.end(page[1]);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  origin = `http://pin.test:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const fetchAs = async (path: string, ctx: any): Promise<string> => String(await tool.execute({ url: origin + path }, ctx));

describe('web_fetch on a script-rendered page', () => {
  it('says the text is missing, points at browser_navigate, and says a refetch is useless', async () => {
    const r = await fetchAs('/shell', host);
    expect(r).toContain(`\n${TITLE}\n\n[note] `); // 抽出来的只有标题,尾注紧跟其后
    expect(r.endsWith(jsShellNote('ready'))).toBe(true);
    expect(r).toMatch(/most likely rendered by JavaScript/);
    expect(r).toMatch(/open this URL with browser_navigate/);
    expect(r).toMatch(/Fetching this URL again with web_fetch will return the same thing/);
    expect(r).not.toContain('load_tools');
  });

  it('coding preset: browser_navigate is on-demand, so the note says to load it first', async () => {
    expect((await fetchAs('/shell', coding)).endsWith(jsShellNote('load'))).toBe(true);
    expect(jsShellNote('load')).toMatch(/load browser_navigate with load_tools, then open this URL/);
    // 本 run 已经 load 过 → 直接用
    expect((await fetchAs('/shell', { ...coding, unlockedTools: new Set(['browser_navigate']) })).endsWith(jsShellNote('ready'))).toBe(true);
  });

  it.each([['chat preset', chat], ['sandbox / cloud', sandbox], ['strict agent tool list without it', strict]])(
    '%s: no browser tool in the session → the note never names one', async (_name, ctx) => {
      const r = await fetchAs('/shell', ctx);
      expect(r.endsWith(jsShellNote(null))).toBe(true);
      expect(r).not.toMatch(/browser_|load_tools/);
      expect(r).toMatch(/most likely rendered by JavaScript/);
      expect(r).toMatch(/Fetching this URL again with web_fetch will return the same thing/);
    });

  it.each(['/short', '/one-line', '/ip', '/api'])('ordinary short page %s gets no note', async (path) => {
    const r = await fetchAs(path, host);
    expect(r).not.toMatch(/^Error/);
    expect(r).not.toContain('[note]');
    expect(r).not.toContain('browser_navigate');
  });
});

describe('browserReach follows what the session can actually call', () => {
  it('resident / on-demand / absent', () => {
    expect(browserReach(host)).toBe('ready');
    expect(browserReach({ ...host, planMode: true })).toBe('ready'); // 计划模式里浏览器只读入口照常可用
    expect(browserReach(coding)).toBe('load');
    expect(browserReach({ ...coding, automationOrigin: 'rule-1' })).toBe('ready'); // 自动化 run 不吃按需装载,定义全在面上
    expect(browserReach({ ...coding, unlockTools: undefined })).toBe(null); // 解锁不了的调用方(群聊成员)= 够不着
    for (const ctx of [chat, sandbox, strict]) expect(browserReach(ctx)).toBe(null);
  });
});

describe('jsShellNote wording contract', () => {
  // ⚠️ desktop/scripts/intelligent-ui.live.cjs 靠这半句认「这条 web_fetch 结果没拿到正文」(不排除的话,光尾注就把结果
  // 撑过台架的长度线,只有标题也算「取到了正文」)。这里红了 = 措辞改了,那边的匹配串要一起改。
  it.each(['ready', 'load', null] as const)('%s starts with the marker the live harness matches', (reach) => {
    expect(jsShellNote(reach).startsWith("[note] web_fetch got almost none of this page's text")).toBe(true);
  });
});
