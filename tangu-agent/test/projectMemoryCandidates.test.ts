/** 项目记忆的待确认候选(10-04 用户裁决「有风险的才需要确认」):后台提的、过不了形状闸的项目事实不写进记忆,等用户逐条采纳 / 丢弃。 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import {
  addProjectFact, buildProjectMemoryContext, forgetProjectMemory, openProjectMemory, peekProjectMemory, pendingProjectFacts, projectMemoryView,
  queueProjectFact, resolveProjectCandidate, resolveProjectMemory, PROJECT_MEMORY_CHAR_BUDGET, type ProjectMemoryRef,
} from '../src/services/projectMemory.js';

let home: string, work: string, database: any;
const previousHome = process.env.TANGU_HOME;
const project = (name: string): string => join(work, name);
const session = (id: string, name: string): void => {
  if (!existsSync(project(name))) mkdirSync(project(name));
  database.prepare('INSERT INTO chat_sessions (id, user_id, app_id, title, project_path, projectless) VALUES (?, ?, ?, ?, ?, 0)').run(id, 'owner', 'tangu', id, project(name));
};
const refOf = async (sessionId: string): Promise<ProjectMemoryRef> => (await resolveProjectMemory('owner', sessionId))!;
const waiting = async (name: string): Promise<string[]> => (await projectMemoryView(project(name))).candidates.map((c) => c.content);
const saved = async (name: string): Promise<string[]> => (await projectMemoryView(project(name))).entries.map((e) => e.content);
const idOf = async (name: string, fact: string): Promise<string> => (await projectMemoryView(project(name))).candidates.find((c) => c.content === fact)!.id;
const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e) => String(e?.code || e?.message));

const DEPLOY = 'Deploys go through https://ci.example.test/deploy, never from a laptop';
const TOKEN = 'The staging API token lives in the team vault under "staging"';

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-project-candidates-'))); process.env.TANGU_HOME = home;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-project-candidates-work-')));
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('项目记忆的待确认候选', () => {
  it('排进清单的不是记忆:界面看得到,系统提示里没有;一字不差的不重复排,已经记着的不排', async () => {
    session('a1', 'alpha'); session('a2', 'alpha');
    const ref = await refOf('a1');
    expect(await queueProjectFact(ref, DEPLOY, 'a1')).toBe(true);
    expect(await waiting('alpha')).toEqual([DEPLOY]);
    expect(await saved('alpha')).toEqual([]);
    expect(await buildProjectMemoryContext('owner', 'a2')).toBe('');            // 同项目的下一个会话读不到它
    expect(await queueProjectFact(ref, `  ${DEPLOY.toUpperCase()} `, 'a2')).toBe(false); // 大小写 / 空白不同也算同一句
    await addProjectFact(ref, 'Tests run with npm run test:unit', 'a1');
    expect(await queueProjectFact(ref, 'tests run with npm run test:unit', 'a2')).toBe(false);
    expect(await waiting('alpha')).toEqual([DEPLOY]);
    expect(await buildProjectMemoryContext('owner', 'a2')).not.toContain('ci.example.test');
  });

  it('采纳:以用户的名义记进项目记忆,从清单里拿掉;此后系统提示里有它', async () => {
    const view = await resolveProjectCandidate(project('alpha'), await idOf('alpha', DEPLOY), true);
    expect(view.candidates).toEqual([]);
    expect(view.entries.map((e) => e.content)).toEqual(['Tests run with npm run test:unit', DEPLOY]);
    const entry = (await peekProjectMemory(await refOf('a1')))!.entries.find((e) => e.content === DEPLOY)!;
    expect(entry.source.kind).toBe('manual');
    expect(entry.evidenceIds).toContain('session:a1');
    expect(await buildProjectMemoryContext('owner', 'a2')).toContain('ci.example.test');
    expect(await queueProjectFact(await refOf('a1'), DEPLOY, 'a2')).toBe(false); // 已经记着了
  });

  it('采纳的那条日后被用户删了 → 提出它的那个会话后台不再记、也不再排;别的会话不受影响', async () => {
    const before = await projectMemoryView(project('alpha'));
    await forgetProjectMemory(project('alpha'), before.entries.find((e) => e.content === DEPLOY)!.id, before.version!);
    const ref = await refOf('a1');
    expect(await queueProjectFact(ref, DEPLOY, 'a2')).toBe(false);                  // 删掉的那句谁也不许再提
    expect(await queueProjectFact(ref, 'Deploy only via the CI page at https://ci.example.test', 'a1')).toBe(false); // 换个说法、同一个会话
    expect(await addProjectFact(ref, 'Release branches are cut on Mondays', 'a1')).toBe('duplicate');
    expect(await queueProjectFact(ref, TOKEN, 'a2')).toBe(true);
    expect(await waiting('alpha')).toEqual([TOKEN]);
  });

  it('丢弃:不进记忆;同一句不再排,丢弃它的那个会话也不再排,别的会话照常', async () => {
    session('b1', 'beta'); session('b2', 'beta');
    const ref = await refOf('b1');
    await queueProjectFact(ref, DEPLOY, 'b1');
    const view = await resolveProjectCandidate(project('beta'), await idOf('beta', DEPLOY), false);
    expect(view.candidates).toEqual([]);
    expect(view.entries).toEqual([]);
    expect(await queueProjectFact(ref, DEPLOY, 'b2')).toBe(false);                 // 一字不差
    expect(await queueProjectFact(ref, TOKEN, 'b1')).toBe(false);                  // 同一个会话:判官会换说法再提,一刀切
    expect(await queueProjectFact(ref, TOKEN, 'b2')).toBe(true);
    expect(pendingProjectFacts(ref)).toEqual([DEPLOY, TOKEN]);                      // 丢弃过的也给判官看(「已经提过」)
    expect(await waiting('beta')).toEqual([TOKEN]);
  });

  it('那一条已经不在了 → MEMORY_NOT_FOUND;没有清单的项目不会因为这次点击被建出目录', async () => {
    expect(await code(resolveProjectCandidate(project('beta'), 'no-such-id', true))).toBe('MEMORY_NOT_FOUND');
    const id = await idOf('beta', TOKEN);
    await resolveProjectCandidate(project('beta'), id, true);
    expect(await code(resolveProjectCandidate(project('beta'), id, true))).toBe('MEMORY_NOT_FOUND');   // 点了两次
    expect(await code(resolveProjectCandidate(project('beta'), id, false))).toBe('MEMORY_NOT_FOUND');
    expect(await saved('beta')).toEqual([TOKEN]);                                                        // 没有记两遍
    const stores = readdirSync(join(home, 'project-memory')).length;
    mkdirSync(project('gamma'));
    expect(await code(resolveProjectCandidate(project('gamma'), 'x', true))).toBe('MEMORY_NOT_FOUND');
    expect((await projectMemoryView(project('gamma'))).candidates).toEqual([]);
    expect(readdirSync(join(home, 'project-memory'))).toHaveLength(stores);
  });

  it('清单封顶:只留最新的 20 条;记忆放不下时采纳失败、候选留着', async () => {
    session('d1', 'delta');
    const ref = await refOf('d1');
    for (let n = 0; n < 23; n++) expect(await queueProjectFact(ref, `Service ${n} is reachable at https://svc-${n}.example.test`, 'd1')).toBe(true);
    const list = await waiting('delta');
    expect(list).toHaveLength(20);
    expect(list[0]).toContain('Service 3 ');
    expect(list.at(-1)).toContain('Service 22 ');
    // 把记忆填到只剩二十来个字:比任何一条候选都短
    const filler = (n: number): string => `Convention ${n}: ${'this project keeps generated files out of the source tree. '.repeat(4)}`.slice(0, 290);
    const store = await openProjectMemory(ref);
    for (let n = 0; n < 60; n++) { try { store.mutate({ action: 'add', fact: filler(n), cap: PROJECT_MEMORY_CHAR_BUDGET }); } catch { break; } }
    const room = PROJECT_MEMORY_CHAR_BUDGET - (await projectMemoryView(project('delta'))).chars - 1;
    if (room > 30) store.mutate({ action: 'add', fact: 'z'.repeat(room - 20), cap: PROJECT_MEMORY_CHAR_BUDGET });
    const stuck = await idOf('delta', list[0]!);
    expect(await code(resolveProjectCandidate(project('delta'), stuck, true))).toBe('MEMORY_FULL');
    expect(await waiting('delta')).toHaveLength(20);
  });

  it('丢弃记录比待确认留得久:丢弃过二十多条之后,最早那条和它的会话仍然不会再排', async () => {
    session('z0', 'zeta');
    const ref = await refOf('z0');
    for (let n = 0; n < 25; n++) {
      session(`z${n + 1}`, 'zeta');
      const fact = `Mirror ${n} is at https://mirror-${n}.example.test`;
      expect(await queueProjectFact(ref, fact, `z${n + 1}`)).toBe(true);
      await resolveProjectCandidate(project('zeta'), await idOf('zeta', fact), false);
    }
    expect(await waiting('zeta')).toEqual([]);
    expect(await queueProjectFact(ref, 'Mirror 0 is at https://mirror-0.example.test', 'z0')).toBe(false);   // 最早丢弃的那句
    expect(await queueProjectFact(ref, 'Another fact with https://other.example.test', 'z1')).toBe(false);   // 最早丢弃过的那个会话
    expect(pendingProjectFacts(ref)).toHaveLength(25);
  });

  it('清单在、记忆文件还没有(或清单写坏了)也不出错:候选照常显示,坏清单当空', async () => {
    session('e1', 'epsilon');
    const ref = await refOf('e1');
    mkdirSync(ref.dir, { recursive: true });
    writeFileSync(join(ref.dir, 'PENDING.json'), JSON.stringify([{ id: 'p1', fact: DEPLOY, sessionId: 'e1', at: 1 }, { id: 7, fact: 'malformed row' }]));
    const view = await projectMemoryView(project('epsilon'));
    expect(view).toMatchObject({ version: null, entries: [], candidates: [{ id: 'p1', content: DEPLOY, at: 1 }] });
    writeFileSync(join(ref.dir, 'PENDING.json'), '{not json');
    expect((await projectMemoryView(project('epsilon'))).candidates).toEqual([]);
    expect(await queueProjectFact(ref, TOKEN, 'e1')).toBe(true);
    expect(await waiting('epsilon')).toEqual([TOKEN]);
  });
});
