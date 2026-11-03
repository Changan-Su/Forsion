/**
 * 小组件只读接口(routes/widgets.ts):仪表盘 / 卡片区 / 主页没有会话,按 id 读原件和记录。真 express + 真文件。
 * 钉:本机才有、远端 403;data.db 坏了卡照样回(records 标 error);找不到时带上读不了的个数;两份 409;项目级要给 ?project=;
 * 唯一的写接口是 restore(撤销软删除),记录不经这里写。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { agentsDir, humanDir } from '../src/core/tanguHome.js';
import { createWidget, setRecord, softDeleteWidget } from '../src/services/widgetStore.js';
import widgetsRouter from '../src/routes/widgets.js';

let srv: Server, base: string, home: string, project: string;
const host = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' }).host;
const local = () => configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
const get = async (path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer x', ...headers } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const doc = JSON.stringify({ version: 2, id: 'ledger', title: 'Ledger', inputs: [], resources: [], blocks: [{ id: 's', kind: 'stats', items: [{ label: 'Total', value: "sum(each(records,'r',r.amount))" }] }] });

beforeAll(() => {
  local();
  const app = express();
  app.use(express.json());
  app.use(widgetsRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => { srv?.close(); delete process.env.TANGU_HOME; });
beforeEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (project) rmSync(project, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'tangu-widget-routes-'));
  project = mkdtempSync(join(tmpdir(), 'tangu-widget-routes-project-'));
  process.env.TANGU_HOME = home;
});

describe('GET /agent/widgets/:id', () => {
  it('returns the original and its records, without a session', async () => {
    const { widget } = await createWidget({ agentSlug: 'tester' }, { name: 'ledger', entry: 'widget.json', content: doc, title: 'Tokyo', summary: 'first', sizes: ['md'], rail: true });
    expect((await get(`/agent/widgets/${widget.manifest.id}`)).body.widget.records).toEqual({ status: 'none' }); // 这台设备上还没有 data.db
    const r = await setRecord({ agentSlug: 'tester' }, widget.manifest.id, { item: 'lunch', amount: 38 });
    const res = await get(`/agent/widgets/${widget.manifest.id}`);
    expect(res.status).toBe(200);
    expect(res.body.widget).toEqual({
      id: widget.manifest.id, rev: 1, name: 'ledger', title: 'Tokyo', entry: 'widget.json', scope: 'agent', agentSlug: 'tester',
      updatedAt: widget.manifest.updatedAt, summary: 'first', sizes: ['md'], rail: true, content: doc,
      records: { status: 'ok', rows: [{ id: r.id, cells: { item: 'lunch', amount: 38 } }] },
    });
  });

  it('a damaged data.db still returns the card, with records marked unreadable', async () => {
    const { widget } = await createWidget({ agentSlug: 'tester' }, { name: 'ledger', entry: 'widget.html', content: '<p>x</p>' });
    const file = join(agentsDir(), 'tester', 'WidgetData', widget.manifest.id, 'data.db');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{"rows": [trunc');
    const res = await get(`/agent/widgets/${widget.manifest.id}`);
    expect(res.status).toBe(200);
    expect(res.body.widget.content).toBe('<p>x</p>');
    expect(res.body.widget.records).toEqual({ status: 'error', error: expect.stringMatching(/cannot be read/) });
    expect(readFileSync(file, 'utf8')).toBe('{"rows": [trunc'); // 只读
  });

  it('404 tells "not found" from "not found, and some folders could not be read"; two copies 409; bad id 400', async () => {
    expect((await get('/agent/widgets/w_missing')).body).toMatchObject({ error: 'WIDGET_NOT_FOUND', unreadable: 0 });
    const bad = join(agentsDir(), 'other', 'Library', 'Widgets', 'broken');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'manifest.json'), '{ not json');
    const res = await get('/agent/widgets/w_missing');
    expect([res.status, res.body.error, res.body.unreadable]).toEqual([404, 'WIDGET_NOT_FOUND', 1]);
    const { widget } = await createWidget({ agentSlug: 'tester' }, { name: 'ledger', entry: 'widget.html', content: '<p>x</p>' });
    const copy = join(agentsDir(), 'third', 'Library', 'Widgets', 'ledger');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'widget.html'), 'y');
    writeFileSync(join(copy, 'manifest.json'), readFileSync(join(widget.dir, 'manifest.json')));
    expect(await get(`/agent/widgets/${widget.manifest.id}`)).toMatchObject({ status: 409, body: { error: 'WIDGET_TWO_COPIES' } });
    expect((await get('/agent/widgets/Bad%20Id')).status).toBe(400);
  });

  it('sees the project level only when the project is given, as an absolute path', async () => {
    const { widget } = await createWidget({ agentSlug: 'tester', projectDir: project }, { name: 'releases', entry: 'widget.html', content: '<p>p</p>' });
    expect((await get(`/agent/widgets/${widget.manifest.id}`)).status).toBe(404);
    const res = await get(`/agent/widgets/${widget.manifest.id}?project=${encodeURIComponent(project)}`);
    expect(res.body.widget).toMatchObject({ scope: 'project', content: '<p>p</p>' });
    expect(res.body.widget.agentSlug).toBeUndefined();
    expect((await get(`/agent/widgets/${widget.manifest.id}?project=relative/dir`)).status).toBe(400);
  });
});

describe('GET /agent/widgets', () => {
  it('lists every agent, the user level and (when given) the project, with soft-deleted and unreadable ones', async () => {
    const mine = (await createWidget({ agentSlug: 'tester' }, { name: 'ledger', entry: 'widget.html', content: '<p>x</p>' })).widget;
    await createWidget({ agentSlug: 'tester' }, { name: 'everyone', entry: 'widget.json', content: doc, scope: 'user' });
    await createWidget({ agentSlug: 'tester', projectDir: project }, { name: 'releases', entry: 'widget.html', content: '<p>p</p>' });
    await softDeleteWidget({ agentSlug: 'tester' }, mine.manifest.id);
    mkdirSync(join(humanDir(), 'Widgets', 'half-synced'), { recursive: true });
    const res = await get('/agent/widgets');
    expect(res.status).toBe(200);
    expect(res.body.widgets.map((w: any) => [w.name, w.scope, w.agentSlug, !!w.deletedAt]).sort()).toEqual([['everyone', 'user', undefined, false], ['ledger', 'agent', 'tester', true]]);
    expect(res.body.widgets.every((w: any) => !('content' in w) && !('records' in w))).toBe(true);
    expect(res.body.unreadable).toEqual([{ scope: 'user', name: 'half-synced', error: expect.stringMatching(/no manifest/) }]);
    const withProject = await get(`/agent/widgets?project=${encodeURIComponent(project)}`);
    expect(withProject.body.widgets.map((w: any) => w.name).sort()).toEqual(['everyone', 'ledger', 'releases']);
  });
});

describe('POST /agent/widgets/:id/restore', () => {
  const post = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: 'Bearer x', ...headers } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  it('undoes a soft delete without a session, keeps records, and is refused remotely', async () => {
    const { widget } = await createWidget({ agentSlug: 'tester' }, { name: 'ledger', entry: 'widget.json', content: doc });
    await setRecord({ agentSlug: 'tester' }, widget.manifest.id, { amount: 38 });
    await softDeleteWidget({ agentSlug: 'tester' }, widget.manifest.id);
    expect((await post(`/agent/widgets/${widget.manifest.id}/restore`, { 'x-forsion-remote': 'tunnel' })).status).toBe(403);
    expect((await get(`/agent/widgets/${widget.manifest.id}`)).body.widget.deletedAt).toBeTruthy();
    const res = await post(`/agent/widgets/${widget.manifest.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.widget).toMatchObject({ id: widget.manifest.id, name: 'ledger', scope: 'agent', agentSlug: 'tester', rev: 1 });
    expect(res.body.widget.deletedAt).toBeUndefined();
    expect('content' in res.body.widget || 'records' in res.body.widget).toBe(false);
    const after = (await get(`/agent/widgets/${widget.manifest.id}`)).body.widget;
    expect(after.deletedAt).toBeUndefined();
    expect(after.records.rows.map((r: any) => r.cells.amount)).toEqual([38]);
    expect(await post('/agent/widgets/w_missing/restore')).toMatchObject({ status: 404, body: { error: 'WIDGET_NOT_FOUND', unreadable: 0 } });
    const inP = (await createWidget({ agentSlug: 'tester', projectDir: project }, { name: 'releases', entry: 'widget.html', content: '<p>p</p>' })).widget;
    await softDeleteWidget({ agentSlug: 'tester', projectDir: project }, inP.manifest.id);
    expect((await post(`/agent/widgets/${inP.manifest.id}/restore`)).status).toBe(404); // 项目级要给 ?project=
    expect((await post(`/agent/widgets/${inP.manifest.id}/restore?project=${encodeURIComponent(project)}`)).body.widget).toMatchObject({ scope: 'project' });
  });
});

describe('boundary', () => {
  it('needs auth, refuses remote callers, exists only on a local engine, and has no write endpoint', async () => {
    expect((await fetch(`${base}/agent/widgets`)).status).toBe(401);
    expect(await get('/agent/widgets', { 'x-forsion-remote': 'tunnel' })).toMatchObject({ status: 403, body: { error: 'WIDGET_REMOTE_DENIED' } });
    expect((await get('/agent/widgets/w_x', { 'x-forsion-remote': 'lan' })).status).toBe(403);
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) expect((await fetch(`${base}/agent/widgets/w_x`, { method, headers: { Authorization: 'Bearer x' } })).status).toBe(404); // 只有 restore 一个写接口
    configureTangu({ host, brain: {} as any, billing: {} as any, profile: createAiStudioProfile() });
    try {
      expect(await get('/agent/widgets')).toMatchObject({ status: 404, body: { error: 'WIDGET_LOCAL_ONLY' } });
      expect((await get('/agent/widgets/w_x')).status).toBe(404);
      expect((await fetch(`${base}/agent/widgets/w_x/restore`, { method: 'POST', headers: { Authorization: 'Bearer x' } })).status).toBe(404);
    } finally { local(); }
  });
});
