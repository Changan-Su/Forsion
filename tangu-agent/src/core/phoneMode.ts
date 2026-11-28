/**
 * Phone mode: the engine runs inside the Forsion Android app ("This phone" run location), under PRoot on Ubuntu,
 * started by the app's native shell with `TANGU_PHONE=1`.
 *
 * What changes:
 * - Local HTTP auth accepts only the per-start local token (`TANGU_LOCAL_TOKEN`). The account token is still given
 *   to the engine (models, cloud features), but never doubles as the local credential: any other app on the phone
 *   can reach 127.0.0.1, and the account token is not a secret the native shell alone holds.
 * - Always-on background work a phone should not carry by default: the Muse patrol (5-minute supervisor + beats;
 *   `config.json` `phone.musePatrol: true` turns it back on), inbox polling, the Chrome extension bridge, and the
 *   Docker sandbox janitors (there is no Docker; they would spawn `docker ps` at every start).
 */
import { getRawSection } from './config.js';

export function phoneMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TANGU_PHONE === '1';
}

/** The credential local HTTP requests must present. Phone mode: the local token only, never the account token. */
export function localHostCredential(cfg: { localToken?: string; token?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (phoneMode(env)) return cfg.localToken || '';
  return cfg.localToken || cfg.token || '';
}

export interface BackgroundGates {
  muse: boolean;
  inbox: boolean;
  browserBridge: boolean;
  sandboxJanitors: boolean;
}

/** Which always-on background services start. Off the phone everything stays as it was. */
export function backgroundGates(env: NodeJS.ProcessEnv = process.env, phoneSection: unknown = phoneMode(env) ? getRawSection('phone') : undefined): BackgroundGates {
  if (!phoneMode(env)) return { muse: true, inbox: true, browserBridge: true, sandboxJanitors: true };
  const musePatrol = !!phoneSection && typeof phoneSection === 'object' && (phoneSection as { musePatrol?: unknown }).musePatrol === true;
  return { muse: musePatrol, inbox: false, browserBridge: false, sandboxJanitors: false };
}
