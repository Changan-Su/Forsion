/**
 * POST /agent/agents 新建的 id:saveAgent 是按 slug 的 upsert,撞了会**静默覆盖**。
 * 只有中文名要显式给 id;显式 id 撞了 409;由名字推出来的撞了递增后缀;PATCH 仍原位更新。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import agentsRouter from '../src/routes/agents.js';

let home: string;
let srv: Server;
let base: string;

const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x', ...(init?.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-agents-create-'));
  process.env.TANGU_HOME = home;
  const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});

afterAll(() => {
  srv?.close();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /agent/agents 撞 slug', () => {
  it('只有中文名、没给 id → 400,不落到兜底的 agent、不转拼音', async () => {
    const r = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ nameZh: '秦车', systemPrompt: 'A' }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('slug_required');
    expect((await api('/agent/agents')).body.agents.map((x: any) => x.slug)).not.toContain('agent');
  });

  it('中文名 + 显式 id 建成;撞已有 id → 409,不覆盖也不悄悄换一个', async () => {
    const a = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'agent', nameZh: '秦车', systemPrompt: 'A' }) });
    expect(a.status).toBe(200);
    expect(a.body.agent).toMatchObject({ slug: 'agent', name: '秦车', nameZh: '秦车', nameEn: '' });
    const dup = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'agent', nameZh: '墨璃', systemPrompt: 'B' }) });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('exists');
    expect((await api('/agent/agents/agent', { method: 'PATCH', body: '{}' })).body.agent.name).toBe('秦车');
  });

  it('不合法的 id → 400(旧口径悄悄改用名字推的)', async () => {
    const r = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'Bad Id', nameEn: 'Okay', systemPrompt: 'A' }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_slug');
  });

  it('id 由英文名推;推出来的撞了递增后缀,绝不覆盖', async () => {
    const a = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ nameEn: 'Night Owl', nameZh: '夜猫', systemPrompt: 'A' }) });
    const b = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ name: 'Night Owl', systemPrompt: 'B' }) });
    expect(a.body.agent.slug).toBe('night-owl');
    expect(b.body.agent.slug).toBe('night-owl-2');
  });

  it('英文名有汉字 → 400,什么都不写', async () => {
    const r = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'mixed', nameEn: 'Night 猫', systemPrompt: 'A' }) });
    expect(r.status).toBe(400);
    expect((await api('/agent/agents')).body.agents.map((x: any) => x.slug)).not.toContain('mixed');
  });

  it('PATCH 仍原位更新,不产生新 slug', async () => {
    const r = await api('/agent/agents/agent', { method: 'PATCH', body: JSON.stringify({ systemPrompt: 'A2' }) });
    expect(r.status).toBe(200);
    expect(r.body.agent.slug).toBe('agent');
    expect(r.body.agent.systemPrompt).toBe('A2');
  });
});
