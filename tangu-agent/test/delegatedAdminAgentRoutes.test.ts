/**
 * 委托管理员档在引擎这一侧(unitWeb 盖的 x-forsion-remote-role: delegated-admin):
 *   · remoteRole 只在远端标记有效且来路为隧道时认这个头(本机进程自己加的头 / 局域网 / P2P 一律 undefined);
 *   · GET /agent/agents:带这个角色时不藏人设(systemPrompt / soul 原样),审批档仍按远程上限钳;其余远端照旧投影;
 *   · 远端写 Agent(POST / PATCH)审批档照远端上限钳、custom 不收、存值 custom 不改写、提交「钳后的存值」不压低存值;
 *     同步 / 共享记忆 / 电脑历史 / 分身字段不收;
 *   · 远端删 Agent 不连带删私聊。
 * 真 express + 真 agents 路由 + 临时 TANGU_HOME(同 remoteProjectionRoutes.test)。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/delegatedAdminAgentRoutes.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import agentsRouter, { remoteAgentApprovalMode } from '../src/routes/agents.js';
import { saveAgent, getAgent } from '../src/agents/agentRegistry.js';
import { remoteRole } from '../src/services/remoteOrigin.js';

let srv: Server;
let base: string;
let home: string;
const prevHome = process.env.TANGU_HOME;
const prevMark = process.env.TANGU_REMOTE_MARK_SECRET;

const SECRET_SOUL = 'DA-SOUL-TEXT';
const SECRET_DI = 'DA-DEVELOPER-INSTRUCTIONS';
const MARK = 'boot-mark-secret';
const ADMIN = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK, 'x-forsion-remote-role': 'delegated-admin' };
const TUNNEL = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK };

const call = async (method: string, p: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: any; raw: string }> => {
  const r = await fetch(`${base}${p}`, { method, headers: { Authorization: 'Bearer x', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
  return { status: r.status, body: parsed, raw };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-delegated-'));
  process.env.TANGU_HOME = home;
  process.env.TANGU_REMOTE_MARK_SECRET = MARK;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  await saveAgent({ slug: 'da-wide', name: 'Wide', description: 'probe', systemPrompt: SECRET_DI, soul: SECRET_SOUL, approvalMode: 'full-auto' } as any);
  await saveAgent({ slug: 'da-custom', name: 'Custom', description: 'probe', systemPrompt: SECRET_DI, approvalMode: 'custom' } as any);
  await saveAgent({ slug: 'da-tight', name: 'Tight', description: 'probe', systemPrompt: SECRET_DI, approvalMode: 'readonly' } as any);
  const app = express(); app.use(express.json()); app.use(agentsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  if (prevMark === undefined) delete process.env.TANGU_REMOTE_MARK_SECRET; else process.env.TANGU_REMOTE_MARK_SECRET = prevMark;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('remoteRole', () => {
  it('只在标记有效 + 隧道时认', () => {
    expect(remoteRole(ADMIN)).toBe('delegated-admin');
    expect(remoteRole({ ...ADMIN, 'x-forsion-remote-role': 'Delegated-Admin ' })).toBe('delegated-admin');
    expect(remoteRole({ ...ADMIN, 'x-forsion-remote-mark': 'wrong' })).toBeUndefined();
    expect(remoteRole({ 'x-forsion-remote': 'tunnel', 'x-forsion-remote-role': 'delegated-admin' })).toBeUndefined();
    expect(remoteRole({ ...ADMIN, 'x-forsion-remote': 'lan' })).toBeUndefined();
    expect(remoteRole({ ...ADMIN, 'x-forsion-remote': 'p2p' })).toBeUndefined();
    expect(remoteRole({ 'x-forsion-remote-role': 'delegated-admin', 'x-forsion-remote-mark': MARK })).toBeUndefined();
    expect(remoteRole({ ...ADMIN, 'x-forsion-remote-role': 'owner' })).toBeUndefined();
  });
});

describe('GET /agent/agents', () => {
  it('委托管理员:人设原样回,审批档仍钳到远程上限', async () => {
    const r = await call('GET', '/agent/agents', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.remote).toBe(true);
    const wide = r.body.agents.find((a: any) => a.slug === 'da-wide');
    expect(wide.systemPrompt).toBe(SECRET_DI);
    expect(wide.soul).toBe(SECRET_SOUL);
    expect(wide.approvalMode).toBe('auto-edit');
    expect(r.body.agents.find((a: any) => a.slug === 'da-custom').approvalMode).toBe('custom');
  });
  it('普通隧道 / 标记不对的角色头:照旧藏人设', async () => {
    for (const h of [TUNNEL, { ...ADMIN, 'x-forsion-remote-mark': 'forged' }, { ...ADMIN, 'x-forsion-remote': 'lan' }]) {
      const r = await call('GET', '/agent/agents', h);
      expect(r.status).toBe(200);
      expect(r.raw).not.toContain(SECRET_SOUL);
      expect(r.raw).not.toContain(SECRET_DI);
    }
  });
});

describe('remoteAgentApprovalMode', () => {
  it('钳到上限;custom 不收;存值 custom 不改写;提交「钳后的存值」不动存值', () => {
    expect(remoteAgentApprovalMode('full-auto', undefined, 'auto-edit')).toBe('auto-edit');
    expect(remoteAgentApprovalMode('readonly', undefined, 'auto-edit')).toBe('readonly');
    expect(remoteAgentApprovalMode('custom', undefined, 'auto-edit')).toBeUndefined();
    expect(remoteAgentApprovalMode('bogus', 'readonly', 'auto-edit')).toBeUndefined();
    expect(remoteAgentApprovalMode('readonly', 'custom', 'auto-edit')).toBeUndefined();
    expect(remoteAgentApprovalMode('auto-edit', 'full-auto', 'auto-edit')).toBeUndefined(); // 名册里看到的就是 auto-edit
    expect(remoteAgentApprovalMode('readonly', 'full-auto', 'auto-edit')).toBe('readonly'); // 真的收紧照写
    expect(remoteAgentApprovalMode('full-auto', 'readonly', 'auto-edit')).toBe('auto-edit'); // 放宽到上限为止
    expect(remoteAgentApprovalMode('full-auto', 'readonly', 'full-auto')).toBe('full-auto'); // 本机把上限设成 full-auto 才到得了
  });
});

describe('远端写 Agent', () => {
  it('PATCH 只改简介(整表回存):存着的 full-auto 不被压成钳后的值,人设照写', async () => {
    const r = await call('PATCH', '/agent/agents/da-wide', ADMIN, { description: 'edited', approvalMode: 'auto-edit', systemPrompt: 'new prompt' });
    expect(r.status).toBe(200);
    const def = await getAgent('da-wide');
    expect(def?.description).toBe('edited');
    expect(def?.systemPrompt).toBe('new prompt');
    expect(def?.approvalMode).toBe('full-auto');
  });
  it('PATCH 放宽被钳到上限;custom 不收;存值 custom 不改写', async () => {
    expect((await call('PATCH', '/agent/agents/da-tight', ADMIN, { approvalMode: 'full-auto' })).status).toBe(200);
    expect((await getAgent('da-tight'))?.approvalMode).toBe('auto-edit');
    expect((await call('PATCH', '/agent/agents/da-tight', ADMIN, { approvalMode: 'custom' })).status).toBe(200);
    expect((await getAgent('da-tight'))?.approvalMode).toBe('auto-edit');
    expect((await call('PATCH', '/agent/agents/da-custom', ADMIN, { approvalMode: 'readonly' })).status).toBe(200);
    expect((await getAgent('da-custom'))?.approvalMode).toBe('custom');
  });
  it('PATCH / POST 不收同步、共享记忆、电脑历史字段(存值照留)', async () => {
    expect((await call('PATCH', '/agent/agents/da-tight', ADMIN, { activityAccess: true, shareDefaultMemory: true, cloudSync: true })).status).toBe(200);
    const def = await getAgent('da-tight');
    expect(def?.activityAccess).toBeFalsy();
    expect(def?.shareDefaultMemory).toBeFalsy();
    const c = await call('POST', '/agent/agents', ADMIN, { name: 'Made remotely', slug: 'da-new', systemPrompt: 'p', approvalMode: 'full-auto', activityAccess: true, shareDefaultMemory: true });
    expect(c.status).toBe(200);
    const made = await getAgent('da-new');
    expect(made?.approvalMode).toBe('auto-edit');
    expect(made?.activityAccess).toBeFalsy();
    expect(made?.shareDefaultMemory).toBeFalsy();
    const custom = await call('POST', '/agent/agents', ADMIN, { name: 'Custom remote', slug: 'da-new-custom', systemPrompt: 'p', approvalMode: 'custom' });
    expect(custom.status).toBe(200);
    expect((await getAgent('da-new-custom'))?.approvalMode || '').not.toBe('custom');
  });
  it('本机请求不受影响:照写 full-auto 与 activityAccess', async () => {
    expect((await call('PATCH', '/agent/agents/da-tight', {}, { approvalMode: 'full-auto', activityAccess: true })).status).toBe(200);
    const def = await getAgent('da-tight');
    expect(def?.approvalMode).toBe('full-auto');
    expect(def?.activityAccess).toBe(true);
  });
  it('DELETE:远端不回本机回收站路径(私聊不连带删,见 uninstallAgent 的 deleteChats)', async () => {
    const r = await call('DELETE', '/agent/agents/da-new?deleteChats=1&keepFiles=1', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.keptAt).toBeUndefined();
    expect(await getAgent('da-new')).toBeFalsy();
  });
});
