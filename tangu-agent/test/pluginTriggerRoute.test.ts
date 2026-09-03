/**
 * POST /agent/special/muse/triggers 的插件种子规则闸(E8 / §6.4):真 express(随机端口 fetch 直打)+ tmp TANGU_HOME。
 * 覆盖:plugin: 前缀 id 幂等创建(200 created→200 updated)/ tool_call 与 agent_run 被拒(400)/ id 形态闸 400 /
 * 非插件不存在 id 仍 404 / enabled false→true 时重播种(**与规则来源无关**:用户规则同样适用)/
 * 监听列是公式列时建规则即拒(precheckWatchCols)。
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
import specialRouter from '../src/routes/special.js';
import { setCursors, loadCursors } from '../src/services/dbCursors.js';
import { loadTriggers } from '../src/services/museTriggers.js';

let srv: Server;
let base: string;
let home: string;
let vault: string;

const post = async (body: any): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/agent/special/muse/triggers`, {
    method: 'POST',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-plugtrig-'));
  vault = mkdtempSync(join(tmpdir(), 'tangu-plugtrig-vault-'));
  process.env.TANGU_HOME = home;
  process.env.FORSION_AMADEUS_VAULT = vault;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'local' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  const app = express();
  app.use(express.json());
  app.use(specialRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});

afterAll(() => {
  srv?.close();
  delete process.env.TANGU_HOME;
  delete process.env.FORSION_AMADEUS_VAULT;
  try { rmSync(home, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true }); } catch { /* ignore */ }
});

const seed = (over: Record<string, unknown> = {}) => ({
  id: 'plugin:pc-erp:order-added',
  desc: 'ERP 订单加行',
  cond_type: 'db_changed', path: '电脑销售ERP/订单总表.db', event: 'row_added', vault,
  actions: [{ type: 'db_row_add', path: '电脑销售ERP/出库记录.db', cells: { 配件: '{{row.CPU}}' }, skipIfEmpty: '配件' }],
  ...over,
});

describe('POST /agent/special/muse/triggers × plugin: 前缀', () => {
  it('幂等创建:第一次 created=true,第二次 created=false,只有一条', async () => {
    const a = await post(seed());
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ created: true, trigger: { id: 'plugin:pc-erp:order-added', cooldownHours: 0 } });
    const b = await post(seed({ desc: '改了' }));
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ created: false, trigger: { desc: '改了' } });
    expect((await loadTriggers()).filter((t) => t.id.startsWith('plugin:'))).toHaveLength(1);
  });

  it('插件规则拒 tool_call(allowToolCall:false 在校验前就定死)与 agent_run;普通规则的 tool_call 照旧放行', async () => {
    const tc = await post(seed({ id: 'plugin:pc-erp:evil', actions: [{ type: 'tool_call', tool: 'web_fetch', args: { url: 'https://x' } }] }));
    expect(tc.status).toBe(400);
    expect(tc.body.detail).toContain('tool_call');
    const ar = await post(seed({ id: 'plugin:pc-erp:evil2', actions: [{ type: 'agent_run', agentSlug: 'coder', prompt: 'x' }] }));
    expect(ar.status).toBe(400);
    expect(ar.body.detail).toContain('agent');
    expect((await loadTriggers()).some((t) => t.id.startsWith('plugin:pc-erp:evil'))).toBe(false);
    // 负对照:同样的 tool_call 走非插件路(无 id)→ 这条 UI 通道本来就放行
    const ok = await post({ desc: '普通', cond_type: 'manual', actions: [{ type: 'tool_call', tool: 'web_fetch', args: { url: 'https://x' } }] });
    expect(ok.status).toBe(200);
  });

  it('id 形态闸 400;非插件不存在 id 仍 404', async () => {
    const bad = await post(seed({ id: 'plugin:Pc_Erp:x' }));
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain('形态');
    const nf = await post(seed({ id: 'w-doesnotexist' }));
    expect(nf.status).toBe(404);
  });

  const cur = (path: string, rowIds: string[]) =>
    ({ v: 2 as const, path, event: 'row_added' as const, vault, rowIds });

  it('enabled false→true → 重播种(停用期间的行不爆发);其它 upsert 不动游标', async () => {
    const P = 'plugin:pc-erp:order-added';
    const T = '电脑销售ERP/订单总表.db';
    await setCursors({ [P]: cur(T, ['stale']) });
    const off = await post(seed({ enabled: false }));
    expect(off.status).toBe(200);
    expect((await loadCursors())[P]).toEqual(cur(T, ['stale'])); // 关掉不动
    const on = await post(seed({ enabled: true }));
    expect(on.status).toBe(200);
    expect((await loadCursors())[P]).toBeUndefined(); // 重新播种
    // 负对照:已启用再 upsert 一次(cond 同)→ 游标保留
    await setCursors({ [P]: cur(T, ['keep']) });
    await post(seed({ desc: '又改' }));
    expect((await loadCursors())[P]).toEqual(cur(T, ['keep']));
  });

  it('用户规则(非 plugin: 前缀)同样适用:停用→启用即重播种 —— 从前只保护插件规则', async () => {
    const created = await post({ desc: '用户规则', cond_type: 'db_changed', path: '用户表.db', event: 'row_added', vault, actions: [{ type: 'notify', title: 'n' }] });
    expect(created.status).toBe(200);
    const id: string = created.body.trigger.id;
    expect(id.startsWith('plugin:')).toBe(false);
    const upd = (over: Record<string, unknown>) => post({ id, desc: '用户规则', cond_type: 'db_changed', path: '用户表.db', event: 'row_added', vault, actions: [{ type: 'notify', title: 'n' }], ...over });
    await setCursors({ [id]: cur('用户表.db', ['stale']) });
    await upd({ enabled: false });
    expect((await loadCursors())[id]).toEqual(cur('用户表.db', ['stale'])); // 停用期间积压在攒
    await upd({ enabled: true });
    // 负对照:upsertTrigger 去掉 reEnabled 分支 → 这里得到 ['stale'],下一 tick 整批积压一次引爆
    expect((await loadCursors())[id]).toBeUndefined();
  });

  it('监听列是公式/引用列 → 建规则即 400(引擎侧与桌面构建器的对等闸)', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(vault, 'calc'), { recursive: true });
    writeFileSync(join(vault, 'calc', '计算.db'), JSON.stringify({
      version: 1, name: '计算',
      columns: [{ id: 'a', name: 'A', type: 'number' }, { id: 'f', name: '合计', type: 'formula', formula: '{A}*2' }],
      rows: [{ id: 'r1', cells: { a: 1 } }],
    }), 'utf8');
    const bad = await post({ desc: '盯公式列', cond_type: 'db_changed', path: 'calc/计算.db', event: 'cell_changed', column_id: 'f', vault, actions: [{ type: 'notify', title: 'n' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain('落盘列');
    // 对照:盯落盘列照常建
    const ok = await post({ desc: '盯落盘列', cond_type: 'db_changed', path: 'calc/计算.db', event: 'cell_changed', column_id: 'a', vault, actions: [{ type: 'notify', title: 'n' }] });
    expect(ok.status).toBe(200);
  });
});
