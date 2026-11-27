/**
 * Agents(及记忆)同步先封住(AGENT_SYNC_SEALED,2026-11-27 智库同步统一方案第 0 步)。
 * 封法:入口锁住、不再跑;存着的选择一个字不改;云端已有的那份不删;放开(常量改回 false)即原样恢复。
 * human/(「我的资料」与默认日历)照常同步:它的同意来自总闸或某个 Agent 的 shared,封的是动作,不是读数。
 * 负对照:常量临时改回 false,「Agent 文件夹不推不拉」与「删除记录不执行」两条应该红(交付时实跑过一次)。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import { prepareAgentFilesForRun, runAgentFilesSync } from '../src/services/agentFileSync.js';
import { setSyncSources, syncNow } from '../src/services/memorySyncService.js';
import { AGENT_SYNC_SEALED, agentSyncDefault, agentSyncPermission, agentSyncScope, setAgentSyncDefault, setAgentSyncPermission, setAgentSyncSharedOnly } from '../src/services/cloudSyncAccount.js';
import { deleteAgent, saveAgent } from '../src/agents/agentRegistry.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';
import { AgentFileConflictError, type AgentFilesBrain, type CloudBrainServices } from '../src/seams/cloudBrain.js';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import agentsRouter from '../src/routes/agents.js';
import memoryRouter from '../src/routes/memory.js';

/** 内存云端(seq / hash / CAS 与当前服务端一致),记下每次读写删。 */
function fakeCloud(paths: string[] = ['human', 'human-folder']) {
  const rows = new Map<string, any>();
  const calls: string[] = [];
  const key = (s: string, p: string) => `${s}\0${p}`;
  const put = (slug: string, relPath: string, content: string) => {
    const ex = rows.get(key(slug, relPath));
    rows.set(key(slug, relPath), { content, isBinary: false, mtimeMs: 1000, deleted: false, seq: (ex?.seq ?? 0) + 1, hash: createHash('sha256').update(content).digest('hex') });
  };
  const brain: AgentFilesBrain & { rows: typeof rows; calls: string[]; put: typeof put } = {
    rows, calls, put,
    async getManifest() {
      const bySlug = new Map<string, any[]>();
      for (const [k, r] of rows) {
        const [slug, relPath] = k.split('\0');
        bySlug.set(slug, [...(bySlug.get(slug) ?? []), { relPath, mtimeMs: r.mtimeMs, size: 0, isBinary: false, deleted: !!r.deleted, seq: r.seq, hash: r.hash }]);
      }
      return Object.assign([...bySlug.entries()].map(([slug, files]) => ({ slug, files })), { paths });
    },
    async getFile(_u, slug, relPath) {
      calls.push(`get ${slug}/${relPath}`);
      const r = rows.get(key(slug, relPath));
      if (!r) return null;
      if (r.deleted) return { isBinary: false, mtimeMs: r.mtimeMs, deleted: true, seq: r.seq, hash: null };
      return { content: r.content, isBinary: false, mtimeMs: r.mtimeMs, deleted: false, seq: r.seq, hash: r.hash };
    },
    async putFile(_u, slug, relPath, body) {
      calls.push(`put ${slug}/${relPath}`);
      const ex = rows.get(key(slug, relPath));
      const seq = ex && !ex.deleted ? ex.seq : 0;
      if (body.baseSeq !== undefined && body.baseSeq !== seq) throw new AgentFileConflictError({ code: body.baseSeq === 0 ? 'EXISTS' : 'CONFLICT', seq, hash: ex?.hash ?? null, mtimeMs: ex?.mtimeMs ?? 0, deleted: !!ex?.deleted });
      const hash = createHash('sha256').update(body.content ?? '').digest('hex');
      rows.set(key(slug, relPath), { ...body, seq: (ex?.seq ?? 0) + 1, hash, deleted: false });
      return { mtimeMs: body.mtimeMs, seq: (ex?.seq ?? 0) + 1, hash };
    },
    async deleteFile(_u, slug, relPath, mtimeMs) {
      calls.push(`delete ${slug}/${relPath}`);
      const ex = rows.get(key(slug, relPath));
      rows.set(key(slug, relPath), { mtimeMs, deleted: true, seq: (ex?.seq ?? 0) + 1, hash: null });
    },
  };
  return brain;
}
type Cloud = ReturnType<typeof fakeCloud>;
const HUMAN = new Set(['__human__', '__user__']);
/** 碰过的 Agent 槽位(human/ 与 USER.md 槽位之外的一切)。 */
const agentCalls = (cloud: Cloud) => cloud.calls.filter((c) => !HUMAN.has(c.split(' ')[1].split('/')[0]));
const calendarRows = (cloud: Cloud): string[] => JSON.parse(cloud.rows.get('__human__\0CALENDAR.db')?.content ?? '{"rows":[]}').rows.map((r: any) => r.id).sort();
const CAL = (ids: string[]) => `${JSON.stringify({ version: 2, name: 'Calendar', columns: [{ id: 'n', name: 'Name', type: 'text' }, { id: 'd', name: 'Date', type: 'calendarDate' }], rows: ids.map((id) => ({ id, cells: { n: `event ${id}`, d: '2026-11-27' } })) }, null, 2)}\n`;

/** agents/ 下所有同步状态文件(总闸、每个 Agent 的授权与影子、删除记录)和每个 config.toml 的原样字节。 */
function agentState(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.startsWith('.cloudsync') || name === 'config.toml' || dir.includes('.cloudsync-deleted')) out[relative(agentsDir(), full)] = readFileSync(full, 'utf8');
    }
  };
  walk(agentsDir());
  return out;
}
const agentFolder = (slug: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => { for (const name of readdirSync(dir)) { const full = join(dir, name); if (statSync(full).isDirectory()) walk(full); else out[relative(dir, full)] = readFileSync(full, 'utf8'); } };
  walk(join(agentsDir(), slug));
  return out;
};

let root = '';
let home = '';
const prev = { home: process.env.TANGU_HOME, cal: process.env.FORSION_DEFAULT_CALENDAR };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tangu-agent-seal-'));
  home = join(root, 'tangu');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'Vault'), { recursive: true });
  process.env.TANGU_HOME = home;
  process.env.FORSION_DEFAULT_CALENDAR = join(root, 'Vault', 'Calendar.db'); // 默认日历在测试自己的库里,不碰真实笔记库
});
afterEach(() => {
  if (prev.home === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev.home;
  if (prev.cal === undefined) delete process.env.FORSION_DEFAULT_CALENDAR; else process.env.FORSION_DEFAULT_CALENDAR = prev.cal;
  rmSync(root, { recursive: true, force: true });
});

/** 本机一个 Agent + 我的资料 + 默认日历;consent:human/ 的同意从哪来(账号总闸 / 只有这个 Agent 的 shared)。
 *  云端已经有这个 Agent 的一份资料、另一台设备的 Agent,和别处删掉的一个文件:封着时一样都不该拉下来。 */
async function seed(consent: 'master' | 'shared'): Promise<{ cloud: Cloud; scope: string }> {
  const cloud = fakeCloud();
  const scope = agentSyncScope(cloud, 'u')!;
  await saveAgent({ slug: 'writer', name: 'Writer', systemPrompt: 'fixture' });
  writeFileSync(join(agentsDir(), 'writer', 'SOUL.md'), 'local soul');
  writeFileSync(join(home, 'USER.md'), 'Name: Test User\n');
  writeFileSync(process.env.FORSION_DEFAULT_CALENDAR!, CAL(['r1', 'r2']));
  if (consent === 'master') setAgentSyncDefault(scope, true);
  else setAgentSyncPermission('writer', scope, true, true);
  cloud.put('writer', 'Library/from-cloud.md', 'cloud library');
  cloud.put('other-device', 'config.toml', 'name = "Other"\n');
  return { cloud, scope };
}

describe('sealed agent sync', () => {
  it('is on in this build', () => {
    expect(AGENT_SYNC_SEALED).toBe(true);
  });

  for (const consent of ['master', 'shared'] as const) {
    it(`runAgentFilesSync: no agent folder moves and nothing stored changes, human/ still syncs (consent: ${consent})`, async () => {
      const { cloud, scope } = await seed(consent);
      const before = agentState();
      const folder = agentFolder('writer');
      const r = await runAgentFilesSync(cloud, 'u');
      expect(r.error ?? '').toBe('');
      expect(r.agents).toBe(0);
      expect(agentCalls(cloud)).toEqual([]); // 不推、不拉、不删、不发现
      expect(agentFolder('writer')).toEqual(folder);
      expect(existsSync(join(agentsDir(), 'other-device'))).toBe(false);
      expect(agentState()).toEqual(before);
      expect(agentSyncPermission('writer', scope)).toEqual(expect.objectContaining({ enabled: true })); // 读数照实
      expect(calendarRows(cloud)).toEqual(['r1', 'r2']); // 默认日历照常上云(手机 / 网页靠它)
      expect(cloud.rows.get('__human__\0MEMORY.md')?.content).toContain('Test User');
    });
  }

  for (const consent of ['master', 'shared'] as const) it(`syncNow (POST /agent/sync): human/ syncs, agents and the old shared-memory store do not, stored consent unchanged (consent: ${consent})`, async () => {
    const { cloud } = await seed(consent);
    const memory = new Proxy({}, { get: (_t, name) => { if (name === 'then') return undefined; throw new Error(`historical memory store touched: ${String(name)}`); } });
    setSyncSources({ brain: { agentFiles: cloud, memory } as unknown as CloudBrainServices });
    const before = agentState();
    const r = await syncNow('u');
    expect(r.error ?? '').toBe('');
    expect(r.memory).toBe('skipped');
    expect(agentCalls(cloud)).toEqual([]);
    expect(agentState()).toEqual(before);
    expect(calendarRows(cloud)).toEqual(['r1', 'r2']);
  });

  for (const consent of ['master', 'shared'] as const) {
    it(`prepareAgentFilesForRun (start of a run): human/ syncs in the background, the agent folder does not (consent: ${consent})`, async () => {
      const { cloud } = await seed(consent);
      const before = agentState();
      expect((await prepareAgentFilesForRun(cloud, 'u', 'writer')).status).toBe('local');
      await vi.waitFor(() => expect(calendarRows(cloud)).toEqual(['r1', 'r2']));
      await runAgentFilesSync(cloud, 'u', { onlySlug: 'writer' }); // 同一账号的同步串行:等到后台那轮也跑完
      expect(agentCalls(cloud)).toEqual([]);
      expect(agentState()).toEqual(before);
    });
  }

  it('an agent removed in the app keeps its removal record and its cloud copy while sealed', async () => {
    const { cloud, scope } = await seed('master');
    await saveAgent({ slug: 'retired', name: 'Retired', systemPrompt: 'fixture' });
    cloud.put('retired', 'config.toml', 'name = "Retired"\n');
    cloud.put('retired', 'SOUL.md', 'cloud soul');
    expect(await deleteAgent('retired')).toBe(true);
    const record = join(agentsDir(), '.cloudsync-deleted', 'retired', scope);
    expect(existsSync(record)).toBe(true);
    const before = agentState();
    await runAgentFilesSync(cloud, 'u');
    expect(agentCalls(cloud)).toEqual([]);
    expect(cloud.rows.get('retired\0SOUL.md')?.deleted).toBe(false); // 云端那份不删
    expect(existsSync(record)).toBe(true); // 放开后照原样执行
    expect(existsSync(join(agentsDir(), 'retired'))).toBe(false); // 也不当成别处新建的拉回来
    expect(agentState()).toEqual(before);
  });
});

describe('setAgentSyncSharedOnly keeps enabled and follow exactly as stored', () => {
  const stored = (slug: string, scope: string) => JSON.parse(readFileSync(join(agentsDir(), slug, '.cloudsync-accounts.json'), 'utf8')).accounts[scope];
  const cases: Array<[string, (scope: string) => void, boolean]> = [
    ['no record, account switch on', (s) => setAgentSyncDefault(s, true), true],
    ['no record, account switch off', (s) => setAgentSyncDefault(s, false), false],
    ['no record, never decided', () => {}, false],
    ['set on by itself', (s) => setAgentSyncPermission('writer', s, true, false), true],
    ['set off by itself', (s) => setAgentSyncPermission('writer', s, false, false), false],
    // 总闸关的时候单独开着的改记成 follow;再把总闸开 / 关回来
    ['following the switch, switch on', (s) => { setAgentSyncPermission('writer', s, true, false); setAgentSyncDefault(s, false); setAgentSyncDefault(s, true); }, true],
    ['following the switch, switch off', (s) => { setAgentSyncPermission('writer', s, true, false); setAgentSyncDefault(s, false); }, false],
  ];
  for (const [name, arrange, enabled] of cases) {
    it(name, async () => {
      const cloud = fakeCloud();
      const scope = agentSyncScope(cloud, 'u')!;
      await saveAgent({ slug: 'writer', name: 'Writer', systemPrompt: 'fixture' });
      arrange(scope);
      const file = join(agentsDir(), 'writer', '.cloudsync-accounts.json');
      const recordFollow = (): boolean | null => { const rec = existsSync(file) ? stored('writer', scope) : undefined; return rec ? rec.follow === true : null; };
      const followBefore = recordFollow();
      expect(agentSyncPermission('writer', scope).enabled).toBe(enabled);
      for (const shared of [true, false, true]) {
        const bytes = existsSync(file) ? readFileSync(file, 'utf8') : null;
        const was = agentSyncPermission('writer', scope).shared;
        // 跟着总闸的那条:shared 原样存着(总闸关着时读数恒不共享),用户改了它就记下,总闸再开时按新的来
        const rawWas = followBefore === true ? stored('writer', scope).shared === true : null;
        const wrote = setAgentSyncSharedOnly('writer', scope, shared);
        const now = agentSyncPermission('writer', scope);
        expect(now.enabled).toBe(enabled);
        expect(now.shared).toBe(enabled && shared);
        expect(wrote).toBe(rawWas !== null ? rawWas !== shared : was !== now.shared);
        if (followBefore === true) expect(stored('writer', scope).shared === true).toBe(shared);
        if (!wrote) expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(bytes);
        const followNow = recordFollow();
        if (followBefore !== null) expect(followNow).toBe(followBefore);
        else if (followNow !== null) expect(followNow).toBe(true); // 没设过的记成跟着总闸:和原来「隐含地跟着总闸」一样
      }
    });
  }
  it('the default agent under an account switch that is on keeps its implicit shared bit when nothing changes', async () => {
    const cloud = fakeCloud();
    const scope = agentSyncScope(cloud, 'u')!;
    setAgentSyncDefault(scope, true);
    await saveAgent({ slug: DEFAULT_AGENT_SLUG, name: 'Default', systemPrompt: 'fixture' });
    expect(setAgentSyncSharedOnly(DEFAULT_AGENT_SLUG, scope, true)).toBe(false);
    expect(existsSync(join(agentsDir(), DEFAULT_AGENT_SLUG, '.cloudsync-accounts.json'))).toBe(false);
  });
});

describe('sealed routes', () => {
  let srv: Server;
  let base = '';
  let cloud: Cloud;
  const api = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x', ...(init?.headers || {}) } });
    return { status: r.status, body: await r.json() };
  };
  beforeAll(() => {
    cloud = fakeCloud();
    const { host } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
    configureTangu({ host, brain: { agentFiles: cloud } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
    const app = express();
    app.use(express.json());
    app.use(agentsRouter);
    app.use(memoryRouter);
    srv = app.listen(0);
    base = `http://127.0.0.1:${(srv.address() as any).port}`;
  });
  afterAll(() => { srv?.close(); });

  it('PUT /agent/sync/default answers 409 and writes nothing; GET reports the stored value and sealed', async () => {
    const scope = agentSyncScope(cloud, 'u')!;
    setAgentSyncDefault(scope, true);
    const file = join(agentsDir(), '.cloudsync-default.json');
    const bytes = readFileSync(file, 'utf8');
    const r = await api('/agent/sync/default', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    expect(r).toEqual({ status: 409, body: { detail: 'agent_sync_sealed' } });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(agentSyncDefault(scope)).toBe(true);
    expect((await api('/agent/sync/default')).body).toMatchObject({ enabled: true, sealed: true, available: true });
    rmSync(file);
    expect((await api('/agent/sync/default', { method: 'PUT', body: JSON.stringify({ enabled: true }) })).status).toBe(409);
    expect(existsSync(file)).toBe(false);
  });

  it('saving an agent with cloudSync writes no consent and no cloud_sync; the reply reports what is stored', async () => {
    const scope = agentSyncScope(cloud, 'u')!;
    // 新建:带 cloudSync 也不建授权、config.toml 里没有 cloud_sync
    const created = await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'helper', name: 'Helper', systemPrompt: 'A', cloudSync: true }) });
    expect(created.status).toBe(200);
    expect(created.body.agent.cloudSync).toBe(false);
    expect(existsSync(join(agentsDir(), 'helper', '.cloudsync-accounts.json'))).toBe(false);
    expect(readFileSync(join(agentsDir(), 'helper', 'config.toml'), 'utf8')).not.toContain('cloud_sync');
    // 已经单独开着的:设置页整份保存(cloudSync 关、shareDefaultMemory 原值)一个字节都不动
    setAgentSyncPermission('helper', scope, true, false);
    const before = agentState();
    const off = await api('/agent/agents/helper', { method: 'PATCH', body: JSON.stringify({ name: 'Helper 2', cloudSync: false, shareDefaultMemory: false }) });
    expect(off.status).toBe(200);
    expect(off.body.agent.cloudSync).toBe(true);
    const after = agentState();
    expect(after['helper/.cloudsync-accounts.json']).toBe(before['helper/.cloudsync-accounts.json']);
    expect(after['helper/config.toml']).not.toContain('cloud_sync');
    // 单独关着的:打开 cloudSync 也不写
    setAgentSyncPermission('helper', scope, false, false);
    const offBytes = agentState()['helper/.cloudsync-accounts.json'];
    const on = await api('/agent/agents/helper', { method: 'PATCH', body: JSON.stringify({ cloudSync: true }) });
    expect(on.body.agent.cloudSync).toBe(false);
    expect(agentState()['helper/.cloudsync-accounts.json']).toBe(offBytes);
    expect(agentState()['helper/config.toml']).not.toContain('cloud_sync');
  });

  it('changing "share default memory" only moves the shared bit; enabled stays as stored', async () => {
    const scope = agentSyncScope(cloud, 'u')!;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: 'reader', name: 'Reader', systemPrompt: 'A' }) });
    setAgentSyncPermission('reader', scope, true, false);
    const r = await api('/agent/agents/reader', { method: 'PATCH', body: JSON.stringify({ shareDefaultMemory: true, cloudSync: false }) });
    expect(r.status).toBe(200);
    expect(agentSyncPermission('reader', scope)).toMatchObject({ enabled: true, shared: true });
    setAgentSyncPermission('reader', scope, false, false);
    const bytes = agentState()['reader/.cloudsync-accounts.json'];
    await api('/agent/agents/reader', { method: 'PATCH', body: JSON.stringify({ shareDefaultMemory: false }) });
    await api('/agent/agents/reader', { method: 'PATCH', body: JSON.stringify({ shareDefaultMemory: true, cloudSync: true }) });
    expect(agentSyncPermission('reader', scope)).toMatchObject({ enabled: false, shared: false });
    expect(agentState()['reader/.cloudsync-accounts.json']).toBe(bytes); // 关着的 Agent:shared 位读数不变,不写
  });
});
