/**
 * 后台进程三条路由(摘要栏「后台」卡):真 express + 真路由 + 真后台进程 + 内存 SQLite。
 *   - 地址识别:vite 那种带色码、绑 0.0.0.0 的输出 → url 归一成 http://localhost:5173/;最后一行剥色码
 *   - 归属:别人的会话不出现在列表里,output / kill 一律 404
 *   - 用户停止:不走审批,直接停;停了 url 不再给
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { query } from '../src/core/db.js';
import processesRouter from '../src/routes/processes.js';
import { startBackgroundProcess, disposeAllProcesses, detectLocalUrl, lastLine, type BackgroundProcess } from '../src/tools/processRegistry.js';

const USER = 'u1';
const AUTH = { Authorization: 'Bearer x' };
let home: string;
let srv: Server;
let base: string;

const get = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { headers: AUTH });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (path: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: AUTH });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const start = (sid: string, cmd: string): BackgroundProcess => {
  const r = startBackgroundProcess(sid, cmd, process.cwd());
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const until = async (fn: () => boolean, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 30));
  }
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-process-routes-'));
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = { users: { getUserById: async () => ({ id: USER, username: 'u' }) }, models: { hasDirectModel: () => false } };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('MINE', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('THEIRS', 'u2', 'tangu', 't', 'm1', 'user')`);
  const app = express();
  app.use(express.json());
  app.use(processesRouter);
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  delete process.env.TANGU_HOME;
  rmSync(home, { recursive: true, force: true });
});
afterEach(() => disposeAllProcesses());

describe('detectLocalUrl / lastLine', () => {
  it('strips colour codes and normalises the host', () => {
    const vite = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://0.0.0.0:\x1b[1m5173\x1b[22m/\x1b[39m';
    expect(detectLocalUrl(vite)).toBe('http://localhost:5173/');
    expect(detectLocalUrl('listening on http://127.0.0.1:8080')).toBe('http://localhost:8080');
    expect(detectLocalUrl('see https://example.com')).toBeNull();
  });
  it('streamed output: an address cut off mid-port or mid-colour-code is not taken yet', () => {
    expect(detectLocalUrl('Local: http://localhost:', true)).toBeNull();
    expect(detectLocalUrl('Local: http://0.0.0.0:\x1b[1', true)).toBeNull();
    expect(detectLocalUrl('Local: http://localhost:5173/\n', true)).toBe('http://localhost:5173/');
  });
  it('last non-empty line, carriage-return progress split', () => {
    expect(lastLine('a\nb\n\n')).toBe('b');
    expect(lastLine('10%\r50%\r\x1b[32m100%\x1b[0m')).toBe('100%');
  });
});

describe('process routes', () => {
  it('lists own sessions only, with the detected url and last line', async () => {
    const mine = start('MINE', `node -e "console.log('\\x1b[36mhttp://0.0.0.0:5173/\\x1b[39m'); console.log('ready'); setInterval(() => {}, 1000)"`);
    start('THEIRS', `node -e "setInterval(() => {}, 1000)"`);
    await until(() => mine.url !== undefined && mine.output.includes('ready'));
    const r = await get('/agent/processes');
    expect(r.status).toBe(200);
    expect(r.body.processes.map((p: any) => p.sessionId)).toEqual(['MINE']);
    expect(r.body.processes[0]).toMatchObject({ id: mine.id, status: 'running', url: 'http://localhost:5173/', last: 'ready' });
  });

  it('output and kill are 404 for someone else\'s session', async () => {
    const theirs = start('THEIRS', `node -e "setInterval(() => {}, 1000)"`);
    expect((await get(`/agent/sessions/THEIRS/processes/${theirs.id}/output`)).status).toBe(404);
    expect((await post(`/agent/sessions/THEIRS/processes/${theirs.id}/kill`)).status).toBe(404);
    // 会话对、进程不属于它 → 也是 404
    expect((await get(`/agent/sessions/MINE/processes/${theirs.id}/output`)).status).toBe(404);
    expect(theirs.status).toBe('running');
  });

  it('user stop kills without approval and drops the url', async () => {
    const p = start('MINE', `node -e "console.log('http://localhost:4321'); setInterval(() => {}, 1000)"`);
    await until(() => !!p.url);
    const out = await get(`/agent/sessions/MINE/processes/${p.id}/output`);
    expect(out.body.output).toContain('http://localhost:4321');
    const k = await post(`/agent/sessions/MINE/processes/${p.id}/kill`);
    expect(k.status).toBe(200);
    expect(k.body).toMatchObject({ status: 'killed', url: null });
    await until(() => p.child === null);
  });
});
