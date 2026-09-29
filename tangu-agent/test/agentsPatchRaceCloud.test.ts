/**
 * PATCH /agent/agents/:slug × 并发写 —— 云端分支(hostExec=false + brain.agentFiles,同 agentsPatchRace 的本地版):
 *   旧口径锁外 cloudGetAgent 读 cur,mergeAgentPatch(cur, fields) 补齐全部未提交字段(含审批档)再 cloudSaveAgent,且不带 mustExist ——
 *   ① 读到写之间用户在另一处收紧审批档 / 收窄工具,这次只改模型的 PATCH 用旧快照把它们盖回去(cloudSaveAgent 锁内现读的是新
 *     baseSeq,CAS 也拦不住);
 *   ② 读到写之间 agent 被删(墓碑),锁内现读 = 不存在 + 没 mustExist → 按新建落盘,删掉的 agent 复活、回 200;
 *   ③ 墓碑过的内置预设:预读按预设兜底放行,旧口径照样把它写回来。
 *   现在走 cloudPatchAgent:按 user+slug 串行化、锁内现读(认墓碑)、只改提交了的字段、审批档没提交就 KEEP、恒 mustExist → 404。
 * 注入点:内存 agentFiles 的 getFile 闸门,卡在路由预读读完 SOUL.md 之后(预读不持锁,另一方当场做完,直接 await)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import agentsRouter from '../src/routes/agents.js';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { AgentFileConflictError } from '../src/seams/cloudBrain.js';
import { cloudGetAgent, cloudSaveAgent, cloudDeleteAgent } from '../src/agents/cloudAgentStore.js';
import type { SaveAgentInput } from '../src/agents/agentRegistry.js';

type Row = { content?: string; contentBase64?: string; isBinary: boolean; mtimeMs: number; size: number; deleted: boolean; seq: number };
type Gate = { promise: Promise<void>; release: () => void; reached: Promise<void>; hit: () => void };
function gate(): Gate {
  let release!: () => void;
  let hit!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { hit = r; });
  return { promise, release, reached, hit };
}

/** 内存 agentFiles,带服务端同款 seq / CAS(同 cloudAgentStore.locking 的桩);getGates:relPath → 一次性闸门(读到之后、返回之前卡住)。 */
function memAgentFiles() {
  const store = new Map<string, Row>();
  const key = (u: string, s: string, r: string): string => `${u}\u0000${s}\u0000${r}`;
  const getGates = new Map<string, Gate>();
  const conflict = (code: 'CONFLICT' | 'EXISTS', row: Row | undefined): Error =>
    new AgentFileConflictError({ code, seq: row && !row.deleted ? row.seq : 0, hash: null, mtimeMs: row?.mtimeMs ?? 0, deleted: !!row?.deleted });
  return {
    getGates,
    row: (u: string, s: string, r: string): Row | undefined => store.get(key(u, s, r)),
    getManifest: async (u: string) => {
      const by = new Map<string, any[]>();
      for (const [k, v] of store) {
        const [ku, ks, kr] = k.split('\u0000');
        if (ku !== u) continue;
        if (!by.has(ks)) by.set(ks, []);
        by.get(ks)!.push({ relPath: kr, mtimeMs: v.mtimeMs, size: v.size, isBinary: v.isBinary, deleted: v.deleted, seq: v.seq });
      }
      return [...by.entries()].map(([slug, files]) => ({ slug, files }));
    },
    getFile: async (u: string, s: string, r: string) => {
      const v = store.get(key(u, s, r));
      const out = v ? { ...v } : null;
      const g = getGates.get(r);
      if (g) { getGates.delete(r); g.hit(); await g.promise; }
      return out;
    },
    putFile: async (u: string, s: string, r: string, b: any) => {
      const cur = store.get(key(u, s, r));
      if (b.baseSeq === 0 && cur && !cur.deleted) throw conflict('EXISTS', cur);
      if (typeof b.baseSeq === 'number' && b.baseSeq > 0 && (!cur || cur.deleted || cur.seq !== b.baseSeq)) throw conflict('CONFLICT', cur);
      const row: Row = { content: b.content, contentBase64: b.contentBase64, isBinary: !!b.isBinary, mtimeMs: b.mtimeMs, size: b.size, deleted: false, seq: (cur?.seq ?? 0) + 1 };
      store.set(key(u, s, r), row);
      return { mtimeMs: row.mtimeMs, seq: row.seq };
    },
    deleteFile: async (u: string, s: string, r: string, m: number) => {
      const cur = store.get(key(u, s, r));
      store.set(key(u, s, r), { isBinary: false, size: 0, mtimeMs: m, deleted: true, seq: (cur?.seq ?? 0) + 1 });
    },
  };
}

const U = 'u1';
// ⚠️ 必须设 req.user:路由在 try 里读 req.user!.userId,不设 = TypeError 被吞成 400,「→ 404」「→ 200」都会因为错的原因红 / 绿。
const fakeHost: any = {
  query: async () => [],
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { userId: U }; next(); },
  adminMiddleware: (_req: any, _res: any, next: any) => next(),
};
const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };

let af: ReturnType<typeof memAgentFiles>;
let srv: Server;
let base = '';
beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => { srv?.close(); });
beforeEach(() => {
  af = memAgentFiles();
  configureTangu({ host: fakeHost, brain: { agentFiles: af } as any, billing: fakeBilling, profile: createAiStudioProfile(), state: {} as any });
});

const patch = async (slug: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/agent/agents/${slug}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const USER_BOT: SaveAgentInput = {
  slug: 'bot', name: 'Bot', description: 'user summary', model: 'm1', tools: ['t1', 't2'], approvalMode: 'full-auto', systemPrompt: 'be a bot', soul: 'calm',
};
const userSave = (p: Partial<SaveAgentInput>) => cloudSaveAgent(U, 'bot', { ...USER_BOT, ...p });

/** 路由预读读完 SOUL.md 后卡住。必须在播种之后再挂:播种的 cloudSaveAgent 锁内现读也读 SOUL.md,会吃掉一次性闸门。 */
function holdPreRead(): Gate {
  const g = gate();
  af.getGates.set('SOUL.md', g);
  return g;
}

describe('云端 PATCH · 读到写之间的并发写', () => {
  it('只改模型的 PATCH × 用户同时收紧审批档、收窄工具 → 收紧与收窄都留下,模型照改', async () => {
    await userSave({});
    const g = holdPreRead();
    const p = patch('bot', { model: 'm9' });
    await g.reached;
    await userSave({ approvalMode: 'readonly', tools: ['t1'], description: 'user v2' }); // 预读不持锁 → 当场落盘
    g.release();
    const r = await p;
    expect(r.status).toBe(200);
    expect(await cloudGetAgent(U, 'bot')).toMatchObject({ approvalMode: 'readonly', tools: ['t1'], description: 'user v2', model: 'm9' });
  });

  it('PATCH × 并发删除 → 404,不把删掉的 agent 写回来', async () => {
    await userSave({});
    const g = holdPreRead();
    const p = patch('bot', { model: 'm9' });
    await g.reached;
    expect(await cloudDeleteAgent(U, 'bot')).toBe(true);
    g.release();
    const r = await p;
    expect(r.status).toBe(404);
    expect(r.body.detail).toBe('Agent not found');
    expect(af.row(U, 'bot', 'config.toml')?.deleted).toBe(true);
  });
});

describe('云端 PATCH · 内置预设', () => {
  it('墓碑过的预设 → 404(预读按预设兜底放行,锁内现读认墓碑),不复活', async () => {
    expect(await cloudDeleteAgent(U, 'aria')).toBe(true);
    const r = await patch('aria', { model: 'm9' });
    expect(r.status).toBe(404);
    expect(af.row(U, 'aria', 'config.toml')?.deleted).toBe(true);
  });

  it('从未物化的预设照常可改(编辑即物化)', async () => {
    const r = await patch('recita', { name: 'My Recita' });
    expect(r.status).toBe(200);
    expect(r.body.agent.name).toBe('My Recita');
    expect(af.row(U, 'recita', 'config.toml')?.deleted).toBe(false);
  });

  it('只改提交了的字段;没提交审批档 → 保留现值', async () => {
    await userSave({ approvalMode: 'readonly' });
    const r = await patch('bot', { description: 'd2' });
    expect(r.status).toBe(200);
    expect(await cloudGetAgent(U, 'bot')).toMatchObject({ approvalMode: 'readonly', description: 'd2', model: 'm1', tools: ['t1', 't2'], soul: 'calm' });
  });
});
