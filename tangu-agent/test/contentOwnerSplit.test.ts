/**
 * 「谁管落盘同步」拆成 human / agents 两位(智库同步统一方案第 2 步,契约 §3.7 / 实现期修订 H-1 第 5 条)。
 * 三种机器:human/ 的同意来自账号总闸的、来自某个 Agent 的 shared 的、content 原来就管 human 的(老 owner:'content' 文件)。
 * 断言:human 那一位归 content → 旧通道一个 human/ 请求都不发;归引擎 → 照常同步,不管 agents 那一位是什么;两位都能单独读回。
 * 负对照(交付时实跑过):把 agentFileSync 里 human 同意改回「从按 Agents 那一位滤过的 agents 里找」,'shared' 那台在 agents=content 时应该红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runAgentFilesSync } from '../src/services/agentFileSync.js';
import { agentSyncDefault, agentSyncPermission, agentSyncScope, contentSyncOwnership, setAgentSyncDefault, setAgentSyncPermission, setContentSyncOwner, setContentSyncOwnership } from '../src/services/cloudSyncAccount.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { agentsDir } from '../src/core/tanguHome.js';
import { AgentFileConflictError, type AgentFilesBrain } from '../src/seams/cloudBrain.js';
import { contentOwnsOf, withContentOwns } from '../src/contracts/contentSyncOwner.js';

function fakeCloud(paths: string[] = ['human', 'human-folder']) {
  const rows = new Map<string, any>();
  const calls: string[] = [];
  const key = (s: string, p: string) => `${s}\0${p}`;
  const brain: AgentFilesBrain & { rows: typeof rows; calls: string[] } = {
    rows, calls,
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
const humanCalls = (cloud: Cloud) => cloud.calls.filter((c) => HUMAN.has(c.split(' ')[1].split('/')[0]));
const CAL = (ids: string[]) => `${JSON.stringify({ version: 2, name: 'Calendar', columns: [{ id: 'n', name: 'Name', type: 'text' }, { id: 'd', name: 'Date', type: 'calendarDate' }], rows: ids.map((id) => ({ id, cells: { n: `event ${id}`, d: '2026-11-27' } })) }, null, 2)}\n`;
const calendarRows = (cloud: Cloud): string[] => JSON.parse(cloud.rows.get('__human__\0CALENDAR.db')?.content ?? '{"rows":[]}').rows.map((r: any) => r.id).sort();

let root = '';
let home = '';
const prev = { home: process.env.TANGU_HOME, cal: process.env.FORSION_DEFAULT_CALENDAR };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tangu-owner-split-'));
  home = join(root, 'tangu');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'Vault'), { recursive: true });
  process.env.TANGU_HOME = home;
  process.env.FORSION_DEFAULT_CALENDAR = join(root, 'Vault', 'Calendar.db');
});
afterEach(() => {
  if (prev.home === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev.home;
  if (prev.cal === undefined) delete process.env.FORSION_DEFAULT_CALENDAR; else process.env.FORSION_DEFAULT_CALENDAR = prev.cal;
  rmSync(root, { recursive: true, force: true });
});

type Machine = 'master' | 'shared' | 'content'
async function seed(machine: Machine): Promise<{ cloud: Cloud; scope: string }> {
  const cloud = fakeCloud();
  const scope = agentSyncScope(cloud, 'u')!;
  await saveAgent({ slug: 'writer', name: 'Writer', systemPrompt: 'fixture' });
  writeFileSync(join(home, 'USER.md'), 'Name: Test User\n');
  writeFileSync(process.env.FORSION_DEFAULT_CALENDAR!, CAL(['r1', 'r2']));
  if (machine === 'shared') setAgentSyncPermission('writer', scope, true, true);
  else setAgentSyncDefault(scope, true);
  if (machine === 'content') setContentSyncOwner(scope, true); // 第 2 步之前的老 claim(true):文件里只有 owner:'content'
  return { cloud, scope };
}

describe('content owner: format', () => {
  it('reads an old owner:content entry as both bits and writes owner only while human belongs to content', () => {
    expect(contentOwnsOf({ enabled: true, revision: 3, owner: 'content' })).toEqual({ human: true, agents: true });
    expect(contentOwnsOf({ enabled: true, revision: 3 })).toEqual({ human: false, agents: false });
    const agentsOnly = withContentOwns({ enabled: true, revision: 3, owner: 'content' }, { human: false });
    expect(agentsOnly).toEqual({ enabled: true, revision: 4, contentOwns: { human: false, agents: true } });
    expect(withContentOwns(agentsOnly, { agents: false })).toEqual({ enabled: true, revision: 5 });
    expect(withContentOwns(undefined, { human: true })).toEqual({ enabled: false, revision: 1, owner: 'content', contentOwns: { human: true, agents: false } });
  });
});

describe('content owner: three machines hand human over and back', () => {
  for (const machine of ['master', 'shared', 'content'] as const) {
    it(`${machine}: human follows only the human bit, the agents bit never stops it, both bits read back`, async () => {
      const { cloud, scope } = await seed(machine);
      // 1. 起点:content 原来就管 human 的那台,旧通道不碰 human/;另外两台照常同步
      let r = await runAgentFilesSync(cloud, 'u');
      expect(r.error ?? '').toBe('');
      if (machine === 'content') {
        expect(contentSyncOwnership(scope)).toEqual({ human: true, agents: true });
        expect(humanCalls(cloud)).toEqual([]);
      } else {
        expect(contentSyncOwnership(scope)).toEqual({ human: false, agents: false });
        expect(calendarRows(cloud)).toEqual(['r1', 'r2']);
      }
      // 2. human 归引擎、agents 归 content(条目同步接手后的机器,或者把 human 还给引擎的老 claim 机器):human/ 照常同步
      setContentSyncOwnership(scope, { human: false, agents: true });
      expect(contentSyncOwnership(scope)).toEqual({ human: false, agents: true });
      expect(agentSyncPermission('writer', scope).enabled).toBe(false); // Agents 那一位照旧压住每个 Agent 的同步
      cloud.calls.length = 0;
      writeFileSync(process.env.FORSION_DEFAULT_CALENDAR!, CAL(['r1', 'r2', 'r3']));
      r = await runAgentFilesSync(cloud, 'u');
      expect(r.error ?? '').toBe('');
      expect(humanCalls(cloud).length).toBeGreaterThan(0);
      expect(calendarRows(cloud)).toEqual(['r1', 'r2', 'r3']);
      // 3. human 交给 content:旧通道一个 human/ 请求都不发,本机后来的改动也不推
      setContentSyncOwnership(scope, { human: true });
      expect(contentSyncOwnership(scope)).toEqual({ human: true, agents: true });
      expect(agentSyncDefault(scope)).toBe(false);
      expect(agentSyncPermission('writer', scope, 'human').shared).toBe(false);
      cloud.calls.length = 0;
      writeFileSync(process.env.FORSION_DEFAULT_CALENDAR!, CAL(['r1', 'r2', 'r3', 'r4']));
      r = await runAgentFilesSync(cloud, 'u');
      expect(r.error ?? '').toBe('');
      expect(humanCalls(cloud)).toEqual([]);
      expect(calendarRows(cloud)).toEqual(['r1', 'r2', 'r3']);
    });
  }

  it('an unreadable owner file is not read as "nobody owns it" and is not overwritten', async () => {
    const { scope } = await seed('master');
    const file = join(agentsDir(), '.cloudsync-default.json');
    writeFileSync(file, '{"accounts":');
    expect(() => contentSyncOwnership(scope)).toThrow();
    expect(() => setContentSyncOwnership(scope, { human: true })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"accounts":');
  });
});
