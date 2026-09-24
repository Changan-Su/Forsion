/**
 * Tangu for Chrome 扩展桥:只收固定扩展 ID 的来源、首条消息必须带对连接码、请求往返 / 超时 / 断线。
 * 用 ws 客户端冒充扩展(真扩展 × 真 Chrome 的端到端见 scripts/browser-extension.smoke.mjs)。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  EXTENSION_ID, connectCode, currentExtensionClient, extensionCall, extensionClientAlive, extensionConnected, extensionStatus, extensionToken,
  startBrowserExtensionBridge, stopBrowserExtensionBridge,
} from './browserExtension.js';

const freePort = (): Promise<number> => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const saved = { home: process.env.TANGU_HOME, port: process.env.TANGU_BROWSER_EXTENSION_PORT, on: process.env.TANGU_BROWSER_EXTENSION };
let port = 0;

const hmac = (token: string, msg: string): string => createHmac('sha256', token).update(msg).digest('hex');

/** 冒充扩展:按给定 origin / token 走双向挑战-应答握手;handler 回答引擎发来的命令。serverProofOk 记下对面证明对不对。 */
function fakeExtension(opts: { origin?: string; token?: string; handler?: (m: any) => any } = {}): Promise<{ ws: WebSocket; closed: Promise<number>; welcomed: Promise<any>; serverProofOk: () => boolean | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tangu-browser`, { origin: opts.origin ?? `chrome-extension://${EXTENSION_ID}` });
    const token = opts.token ?? extensionToken();
    const nonce = randomBytes(16).toString('hex');
    let serverProof: boolean | null = null;
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    let welcome: (v: any) => void = () => {};
    const welcomed = new Promise<any>((r) => { welcome = r; });
    ws.on('message', async (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'challenge') { serverProof = m.proof === hmac(token, `server:${nonce}`); ws.send(JSON.stringify({ type: 'auth', proof: hmac(token, `client:${m.nonce}`) })); return; }
      if (m.type === 'welcome') { welcome(m); return; }
      if (m.id != null) {
        try { ws.send(JSON.stringify({ id: m.id, result: await opts.handler?.(m) })); } catch (e: any) { ws.send(JSON.stringify({ id: m.id, error: e.message })); }
      }
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', nonce, version: 'test' })); resolve({ ws, closed, welcomed, serverProofOk: () => serverProof }); });
    ws.on('unexpected-response', () => resolve({ ws, closed: Promise.resolve(-1), welcomed: new Promise(() => {}) }));
    ws.on('error', () => { /* 被拒的握手走 unexpected-response / close */ });
  });
}

beforeEach(async () => {
  process.env.TANGU_HOME = mkdtempSync(join(tmpdir(), 'tangu-ext-bridge-'));
  port = await freePort();
  process.env.TANGU_BROWSER_EXTENSION_PORT = String(port);
  process.env.TANGU_BROWSER_EXTENSION = '1';
  startBrowserExtensionBridge();
  for (let i = 0; i < 50 && !extensionStatus().listening; i++) await new Promise((r) => setTimeout(r, 20));
});
afterEach(() => {
  stopBrowserExtensionBridge();
  for (const [k, v] of [['TANGU_HOME', saved.home], ['TANGU_BROWSER_EXTENSION_PORT', saved.port], ['TANGU_BROWSER_EXTENSION', saved.on]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('Tangu for Chrome 扩展桥', () => {
  it('连接码 = tangu:<端口>:<令牌>,令牌按家目录持久化、reset 换新', () => {
    const code = connectCode();
    expect(code).toMatch(new RegExp(`^tangu:${port}:[0-9a-f]{48}$`));
    expect(connectCode()).toBe(code);
    extensionToken(true);
    expect(connectCode()).not.toBe(code);
  });

  it('来源不是固定扩展 ID 的一律拒绝握手(网页 / 别的扩展冒充不了)', async () => {
    const { closed } = await fakeExtension({ origin: 'https://evil.example' });
    expect(await closed).toBe(-1);
    expect(extensionConnected()).toBe(false);
  });

  it('连接码不对:以 4001 断开,扩展据此停止重试;对面的证明扩展那边也验不过', async () => {
    const { closed, serverProofOk } = await fakeExtension({ token: 'f'.repeat(48) });
    expect(await closed).toBe(4001);
    expect(serverProofOk()).toBe(false);
    expect(extensionConnected()).toBe(false);
  });

  it('握手不泄露令牌、不许跳步:明文令牌 hello / 不先 hello 直接 auth 都拒', async () => {
    for (const first of [{ type: 'hello', token: extensionToken(), version: 'old' }, { type: 'auth', proof: 'x'.repeat(64) }]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/tangu-browser`, { origin: `chrome-extension://${EXTENSION_ID}` });
      const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
      const frames: string[] = [];
      ws.on('message', (d) => frames.push(String(d)));
      await new Promise((r) => ws.on('open', r));
      ws.send(JSON.stringify(first));
      expect(await closed).toBe(4001);
      expect(frames.join('')).not.toContain(extensionToken()); // 服务端从不回显令牌
    }
    expect(extensionConnected()).toBe(false);
  });

  it('配对成功:收到 welcome,命令往返,扩展报错原样带回', async () => {
    const { welcomed, serverProofOk } = await fakeExtension({
      handler: (m) => { if (m.method === 'boom') throw new Error('page script failed'); return { echo: m.method, params: m.params }; },
    });
    expect((await welcomed).type).toBe('welcome');
    expect(serverProofOk()).toBe(true); // 扩展据此确认对面真是 Tangu
    expect(extensionConnected()).toBe(true);
    await expect(extensionCall('tabs.list', { a: 1 })).resolves.toEqual({ echo: 'tabs.list', params: { a: 1 } });
    await expect(extensionCall('boom')).rejects.toThrow('page script failed');
  });

  it('扩展断线:挂起中的请求立刻失败,不会等满超时', async () => {
    const { ws, welcomed } = await fakeExtension({ handler: () => new Promise(() => {}) }); // 永不回答
    await welcomed;
    const pending = extensionCall('page.read', {}, 30_000);
    ws.close();
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  it('扩展迟迟不答:按超时报错', async () => {
    const { welcomed } = await fakeExtension({ handler: () => new Promise(() => {}) });
    await welcomed;
    await expect(extensionCall('page.read', {}, 150)).rejects.toThrow(/did not answer page.read/);
  });

  const raw = async (): Promise<{ ws: WebSocket; closed: Promise<number> }> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tangu-browser`, { origin: `chrome-extension://${EXTENSION_ID}` });
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.on('error', () => { /* 被掐断时客户端报 ECONNRESET,随后 close */ });
    await new Promise((r) => ws.on('open', r));
    return { ws, closed };
  };

  it('没认证的连接只收小帧、并发有上限(别的系统用户也连得上回环口)', async () => {
    const big = await raw();
    big.ws.send(JSON.stringify({ type: 'hello', nonce: 'ab'.repeat(16), pad: 'x'.repeat(1024 * 1024) }));
    expect(await big.closed).toBe(1006); // 按原始字节直接掐断,不等 ws 把整帧收齐再判(那时内存已经吃进去了)
    const idle = await Promise.all(Array.from({ length: 8 }, raw)); // 占满握手名额、一直不说话
    expect(await (await raw()).closed).toBe(1013);
    for (const s of idle) s.ws.close();
    await Promise.all(idle.map((s) => s.closed));
    const { welcomed } = await fakeExtension(); // 名额释放后正常配对不受影响
    expect((await welcomed).type).toBe('welcome');
  });

  it('握手字段类型全不可信:toString 被置空的对象不会弄崩引擎', async () => {
    const evil = await raw();
    evil.ws.send(JSON.stringify({ type: 'hello', nonce: 'ab'.repeat(16), version: { toString: null } }));
    evil.ws.send(JSON.stringify({ type: 'auth', proof: { toString: null } }));
    expect(await evil.closed).toBe(4001);
    const { welcomed } = await fakeExtension();
    expect((await welcomed).type).toBe('welcome');
  });

  it('指名的那条连接断了:发给它的命令直接失败,绝不落到后连上的另一个浏览器', async () => {
    const a = await fakeExtension({ handler: () => 'A' });
    await a.welcomed;
    const idA = currentExtensionClient()!;
    const b = await fakeExtension({ handler: () => 'B' });
    await b.welcomed;
    expect(currentExtensionClient()).not.toBe(idA); // 默认连接 = 最近连上的
    await expect(extensionCall('tabs.list', {}, undefined, idA)).resolves.toBe('A');
    a.ws.close();
    for (let i = 0; i < 50 && extensionClientAlive(idA); i++) await new Promise((r) => setTimeout(r, 20));
    await expect(extensionCall('tabs.list', {}, undefined, idA)).rejects.toThrow(/no longer connected/);
    await expect(extensionCall('tabs.list')).resolves.toBe('B');
  });

  it('换连接码会断开已配对的扩展', async () => {
    const { closed, welcomed } = await fakeExtension();
    await welcomed;
    extensionToken(true);
    expect(await closed).toBe(4001);
  });
});
