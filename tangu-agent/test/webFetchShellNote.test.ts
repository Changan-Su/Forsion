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

import { getToolDefinitions } from '../src/tools/registry.js'; // 连带副作用:注册全部内置 provider(browser_navigate 在不在场靠它)
import { webFetchProvider, jsShellNote, browserReach } from '../src/tools/builtin/webFetch.js';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
const profile = createTanguProfile({ sandboxMode: 'none' });
configureTangu({ host: stub, brain: stub, billing: stub, profile });
const tool = webFetchProvider.tools()[0];

// 本机桌面会话(work 预设):browser_navigate 常驻。hostSandbox 显式给「关」—— 不给的话 resolveTools 会去读开发机自己的
// config.json,那边开着宿主沙箱时浏览器整族不在场,这个文件就跟着红。
const host = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', hostSandbox: { mode: 'off', network: 'deny' } } as any;
// coding 预设:浏览器整族在按需目录里,得先 load_tools
const coding = { ...host, preset: 'coding', unlockTools: () => {} };
// 没有浏览器工具的几种会话:chat 预设(host 工具整族不给)、云端沙箱形态、宿主沙箱开着、限定工具集的 agent(tools_strict,名单里没它)
const chat = { ...host, preset: 'chat' };
const sandbox = { ...host, execMode: 'sandbox' };
const boxed = { ...host, hostSandbox: { mode: 'read-only', network: 'deny' } };
const strict = { ...host, toolsStrict: true, toolsList: ['web_fetch', 'web_search'] };
// 名单里有浏览器、却没有 load_tools 的限定 agent:coding 预设下浏览器在按需目录里 → 取不回来,等于没有
const strictNoLoader = { ...coding, toolsStrict: true, toolsList: ['web_fetch', 'browser_navigate'] };

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

  it.each([
    ['chat preset', chat], ['sandbox / cloud', sandbox], ['host sandbox on', boxed],
    ['strict agent tool list without it', strict], ['strict list has it but not load_tools (coding)', strictNoLoader],
  ])(
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
    expect(browserReach(coding)).toBe('load');
    for (const ctx of [chat, sandbox, boxed, strict, strictNoLoader]) expect(browserReach(ctx)).toBe(null);
  });

  // 准绳 = 真正喂给模型的那份工具定义(registry.getToolDefinitions):'ready' ⇔ browser_navigate 就在里面;
  // 'load' ⇔ 现在不在、load_tools 在、解锁后它会进来;null ⇔ 现在不在、也没有一条能把它取回来的路。
  const defs = (ctx: any): string[] => getToolDefinitions({ ...ctx }).map((d: any) => d.function.name);
  it.each([
    ['work', host],
    ['plan mode', { ...host, planMode: true }],
    ['coding', coding],
    ['coding, already loaded this run', { ...coding, unlockedTools: new Set(['browser_navigate']) }],
    ['coding, caller cannot unlock (group chat member)', { ...coding, unlockTools: undefined }],
    ['coding, automation run (no on-demand loading)', { ...coding, automationOrigin: 'rule-1' }],
    ['work, the agent shelved it', { ...host, shelvedTools: new Set(['browser_navigate']), unlockTools: () => {} }],
    ['chat', chat], ['sandbox', sandbox], ['host sandbox on', boxed],
    ['strict list without it', strict],
    ['strict list with it (work)', { ...host, toolsStrict: true, toolsList: ['web_fetch', 'browser_navigate'] }],
    ['strict list with it but no load_tools (coding)', strictNoLoader],
    ['strict list with it and load_tools (coding)', { ...coding, toolsStrict: true, toolsList: ['web_fetch', 'browser_navigate', 'load_tools'] }],
  ])('%s: agrees with the tool definitions the model is given', (_name, ctx) => {
    const reach = browserReach(ctx);
    const now = defs(ctx);
    const afterLoad = defs({ ...ctx, unlockedTools: new Set([...(ctx.unlockedTools ?? []), 'browser_navigate']) });
    const loadable = !now.includes('browser_navigate') && now.includes('load_tools') && afterLoad.includes('browser_navigate');
    expect(reach).toBe(now.includes('browser_navigate') ? 'ready' : loadable ? 'load' : null);
  });
});

describe('jsShellNote wording contract', () => {
  // ⚠️ desktop/scripts/intelligent-ui.live.cjs 靠这半句认「这条 web_fetch 结果没拿到正文」(不排除的话,光尾注就把结果
  // 撑过台架的长度线,只有标题也算「取到了正文」)。这里红了 = 措辞改了,那边的匹配串要一起改。
  it.each(['ready', 'load', null] as const)('%s starts with the marker the live harness matches', (reach) => {
    expect(jsShellNote(reach).startsWith("[note] web_fetch got almost none of this page's text")).toBe(true);
  });
});
