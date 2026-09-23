/**
 * GET /agent/tools 的自定义工具分区与 run 同闸(09-22):profile.features.customTools=false 的 app,
 * run 不装载自定义工具(见 src/services/customToolsProfileGate.test.ts),清单也不该列 —— 否则「列表有、run 不装」。
 * flag 经 profileStore 文件覆盖层注入(checked-in 覆盖给 'tangu' 写死了 customTools:true,只改 baseline 会被压回)。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createProfileStore } from '../src/profiles/profileStore.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import assetsRouter from '../src/routes/assets.js';

let srv: Server | null = null;
let home: string | null = null;

afterEach(async () => {
  if (srv) await new Promise((r) => srv!.close(r));
  srv = null;
  delete process.env.TANGU_HOME;
  if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } home = null; }
});

async function listTools(flag: boolean): Promise<{ custom: any[]; listSpy: ReturnType<typeof vi.fn> }> {
  home = mkdtempSync(join(tmpdir(), 'tangu-toolslist-'));
  process.env.TANGU_HOME = home;
  const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  const listSpy = vi.fn(async () => [{ id: 'ct1', name: 'zz_probe', description: 'probe', executor: 'http' }]);
  const baseline = createTanguProfile({ sandboxMode: 'none' });
  const profileStore = createProfileStore({ baseline, fileOverrides: { tangu: { features: { customTools: flag } } } });
  configureTangu({ host, brain: { assets: { listCustomTools: listSpy } } as any, billing: {} as any, profile: baseline, profileStore });
  const app = express();
  app.use(assetsRouter);
  srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const r = await fetch(`${base}/agent/tools?appId=tangu`, { headers: { Authorization: 'Bearer x' } });
  expect(r.status).toBe(200);
  return { custom: (await r.json()).custom, listSpy };
}

describe('GET /agent/tools · 自定义工具分区跟随 profile.features.customTools', () => {
  it('flag=false:不查也不列自定义工具', async () => {
    const { custom, listSpy } = await listTools(false);
    expect(listSpy).not.toHaveBeenCalled();
    expect(custom).toEqual([]);
  });

  it('flag=true:照常列出(正对照,证明探针接上了)', async () => {
    const { custom, listSpy } = await listTools(true);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(custom.map((t: any) => t.name)).toEqual(['zz_probe']);
  });
});
