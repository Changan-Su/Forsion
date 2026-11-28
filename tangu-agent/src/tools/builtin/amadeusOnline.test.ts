import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpBrain } from '../../adapters/standalone/httpBrain.js';
import { pinAmadeusVault } from '../../core/amadeusVault.js';
import { createTanguProfile } from '../../profiles/index.js';
import { defaultPromptSections } from '../../profiles/promptSections.js';
import { standInReadDenied, standInSearchDenied, standInWriteDenied } from '../../services/accessDomain.js';
import { inVaultDb } from '../../services/amadeusDb.js';
import { advanceSelfCursors } from '../../services/automation.js';
import { listDeferredTools } from '../registry.js';
import { resolveNoteRef } from '../../services/museStarters.js';
import { currentRunAmadeusVault, enterRunContext, setRunAmadeusVault } from '../../seams/runContext.js';
import { configureTangu } from '../../seams/runtime.js';
import type { ToolContext } from '../toolTypes.js';
import { amadeusProvider, amadeusVaultPath } from './amadeus.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const tools = amadeusProvider.tools();
const noteTools = ['amadeus_list_notes', 'amadeus_read_note', 'amadeus_write_note'];
const vaultId = 'abc123';
const defaultId = 'default-real-id';
const cloudUrl = 'https://cloud.test';
const jwt = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.y`;
let tmp: string;
let local: string;
let config: string;
let token: string;
let requests: Array<{ path: string; caps: string | null; method: string; body: unknown }>;
let cloudContent: string;
let cloudSeq: number;
let cloudFileId: string;
let cloud: ReturnType<typeof createHttpBrain>;
let ref: { kind: 'online'; account: string; libraryId: string; vaultId: string; prefix: string; name: string };

function writeConfig(activeVault: unknown, root = local) {
  writeFileSync(config, JSON.stringify({ lastVault: root, activeVault }));
}
function context(amadeusVault?: ToolContext['amadeusVault'], execMode: ToolContext['execMode'] = 'host') {
  return { execMode, amadeusVault } as ToolContext;
}
function visible(ctx: ToolContext) {
  return tools.filter(tool => tool.isEnabledFor?.(profile, ctx)).map(tool => tool.name);
}
function named(name: string) {
  return tools.find(tool => tool.name === name)!;
}
function pin(generation = 'run-1') {
  return pinAmadeusVault(generation, cloud.amadeus);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'amadeus-online-'));
  local = path.join(tmp, 'local');
  config = path.join(tmp, 'amadeus-config.json');
  mkdirSync(local);
  writeFileSync(path.join(local, 'entry.md'), 'local only');
  vi.stubEnv('FORSION_AMADEUS_CONFIG', config);
  vi.stubEnv('FORSION_AMADEUS_VAULT', undefined);
  vi.stubEnv('TANGU_HOME', path.join(tmp, 'tangu'));
  token = jwt('u-1');
  cloud = createHttpBrain({ cloudUrl, token: () => token });
  ref = { kind: 'online', account: cloud.amadeus!.accountNamespace!()!, libraryId: vaultId, vaultId, prefix: 'Amadeus/', name: 'Work' };
  requests = [];
  cloudContent = 'online only';
  cloudSeq = 3;
  cloudFileId = 'file-id';
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.origin !== cloudUrl) throw new Error('Unexpected cloud origin');
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ path: url.pathname, caps: headers.get('X-Content-Caps'), method, body });
    if (url.pathname === '/api/amadeus/libraries') {
      return Response.json({ libraries: [
        { id: vaultId, kind: 'own', vaultId, prefix: 'Amadeus/' },
        { id: defaultId, kind: 'default', vaultId: defaultId, prefix: 'Amadeus/' },
      ] });
    }
    if (url.pathname.endsWith('/tree')) return Response.json({ pages: ['entry.md'], files: [] });
    if (url.pathname.endsWith('/file') && method === 'GET') return Response.json({ id: cloudFileId, content: cloudContent, seq: cloudSeq });
    if (url.pathname.endsWith('/file') && method === 'PUT') {
      if ((body.baseSeq !== cloudSeq || body.expectedFileId !== cloudFileId) && !body.force) return Response.json({ seq: cloudSeq, content: cloudContent }, { status: 409 });
      cloudContent = body.content;
      return Response.json({ seq: ++cloudSeq });
    }
    return new Response(null, { status: 404 });
  }));
  configureTangu({ profile, brain: cloud, host: {} as never, billing: {} as never });
});

afterEach(() => {
  enterRunContext('');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('managed Amadeus selection', () => {
  it.each(['missing', 'empty', 'truncated', 'array', 'bad ref'])('does not use a default or local vault when config is %s', async (shape) => {
    if (shape === 'empty') writeFileSync(config, '');
    if (shape === 'truncated') writeFileSync(config, '{');
    if (shape === 'array') writeFileSync(config, '[]');
    if (shape === 'bad ref') writeConfig({ ...ref, prefix: 'Amadeus/../' });
    const vault = await pin();
    expect(vault.kind).toBe('none');
    expect(amadeusVaultPath(context(vault))).toBeNull();
    expect(visible(context(vault))).toEqual([]);
    expect(visible(context(vault, 'sandbox'))).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('uses lastVault for a different account, and keeps the CLI fallback without a managed config', async () => {
    writeConfig({ ...ref, account: '1'.repeat(64) });
    expect(await pin()).toMatchObject({ kind: 'local', root: local });
    vi.stubEnv('FORSION_AMADEUS_CONFIG', undefined);
    expect(amadeusVaultPath()).toBe(path.join(os.homedir(), 'Forsion', 'Amadeus'));
    expect(requests).toEqual([]);
  });

  it('keeps managed online and unreadable selections authoritative even with a CLI root set', async () => {
    vi.stubEnv('FORSION_AMADEUS_VAULT', path.join(tmp, 'explicit'));
    writeConfig(ref);
    expect(await pin()).toMatchObject({ kind: 'online' });
    writeFileSync(config, '{');
    expect(await pin()).toMatchObject({ kind: 'none' });
  });

  it('pins the local selection even when a config change happens before a same-run reentry', async () => {
    writeConfig(null);
    enterRunContext('u', 'run-1');
    const selected = await pin();
    setRunAmadeusVault(selected);
    writeConfig(ref, path.join(tmp, 'other'));
    enterRunContext('u', 'run-1', 'notes');
    expect(currentRunAmadeusVault()).toBe(selected);
    expect(amadeusVaultPath()).toBe(local);
    expect(await named('amadeus_list_notes').execute({}, context(selected))).toBe('- entry.md');
    enterRunContext('u', 'run-2');
    expect(currentRunAmadeusVault()).toBeUndefined();
    expect(await pin('run-2')).toMatchObject({ kind: 'online', generation: 'run-2' });
  });

  it('uses only the pinned independent library for listing, reading and writing', async () => {
    writeConfig(ref);
    const vault = await pin();
    writeConfig(null); // Tools must keep using the pinned route, even outside the original ALS.
    const ctx = context(vault);
    expect(amadeusVaultPath(ctx)).toBeNull();
    expect(visible(ctx)).toEqual(noteTools);
    expect(named('amadeus_read_note').definitionFor?.(ctx).function.description).toContain('current online');
    const deferred = listDeferredTools({ ...ctx, preset: 'chat' });
    expect(deferred.find(tool => tool.name === 'amadeus_read_note')?.hint).toContain('current online');
    expect(defaultPromptSections({ execMode: 'host', amadeusVault: vault }).environment.join('\n'))
      .toContain('The current Amadeus library is "Work" (online). You cannot run commands');
    expect(defaultPromptSections({ execMode: 'host', amadeusVault: vault }).environment.join('\n')).not.toContain(local);
    expect(await named(noteTools[0]).execute({}, ctx)).toBe('- entry.md');
    expect(await named(noteTools[1]).execute({ path: 'entry.md' }, ctx)).toBe('online only');
    expect(await named(noteTools[2]).execute({ path: 'entry.md', content: 'edited online' }, ctx)).toBe('Saved note entry.md.');
    expect(cloudContent).toBe('edited online');
    expect(readFileSync(path.join(local, 'entry.md'), 'utf8')).toBe('local only');
    expect(requests.map(r => r.path)).toEqual([
      '/api/amadeus/libraries', `/api/amadeus/vaults/${vaultId}/tree`,
      ...Array(3).fill(`/api/amadeus/vaults/${vaultId}/file`),
    ]);
    expect(requests.every(r => r.caps === 'vaults')).toBe(true);
    expect(requests.at(-1)?.body).toMatchObject({ baseSeq: 3, expectedFileId: cloudFileId });
  });

  it('does not enable notes for the real default UUID or touch its tree or files', async () => {
    writeConfig({ ...ref, vaultId: defaultId, libraryId: defaultId });
    const vault = await pin();
    expect(vault.kind).toBe('online');
    const ctx = context(vault);
    expect(visible(ctx)).toEqual([]);
    expect(visible(context(vault, 'sandbox'))).toEqual([]);
    for (const name of noteTools) expect(await named(name).execute({ path: 'entry.md' }, ctx)).toContain('not available');
    expect(requests.map(r => r.path)).toEqual(['/api/amadeus/libraries']);
  });

  it.each([
    { vaultId: 'default', libraryId: 'default' },
    { libraryId: `${defaultId}:Amadeus/Lab/`, vaultId: defaultId, prefix: 'Amadeus/Lab/' },
  ])('does not attempt a request for an alias or original-location library', async (override) => {
    writeConfig({ ...ref, ...override });
    expect(visible(context(await pin()))).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('does not fall back to local or default notes when the library list is unavailable', async () => {
    writeConfig(ref);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const vault = await pin();
    expect(vault.kind).toBe('online');
    expect(amadeusVaultPath(context(vault))).toBeNull();
    expect(visible(context(vault))).toEqual([]);
  });

  it('rejects an online request after the credential changes account', async () => {
    writeConfig(ref);
    const ctx = context(await pin());
    token = jwt('u-2');
    await expect(named('amadeus_read_note').execute({ path: 'entry.md' }, ctx)).rejects.toThrow('account changed');
    expect(requests.map(r => r.path)).toEqual(['/api/amadeus/libraries']);
  });

  it('rejects a conflicted write and skips PUT when its preflight had an unknown failure', async () => {
    writeConfig(ref);
    const ctx = context(await pin());
    const fetchBefore = fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        cloudContent = 'edited by someone else';
        cloudFileId = 'replacement-file-id';
      }
      return fetchBefore(input, init);
    }));
    const write = () => named('amadeus_write_note').execute({ path: 'entry.md', content: 'requested edit' }, ctx);
    await expect(write()).rejects.toThrow('write conflict');
    expect(cloudContent).toBe('edited by someone else');
    const unknown = vi.fn(async () => Response.json({ detail: 'vault not found' }, { status: 404 }));
    vi.stubGlobal('fetch', unknown);
    await expect(write()).rejects.toThrow('read 404');
    expect(unknown).toHaveBeenCalledTimes(1);
  });

  it('keeps the last local root in the stand-in deny rules only', async () => {
    writeConfig(ref);
    enterRunContext('u', 'run-1');
    setRunAmadeusVault(await pin());
    const standIn = { slug: 'helper', bodySlug: 'main', agentMd: false, library: [], roots: [tmp] };
    const note = path.join(local, 'entry.md');
    expect(standInReadDenied(standIn, note)).toContain('Access denied');
    expect(standInWriteDenied(standIn, note)).toContain('Access denied');
    expect(standInSearchDenied(standIn, tmp)).toContain('Access denied');
    expect(resolveNoteRef('entry.md')).toBeNull();
    expect(resolveNoteRef(note)).toBe(note); // An explicit local media/source path remains usable.
    await expect(inVaultDb('table.db')).rejects.toThrow('No local Amadeus vault');
  });

  it('does not advance automation cursors without a local vault', async () => {
    const loadTriggers = vi.fn();
    const loadCursors = vi.fn();
    const setCursors = vi.fn();
    await advanceSelfCursors({ rule: { 'Table.db': { addedIds: ['row-1'], edited: [] } } }, {
      currentVault: null, loadTriggers, loadCursors, setCursors,
    });
    expect(loadTriggers).not.toHaveBeenCalled();
    expect(loadCursors).not.toHaveBeenCalled();
    expect(setCursors).not.toHaveBeenCalled();
  });

  it('keeps the Worker descriptions, default-vault paths, and force write', async () => {
    vi.stubEnv('FORSION_AMADEUS_CONFIG', undefined);
    const ctx = context(undefined, 'sandbox');
    expect(visible(ctx)).toEqual(expect.arrayContaining(noteTools));
    const write = named('amadeus_write_note');
    expect(write.definitionFor?.(ctx)).toEqual(write.definition);
    await write.execute({ path: 'entry.md', content: 'worker edit' }, ctx);
    expect(requests).toEqual([
      { path: '/api/amadeus/vaults/default/file', method: 'GET', caps: null, body: null },
      { path: '/api/amadeus/vaults/default/file', method: 'PUT', caps: null, body: { path: 'entry.md', content: 'worker edit', force: true } },
    ]);
  });
});
