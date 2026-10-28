/**
 * 项目文件夹搬走后重新指向(projectRelink.ts):
 *   - 三处一起改:会话 project_path + 配置里的 cwd / extraRoots、项目记忆目录(按新 realpath 改名、标记改写)、project-settings.json 那一项
 *   - 中途失败(会话库那一步抛)→ 记忆目录和设置文件都撤回原样,会话一行没动
 *   - 新位置已是另一个项目 → already_project;merge 后会话并过去、两份记忆合并去重、那边的默认项保留、不留中间目录
 *   - 外接盘没挂上:只出现在「不在原处」里,什么都不改;指向一个不存在的目录被拒
 *   - 同名文件夹:旧路径的上一级 / ~ / ~/Documents / ~/Projects;记下的远端对上了才 remoteMatch
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { runMigration } from '../db/migrate.js';
import { query } from '../core/db.js';
import { openProjectMemory, refOf, PROJECT_MEMORY_CHAR_BUDGET } from './projectMemory.js';
import { projectSettingsFile, readProjectSettings, rememberProjectRemote, writeProjectSettings } from './projectContext.js';
import { missingProjectPaths, oldPathKeys, rebasePath, relinkInfo, relinkProject, remoteIdentity } from './projectRelink.js';

let root: string;
let host: ReturnType<typeof createSqliteHost>['host'];
const mk = (rel: string): string => { const p = path.join(root, rel); mkdirSync(p, { recursive: true }); return realpathSync(p); };
let n = 0;
async function session(projectPath: string, name: string, cfg?: object): Promise<string> {
  const id = `s${++n}`;
  await query(`INSERT INTO chat_sessions (id, user_id, title, project_path, project_name, agent_config) VALUES (?, 'u1', ?, ?, ?, ?)`,
    [id, id, projectPath, name, cfg ? JSON.stringify(cfg) : null]);
  return id;
}
const row = async (id: string): Promise<any> => (await query<any[]>(`SELECT project_path, project_name, agent_config FROM chat_sessions WHERE id = ?`, [id]))[0];
const cfgOf = async (id: string): Promise<any> => JSON.parse((await row(id)).agent_config);
async function remember(project: string, facts: string[]): Promise<void> {
  const repo = await openProjectMemory(refOf(project));
  for (const fact of facts) repo.mutate({ action: 'add', fact, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'manual' } });
}
const factsAt = (project: string): string[] => readFileSync(path.join(refOf(project).dir, 'MEMORY.md'), 'utf8').split('\n').filter(Boolean);
const memoryRoot = (): string => path.join(process.env.TANGU_HOME!, 'project-memory');
/** 一个已经搬走的项目:建好目录、往里记东西,再把目录挪走(记录里是搬走前的 realpath)。 */
async function movedAway(rel: string, dest: string): Promise<{ old: string; moved: string }> {
  const old = mk(rel);
  await remember(old, ['Run tests with npm test', 'Docs live in docs/']);
  await writeProjectSettings(old, { defaultAgent: 'xyra', approvalMode: 'readonly' });
  const moved = path.join(root, dest);
  mkdirSync(path.dirname(moved), { recursive: true });
  execFileSync('mv', [old, moved]);
  return { old, moved: realpathSync(moved) };
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tangu-relink-')));
  process.env.TANGU_HOME = mk('home/.tangu');
  ({ host } = (() => { const h = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' }); h.db.exec(toSqliteDDL(STANDALONE_SCHEMA)); return h; })());
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
afterAll(() => { delete process.env.TANGU_HOME; rmSync(root, { recursive: true, force: true }); });

describe('helpers', () => {
  it('旧路径的写法:不在了就用最深的现存上级 realpath 补;rebase 只动落在旧目录下的', () => {
    const base = mk('keys');
    expect(oldPathKeys(path.join(base, 'gone', 'deeper'))).toEqual([path.join(base, 'gone', 'deeper')]);
    expect(rebasePath('/a/site', ['/a/site'], '/b/web')).toBe('/b/web');
    expect(rebasePath('/a/site/sub', ['/x', '/a/site'], '/b/web')).toBe('/b/web/sub');
    expect(rebasePath('/a/site2', ['/a/site'], '/b/web')).toBe('/a/site2');
    expect(rebasePath(undefined, ['/a/site'], '/b/web')).toBe(undefined);
    expect(rebasePath('/a/site/../shared', ['/a/site'], '/b/web')).toBe('/a/site/../shared'); // 其实在项目外面
  });
  it('远端比对形:https / ssh / 带凭据 / 结尾 .git 认成同一个', () => {
    const id = remoteIdentity('https://github.com/demo/site.git');
    expect(remoteIdentity('git@github.com:demo/site.git')).toBe(id);
    expect(remoteIdentity('https://user:tok@GitHub.com/demo/site/')).toBe(id);
    expect(remoteIdentity('https://github.com/demo/other')).not.toBe(id);
  });
});

describe('relinkProject', () => {
  it('三处一起改:会话路径与配置 cwd、记忆目录按新 realpath 改名、默认项与远端记录挪过去', async () => {
    const { old, moved } = await movedAway('a/Site', 'b/Site');
    await rememberProjectRemote(old, 'https://github.com/demo/site.git');
    const s1 = await session(old, '官网', { cwd: old, execMode: 'host', extraRoots: [path.join(old, 'assets'), '/elsewhere'] });
    const s2 = await session(old, '官网');
    const bystander = await session('/other/project', 'Other', { cwd: '/other/project' });
    const oldDir = refOf(old).dir;

    const r = await relinkProject('u1', old, moved);
    expect(r).toMatchObject({ ok: true, path: moved, name: null, memory: 'moved' });
    expect((await row(s1)).project_path).toBe(moved);
    expect((await row(s1)).project_name).toBe('官网'); // 项目名不跟文件夹名走
    expect((await row(s2)).project_path).toBe(moved);
    expect(await cfgOf(s1)).toMatchObject({ cwd: moved, execMode: 'host', extraRoots: [path.join(moved, 'assets'), '/elsewhere'] });
    expect(await cfgOf(bystander)).toEqual({ cwd: '/other/project' });
    expect(existsSync(oldDir)).toBe(false);
    expect(factsAt(moved)).toEqual(['Run tests with npm test', 'Docs live in docs/']);
    expect(JSON.parse(readFileSync(path.join(refOf(moved).dir, 'PROJECT.json'), 'utf8'))).toEqual({ project: moved });
    expect(await readProjectSettings(moved)).toEqual({ defaultAgent: 'xyra', approvalMode: 'readonly' });
    const file = JSON.parse(readFileSync(projectSettingsFile(), 'utf8'));
    expect(file.projects[old]).toBeUndefined();
    expect(file.remotes[moved]).toBe('https://github.com/demo/site.git');
    expect(file.remotes[old]).toBeUndefined();
  });

  it('会话库那一步失败 → 记忆目录与设置文件都撤回,会话一行没动', async () => {
    const { old, moved } = await movedAway('c/App', 'd/App');
    const s = await session(old, 'App', { cwd: old });
    const settingsBefore = readFileSync(projectSettingsFile(), 'utf8');
    const real = host.query.bind(host);
    const spy = vi.spyOn(host, 'query').mockImplementation(((sql: string, params?: any[]) =>
      /^UPDATE chat_sessions SET project_path/.test(sql) ? Promise.reject(new Error('disk full')) : real(sql, params)) as any);
    try {
      await expect(relinkProject('u1', old, moved)).rejects.toThrow('disk full');
    } finally { spy.mockRestore(); }
    expect(await row(s)).toMatchObject({ project_path: old });
    expect(await cfgOf(s)).toEqual({ cwd: old });
    expect(existsSync(refOf(old).dir)).toBe(true);
    expect(existsSync(refOf(moved).dir)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(refOf(old).dir, 'PROJECT.json'), 'utf8'))).toEqual({ project: old });
    expect(readFileSync(projectSettingsFile(), 'utf8')).toBe(settingsBefore);
  });

  it('新位置已是另一个项目:先回 already_project;合并后会话并过去、记忆去重合并、那边的默认项保留', async () => {
    const { old, moved } = await movedAway('e/Blog', 'f/Blog');
    const mine = await session(old, 'Blog', { cwd: old });
    // moved 那里已经是项目「Blog 2」:有自己的会话、记忆(其中一条与旧项目一样)和默认项
    const theirs = await session(moved, 'Blog 2', { cwd: moved });
    await remember(moved, ['Docs live in docs/', 'Deploy with make ship']);
    await writeProjectSettings(moved, { defaultAgent: 'muse' });

    expect(await relinkProject('u1', old, moved)).toEqual({ ok: false, error: 'already_project', path: moved, name: 'Blog 2' });
    expect((await row(mine)).project_path).toBe(old); // 没点合并:什么都没动
    expect(existsSync(refOf(old).dir)).toBe(true);

    const r = await relinkProject('u1', old, moved, { merge: true });
    expect(r).toMatchObject({ ok: true, path: moved, name: 'Blog 2', memory: 'merged' });
    expect(await row(mine)).toMatchObject({ project_path: moved, project_name: 'Blog 2' });
    expect(await cfgOf(mine)).toEqual({ cwd: moved });
    expect((await row(theirs)).project_path).toBe(moved);
    expect(factsAt(moved).sort()).toEqual(['Deploy with make ship', 'Docs live in docs/', 'Run tests with npm test']);
    expect(existsSync(refOf(old).dir)).toBe(false);
    expect(readdirSync(memoryRoot()).filter((x) => x.includes('.'))).toEqual([]); // 不留 .relink- / .before- 中间目录
    expect(await readProjectSettings(moved)).toEqual({ defaultAgent: 'muse' });
  });

  it('合并途中失败:那之间别处写进来的记忆和默认项留着,旧项目那份放回原处', async () => {
    const { old, moved } = await movedAway('i/Wiki', 'j/Wiki');
    const mine = await session(old, 'Wiki', { cwd: old });
    await session(moved, 'Wiki 2', { cwd: moved });
    await remember(moved, ['Pages are markdown']);
    await writeProjectSettings(moved, { defaultAgent: 'muse' });
    const real = host.query.bind(host);
    const spy = vi.spyOn(host, 'query').mockImplementation((async (sql: string, params?: any[]) => {
      if (!/^UPDATE chat_sessions SET project_path/.test(sql)) return real(sql, params);
      // 记忆已换成合并后的、默认项已挪好,会话库还没写:「Wiki 2」自己的会话这时记了一条、另一个窗口改了默认项
      await remember(moved, ['Images go in assets/']);
      await writeProjectSettings(moved, { defaultAgent: 'muse', model: 'm2' });
      throw new Error('disk full');
    }) as any);
    try { await expect(relinkProject('u1', old, moved, { merge: true })).rejects.toThrow('disk full'); } finally { spy.mockRestore(); }
    expect((await row(mine)).project_path).toBe(old);
    expect(factsAt(moved)).toContain('Images go in assets/');
    expect(factsAt(moved)).toContain('Pages are markdown');
    expect(factsAt(old)).toEqual(['Run tests with npm test', 'Docs live in docs/']);
    expect(await readProjectSettings(moved)).toEqual({ defaultAgent: 'muse', model: 'm2' });
    expect(await readProjectSettings(old)).toEqual({ defaultAgent: 'xyra', approvalMode: 'readonly' });
    expect(readdirSync(memoryRoot()).filter((x) => x.includes('.'))).toEqual([]);
  });

  it('两个项目同时指到同一处:只有先到的那个成,后到的回 already_project,不会悄悄并到一起', async () => {
    const one = await movedAway('k/Repo', 'k2/Repo');
    const twoOld = mk('l/Repo');
    const a = await session(one.old, 'Repo A');
    const b = await session(twoOld, 'Repo B');
    rmSync(twoOld, { recursive: true });
    const [ra, rb] = await Promise.all([relinkProject('u1', one.old, one.moved), relinkProject('u1', twoOld, one.moved)]);
    expect(ra).toMatchObject({ ok: true });
    expect(rb).toEqual({ ok: false, error: 'already_project', path: one.moved, name: 'Repo A' });
    expect((await row(a)).project_path).toBe(one.moved);
    expect((await row(b)).project_path).toBe(twoOld);
  });

  it('外接盘没挂上:只出现在「不在原处」里,什么都不改;指向不存在的目录被拒', async () => {
    const here = mk('g/Here');
    const drive = path.join(root, 'Volumes', 'Ext', 'Photos'); // 从没挂上过
    const a = await session(here, 'Here');
    const b = await session(drive, 'Photos', { cwd: drive });
    const missing = await missingProjectPaths('u1');
    expect(missing).toContain(drive);
    expect(missing).not.toContain(here);
    expect(await row(b)).toMatchObject({ project_path: drive });
    await expect(relinkProject('u1', drive, path.join(root, 'Volumes', 'Ext2', 'Photos'))).rejects.toThrow(/does not exist/);
    expect(await cfgOf(b)).toEqual({ cwd: drive });
    expect((await row(a)).project_path).toBe(here);
  });
});

describe('relinkInfo', () => {
  it('列出同名文件夹;记下的远端对上了才 remoteMatch,另一个项目占着的带上它的名字', async () => {
    const home = mk('home');
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const { old } = await movedAway('h/Shop', 'nowhere/Shop');
      await rememberProjectRemote(old, 'git@github.com:demo/shop.git');
      await session(old, 'Shop');
      const inProjects = mk('home/Projects/Shop');
      const inDocs = mk('home/Documents/Shop');
      execFileSync('git', ['init', '-q', inProjects]);
      execFileSync('git', ['-C', inProjects, 'remote', 'add', 'origin', 'https://github.com/demo/shop.git']);
      execFileSync('git', ['init', '-q', inDocs]);
      execFileSync('git', ['-C', inDocs, 'remote', 'add', 'origin', 'https://github.com/someone/shop.git']);
      await session(inDocs, 'Shop copy');

      const info = await relinkInfo('u1', old);
      expect(info).toMatchObject({ from: old, sessions: 1, memoryEntries: 2, settings: ['defaultAgent', 'approvalMode'], remote: 'git@github.com:demo/shop.git' });
      expect(info.candidates).toEqual([
        { path: inDocs, remote: 'https://github.com/someone/shop.git', remoteMatch: false, project: 'Shop copy' },
        { path: inProjects, remote: 'https://github.com/demo/shop.git', remoteMatch: true, project: null },
      ]);
    } finally { process.env.HOME = prevHome; }
  });
});
