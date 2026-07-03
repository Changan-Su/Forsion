/**
 * POST /agent/agents 新建撞 slug 回归测试:中文等非 ASCII 名全部派生为兜底 'agent',
 * 此前第二次创建会**静默覆盖**第一个(saveAgent 是按 slug 的 upsert)。
 * 修复后:新建撞 slug 递增后缀,绝不覆盖;PATCH 仍原位更新。
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
  it('两个中文名(同派生 slug)→ 两个独立 agent,绝不覆盖', async () => {
    const a = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ name: '秦车', systemPrompt: 'A' }) });
    const b = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ name: '墨璃', systemPrompt: 'B' }) });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.agent.slug).toBe('agent');
    expect(b.body.agent.slug).toBe('agent-2');
    const list = await api('/agent/agents');
    const bySlug = Object.fromEntries(list.body.agents.map((x: any) => [x.slug, x]));
    expect(bySlug['agent'].name).toBe('秦车');
    expect(bySlug['agent'].systemPrompt).toBe('A');
    expect(bySlug['agent-2'].name).toBe('墨璃');
  });

  it('显式传已存在 slug 新建 → 同样唯一化(想更新走 PATCH)', async () => {
    const r = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'agent', name: 'Third', systemPrompt: 'C' }) });
    expect(r.body.agent.slug).toBe('agent-3');
  });

  it('PATCH 仍原位更新,不产生新 slug', async () => {
    const r = await api('/agent/agents/agent', { method: 'PATCH', body: JSON.stringify({ systemPrompt: 'A2' }) });
    expect(r.status).toBe(200);
    expect(r.body.agent.slug).toBe('agent');
    expect(r.body.agent.systemPrompt).toBe('A2');
  });
});
