/**
 * 记忆按条标适用范围(11-06):remember 的 appliesTo、界面 / 接口写入、拼提示词时只放本机适用的、改名换标签、Dream 不合并不同标签、
 * Historian 带本机路径的候选不进共用记忆。合成数据,不碰真账号 / 真记忆。
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
vi.mock('../src/services/memorySyncService.js', () => ({ syncNow: vi.fn(), getSyncStatus: vi.fn() }));
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { saveAgent } from '../src/agents/agentRegistry.js';
import { readPortrait } from '../src/agents/humanPortrait.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';
import agentsRouter from '../src/routes/agents.js';
import { createMemoryRepository } from '../src/services/memoryRepository.js';
import { deviceTagContext, hasLocalPath, reconcileDeviceRename, textForThisDevice } from '../src/services/deviceTagContext.js';
import { buildAgentMemoryContext } from '../src/services/memoryRecall.js';
import { validateDreamProposal } from '../src/services/memoryDream.js';
import { agentsDir } from '../src/core/tanguHome.js';

let home: string, server: Server, base: string, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const setDevice = (name: string, others: string[] = ['Windows desktop']) => {
  writeFileSync(join(home, 'content-sync-device.json'), JSON.stringify({ id: 'dev-mac', name }));
  writeFileSync(join(home, 'content-sync-devices.json'), JSON.stringify({ devices: [{ id: 'dev-mac', name }, ...others.map((n, i) => ({ id: `o${i}`, name: n }))] }));
};
const api = async (path: string, method = 'GET', body?: any) => {
  const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const memoryOf = (slug: string) => readFileSync(join(agentsDir(), slug, 'MEMORY.md'), 'utf8');
const remember = (slug: string, args: any): Promise<string> => Promise.resolve(runWithAgentSlug(slug, () => memoryLogProvider.tools().find((t) => t.name === 'remember')!
  .execute(args, { userId: 'fixture-user', sessionId: 's', runId: 'r', appId: 'tangu' } as any))) as Promise<string>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-device-scope-')); process.env.TANGU_HOME = home;
  setDevice('MacBook Pro');
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'fixture-user' }); database = db;
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await saveAgent({ slug: 'paper', name: 'Paper', systemPrompt: 'fixture' });
  const app = express(); app.use(express.json()); app.use(agentsRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  database?.close();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('this device', () => {
  it('reads the name the sync page gave it, the system, and the other devices of the account', () => {
    const ctx = deviceTagContext(home, 'darwin');
    expect(ctx).toEqual({ self: 'MacBook Pro', os: 'macOS', others: ['Windows desktop'] });
    expect(deviceTagContext(home, 'win32').os).toBe('Windows');
  });
  it('also knows the names other devices used before a rename (aliases), but not this device’s own old names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tangu-device-alias-'));
    writeFileSync(join(dir, 'content-sync-device.json'), JSON.stringify({ id: 'me', name: 'Desk' }));
    writeFileSync(join(dir, 'content-sync-devices.json'), JSON.stringify({ devices: [{ id: 'me', name: 'Desk', aliases: ['Old desk'] }, { id: 'pc', name: 'Windows desktop', aliases: ['Gaming PC', 'Desk'] }] }));
    expect(deviceTagContext(dir, 'darwin').others).toEqual(['Windows desktop', 'Gaming PC']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('remember: appliesTo', () => {
  it('this-computer / this-os add the label for the model; all / omitted add none; update keeps the old label', async () => {
    const a = JSON.parse(await remember('paper', { action: 'add', fact: '本机装的是 TeX Live 2026', appliesTo: 'this-computer' }));
    expect(a.entry.content).toBe('[MacBook Pro] 本机装的是 TeX Live 2026');
    const o = JSON.parse(await remember('paper', { action: 'add', fact: 'Homebrew 装在 /opt/homebrew', appliesTo: 'this-os' }));
    expect(o.entry.content).toBe(`[${deviceTagContext().os}] Homebrew 装在 /opt/homebrew`);
    const all = JSON.parse(await remember('paper', { action: 'add', fact: '写论文用 LaTeX' }));
    expect(all.entry.content).toBe('写论文用 LaTeX');
    // 改措辞没说范围 → 沿用 [MacBook Pro]
    const u = JSON.parse(await remember('paper', { action: 'update', id: a.entry.id, expectedVersion: all.version, fact: '本机装的是 TeX Live 2026,编译用 latexmk' }));
    expect(u.entry.content).toBe('[MacBook Pro] 本机装的是 TeX Live 2026,编译用 latexmk');
    // 明说 all → 去掉标签
    const u2 = JSON.parse(await remember('paper', { action: 'update', id: u.entry.id, expectedVersion: u.version, fact: '编译用 latexmk', appliesTo: 'all' }));
    expect(u2.entry.content).toBe('编译用 latexmk');
    expect(await remember('paper', { action: 'add', fact: 'x', appliesTo: 'somewhere' })).toMatch(/^Error: appliesTo must be one of/);
    expect(memoryOf('paper')).not.toContain('somewhere');
  });
  it('keeps OS scope when correcting a rejected portrait write', async () => {
    const portrait = await readPortrait();
    const fact = 'The solver uses CFD_LICENSE_MODE=network';
    const args = { action: 'add', fact, appliesTo: 'this-os' };
    expect(await remember('paper', { ...args, scope: 'person' }))
      .toContain('retry with scope "agent" and keep appliesTo "this-os"');
    expect(await readPortrait()).toEqual(portrait);
    const saved = JSON.parse(await remember('paper', { ...args, scope: 'agent' }));
    expect(saved.entry.content).toBe(`[${deviceTagContext().os}] ${fact}`);
    expect(await readPortrait()).toEqual(portrait);
  });
  it('a remote cloud run has no "this computer"', async () => {
    const tool = memoryLogProvider.tools().find((t) => t.name === 'remember')!;
    const r = String(await runWithAgentSlug('paper', () => tool.execute({ action: 'add', fact: 'cloud fact', appliesTo: 'this-computer' },
      { userId: 'fixture-user', sessionId: 's', runId: 'r', appId: 'tangu', profile: { capabilities: { hostExec: false, memory: true } } } as any)));
    expect(r).toMatch(/needs this run to be on one of the user’s computers/);
  });
});

describe('UI route: appliesTo on add, label kept on edit, device context in the snapshot', () => {
  it('works through POST /memory/entries and GET /memory', async () => {
    const snap = (await api('/agent/agents/paper/memory')).body;
    expect(snap.deviceTags).toMatchObject({ self: 'MacBook Pro', others: ['Windows desktop'] });
    const added = (await api('/agent/agents/paper/memory/entries', 'POST', { action: 'add', fact: '模板在笔记库「论文/模板」', appliesTo: 'this-computer', expectedVersion: snap.version })).body;
    const e = added.entries.find((x: any) => x.content.includes('论文/模板'));
    expect(e.content).toBe('[MacBook Pro] 模板在笔记库「论文/模板」');
    // 写回的快照也带设备上下文:界面拿它换掉旧快照,标签不能掉回只认系统名
    expect(added.deviceTags).toMatchObject({ self: 'MacBook Pro', others: ['Windows desktop'] });
    const edited = (await api('/agent/agents/paper/memory/entries', 'POST', { action: 'update', id: e.id, fact: '模板在笔记库「论文/模板 2026」', expectedVersion: added.version })).body;
    expect(edited.entries.some((x: any) => x.content === '[MacBook Pro] 模板在笔记库「论文/模板 2026」')).toBe(true);
    expect((await api('/agent/agents/paper/memory/entries', 'POST', { action: 'add', fact: 'x', appliesTo: 'nowhere', expectedVersion: edited.version })).status).toBe(400);
    const saved = (await api('/agent/agents/paper/memory', 'PUT', { content: edited.content, expectedVersion: edited.version })).body;
    expect(saved.deviceTags?.self).toBe('MacBook Pro');
  });
});

describe('prompt: only what applies here, the rest folds into one English line', () => {
  it('memory recall', async () => {
    const repo = createMemoryRepository(join(agentsDir(), 'paper'));
    const s = repo.snapshot();
    repo.commit({ expectedVersion: s.version, content: ['- 写论文用 LaTeX', '- [MacBook Pro] TeX Live 2026', '- [Windows] Fluent 会在空格处截断路径', '- [Windows desktop] 求解器在 D 盘', '- 每周五整理参考文献'].join('\n'), source: { kind: 'manual' } });
    const ctx = await runWithAgentSlug('paper', () => buildAgentMemoryContext({ userId: 'fixture-user', appId: 'tangu', agentSlug: 'paper', query: '', deviceTags: { self: 'MacBook Pro', os: 'macOS', others: ['Windows desktop'] } }));
    expect(ctx.stable).toContain('TeX Live 2026');
    expect(ctx.stable).not.toContain('Fluent');
    expect(ctx.stable).not.toContain('D 盘');
    expect(ctx.stable).toContain('(2 more entries apply only to other computers: 1 on Windows, 1 on "Windows desktop")');
    expect(ctx.stable).toContain('this computer is "MacBook Pro" (macOS)');
    const winCtx = await runWithAgentSlug('paper', () => buildAgentMemoryContext({ userId: 'fixture-user', appId: 'tangu', agentSlug: 'paper', query: 'Fluent', deviceTags: { self: 'Windows desktop', os: 'Windows', others: ['MacBook Pro'] } }));
    expect(winCtx.content).toContain('Fluent');
    expect(winCtx.content).not.toContain('TeX Live');
    expect(winCtx.stable).toContain('(1 more entry applies only to other computers: 1 on "MacBook Pro")');
  });
  it('memory recall in the cloud: device names unknown, but the model is told what a leading [name] means', async () => {
    const ctx = await runWithAgentSlug('paper', () => buildAgentMemoryContext({ userId: 'fixture-user', appId: 'tangu', agentSlug: 'paper', query: '', deviceTags: { self: null, os: null, others: [] } }));
    expect(ctx.stable).not.toContain('Fluent'); // 系统名照样认得、照样折
    expect(ctx.stable).toContain('[MacBook Pro] TeX Live 2026');
    expect(ctx.stable).toContain('this run is not on any of the user’s computers');
  });
  it('instructions / persona text', () => {
    expect(textForThisDevice('Be brief.\n- [Windows] use D:\\x', { self: 'MacBook Pro', os: 'macOS', others: [] }))
      .toBe('Be brief.\n(1 more part applies only to other computers: 1 on Windows)');
    expect(textForThisDevice('Be brief.', { self: 'MacBook Pro', os: 'macOS', others: [] })).toBe('Be brief.');
  });
});

describe('rename: this device’s [old] tags become [new]', () => {
  it('rewrites MEMORY.md through the repository (evidence kept) and SOUL.md; first sight only records the name', async () => {
    rmSync(join(home, 'device-name.json'), { force: true });
    expect(await reconcileDeviceRename()).toBeNull(); // 第一次:只记下当前名字
    writeFileSync(join(agentsDir(), 'paper', 'SOUL.md'), '- [MacBook Pro] quiet keyboard at night\n- [Windows desktop] other');
    const before = createMemoryRepository(join(agentsDir(), 'paper')).snapshot();
    const old = before.entries.find((e) => e.content.includes('TeX Live 2026'))!;
    setDevice('Studio Mac');
    const r = await reconcileDeviceRename();
    expect(r).toMatchObject({ from: ['MacBook Pro'], to: 'Studio Mac', pending: [] });
    expect(memoryOf('paper')).toContain('- [Studio Mac] TeX Live 2026');
    expect(memoryOf('paper')).not.toContain('[MacBook Pro]');
    expect(memoryOf('paper')).toContain('- [Windows desktop] 求解器在 D 盘');
    expect(readFileSync(join(agentsDir(), 'paper', 'SOUL.md'), 'utf8')).toBe('- [Studio Mac] quiet keyboard at night\n- [Windows desktop] other');
    const after = createMemoryRepository(join(agentsDir(), 'paper')).snapshot();
    expect(after.entries.find((e) => e.content.includes('TeX Live 2026'))!.evidenceIds).toContain(old.id);
    expect(await reconcileDeviceRename()).toBeNull(); // 记下了新名字,再对一次是空操作
  });
  it('waits for the folder lock instead of writing over a concurrent writer, then catches up across two renames', async () => {
    const dir = join(agentsDir(), 'paper'), lock = join(dir, '.memory.lock');
    writeFileSync(lock, '{}'); // 桌面同步 / 另一个写者正拿着这把锁
    setDevice('Desk B');
    const r1 = await reconcileDeviceRename();
    expect(r1).toMatchObject({ from: ['Studio Mac'], to: 'Desk B', pending: ['paper'] });
    expect(memoryOf('paper')).toContain('- [Studio Mac] TeX Live 2026'); // 锁着的时候一个字都没动
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf8')).toContain('[Studio Mac]');
    setDevice('Desk C'); // 没换完又改了一次名
    expect((await reconcileDeviceRename())?.pending).toEqual(['paper']);
    rmSync(lock);
    const r3 = await reconcileDeviceRename();
    expect(r3?.from).toEqual(expect.arrayContaining(['Studio Mac', 'Desk B']));
    expect(r3?.pending).toEqual([]);
    expect(memoryOf('paper')).toContain('- [Desk C] TeX Live 2026');
    expect(readFileSync(join(dir, 'SOUL.md'), 'utf8')).toBe('- [Desk C] quiet keyboard at night\n- [Windows desktop] other');
    expect(await reconcileDeviceRename()).toBeNull();
  });
  it('config.toml: tags at the start of a value too; a name the string cannot hold leaves the file as it is', async () => {
    const dir = join(agentsDir(), 'tomlcase'); mkdirSync(dir, { recursive: true });
    const cfg = 'name = "T"\ninstructions = "[Desk C] single line"\nprompt = \"\"\"\n[Desk C] multi\n- [Windows desktop] other\n\"\"\"\n';
    writeFileSync(join(dir, 'config.toml'), cfg);
    setDevice("Alice's Mac");
    const r = await reconcileDeviceRename();
    expect(r?.files).toContain('tomlcase/config.toml');
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(cfg.split('[Desk C]').join("[Alice's Mac]"));
    // 反斜杠在基本字符串里是转义:原样换进去解析出来就不对了 → 这份不写,记进 skipped,不算没换完(不会一直重试)
    const held = 'name = "T"\nprompt = """\n[Alice\'s Mac] multi\n"""\n';
    writeFileSync(join(dir, 'config.toml'), held);
    setDevice('Lab\\Box');
    const r2 = await reconcileDeviceRename();
    expect(r2).toMatchObject({ pending: [], skipped: ['tomlcase/config.toml'] });
    expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(held);
    expect(memoryOf('paper')).toContain('- [Lab\\Box] TeX Live 2026'); // 别的文件照换
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Dream keeps device labels', () => {
  const sources = [
    { id: 'm1', fact: '[Studio Mac] 编译用 latexmk', kind: 'memory' as const },
    { id: 'm2', fact: '[Windows desktop] 编译用 latexmk', kind: 'memory' as const },
    { id: 'c1', fact: '编译 LaTeX 用 latexmk', kind: 'candidate' as const, evidence: 'x'.repeat(1200) },
  ];
  const tags = { self: 'Studio Mac', os: 'macOS' as const, others: ['Windows desktop'] };
  it('refuses to merge facts whose labels differ', () => {
    expect(() => validateDreamProposal({ groups: [{ fact: '编译用 latexmk', sourceIds: ['m1', 'm2'] }], discarded: [{ sourceId: 'c1', reason: 'dup' }] }, sources, { portrait: false, tags }))
      .toThrow(/different devices/);
  });
  it('restores the label from the sources when the model drops or changes it', () => {
    const p = validateDreamProposal({ keep: ['m2'], groups: [{ fact: '编译用 latexmk -pdf', sourceIds: ['m1'] }, { fact: '[Windows] 编译 LaTeX 用 latexmk', sourceIds: ['c1'] }], discarded: [] }, sources, { portrait: false, tags });
    expect(p.groups.map((g) => g.fact)).toEqual(['[Windows desktop] 编译用 latexmk', '[Studio Mac] 编译用 latexmk -pdf', '编译 LaTeX 用 latexmk']);
  });
});

describe('Dream without device names (cloud)', () => {
  it('treats any leading bracket as a label: never merges [x] facts with untagged ones', () => {
    const sources = [{ id: 'm1', fact: '[Studio Mac] 编译用 latexmk', kind: 'memory' as const }, { id: 'm2', fact: '编译用 latexmk', kind: 'memory' as const }];
    const cloud = { self: null, os: null, others: [] };
    expect(() => validateDreamProposal({ groups: [{ fact: '编译用 latexmk', sourceIds: ['m1', 'm2'] }], discarded: [] }, sources, { portrait: false, tags: cloud })).toThrow(/different devices/);
    const p = validateDreamProposal({ keep: ['m2'], groups: [{ fact: '编译用 latexmk -pdf', sourceIds: ['m1'] }], discarded: [] }, sources, { portrait: false, tags: cloud });
    expect(p.groups.map((g) => g.fact)).toContain('[Studio Mac] 编译用 latexmk -pdf');
  });
});

describe('Historian: facts with a local path', () => {
  it('recognises local absolute paths, not URLs', () => {
    for (const t of ['模板在 /Users/su/Documents/论文', 'TeX at ~/texlive', '用 C:\\Fluent\\x 跑', 'share \\\\nas\\docs\\a', '路径：/home/a/b', 'repo in /workspace/app', 'data at /data/runs']) expect(hasLocalPath(t)).toBe(true);
    for (const t of ['see https://x.com/Users/a', 'api /api/v1/x', '写论文用 LaTeX']) expect(hasLocalPath(t)).toBe(false);
  });
});
