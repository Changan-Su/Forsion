/**
 * Phone mode (TANGU_PHONE=1): the local token is the only local credential, and the always-on services a phone
 * should not carry stay off. setupHost runs against a real express app and an in-memory SQLite host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { backgroundGates, localHostCredential, phoneMode } from './phoneMode.js';
import { hostOriginHeaders } from './hostOrigin.js';
import { setupHost } from '../standalone/assemble.js';
import { validate, type StandaloneConfig } from '../standalone/config.js';

const baseCfg = (over: Partial<StandaloneConfig>): StandaloneConfig => ({
  cloudUrl: '', token: '', localToken: undefined, databaseUrl: '', dataDir: 'memory', defaultModelId: '', toolBuiltins: undefined,
  port: 0, host: '127.0.0.1', userId: 'local', sandbox: 'none', providers: [], providersFile: undefined,
  showHelp: false, showVersion: false, printConfig: false, ...over,
} as StandaloneConfig);

async function statusWith(cfg: StandaloneConfig, bearer: string): Promise<number> {
  const { host } = await setupHost(cfg);
  const app = express();
  app.get('/probe', host.authMiddleware, (_req, res) => { res.json({ ok: true }); });
  const srv: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const port = (srv.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/probe`, { headers: { Authorization: `Bearer ${bearer}` } });
    return r.status;
  } finally {
    srv.close();
  }
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('phone mode', () => {
  it('is off unless TANGU_PHONE=1', () => {
    expect(phoneMode({})).toBe(false);
    expect(phoneMode({ TANGU_PHONE: 'true' })).toBe(false);
    expect(phoneMode({ TANGU_PHONE: '1' })).toBe(true);
  });

  it('never falls back to the account token as the local credential', () => {
    expect(localHostCredential({ token: 'acct' }, {})).toBe('acct'); // desktop / standalone: unchanged
    expect(localHostCredential({ localToken: 'loc', token: 'acct' }, {})).toBe('loc');
    expect(localHostCredential({ token: 'acct' }, { TANGU_PHONE: '1' })).toBe('');
    expect(localHostCredential({ localToken: 'loc', token: 'acct' }, { TANGU_PHONE: '1' })).toBe('loc');
  });

  it('refuses to start without a local token', () => {
    vi.stubEnv('TANGU_PHONE', '1');
    expect(validate(baseCfg({ token: 'acct' }))).toEqual(['phone mode (TANGU_PHONE=1) requires TANGU_LOCAL_TOKEN']);
    expect(validate(baseCfg({ token: 'acct', localToken: 'loc' }))).toEqual([]);
    vi.unstubAllEnvs();
    expect(validate(baseCfg({ token: 'acct' }))).toEqual([]); // off the phone the account token still works
  });

  it('local HTTP: the account token gets 401, the local token passes', async () => {
    vi.stubEnv('TANGU_PHONE', '1');
    const cfg = baseCfg({ token: 'acct-token', localToken: 'local-token' });
    expect(await statusWith(cfg, 'acct-token')).toBe(401);
    expect(await statusWith(cfg, 'local-token')).toBe(200);
    expect(await statusWith(cfg, '')).toBe(401);
  });

  it('keeps Muse, inbox, the Chrome bridge and the Docker janitors off by default', () => {
    expect(backgroundGates({})).toEqual({ muse: true, inbox: true, browserBridge: true, sandboxJanitors: true });
    expect(backgroundGates({ TANGU_PHONE: '1' }, undefined)).toEqual({ muse: false, inbox: false, browserBridge: false, sandboxJanitors: false });
    expect(backgroundGates({ TANGU_PHONE: '1' }, { musePatrol: true }).muse).toBe(true);
    expect(backgroundGates({ TANGU_PHONE: '1' }, { musePatrol: 'yes' }).muse).toBe(false);
  });

  it('reports the device as android to the cloud', () => {
    expect(hostOriginHeaders({ TANGU_HOST_CLIENT: 'mobile/2.15.0', TANGU_PHONE: '1' }, 'linux')).toEqual({ 'X-Forsion-Client': 'mobile/2.15.0', 'X-Forsion-Env': 'android' });
    expect(hostOriginHeaders({ TANGU_HOST_CLIENT: 'desktop/2.15.0' }, 'linux')['X-Forsion-Env']).toBe('linux');
  });
});
