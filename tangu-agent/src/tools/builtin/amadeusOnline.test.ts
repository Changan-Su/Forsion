import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpBrain } from '../../adapters/standalone/httpBrain.js';
import { pinAmadeusVault, verifyAmadeusNotes } from '../../core/amadeusVault.js';
import { createTanguProfile } from '../../profiles/index.js';
import { defaultPromptSections } from '../../profiles/promptSections.js';
import { standInReadDenied, standInSearchDenied, standInWriteDenied } from '../../services/accessDomain.js';
import { inVaultDb } from '../../services/amadeusDb.js';
import { advanceSelfCursors } from '../../services/automation.js';
import { evaluateTriggers, type MuseTrigger } from '../../services/museTriggers.js';
import { listDeferredTools } from '../registry.js';
import { resolveNoteRef } from '../../services/museStarters.js';
import { currentRunAmadeusVault, enterRunContext, setRunAmadeusVault } from '../../seams/runContext.js';
import { configureTangu } from '../../seams/runtime.js';
import { humanDir } from '../../core/tanguHome.js';
import type { ToolContext } from '../toolTypes.js';
import { amadeusProvider, amadeusVaultPath, localCalendarRows } from './amadeus.js';

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
let cloudFileId: string | undefined;
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
  return verifyAmadeusNotes(pinAmadeusVault(generation, cloud.amadeus), cloud.amadeus);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'amadeus-online-'));
  local = path.join(tmp, 'local');
  const userData = path.join(tmp, 'userData');
  mkdirSync(userData);
  config = path.join(userData, 'amadeus-config.json');
  mkdirSync(local);
  writeFileSync(path.join(local, 'entry.md'), 'local only');
  vi.stubEnv('FORSION_AMADEUS_CONFIG', config);
  vi.stubEnv('FORSION_AMADEUS_VAULT', undefined);
  vi.stubEnv('TANGU_HOME', path.join(tmp, 'forsion', 'tangu'));
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
    if (url.pathname.endsWith('/file') && method === 'GET') return cloudFileId
      ? Response.json({ id: cloudFileId, content: cloudContent, seq: cloudSeq })
      : Response.json({ detail: 'file not found' }, { status: 404 });
    if (url.pathname.endsWith('/file') && method === 'PUT') {
      if ((body.baseSeq !== cloudSeq || body.expectedFileId !== cloudFileId) && !body.force) return Response.json({ seq: cloudSeq, content: cloudContent }, { status: 409 });
      cloudContent = body.content;
      cloudFileId ??= 'new-file-id';
      return Response.json({ seq: ++cloudSeq });
    }
    return new Response(null, { status: 404 });
  }));
  configureTangu({ profile, brain: cloud, host: {} as never, billing: {} as never });
});

afterEach(() => {
  enterRunContext('');
  vi.restoreAllMocks();
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
    expect(visible(context(vault)).filter(name => noteTools.includes(name))).toEqual([]);
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
    expect(visible(ctx).filter(name => noteTools.includes(name))).toEqual(noteTools);
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
    expect(visible(ctx).filter(name => noteTools.includes(name))).toEqual([]);
    expect(visible(context(vault, 'sandbox'))).toEqual([]);
    for (const name of noteTools) expect(await named(name).execute({ path: 'entry.md' }, ctx)).toContain('not available');
    expect(requests.map(r => r.path)).toEqual(['/api/amadeus/libraries']);
  });

  it.each([
    { vaultId: 'default', libraryId: 'default' },
    { libraryId: `${defaultId}:Amadeus/Lab/`, vaultId: defaultId, prefix: 'Amadeus/Lab/' },
  ])('does not attempt a request for an alias or original-location library', async (override) => {
    writeConfig({ ...ref, ...override });
    expect(visible(context(await pin())).filter(name => noteTools.includes(name))).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('does not fall back to local or default notes when the library list is unavailable', async () => {
    writeConfig(ref);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const vault = await pin();
    expect(vault.kind).toBe('online');
    expect(amadeusVaultPath(context(vault))).toBeNull();
    expect(visible(context(vault)).filter(name => noteTools.includes(name))).toEqual([]);
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
    await named(noteTools[1]).execute({ path: 'entry.md' }, ctx);
    const write = () => named('amadeus_write_note').execute({ path: 'entry.md', content: 'requested edit' }, ctx);
    expect(await write()).toContain('Read it again');
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

  it.each(['changed sequence', 'recreated identity'])('review P0-1: uses the model read ticket after %s', async (change) => {
    writeConfig(ref);
    const ctx = context(await pin());
    const read = () => named(noteTools[1]).execute({ path: 'entry' }, ctx);
    const write = () => named(noteTools[2]).execute({ path: 'entry.md', content: 'model edit' }, ctx);
    expect(await read()).toBe('online only');
    cloudContent = 'user edit';
    if (change === 'changed sequence') cloudSeq++;
    else cloudFileId = 'replacement-file';
    expect(await write()).toContain('Read it again');
    expect(cloudContent).toBe('user edit');
    expect(requests.filter(r => r.method === 'PUT')).toHaveLength(1);
    expect(requests.at(-1)?.body).toMatchObject({ baseSeq: 3, expectedFileId: 'file-id' });
    expect(await write()).toContain('Read this note');
    expect(requests.filter(r => r.method === 'PUT')).toHaveLength(1);
    expect(await read()).toBe('user edit');
    expect(await write()).toBe('Saved note entry.md.');
  });

  it('requires a ticket from this run for an overwrite, while permitting creation', async () => {
    writeConfig(ref);
    const priorRun = context(await pin('another-run'));
    const ctx = context(await pin());
    await named(noteTools[1]).execute({ path: 'entry.md' }, priorRun);
    const write = () => named(noteTools[2]).execute({ path: 'entry.md', content: 'new text' }, ctx);
    expect(await write()).toContain('Read this note');
    expect(requests.some(r => r.method === 'PUT')).toBe(false);
    cloudFileId = undefined;
    cloudSeq = 0;
    expect(await write()).toBe('Saved note entry.md.');
    expect(requests.at(-1)?.body).toEqual({ path: 'entry.md', content: 'new text', baseSeq: 0 });
  });

  it.each([
    '---\ntags: [important]\n---\n<!-- a card1 -->\nBody',
    'Body\n<!-- a card1 -->',
    '---\ntags: [important]\n---\nBody',
    'amadeus_layout: columns\nBody',
  ])('review P0-2: rejects replacing a note with metadata (%#)', async (original) => {
    writeConfig(ref);
    const ctx = context(await pin());
    cloudContent = original;
    await named(noteTools[1]).execute({ path: 'entry.md' }, ctx);
    expect(await named(noteTools[2]).execute({ path: 'entry.md', content: 'Body plus a line' }, ctx))
      .toContain('cannot currently be overwritten online');
    expect(requests.some(r => r.method === 'PUT')).toBe(false);
    expect(cloudContent).toBe(original);
  });

  it('review P0-3: rejects missing or non-string content and accepts an explicit empty string', async () => {
    writeConfig(ref);
    const ctx = context(await pin());
    await named(noteTools[1]).execute({ path: 'entry.md' }, ctx);
    for (const content of [{}, { content: null }, { content: 1 }, { content: false }, { content: {} }]) {
      expect(await named(noteTools[2]).execute({ path: 'entry.md', ...content }, ctx)).toContain('content must be a string');
    }
    expect(requests.some(r => r.method === 'PUT')).toBe(false);
    expect(cloudContent).toBe('online only');
    expect(await named(noteTools[2]).execute({ path: 'entry.md', content: '' }, ctx)).toBe('Saved note entry.md.');
    expect(cloudContent).toBe('');
  });

  it('review P0-5: takes the explicit root on account mismatch but leaves unreadable settings unknown', async () => {
    const explicit = path.join(tmp, 'explicit');
    vi.stubEnv('FORSION_AMADEUS_VAULT', explicit);
    mkdirSync(explicit);
    const table = {
      version: 1, name: 'Work',
      columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }],
      rows: [{ id: 'meeting', cells: { name: 'Original', date: '2026-11-28T11:00' } }],
    };
    for (const root of [local, explicit]) writeFileSync(path.join(root, 'Shared.db'), JSON.stringify(table));
    writeConfig({ ...ref, account: '1'.repeat(64) });
    const vault = await pin();
    await named('amadeus_edit_event').execute({ calendar: 'Shared.db', eventId: 'meeting', title: 'Updated' }, context(vault));
    expect(JSON.parse(readFileSync(path.join(local, 'Shared.db'), 'utf8'))).toEqual(table);
    expect(JSON.parse(readFileSync(path.join(explicit, 'Shared.db'), 'utf8')).rows[0].cells.name).toBe('Updated');
    expect(vault).toMatchObject({ kind: 'local', root: explicit });
    writeFileSync(config, '{');
    expect(await pin()).toMatchObject({ kind: 'none' });
  });

  it.each(['online', 'unreadable', 'missing local directory'])('review P1-7: keeps the default calendar without a local vault (%s)', async (selection) => {
    if (selection === 'online') writeConfig(ref);
    else if (selection === 'unreadable') writeFileSync(config, '{');
    else writeConfig(null, path.join(tmp, 'not-present'));
    const legacy = path.join(local, 'Calendar.db');
    vi.stubEnv('FORSION_DEFAULT_CALENDAR', legacy);
    const db = {
      version: 1, name: 'Calendar', columns: [{ id: 'title', name: 'Title', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }],
      rows: [{ id: 'reminder', cells: { title: 'Reminder', date: '2026-11-28T11:00' } }],
    };
    writeFileSync(legacy, JSON.stringify({ ...db, rows: [] }));
    mkdirSync(humanDir(), { recursive: true });
    writeFileSync(path.join(humanDir(), 'CALENDAR.db'), JSON.stringify(db));
    const vault = await pin();
    const ctx = context(vault);
    const root = amadeusVaultPath(ctx);
    expect(visible(ctx)).toContain('amadeus_list_calendars');
    const outCursors = {};
    const trigger: MuseTrigger = {
      id: 'before', desc: 'Remind me', enabled: true, cooldownHours: 0, lastFiredAt: null, createdAt: '2026-01-01T00:00:00.000Z',
      cond: { type: 'calendar.before', params: { minutes: 10 } },
    };
    expect(await evaluateTriggers([trigger], { currentVault: root, now: new Date(2026, 10, 28, 10, 55), outCursors }))
      .toMatchObject([{ id: 'before' }]);
    expect(outCursors).toMatchObject({ before: { hash: 'human://CALENDAR.db#reminder' } });
    const calendars = JSON.parse(await named('amadeus_list_calendars').execute({}, ctx));
    expect(calendars.map((calendar: any) => calendar.path)).toEqual(['human://CALENDAR.db']);
    await named('amadeus_create_event').execute({ title: 'Second', start: '2026-11-28T12:00' }, ctx);
    expect(await localCalendarRows(null)).toHaveLength(2);
    expect(JSON.parse(readFileSync(legacy, 'utf8')).rows).toEqual([]);
  });

  it('review P1-9: guards the pinned root, a newly selected root and the explicit root during a read failure', async () => {
    const next = path.join(tmp, 'next');
    const third = path.join(tmp, 'explicit');
    mkdirSync(next);
    mkdirSync(third);
    writeConfig(null);
    enterRunContext('u', 'run-1');
    setRunAmadeusVault(await pin());
    const standIn = { slug: 'helper', bodySlug: 'main', agentMd: false, library: [], roots: [tmp] };
    expect(standInReadDenied(standIn, path.join(next, 'entry.md'))).toBeNull();
    writeConfig(null, next);
    for (const directory of [local, next]) {
      expect(standInReadDenied(standIn, path.join(directory, 'entry.md'))).not.toBeNull();
      expect(standInWriteDenied(standIn, path.join(directory, 'entry.md'))).not.toBeNull();
      expect(standInSearchDenied(standIn, directory)).not.toBeNull();
    }
    vi.stubEnv('FORSION_AMADEUS_VAULT', third);
    writeFileSync(config, '{');
    for (const directory of [local, next, third]) {
      expect(standInReadDenied(standIn, path.join(directory, 'entry.md'))).not.toBeNull();
    }
  });

  it.each([
    ['HTML', () => new Response('<html>gateway error</html>')],
    ['old sequence', () => Response.json({ seq: 3 })],
    ['non-numeric sequence', () => Response.json({ seq: '4' })],
  ] as const)('review P1-10: reports an unconfirmed save for %s', async (_label, receipt) => {
    writeConfig(ref);
    const ctx = context(await pin());
    await named(noteTools[1]).execute({ path: 'entry.md' }, ctx);
    const fetchBefore = fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => init?.method === 'PUT' ? receipt() : fetchBefore(input, init)));
    await expect(named(noteTools[2]).execute({ path: 'entry.md', content: 'model edit' }, ctx))
      .rejects.toThrow('Save result unconfirmed');
    expect(cloudContent).toBe('online only');
  });

  it('review P1-11: closes the scoped note facet at the five-second library deadline', async () => {
    writeConfig(ref);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const request = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', request);
    const pinned = pinAmadeusVault('run-1', cloud.amadeus);
    const verifying = verifyAmadeusNotes(pinned, cloud.amadeus);
    expect(pinned.kind).toBe('online');
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
    deadline.abort();
    const verified = await verifying;
    expect(verified).toBe(pinned);
    expect(visible(context(verified)).filter(name => noteTools.includes(name))).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
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
