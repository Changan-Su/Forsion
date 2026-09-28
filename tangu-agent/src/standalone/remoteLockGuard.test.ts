/** P1 · K2 §3.4:引擎侧纵深防御 —— 锁定时远程来源的非只读请求(中止除外)一律 423,本机请求不受影响。 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteLockGuard } from './remoteLockGuard.js';
import { REMOTE_LOCK_FILE_ENV, __resetRemoteLatchForTests, latchRemoteLock } from '../services/remoteLock.js';

let dir: string;
let srv: Server;
let base: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tangu-guard-'));
  process.env[REMOTE_LOCK_FILE_ENV] = join(dir, 'remote-lock.json');
  __resetRemoteLatchForTests();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => remoteLockGuard(req, res, next));
  app.all(/.*/, (_req, res) => { res.json({ ok: true }); });
  srv = app.listen(0);
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterEach(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env[REMOTE_LOCK_FILE_ENV];
  __resetRemoteLatchForTests();
  rmSync(dir, { recursive: true, force: true });
});

const hit = async (method: string, path: string, remote: boolean): Promise<number> =>
  (await fetch(`${base}${path}`, { method, headers: remote ? { 'x-forsion-remote': 'tunnel', 'content-type': 'application/json' } : { 'content-type': 'application/json' }, ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }) })).status;
const lock = (): void => writeFileSync(process.env[REMOTE_LOCK_FILE_ENV]!, JSON.stringify({ v: 1, lock: { locked: true, at: 1, source: 'tray' }, hotkey: '' }));

describe('remoteLockGuard', () => {
  it('未锁:远程 / 本机一律放行', async () => {
    expect(await hit('POST', '/agent/runs', true)).toBe(200);
    expect(await hit('POST', '/agent/runs', false)).toBe(200);
  });

  it('锁定:远程 POST/PUT/PATCH/DELETE → 423 REMOTE_LOCKED;GET / HEAD 与中止放行;本机不受影响', async () => {
    lock();
    const r = await fetch(`${base}/agent/runs`, { method: 'POST', headers: { 'x-forsion-remote': 'p2p', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(423);
    expect(await r.json()).toEqual({ code: 'REMOTE_LOCKED', detail: expect.any(String) });
    for (const [m, p] of [['POST', '/agent/runs/x/approvals/a'], ['PUT', '/agent/sessions/s'], ['PATCH', '/agent/sessions/s'], ['DELETE', '/agent/runs/x/steer/m'], ['POST', '/agent/special/muse/todos/t/approve']]) {
      expect([m, p, await hit(m, p, true)]).toEqual([m, p, 423]);
    }
    expect(await hit('GET', '/agent/sessions', true)).toBe(200);
    expect(await hit('HEAD', '/agent/sessions', true)).toBe(200);
    expect(await hit('POST', '/agent/runs/abc/abort', true)).toBe(200);
    expect(await hit('POST', '/Agent/Runs/abc/ABORT/', true)).toBe(200);
    expect(await hit('POST', '/agent/runs/abc/abort/x', true)).toBe(423);
    expect(await hit('POST', '/agent/runs', false)).toBe(200);
  });

  it('闩也算锁;坏锁文件 fail closed', async () => {
    latchRemoteLock();
    expect(await hit('POST', '/agent/runs', true)).toBe(423);
    __resetRemoteLatchForTests();
    writeFileSync(process.env[REMOTE_LOCK_FILE_ENV]!, 'nope');
    expect(await hit('POST', '/agent/runs', true)).toBe(423);
  });
});
