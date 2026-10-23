/**
 * publish_web_page(把工作区的网页 / 静态文件夹发成 Forsion Connect 链接)+ forsion_account 的 web_pages 段:
 *   - 打包:跳过点开头的、软链、node_modules、.d.ts;入口缺省 index.html / 唯一的顶层 HTML;单文件就发它自己;TS / JSX 原样上传但结果里提醒
 *   - 凭据文件整次拒发、不发请求;slug 不合法不发请求
 *   - 名额满了列出已有 slug;链接用服务端给的 publicUrl;下线走 DELETE
 *   - 每次都问(任何档位),审批卡写清路径、slug、谁能看;宿主沙箱开着时不给(收路径、往外发)
 *   - 可见性同 forsion_account_action:没有账号面 / 远程污点 / 无人值守 / 通道 run 都没有
 * 负对照(实跑):walk 里去掉 `ent.name.startsWith('.')` → 「打包」那条红(.env 进了请求);
 *   add 里去掉 checkReadPath 判定 → 「凭据文件」那条红。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions, listDeferredTools, executeTool, type ToolContext } from '../src/tools/registry.js';
import { toolNeedsApproval } from '../src/services/approvals.js';
import { isHostSandboxToolAllowed } from '../src/sandbox/hostSandboxPolicy.js';
import { webPublishPreview } from '../src/tools/builtin/webPublish.js';
import { getSessionDir } from '../src/sandbox/sessionSandbox.js';
import type { CloudRequest, CloudResponse } from '../src/seams/cloudBrain.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
let dir = '';
const base = (): ToolContext => ({ userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: dir, unlockTools: () => {} });
const NAME = 'publish_web_page';

let seen: CloudRequest[] = [];
let routes: Record<string, CloudResponse> = {};
const request = async (req: CloudRequest): Promise<CloudResponse> => {
  seen.push(req);
  return routes[`${req.method || 'GET'} ${req.path}`] ?? { status: 404, json: { detail: 'not found' } };
};
const call = async (name: string, args: unknown, ctx: Partial<ToolContext> = {}): Promise<string> =>
  String((await executeTool({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } } as any,
    { ...base(), unlockedTools: new Set([NAME, 'forsion_account']), ...ctx })).result);
const everywhere = (ctx: ToolContext): string[] => [...listDeferredTools(ctx).map((d) => d.name), ...getToolDefinitions(ctx).map((t: any) => t.function?.name)];
const write = (rel: string, body: string | Buffer = 'x'): void => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
const sent = (): any => seen.find((r) => r.method === 'POST')?.body;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpub-'));
  seen = [];
  routes = {
    'POST /api/connect/apps': { status: 200, json: { slug: 'book-club', handle: 'changan', url: '/apps/changan/book-club/', publicUrl: 'https://api.forsion.net/apps/changan/book-club/' } },
    'GET /api/connect/apps': { status: 200, json: { apps: [], used: 0, limit: 5, tier: 'plus', handle: 'changan', publicBase: 'https://api.forsion.net' } },
  };
  configureTangu({ host: stub, brain: { cloud: { request } } as any, billing: stub, profile });
});
afterEach(() => { delete process.env.TANGU_WECHAT_STATE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

describe('publish_web_page 发布', () => {
  it('文件夹:跳过点开头的 / node_modules / 软链 / .d.ts,入口缺省 index.html,链接用 publicUrl,TS 原样上传但提醒', async () => {
    write('site/index.html', '<h1>hi</h1>'); write('site/style.css', 'h1{}'); write('site/img/a.png', Buffer.from([1, 2, 3]));
    write('site/.env', 'SECRET=1'); write('site/node_modules/x.js'); write('site/types.d.ts'); write('site/app.tsx', 'export {}');
    fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(dir, 'site/link.txt')); write('outside.txt', 'private');
    const r = await call(NAME, { path: 'site', slug: 'book-club', name: 'Book club' });
    const body = sent();
    expect(body.files.map((f: any) => f.path)).toEqual(['app.tsx', 'img/a.png', 'index.html', 'style.css']);
    expect(body).toMatchObject({ slug: 'book-club', name: 'Book club', entry: 'index.html' });
    expect(body.files.find((f: any) => f.path === 'img/a.png')).toMatchObject({ content_b64: 'AQID', content_type: 'image/png', size: 3 });
    expect(body.files.find((f: any) => f.path === 'index.html').content_type).toBe('text/html');
    expect(seen.find((q) => q.method === 'POST')?.timeoutMs).toBe(300_000);
    expect(r).toMatch(/^Published "Book club" at https:\/\/api\.forsion\.net\/apps\/changan\/book-club\/ \(4 file\(s\), 1 KB, opens index\.html\)\./);
    expect(r).toContain('1 TypeScript/JSX file(s) were uploaded as-is');
  });

  it('单个 HTML 文件:只发它,入口就是它,名字缺省取文件名;老 server 没 publicUrl 就给相对路径', async () => {
    write('pages/读书会.html', '<p>1</p>'); write('pages/other.html');
    routes['POST /api/connect/apps'] = { status: 200, json: { slug: 'club', handle: 'changan', url: '/apps/changan/club/' } };
    const r = await call(NAME, { path: path.join(dir, 'pages/读书会.html'), slug: 'club' });
    expect(sent()).toMatchObject({ slug: 'club', name: '读书会', entry: '读书会.html', files: [{ path: '读书会.html' }] });
    expect(r).toContain('at /apps/changan/club/ (1 file(s)');
  });

  it('文件夹没有 index.html:只有一个顶层 HTML 就用它;多个就报出来、不发', async () => {
    write('one/page.html'); write('one/sub/x.html');
    await call(NAME, { path: 'one', slug: 'one-page' });
    expect(sent().entry).toBe('page.html');
    seen = [];
    write('two/a.html'); write('two/b.html');
    expect(await call(NAME, { path: 'two', slug: 'two-pages' })).toBe('Error: the folder has no index.html; pass entry with the HTML file to open first (top-level HTML files: a.html, b.html).');
    expect(seen).toEqual([]);
  });

  it('沙箱会话(聊天 / 云端节点):路径按会话工作区解析,"/" 是工作区根;软链出工作区就拒', async () => {
    const ctx = { execMode: 'sandbox' as const, preset: 'chat' as const, cwd: undefined, sessionId: `s-sbx-${Date.now()}` };
    const ws = await getSessionDir({ ...base(), ...ctx });
    fs.mkdirSync(path.join(ws, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'out/index.html'), '<p>sandbox</p>');
    await call(NAME, { path: '/out', slug: 'sbx-page' }, ctx);
    expect(sent()).toMatchObject({ entry: 'index.html', files: [{ path: 'index.html', content_b64: Buffer.from('<p>sandbox</p>').toString('base64') }] });
    seen = [];
    fs.symlinkSync(dir, path.join(ws, 'escape'));
    expect(await call(NAME, { path: '/escape', slug: 'sbx-page' }, ctx)).toBe("Error: /escape is outside this session's workspace.");
    expect(await call(NAME, { path: '../../etc', slug: 'sbx-page' }, ctx)).toMatch(/^Error: \.\.\/\.\.\/etc (does not exist|has no files)/);
    expect(seen.filter((r) => r.method === 'POST')).toEqual([]);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('凭据文件:整次拒发,一个请求都不发', async () => {
    write('site/index.html'); write('site/wechat/token.json', '{"token":"t"}');
    process.env.TANGU_WECHAT_STATE_DIR = path.join(dir, 'site/wechat');
    const r = await call(NAME, { path: 'site', slug: 'leaky' });
    expect(r).toMatch(/^Error: Access denied: .*token\.json is a protected credential file .* Nothing was published\.$/);
    expect(seen).toEqual([]);
  });

  it('超过 5MB 的文件:读之前就拒,不发请求', async () => {
    write('big/index.html'); write('big/video.mp4', Buffer.alloc(5 * 1024 * 1024 + 1));
    expect(await call(NAME, { path: 'big', slug: 'big-page' })).toBe('Error: video.mp4 is larger than 5 MB.');
    expect(seen).toEqual([]);
  });

  it('slug 不合法 / 路径不存在 / 空文件夹:不发请求', async () => {
    write('empty/.hidden');
    for (const [args, msg] of [
      [{ path: 'x', slug: 'Bad Slug' }, 'Error: slug must be 3-32 lowercase letters'],
      [{ path: 'x' }, 'Error: slug must be'],
      [{ path: 'nope', slug: 'nope' }, 'Error: nope does not exist.'],
      [{ path: 'empty', slug: 'empty' }, 'Error: empty has no files to publish'],
      [{ action: 'delete', slug: 'abc' }, 'Error: action must be publish or unpublish'],
    ] as const) expect(await call(NAME, args)).toContain(msg);
    expect(seen).toEqual([]);
  });

  it('名额满了:列出已有的 slug;云盘不够、被停用、连不上分开说', async () => {
    write('site/index.html');
    routes['POST /api/connect/apps'] = { status: 403, json: { code: 'limit_reached', detail: '已达同时发布上限（1/1）', used: 1, limit: 1 } };
    routes['GET /api/connect/apps'] = { status: 200, json: { apps: [{ slug: 'old-page' }], used: 1, limit: 1, handle: 'changan' } };
    expect(await call(NAME, { path: 'site', slug: 'new-page' })).toBe(
      "Error: the user's plan allows 1 published page(s) and all are used (old-page). Publish to one of these slugs to replace that page, take one down with action unpublish, or the user can upgrade their plan.");
    routes['POST /api/connect/apps'] = { status: 413, json: { code: 'quota_exceeded', detail: '…' } };
    expect(await call(NAME, { path: 'site', slug: 'new-page' })).toContain('does not have enough free storage');
    routes['POST /api/connect/apps'] = { status: 403, json: { code: 'disabled', detail: '…' } };
    expect(await call(NAME, { path: 'site', slug: 'new-page' })).toContain('disabled by a Forsion administrator');
    routes['POST /api/connect/apps'] = { status: 0, error: 'timeout' };
    expect(await call(NAME, { path: 'site', slug: 'new-page' })).toContain('it is unknown whether the page was published');
    routes['POST /api/connect/apps'] = { status: 401, json: null, error: 'not_signed_in' };
    expect(await call(NAME, { path: 'site', slug: 'new-page' })).toContain('not signed in to a Forsion account');
  });

  it('下线:DELETE 这个 slug;没有这页就说没有', async () => {
    routes['DELETE /api/connect/apps/book-club'] = { status: 200, json: { ok: true } };
    expect(await call(NAME, { action: 'unpublish', slug: 'book-club' })).toBe('Took down the web page book-club; its link no longer works.');
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /api/connect/apps/book-club']);
    expect(await call(NAME, { action: 'unpublish', slug: 'gone-page' })).toBe('Error: the user has no published page called gone-page.');
  });
});

describe('forsion_account web_pages', () => {
  it('列出已发布的网页:链接按 publicBase 拼,带 slug、大小、日期、上架 / 停用状态', async () => {
    routes['GET /api/connect/apps'] = { status: 200, json: {
      used: 2, limit: 5, tier: 'plus', handle: 'changan', publicBase: 'https://api.forsion.net/',
      apps: [
        { slug: 'book-club', name: 'Book club', total_bytes: 6300, updated_at: '2026-10-23T12:00:00.000Z', status: 'active', listing_status: 'pending' },
        { slug: 'tank', name: '坦克', total_bytes: 3 * 1024 * 1024, updated_at: '2026-07-27T16:04:04.008Z', status: 'disabled', listing_status: null },
      ] } };
    expect((await call('forsion_account', { section: 'web_pages' })).split('\n')).toEqual([
      "Published web pages: 2 of 5 allowed on the user's plan.",
      '  - Book club — https://api.forsion.net/apps/changan/book-club/ (slug book-club, 7 KB, updated 2026-10-23) — store listing pending',
      '  - 坦克 — https://api.forsion.net/apps/changan/tank/ (slug tank, 3.0 MB, updated 2026-07-27) — disabled by a Forsion administrator',
      'Publish to an existing slug to update that page, or take one down, with publish_web_page.',
    ]);
    routes['GET /api/connect/apps'] = { status: 200, json: { apps: [], limit: 1, handle: null } };
    expect(await call('forsion_account', { section: 'web_pages' })).toBe("Published web pages: 0 of 1 allowed on the user's plan. None yet; publish one with publish_web_page.");
  });
});

describe('审批与可见性', () => {
  it('每次都问(任何档位);宿主沙箱开着时不给', () => {
    for (const m of ['readonly', 'auto-edit', 'full-auto', undefined] as const) expect(toolNeedsApproval(NAME, m)).toBe(true);
    expect(isHostSandboxToolAllowed(NAME, { execMode: 'host', hostSandbox: { mode: 'read-only', network: 'deny' } as any })).toBe(false);
  });

  it('审批卡写清路径、slug、谁能看、会不会换掉旧页', () => {
    expect(webPublishPreview({ path: 'site', slug: 'book-club', name: 'Book club' })).toBe(
      'Publish site as a Forsion web page "Book club" (link name: book-club).\n' +
      'Anyone with the link can open it. The files go to your Forsion cloud drive and count toward its storage. If you already have a page called book-club, it is replaced.');
    expect(webPublishPreview({ action: 'unpublish', slug: 'book-club' })).toContain('Take down your Forsion web page "book-club"');
    expect(webPublishPreview({ path: 'site', slug: 'X' })).toMatch(/^Publish web page: invalid request/);
  });

  it('前台 run:work / chat 面都在按需目录里;没有账号面 / 远程污点 / 无人值守 / 代批 / 通道 / 子代理都没有,直调也不发请求', async () => {
    for (const ctx of [base(), { ...base(), preset: 'chat' as const, execMode: 'sandbox' as const, cwd: undefined }]) {
      expect(listDeferredTools(ctx).map((d) => d.name), JSON.stringify(ctx.preset)).toContain(NAME);
    }
    for (const ctx of [{ remote: { via: 'tunnel', marked: true } as any }, { runOrigin: 'unattended' as const }, { approvalDeferral: 'queue' as const },
      { runOrigin: 'channel' as const }, { subAgentDepth: 1 }, { planMode: true }]) {
      expect(everywhere({ ...base(), ...ctx }), JSON.stringify(ctx)).not.toContain(NAME);
    }
    write('site/index.html');
    expect(await call(NAME, { path: 'site', slug: 'abc' }, { remote: { via: 'tunnel', marked: true } as any })).toMatch(/not available in this session/);
    expect(seen).toEqual([]);
    configureTangu({ host: stub, brain: {} as any, billing: stub, profile });
    expect(everywhere(base())).not.toContain(NAME);
  });
});
