/**
 * 连接器(连接器方案「要补的两样」)× 真 SDK × 假 MCP server。钉的是:
 *   - 用户自带 Key:mcp.json 里只有模板;Key 只进本机 connector-auth.json;连接时才换进地址;状态、日志、回给模型的报错里只有 `{userKey}`;
 *     Key 不对 = 待登录(不走 OAuth);Key 按模板绑定(换模板 = 要重填);断开删 Key。
 *   - alwaysAsk:只认带 connector 标记的条目、名单只从目录缓存读;缓存读不到 = 每次都问;
 *     完全通行档、「总是允许」在场照样弹卡,无人值守直接拒。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ publish: vi.fn(async () => 1) }));
vi.mock('../services/eventBus.js', () => ({ publish: state.publish }));
vi.mock('../hooks/index.js', () => ({ runHooks: vi.fn(async () => ({})) }));

import { createMcpManager, type McpManager } from './manager.js';
import type { LoadedMcpTool } from './toolBridge.js';
import { connectorAuthFile, connectorCatalogFile } from '../core/tanguHome.js';
import { redactKey, connectorToolAlwaysAsk } from './connectors.js';
import { saveUserKey, loadUserKey } from './oauth.js';
import { declaredApproval } from '../tools/toolRegistry.js';
import { gateToolCall, resolveApproval } from '../services/approvals.js';
import type { ToolCall } from '../core/types.js';
import { startHttpServer } from '../../test/fixtures/fake-mcp-server.mjs';

const FAST = { reconnectCooldownMs: 0, retryBaseMs: 50, retryMaxMs: 200, connectTimeoutMs: 10_000 };
const KEY = 's3cr+t/KEY=1'; // 带 + / = :编码后与原文不同,两种形态都得脱敏
let dir: string;
const prevHome = process.env.TANGU_HOME;
const managers: McpManager[] = [];
const stops: Array<() => Promise<void>> = [];
const logs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tangu-connectors-'));
  process.env.TANGU_HOME = dir;
  logs.length = 0;
  for (const k of ['warn', 'log', 'error'] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  state.publish.mockClear();
});
afterEach(async () => {
  for (const m of managers.splice(0)) await m.dispose();
  for (const s of stops.splice(0)) await s().catch(() => {});
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function manager(servers: Record<string, unknown>): Promise<McpManager> {
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  const m = createMcpManager(file, FAST);
  managers.push(m);
  await m.start();
  return m;
}
const statusOf = (m: McpManager, name: string) => m.listStatus().find((s) => s.name === name)!;
const tool = (m: McpManager, name: string): LoadedMcpTool => m.toolsForRun().get(name)!;

describe('用户自带 Key', () => {
  async function keyServer(opts: { failToolCalls?: any } = {}) {
    const seen: string[] = [];
    const mcp = await startHttpServer({
      tag: 'k', ...opts,
      auth: { isValid: (_t: string | null, _b?: any, url?: string) => { const k = new URL(url ?? '/', 'http://x').searchParams.get('key'); if (k) seen.push(k); return k === KEY; }, authServer: 'http://127.0.0.1:9' },
    });
    stops.push(() => mcp.stop());
    return { url: `${mcp.url}?key={userKey}`, seen };
  }

  it('没 Key = 待登录(填 Key),不走 OAuth;填了才连上,mcp.json 只有模板', async () => {
    const s = await keyServer();
    const m = await manager({ amap: { url: s.url, connector: 'amap' } });
    expect(statusOf(m, 'amap')).toMatchObject({ status: 'needs-login', auth: 'user-key', connector: 'amap' });
    expect(statusOf(m, 'amap').signedIn).toBeUndefined();
    await expect(m.login('amap')).rejects.toThrow(/uses a key/);
    expect(s.seen).toEqual([]); // 没 Key 时根本不去连

    await expect(m.setKey('amap', `  ${KEY}  `)).resolves.toMatchObject({ status: 'connected' });
    expect(s.seen[0]).toBe(KEY); // 编码后进查询串、server 解出来是原文
    expect(statusOf(m, 'amap')).toMatchObject({ status: 'connected', signedIn: true });
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).not.toContain('s3cr');
    expect(readFileSync(join(dir, 'mcp.json'), 'utf8')).toContain('{userKey}');
    expect(readFileSync(connectorAuthFile(), 'utf8')).toContain(JSON.stringify(KEY));
    expect(statSync(connectorAuthFile()).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(m.listStatus())).not.toContain('s3cr');
    const r = await m.callTool(tool(m, 'mcp__amap__echo'), { text: 'hi' });
    expect(r).toMatchObject({ isError: false });
    expect(r.text).toContain('k:hi');
  });

  it('回给模型的报错与日志里只有模板', async () => {
    const s = await keyServer({ failToolCalls: { status: 500, body: `bad request for ?key=${KEY} (${encodeURIComponent(KEY)})` } });
    const m = await manager({ amap: { url: s.url, connector: 'amap' } });
    await m.setKey('amap', KEY);
    const r = await m.callTool(tool(m, 'mcp__amap__echo'), { text: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('{userKey}');
    for (const form of [KEY, encodeURIComponent(KEY), 's3cr']) expect(r.text).not.toContain(form);
    expect(logs.join('\n')).not.toContain('s3cr');
  });

  it('Key 不对 → 待登录;断开删 Key;换模板 = 要重填', async () => {
    const s = await keyServer();
    const m = await manager({ amap: { url: s.url, connector: 'amap' } });
    await expect(m.setKey('amap', 'wrong-key')).resolves.toMatchObject({ status: 'needs-login' });
    await expect(m.setKey('amap', 'a\nb')).rejects.toThrow(/valid key/);
    await expect(m.setKey('amap', KEY)).resolves.toMatchObject({ status: 'connected' });
    await m.dispose();
    const other = await manager({ amap: { url: `${s.url}&v=2`, connector: 'amap' } });
    expect(statusOf(other, 'amap')).toMatchObject({ status: 'needs-login', auth: 'user-key' });
    await other.dispose();
    const again = await manager({ amap: { url: s.url, connector: 'amap' } });
    expect(statusOf(again, 'amap').status).toBe('connected');
    await again.logout('amap');
    expect(readFileSync(connectorAuthFile(), 'utf8')).not.toContain('s3cr');
    const r = await again.callTool(tool(again, 'mcp__amap__echo') ?? ({ name: 'mcp__amap__echo', serverName: 'amap', remoteName: 'echo' } as LoadedMcpTool), { text: 'x' });
    expect(r.text).toMatch(/needs the user's key/);
  });

  it('脱敏覆盖 URL 序列化 / 小写百分号 / JSON 转义几种形态', () => {
    const k = "ab'c/d+e";
    const text = `raw ${k} | enc ${encodeURIComponent(k)} | url ${new URL(`https://x/?key=${encodeURIComponent(k)}`).href} | lower ${encodeURIComponent(k).toLowerCase()} | json ${JSON.stringify({ u: k }).slice(6, -2)}`;
    const out = redactKey(text, k);
    expect(out).not.toMatch(/ab'c|ab%27c|c%2fd|c%2Fd|c\\\/d/i);
    expect(out.match(/\{userKey\}/g)?.length).toBe(5);
  });

  it('停用的条目断开也删 Key;目录换了地址模板,旧模板的 Key 随重载删掉', async () => {
    const s = await keyServer();
    const m = await manager({ amap: { url: s.url, connector: 'amap', enabled: false } });
    saveUserKey(s.url, KEY);
    await m.logout('amap');
    expect(loadUserKey(s.url)).toBeUndefined();
    await m.dispose();

    const live = await manager({ amap: { url: s.url, connector: 'amap' } });
    await live.setKey('amap', KEY);
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { amap: { url: `${s.url}&v=2`, connector: 'amap' } } }));
    await live.reloadConfig();
    expect(loadUserKey(s.url)).toBeUndefined();
    expect(statusOf(live, 'amap')).toMatchObject({ status: 'needs-login', auth: 'user-key' });
  });

  it('普通条目(没有 {userKey})不受影响,setKey 拒收', async () => {
    const mcp = await startHttpServer({ tag: 'p' });
    stops.push(() => mcp.stop());
    const m = await manager({ plain: { url: mcp.url } });
    expect(statusOf(m, 'plain')).toMatchObject({ status: 'connected' });
    expect(statusOf(m, 'plain').auth).toBeUndefined();
    await expect(m.setKey('plain', KEY)).rejects.toThrow(/does not take a key/);
  });
});

describe('alwaysAsk(目录条目里的「每次都问」)', () => {
  const call = (name: string): ToolCall => ({ id: 'c1', type: 'function', function: { name, arguments: '{"text":"x"}' } }) as ToolCall;
  const writeCatalog = (connectors: unknown[]) => writeFileSync(connectorCatalogFile(), JSON.stringify({ fetchedAt: 1, connectors }));
  async function connected() {
    const mcp = await startHttpServer({ tag: 'a' });
    stops.push(() => mcp.stop());
    return manager({ didi: { url: mcp.url, connector: 'didi' }, mine: { url: mcp.url } });
  }

  it('只认带标记的条目里、目录列出的工具', async () => {
    writeCatalog([{ id: 'didi', kind: 'remote-mcp', status: 'published', alwaysAsk: ['echo'] }]);
    await connected();
    expect(declaredApproval('mcp__didi__echo')).toBe('always');
    expect(declaredApproval('mcp__didi__pid')).toBeUndefined();
    expect(declaredApproval('mcp__mine__echo')).toBeUndefined(); // 同一个 server,没标记 = 不算
  });

  it('目录缓存读不到 / 坏了 / 没这个 id → 带标记的条目一律每次都问', async () => {
    await connected();
    expect(declaredApproval('mcp__didi__pid')).toBe('always'); // 没缓存
    writeFileSync(connectorCatalogFile(), '{not json');
    expect(declaredApproval('mcp__didi__pid')).toBe('always');
    writeCatalog([{ id: 'other', alwaysAsk: [] }]);
    expect(declaredApproval('mcp__didi__pid')).toBe('always');
    expect(declaredApproval('mcp__mine__pid')).toBeUndefined();
  });

  it('第二个 manager 起来 / 关掉都不摘掉第一个的判定;桥接名指过的任一远端工具被列进就算', async () => {
    writeCatalog([{ id: 'didi', kind: 'remote-mcp', status: 'published', alwaysAsk: ['echo'] }]);
    await connected();
    const other = createMcpManager(join(dir, 'none.json'), FAST);
    await other.start();
    expect(declaredApproval('mcp__didi__echo')).toBe('always');
    await other.dispose();
    expect(declaredApproval('mcp__didi__echo')).toBe('always');
    writeCatalog([{ id: 'didi', alwaysAsk: ['place_order'] }]);
    expect(connectorToolAlwaysAsk('didi', new Set(['place.order', 'place_order']))).toBe(true); // 工具列表变了、快照里还是旧的那个
    expect(connectorToolAlwaysAsk('didi', new Set(['place.order']))).toBe(false);
  });

  it('完全通行档弹卡,「总是允许」之后照样弹;无人值守、Muse 代批直接拒', async () => {
    writeCatalog([{ id: 'didi', kind: 'remote-mcp', status: 'published', alwaysAsk: ['echo'] }]);
    await connected();
    const ctx = { sessionId: 'ca-s1', execMode: 'host' as const, approvalMode: 'full-auto' as const, cwd: dir };
    for (let i = 0; i < 2; i++) {
      state.publish.mockClear();
      const pending = gateToolCall(`ca${i}`, call('mcp__didi__echo'), ctx);
      await vi.waitFor(() => expect(state.publish).toHaveBeenCalledWith(`ca${i}`, 'approval_request', expect.anything()));
      const ev = (state.publish.mock.calls.find((a: any[]) => a[0] === `ca${i}`) as any)[2];
      resolveApproval(ev.approvalId, { action: 'approve_always' });
      await expect(pending).resolves.toMatchObject({ action: 'approve' });
    }
    // 没列进 alwaysAsk 的工具:完全通行档直接放行
    await expect(gateToolCall('ca9', call('mcp__didi__pid'), ctx)).resolves.toMatchObject({ action: 'approve' });
    await expect(gateToolCall('ca3', call('mcp__didi__echo'), { ...ctx, unattended: true })).resolves.toMatchObject({ action: 'reject', rejectReason: expect.stringMatching(/unattended/) });
    await expect(gateToolCall('ca4', call('mcp__didi__echo'), { ...ctx, approvalDeferral: 'queue' })).resolves.toMatchObject({ action: 'reject' });
  });
});
