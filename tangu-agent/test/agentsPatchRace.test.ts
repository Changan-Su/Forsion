/**
 * PATCH /agent/agents/:slug × 并发写(09-26):
 *   旧口径锁外 getAgent 读 cur,再把 cur 的**每个未提交字段**(含审批档)经 saveAgent 显式写回,且不带 mustExist ——
 *   ① 读到写之间用户在另一处把审批档收紧 / 收窄了工具,这次只改模型的 PATCH 用旧快照把它们盖回去;
 *   ② 读到写之间 agent 被 DELETE,这次保存把目录建回来(复活),还回 200。
 *   现在本地走 patchAgent:按 slug 串行化、锁内现读、只改提交了的字段、审批档没提交就 KEEP、恒 mustExist → 被删了回 404。
 *
 * 注入点(同 agentRegistryLockRace):spy node:fs 的 promises.readFile,PATCH 第一次读完 <slug>/SOUL.md(= 读完整个 agent)后卡住,
 * 把另一方插进「已读、未写」的窗口。卡住的是路由的锁外预读(不存在 → 404 先于 400 校验,是契约),它不持锁,
 * 所以另一方一定能当场做完 —— 直接 await,不靠计时。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import agentsRouter from '../src/routes/agents.js';
import { getAgent, saveAgent, patchAgent, type SaveAgentInput } from '../src/agents/agentRegistry.js';
import { agentsDir } from '../src/core/tanguHome.js';

let srv: Server;
let base = '';
const api = async (p: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x', ...(init?.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};
const patch = (slug: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> =>
  api(`/agent/agents/${slug}`, { method: 'PATCH', body: JSON.stringify(body) });

const USER_BOT: SaveAgentInput = {
  slug: 'bot', name: 'Bot', description: 'user summary', model: 'm1', tools: ['t1', 't2'], thinkingLevel: 'high',
  maxIterations: 120, approvalMode: 'full-auto', systemPrompt: 'be a bot', soul: 'calm', createdBy: 'user',
  toolsMode: 'deny', toolsList: ['run_bash'],
};
const userSave = (p: Partial<SaveAgentInput>): Promise<unknown> => saveAgent({ ...USER_BOT, ...p });

/** 某次操作读完 <slug>/SOUL.md 之后卡住,直到 release();只卡第一次。 */
function holdAfterAgentRead(slug: string): { reached: Promise<void>; release: () => void } {
  const soul = path.join(agentsDir(), slug, 'SOUL.md');
  const realRead = fsp.readFile.bind(fsp) as (...a: any[]) => Promise<any>;
  let armed = true;
  let reachedR!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { reachedR = r; });
  const gate = new Promise<void>((r) => { release = r; });
  vi.spyOn(fsp, 'readFile').mockImplementation((async (...a: any[]) => {
    const r = await realRead(...a);
    if (armed && a[0] === soul) {
      armed = false;
      reachedR();
      await gate;
    }
    return r;
  }) as any);
  return { reached, release };
}

beforeAll(() => {
  const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => { srv?.close(); });

let home = '';
let prevHome: string | undefined;
beforeEach(async () => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(path.join(tmpdir(), 'tangu-agents-patch-race-'));
  process.env.TANGU_HOME = home;
  mkdirSync(agentsDir(), { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await userSave({});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('PATCH · 读到写之间的并发写', () => {
  it('只改模型的 PATCH × 用户同时收紧审批档、收窄工具 → 收紧与收窄都留下,模型照改', async () => {
    const { reached, release } = holdAfterAgentRead('bot');
    const p = patch('bot', { model: 'm9' });
    await reached;
    await userSave({ approvalMode: 'readonly', tools: ['t1'], description: 'user v2' }); // 预读不持锁 → 当场落盘
    release();
    const r = await p;
    vi.restoreAllMocks();
    expect(r.status).toBe(200);
    expect(await getAgent('bot')).toMatchObject({ approvalMode: 'readonly', tools: ['t1'], description: 'user v2', model: 'm9' });
  });

  it('PATCH × 并发 DELETE → 404,不把删掉的 agent 建回来', async () => {
    const { reached, release } = holdAfterAgentRead('bot');
    const p = patch('bot', { model: 'm9' });
    await reached;
    const d = await api('/agent/agents/bot', { method: 'DELETE' }); // 预读不持锁 → 当场删完
    release();
    const r = await p;
    vi.restoreAllMocks();
    expect(d).toMatchObject({ status: 200, body: { ok: true } });
    expect(r.status).toBe(404);
    expect(r.body.detail).toBe('Agent not found');
    expect(existsSync(path.join(agentsDir(), 'bot'))).toBe(false);
    expect(await getAgent('bot')).toBeNull();
  });
});

describe('patchAgent · 读 cur 在锁里', () => {
  // 上面两条把另一方插在**路由的锁外预读**里,patchAgent 自己的读在那之后才开始 —— 就算 patchAgent 把读挪到锁外它们也照样绿。
  // 这里卡住的是 patchAgent **自己**对 SOUL.md 的读:读在锁里 → 用户的保存只能排在它后面、落盘在后;读在锁外 → 用户先落盘,
  // 随后 patchAgent 拿读到的旧快照把收窄的工具盖回去。
  it('patchAgent 读到一半时用户收窄工具 → 用户的保存排在它后面,收窄留下', async () => {
    const { reached, release } = holdAfterAgentRead('bot');
    const p = patchAgent('bot', { model: 'm9' });
    await reached; // patchAgent 读完 SOUL.md 后卡住(首访播种已在 beforeEach 跑过,这是它锁内的那次读)
    const u = userSave({ tools: ['t1'], description: 'user v2' });
    await Promise.race([u, new Promise((r) => setTimeout(r, 30))]); // 若没排队,给用户的保存时间先落盘
    release();
    await Promise.all([p, u]);
    vi.restoreAllMocks();
    expect(await getAgent('bot')).toMatchObject({ tools: ['t1'], description: 'user v2' });
  });
});

describe('POST · 预读查重到落盘之间冒出同 slug', () => {
  it('锁内现读撞上 → 409、什么都不写,先落盘的那个(连同审批档)原样留下', async () => {
    // 卡住另一方(manage_agent create 同款:mustNotExist)对 fresh/config.toml 的写:它已持锁、目录已建,但 config.toml 还没落盘,
    // 所以 POST 的锁外查重看不到它、按 'fresh' 去存,排进同一条队。
    const cfg = path.join(agentsDir(), 'fresh', 'config.toml');
    const realWrite = fsp.writeFile.bind(fsp) as (...a: any[]) => Promise<any>;
    let armed = true;
    let reachedR!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => { reachedR = r; });
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(fsp, 'writeFile').mockImplementation((async (...a: any[]) => {
      if (armed && a[0] === cfg) { armed = false; reachedR(); await gate; }
      return realWrite(...a);
    }) as any);
    const first = saveAgent({ slug: 'fresh', name: 'Fresh', systemPrompt: 'first', approvalMode: 'readonly', createdBy: 'agent', mustNotExist: true });
    await reached;
    const post = api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'fresh', name: 'Fresh', systemPrompt: 'second', approvalMode: 'full-auto' }) });
    await new Promise((r) => setTimeout(r, 150)); // 让 POST 做完锁外查重、排进队(没到就放行 = 假红:它会看到 fresh、改存 fresh-2)
    release();
    const [r] = await Promise.all([post, first]);
    vi.restoreAllMocks();
    expect(r.status).toBe(409);
    expect(await getAgent('fresh')).toMatchObject({ systemPrompt: 'first', approvalMode: 'readonly', createdBy: 'agent' });
    expect(await getAgent('fresh-2')).toBeNull();
  });
});

describe('PATCH · 只改提交了的字段', () => {
  it('提交审批档照写(设置页就是用户改档的地方,收紧放宽都行),其余字段不动', async () => {
    let r = await patch('bot', { approvalMode: 'readonly' });
    expect(r.status).toBe(200);
    expect(r.body.agent).toMatchObject({ approvalMode: 'readonly', model: 'm1' });
    r = await patch('bot', { approvalMode: 'full-auto', model: 'm2' });
    expect(r.status).toBe(200);
    expect(await getAgent('bot')).toMatchObject({
      approvalMode: 'full-auto', model: 'm2', tools: ['t1', 't2'], description: 'user summary', thinkingLevel: 'high',
      maxIterations: 120, systemPrompt: 'be a bot', soul: 'calm', toolsMode: 'deny', toolsList: ['run_bash'], createdBy: 'user',
    });
  });

  it('null 语义照旧:description / approvalMode 传 null = 没提交;maxIterations / toolsMode / toolsList 传 null = 清除', async () => {
    await userSave({ approvalMode: 'readonly' });
    const r = await patch('bot', { description: null, approvalMode: null, maxIterations: null, toolsMode: null, toolsList: null });
    expect(r.status).toBe(200);
    const d = await getAgent('bot');
    expect(d).toMatchObject({ description: 'user summary', approvalMode: 'readonly', maxIterations: null });
    expect(d?.toolsMode).toBeUndefined();
    expect(d?.toolsList).toBeUndefined();
  });

  it('不存在的 slug → 404;低于下限的轮数 → 400 且不落盘', async () => {
    expect((await patch('ghost', { model: 'm9' })).status).toBe(404);
    expect(existsSync(path.join(agentsDir(), 'ghost'))).toBe(false);
    expect((await patch('bot', { maxIterations: 3 })).status).toBe(400);
    expect((await getAgent('bot'))?.maxIterations).toBe(120);
  });
});
