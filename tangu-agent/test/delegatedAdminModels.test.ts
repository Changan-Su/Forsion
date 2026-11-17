/**
 * GET /agent/models 在委托管理员来路下去掉 directProviders[].baseUrl(中转站地址偶尔把凭据写进 URL);
 * 本机 / 普通隧道 / 角色头没有有效标记时原样。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/delegatedAdminModels.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import modelsRouter, { withoutBaseUrl } from '../src/routes/models.js';

const MARK = 'models-mark-secret';
const RELAY = 'https://user:secret@relay.example/v1';
const ADMIN = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK, 'x-forsion-remote-role': 'delegated-admin' };
const TUNNEL = { 'x-forsion-remote': 'tunnel', 'x-forsion-remote-mark': MARK };
let srv: Server;
let base: string;
const prevMark = process.env.TANGU_REMOTE_MARK_SECRET;

beforeAll(() => {
  process.env.TANGU_REMOTE_MARK_SECRET = MARK;
  const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  const brain = {
    models: {
      listGlobalModels: async () => [{ id: 'cloud-1', name: 'Cloud 1' }],
      listDirectProviders: () => [{ providerId: 'relay', baseUrl: RELAY, modelIds: ['m1'] }],
    },
    users: { getUserById: async () => ({ id: 'u1' }) },
  };
  configureTangu({ host, brain: brain as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  const app = express(); app.use(express.json()); app.use(modelsRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  if (prevMark === undefined) delete process.env.TANGU_REMOTE_MARK_SECRET; else process.env.TANGU_REMOTE_MARK_SECRET = prevMark;
});

const get = async (headers: Record<string, string>) => {
  const r = await fetch(`${base}/agent/models`, { headers: { Authorization: 'Bearer x', ...headers } });
  return { status: r.status, raw: await r.text() };
};

describe('GET /agent/models · directProviders[].baseUrl', () => {
  it('委托管理员:去掉 baseUrl,其余字段照旧(模型清单里仍有直连模型)', async () => {
    const r = await get(ADMIN);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.raw);
    expect(r.raw).not.toContain('relay.example');
    expect(body.directProviders).toEqual([{ providerId: 'relay', modelIds: ['m1'] }]);
    expect(body.models.some((m: any) => m.id === 'relay/m1')).toBe(true);
  });
  it('本机 / 普通隧道 / 标记不对的角色头:原样带 baseUrl', async () => {
    for (const h of [{}, TUNNEL, { ...ADMIN, 'x-forsion-remote-mark': 'forged' }, { ...ADMIN, 'x-forsion-remote': 'lan' }]) {
      const body = JSON.parse((await get(h)).raw);
      expect(body.directProviders[0].baseUrl).toBe(RELAY);
    }
  });
  it('withoutBaseUrl 不碰非数组 / 非对象项', () => {
    expect(withoutBaseUrl(undefined)).toBeUndefined();
    expect(withoutBaseUrl([null, { providerId: 'a', baseUrl: 'x' }])).toEqual([null, { providerId: 'a' }]);
  });
});
