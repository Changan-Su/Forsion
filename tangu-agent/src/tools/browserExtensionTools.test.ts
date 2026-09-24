/**
 * browser_* 走 Tangu for Chrome 扩展这一路:按标签 id 寻址、Tangu 自己开的页进组且免审批、用户的标签要审批、
 * 无人值守 run 不碰用户浏览器。用 ws 客户端冒充扩展(真扩展端到端见 scripts/browser-extension.smoke.mjs)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createTanguProfile } from '../profiles/index.js';
import { EXTENSION_ID, currentExtensionClient, extensionClientAlive, extensionConnected, extensionToken, startBrowserExtensionBridge, stopBrowserExtensionBridge, extensionStatus } from '../services/browserExtension.js';
import { browserTabsProvider, browserToolsProvider, userBrowserActionGated } from './builtin/browserTools.js';
import type { ToolContext } from './toolTypes.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const ctxOf = (extra: Partial<ToolContext> = {}): ToolContext => ({ userId: 'u1', sessionId: `s-${Math.random()}`, appId: profile.appId, profile, execMode: 'host', approvalMode: 'auto-edit', ...extra });
const freePort = (): Promise<number> => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const saved = { home: process.env.TANGU_HOME, port: process.env.TANGU_BROWSER_EXTENSION_PORT, on: process.env.TANGU_BROWSER_EXTENSION, priv: process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS };

let ws: WebSocket | null = null;
let port = 0;
let calls: Array<{ method: string; params: any; client: string }> = [];
let nextTabId = 100;

/** 假扩展:用户的标签(t1 用户正看着;t3 被用户拖进了同名的「Tangu」组)+ Tangu 自己开的页。 */
function handle(m: any, client: string): any {
  calls.push({ method: m.method, params: m.params, client });
  switch (m.method) {
    case 'tabs.list':
      return { tabs: [
        { id: 1, title: 'Inbox', url: 'https://mail.example/', active: true, focused: true, tangu: false },
        { id: 2, title: '天禄五环 测评 - 哔哩哔哩', url: 'https://www.bilibili.com/video/BV1', active: false, focused: false, tangu: false },
        { id: 3, title: 'Account', url: 'https://bank.example/', active: false, focused: false, tangu: true },
      ] };
    case 'page.read': return { ok: true, title: 'x', url: 'https://www.bilibili.com/video/BV1', text: 'Best pick: No. 3', snapshot: '- button "推荐款" [ref=e1]', refCount: 1 };
    case 'tabs.open': return { id: ++nextTabId, title: 'Opened', url: m.params.url, tangu: true, ...(String(m.params.url).includes('slow') ? { loadTimedOut: true } : {}) };
    case 'tabs.navigate': return { id: m.params.tabId, title: 'Again', url: m.params.url, tangu: true };
    case 'page.snapshot': return { ok: true, title: 'x', url: 'u', snapshot: '- link "a" [ref=e1]', refCount: 1 };
    case 'page.click': return { ok: true, url: 'u', title: 't' };
    default: throw new Error(`unexpected ${m.method}`);
  }
}

/** 冒充一个浏览器里的扩展连上来(label 记进 calls,分辨命令发给了哪个浏览器);返回时已配对完成。 */
async function connectFake(label: string): Promise<WebSocket> {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/tangu-browser`, { origin: `chrome-extension://${EXTENSION_ID}` });
  const hmac = (msg: string): string => createHmac('sha256', extensionToken()).update(msg).digest('hex');
  const welcomed = new Promise((r) => sock.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'challenge') { sock.send(JSON.stringify({ type: 'auth', proof: hmac(`client:${m.nonce}`) })); return; }
    if (m.type === 'welcome') { r(m); return; }
    if (m.id != null) { try { sock.send(JSON.stringify({ id: m.id, result: handle(m, label) })); } catch (e: any) { sock.send(JSON.stringify({ id: m.id, error: e.message })); } }
  }));
  await new Promise((r) => sock.on('open', r));
  sock.send(JSON.stringify({ type: 'hello', nonce: 'ab'.repeat(16), version: 'test' }));
  await welcomed;
  return sock;
}

beforeEach(async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-ext-tools-'));
  port = await freePort();
  process.env.TANGU_BROWSER_EXTENSION_PORT = String(port);
  process.env.TANGU_BROWSER_EXTENSION = '1';
  process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS = '1';
  startBrowserExtensionBridge();
  for (let i = 0; i < 50 && !extensionStatus().listening; i++) await new Promise((r) => setTimeout(r, 20));
  calls = [];
  ws = await connectFake('A');
});
afterEach(() => {
  try { ws?.close(); } catch { /* ignore */ }
  stopBrowserExtensionBridge();
  for (const [k, v] of [['TANGU_HOME', saved.home], ['TANGU_BROWSER_EXTENSION_PORT', saved.port], ['TANGU_BROWSER_EXTENSION', saved.on], ['TANGU_BROWSER_ALLOW_PRIVATE_URLS', saved.priv]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const tool = (name: string): any => [...browserTabsProvider.tools(), ...browserToolsProvider.tools()].find((t) => t.name === name);
const exec = async (name: string, args: any, ctx: ToolContext): Promise<any> => JSON.parse(String(await tool(name).execute(args, ctx)));

describe('browser_* via the Tangu Chrome extension', () => {
  it('lists the user\'s tabs with the one they are looking at marked focused', async () => {
    const out = await exec('browser_tabs', {}, ctxOf());
    expect(out.tabs).toEqual([
      { tab: 't1', title: 'Inbox', url: 'https://mail.example/', focused: true },
      { tab: 't2', title: '天禄五环 测评 - 哔哩哔哩', url: 'https://www.bilibili.com/video/BV1' },
      { tab: 't3', title: 'Account', url: 'https://bank.example/', tangu: true },
    ]);
  });

  it('selecting the user\'s tab reads it by id and makes actions there need approval', async () => {
    const ctx = ctxOf();
    const read = await exec('browser_tabs', { select: 'bilibili' }, ctx);
    expect(read).toMatchObject({ success: true, tab: 't2', text: 'Best pick: No. 3' });
    expect(calls.find((c) => c.method === 'page.read')?.params).toMatchObject({ tabId: 2 });
    expect(await userBrowserActionGated(ctx.sessionId)).toBe(true);
    const clicked = await exec('browser_click', { ref: '@e1' }, ctx);
    expect(clicked).toMatchObject({ success: true, clicked: 'e1' });
    expect(calls.at(-1)).toEqual({ method: 'page.click', params: { tabId: 2, ref: 'e1' }, client: 'A' }); // 按 id 直达,没有「切标签」这一步
  });

  it('a user tab sitting in a group the user named "Tangu" is still theirs: actions there need approval', async () => {
    const ctx = ctxOf();
    expect(await exec('browser_tabs', { select: 'bank' }, ctx)).toMatchObject({ success: true, tab: 't3' });
    expect(await userBrowserActionGated(ctx.sessionId)).toBe(true); // 免审批只认 Tangu 亲手开的页,不认组名
  });

  it('navigating opens Tangu\'s own tab (grouped, background), reuses it, and needs no approval there', async () => {
    const ctx = ctxOf();
    const first = await exec('browser_navigate', { url: 'http://127.0.0.1/a' }, ctx);
    expect(first).toMatchObject({ success: true, url: 'http://127.0.0.1/a' });
    expect(first.note).toMatch(/Tangu" tab group/);
    const opened = calls.find((c) => c.method === 'tabs.open');
    expect(opened?.params).toEqual({ url: 'http://127.0.0.1/a' });
    await exec('browser_navigate', { url: 'http://127.0.0.1/b' }, ctx);
    expect(calls.filter((c) => c.method === 'tabs.open')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'tabs.navigate')?.params).toEqual({ tabId: nextTabId, url: 'http://127.0.0.1/b' });
    expect(await userBrowserActionGated(ctx.sessionId)).toBe(false);
    expect(first.warning).toBeUndefined();
    expect((await exec('browser_navigate', { url: 'http://127.0.0.1/slow' }, ctxOf())).warning).toMatch(/still loading/);
  });

  it('tab ids belong to one browser: after another Chrome profile connects, old ids are never sent to it', async () => {
    const picked = ctxOf();
    const own = ctxOf();
    await exec('browser_tabs', { select: 'bilibili' }, picked); // 浏览器 A 里用户的 t2
    await exec('browser_navigate', { url: 'http://127.0.0.1/a' }, own); // 浏览器 A 里自己开的页
    const idA = currentExtensionClient()!;
    const second = await connectFake('B'); // 另一个 Chrome 配置也连上了,成了默认连接
    try {
      await exec('browser_navigate', { url: 'http://127.0.0.1/b' }, own);
      expect(calls.filter((c) => c.method === 'tabs.navigate')).toHaveLength(0); // 没拿 A 的标签 id 去 B 里导航
      expect(calls.filter((c) => c.method === 'tabs.open').map((c) => c.client)).toEqual(['A', 'B']);
      ws!.close();
      for (let i = 0; i < 50 && extensionClientAlive(idA); i++) await new Promise((r) => setTimeout(r, 20));
      const out = await exec('browser_click', { ref: 'e1' }, picked);
      expect(out.success).toBe(false); // A 没了 → 绑定作废,绝不落到 B 里同号的标签上
      expect(calls.some((c) => c.method === 'page.click')).toBe(false);
    } finally { second.close(); }
  });

  it('refuses control tools for a conversation that has not picked or opened a tab', async () => {
    const out = await exec('browser_click', { ref: 'e1' }, ctxOf());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/browser_tabs/);
    expect(calls.some((c) => c.method === 'page.click')).toBe(false);
  });

  it('background runs never touch the user\'s browser even while the extension is connected', async () => {
    process.env.TANGU_BROWSER_CDP = 'off';
    try {
      for (const extra of [{ muse: true }, { automationOrigin: 'rule:daily' }, { approvalDeferral: 'queue' as const }]) {
        const out = await exec('browser_tabs', {}, ctxOf(extra));
        expect(out.connected).toBe(false);
      }
      expect(calls).toHaveLength(0);
    } finally { delete process.env.TANGU_BROWSER_CDP; }
  });
});
