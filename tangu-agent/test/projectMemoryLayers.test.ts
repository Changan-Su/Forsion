/** 项目记忆分层(11-09 2b,方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09):写满压缩改成「先挪进详情,再丢过时的」、
 *  整理中断续做与整次撤销、注入(常驻 + 索引 + 按这句话召回、去重、归档不召回)、挪走的别再记回来、图钉、老目录合并带上 Library/。模型是替身。 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';
import type { MemorySource } from '../src/services/memoryRepository.js';
import {
  addProjectFact, buildProjectMemoryLayers, openProjectMemory, pinProjectMemory, projectMemoryView, resetProjectMemoryAbsorbForTests, resolveProjectMemory,
  undoProjectOrganize, PROJECT_MEMORY_CHAR_BUDGET, type ProjectMemoryRef,
} from '../src/services/projectMemory.js';
import { COMPACT_ACCEPT_CHARS, organizeProjectMemory, resetProjectMemoryCompactionForTests, resetProjectMemoryOrganizeForTests } from '../src/services/projectMemoryCompact.js';
import { crashOrganizeAfterForTests } from '../src/services/agentMemoryLayers.js';
import { flushMemoryUseForTests } from '../src/services/memoryUsage.js';

let home: string, work: string, database: any;
const previousHome = process.env.TANGU_HOME;
let n = 0;
const fresh = async (): Promise<{ project: string; sessionId: string; ref: ProjectMemoryRef }> => {
  const name = `q${++n}`; const project = join(work, name); const sessionId = `s-${name}`;
  mkdirSync(project);
  database.prepare('INSERT INTO chat_sessions (id, user_id, app_id, title, project_path, projectless) VALUES (?, ?, ?, ?, ?, 0)').run(sessionId, 'owner', 'tangu', sessionId, project);
  return { project, sessionId, ref: (await resolveProjectMemory('owner', sessionId))! };
};

// ── 模型替身:按系统提示分两种(第一段分堆 / 第二段压缩),回什么由用例定 ──
type OrganizeInput = { limit: number; now: number; target: number; entries: Array<{ id: string; text: string; by: string; pinned: boolean }>; topics: unknown[] };
type CompactInput = { budget: number; entries: Array<{ id: string; fact: string; by: string }>; fixed: string[] };
let calls: Array<{ kind: 'organize' | 'compact'; input: any }>;
let organizeAnswer: (input: OrganizeInput) => unknown;
let compactAnswer: (input: CompactInput) => unknown;

const CMD = 'Run the dev stack with make dev; it starts postgres and redis first.';
const HIST = '2026-08 the queue moved from RabbitMQ to NATS because RabbitMQ used over 2 GB of memory on ARM servers.';
const PROG = '11-03 order export is half done; pagination comes next.';
const MINE = 'Never commit generated files under dist/.';
const RISKY = 'Staging lives at https://staging.example.test/app.';
const filler = (i: number): string => `Background note ${String(i).padStart(2, '0')}: ${'how the billing module grew over the years. '.repeat(5)}`.slice(0, 240);
const idOf = (input: OrganizeInput, has: string): string => input.entries.find((e) => e.text.includes(has))!.id;
const HISTORY_TOPIC = { key: 'history', title: 'History', about: 'Why the stack looks the way it does: past decisions and their reasons' };
/** 合格的分堆:来龙去脉和背景都挪进 history,进度归档,人写的那条也想归档(闸会拦下,留常驻),命令留常驻。 */
const goodPlan = (input: OrganizeInput): unknown => ({
  keep: [idOf(input, 'make dev')],
  move: input.entries.filter((e) => e.text.startsWith('Background') || e.text.includes('RabbitMQ')).map((e) => ({ id: e.id, topic: 'history' })),
  archive: [idOf(input, 'order export'), idOf(input, 'generated files')],
  topics: [HISTORY_TOPIC],
});

async function seed(ref: ProjectMemoryRef, sessionId: string, fillers = 16): Promise<Record<string, string>> {
  const repo = await openProjectMemory(ref);
  const add = (fact: string, source: MemorySource): void => { repo.mutate({ action: 'add', fact, cap: 20_000, source }); };
  add(CMD, { kind: 'explicit', sessionId, runId: 'r0' });
  add(HIST, { kind: 'historian', sessionId });
  add(PROG, { kind: 'historian', sessionId });
  add(MINE, { kind: 'manual' });
  add(RISKY, { kind: 'explicit', sessionId, runId: 'r0' });
  for (let i = 1; i <= fillers; i++) add(filler(i), { kind: 'historian', sessionId });
  return Object.fromEntries(repo.snapshot().entries.map((e) => [e.content, e.id]));
}
/** 测试里没配后台模型:用调用方给的(同前台排整理时传当前 run 的模型)。 */
const org = (ref: ProjectMemoryRef, opts: { manual?: boolean } = {}) => organizeProjectMemory('owner', ref, { fallbackModelId: 'run-model', ...opts });
const residentTexts = async (project: string): Promise<string[]> => (await projectMemoryView(project)).entries.map((e) => e.content);

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-project-layers-'))); process.env.TANGU_HOME = home;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-project-layers-work-')));
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }), llm: {
      resolveModelAndKey: async (id: string) => ({ model: { name: id, provider: 'test' }, apiKey: 'k', baseUrl: '', apiModelId: id }),
      buildProviderPayload: async (p: any) => p,
      streamProviderCompletion: async (o: any) => {
        const system = String(o.payload.messages[0].content);
        const input = JSON.parse(o.payload.messages[1].content);
        const kind = system.startsWith('Compact') ? 'compact' : 'organize';
        calls.push({ kind, input });
        const out = kind === 'compact' ? compactAnswer(input) : organizeAnswer(input);
        return { content: typeof out === 'string' ? out : JSON.stringify(out), usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    } } as any,
  });
  await runMigration();
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { calls = []; organizeAnswer = goodPlan; compactAnswer = () => 'no'; resetProjectMemoryCompactionForTests(); resetProjectMemoryOrganizeForTests(); });
afterEach(() => crashOrganizeAfterForTests(null));

describe('写满整理:先挪进详情,再丢过时的', () => {
  it('来龙去脉挪进 Library/<主题>.md(原句一字不改),进度归档;人写的只挪不归档;过不了形状闸的不给模型看;挪完够了就不叫压缩', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    expect((await projectMemoryView(project)).chars).toBeGreaterThan(PROJECT_MEMORY_CHAR_BUDGET);
    const out = await org(ref);
    expect(out).toMatchObject({ status: 'organized', moved: 17, archived: 1 });
    expect(out.status === 'organized' && out.compacted).toBeFalsy();
    expect(calls.map((c) => c.kind)).toEqual(['organize']);
    const shown: OrganizeInput = calls[0].input;
    expect(shown.entries.map((e) => e.text)).not.toContain(RISKY);
    expect(shown.entries.find((e) => e.text === MINE)).toMatchObject({ by: 'user' });
    expect(shown.entries.find((e) => e.text === HIST)).toMatchObject({ by: 'agent' });
    expect(await residentTexts(project)).toEqual([CMD, MINE, RISKY]);
    const history = readFileSync(join(ref.dir, 'Library', 'history.md'), 'utf8');
    expect(history).toContain(`# History\n\n${HISTORY_TOPIC.about}\n`);
    expect(history).toContain(`- ${HIST} <!--tg by=agent-->`);
    expect(readFileSync(join(ref.dir, 'Library', 'archive.md'), 'utf8')).toContain(`- ${PROG} <!--tg by=agent-->`);
    const view = await projectMemoryView(project);
    expect(view.chars).toBeLessThanOrEqual(COMPACT_ACCEPT_CHARS);
    expect(view.topics).toEqual([expect.objectContaining({ key: 'history', title: 'History', path: 'Library/history.md', about: HISTORY_TOPIC.about })]);
    expect(view.topics![0].entries).toHaveLength(17);
    expect(view.archive!.entries.map((e) => e.text)).toEqual([PROG]);
    expect(view.organizeHistory).toEqual([expect.objectContaining({ moved: 17, archived: 1, topics: ['history', 'archive'] })]);
  });

  it('整次撤销:挪走的、归档的都放回常驻,详情文件收掉', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    const before = await residentTexts(project);
    await org(ref);
    const id = (await projectMemoryView(project)).organizeHistory![0].id;
    const r = await undoProjectOrganize(project, id);
    expect(r.changed).toEqual([]);
    expect([...(await residentTexts(project))].sort()).toEqual([...before].sort());
    expect(existsSync(join(ref.dir, 'Library', 'history.md'))).toBe(false);
    expect(existsSync(join(ref.dir, 'Library', 'archive.md'))).toBe(false);
    expect((await projectMemoryView(project)).organizeHistory![0].undoneAt).toBeGreaterThan(0);
  });

  it('中途断了(详情写好、常驻还没删):下次读的时候接着做完,不会两边都有、也不会丢', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    crashOrganizeAfterForTests('writing');
    const out = await org(ref);
    expect(out).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(readFileSync(join(ref.dir, 'MEMORY.md'), 'utf8')).toContain(HIST); // 常驻还没删
    expect(readFileSync(join(ref.dir, 'Library', 'history.md'), 'utf8')).toContain(HIST);
    const view = await projectMemoryView(project); // 读的路上接着做
    expect(view.entries.map((e) => e.content)).toEqual([CMD, MINE, RISKY]);
    expect(view.topics![0].entries.map((e) => e.text)).toContain(HIST);
    expect(view.organizeHistory).toHaveLength(1);
  });

  it('中断后、续做前用户改了要挪的那句(身份相同、原文不同):续做只删一字不差的那行,改过的留在常驻(Codex 评审 11-09)', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    crashOrganizeAfterForTests('writing');
    expect(await org(ref)).toMatchObject({ status: 'skipped', reason: 'failed' });
    const file = join(ref.dir, 'MEMORY.md');
    const edited = HIST.replace('RabbitMQ', 'RABBITMQ'); // 只改大小写:归一化后的身份不变
    writeFileSync(file, readFileSync(file, 'utf8').replace(HIST, edited));
    const view = await projectMemoryView(project);
    expect(readFileSync(file, 'utf8')).toContain(edited); // 盘上留着(同身份时界面 / 注入按 2a 的位置规则只给一份,改过的这句不丢)
    expect(view.topics![0].entries.map((e) => e.text)).toContain(HIST);
  });
  it('编号条目(「1. 」开头)挪得过去:详情里身份对得上,事务收场、不反复追加(Codex 评审 11-09)', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    const NUM = `1. ${HIST}`;
    const repo = await openProjectMemory(ref);
    repo.mutate({ action: 'add', fact: NUM, cap: 20_000, source: { kind: 'historian', sessionId } });
    expect(await org(ref)).toMatchObject({ status: 'organized' }); // goodPlan 把带 RabbitMQ 的两条(含编号那条)都挪进 history
    await projectMemoryView(project); await projectMemoryView(project); // 读两次:没有悬着的事务,不再追加
    expect(readFileSync(join(ref.dir, 'MEMORY.md'), 'utf8')).not.toContain(NUM);
    expect(readFileSync(join(ref.dir, 'Library', 'history.md'), 'utf8').split(NUM).length - 1).toBe(1);
    expect(existsSync(join(ref.dir, '.memory-organize.json')) && JSON.parse(readFileSync(join(ref.dir, '.memory-organize.json'), 'utf8')).pending).toBeFalsy();
  });
  it('挪完常驻还超过七成 → 才走第二段原来的压缩(它的闸照旧);第一段的挪动照样算数', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    organizeAnswer = (input) => ({ keep: [], move: [{ id: idOf(input, 'RabbitMQ'), topic: 'history' }], archive: [], topics: [HISTORY_TOPIC] });
    compactAnswer = (input) => ({ keep: input.entries.filter((e) => !e.fact.startsWith('Background')).map((e) => e.id), groups: [], discarded: input.entries.filter((e) => e.fact.startsWith('Background')).map((e) => e.id) });
    const out = await org(ref);
    expect(calls.map((c) => c.kind)).toEqual(['organize', 'compact']);
    expect(out).toMatchObject({ status: 'organized', moved: 1, archived: 0, compacted: expect.objectContaining({ before: expect.any(Object), after: expect.any(Object) }) });
    // 第二段:人写的、过不了形状闸的照旧不给它改(fixed)
    const fixed: string[] = calls[1].input.fixed;
    expect(fixed).toContain(MINE);
    expect(fixed).not.toContain(RISKY);
    const view = await projectMemoryView(project);
    expect(view.entries.map((e) => e.content)).toEqual([CMD, PROG, MINE, RISKY]);
    expect(view.topics![0].entries.map((e) => e.text)).toEqual([HIST]);
    expect(view.compacted!.removed.map((r) => r.content).filter((c) => c.startsWith('Background'))).toHaveLength(16); // 丢掉的原句逐句可恢复
  });

  it('自动排的:常驻没过线不叫模型;没整理到线内之后一段时间不再自动试(手点不受限)', async () => {
    const { ref, sessionId } = await fresh();
    await seed(ref, sessionId, 2);
    expect(await org(ref)).toMatchObject({ status: 'skipped', reason: 'under' });
    expect(calls).toHaveLength(0);
    const { ref: full, sessionId: s2 } = await fresh();
    await seed(full, s2);
    organizeAnswer = () => 'no';
    expect(await org(full)).toMatchObject({ status: 'skipped' });
    const tried = calls.length;
    expect(await org(full)).toMatchObject({ status: 'skipped', reason: 'cooldown' });
    expect(calls).toHaveLength(tried);
    organizeAnswer = goodPlan;
    expect(await org(full, { manual: true })).toMatchObject({ status: 'organized' });
  });
});

describe('注入:常驻 + 索引 + 按这句话召回', () => {
  it('稳定段 = 常驻和每份详情一行索引;易变段 = 和这句话对得上的详情;归档不召回;常驻里给过的不重复;用量记一笔', async () => {
    const { ref, sessionId } = await fresh();
    const ids = await seed(ref, sessionId);
    await org(ref);
    const quiet = await buildProjectMemoryLayers('owner', sessionId, '');
    expect(quiet.volatile).toBe('');
    expect(quiet.stable).toContain(`[project_memory_id=${ids[CMD]}] ${CMD}`);
    expect(quiet.stable).not.toContain('RabbitMQ');
    expect(quiet.stable).toContain(`- History · 17 entries — ${HISTORY_TOPIC.about} (${join(ref.dir, 'Library', 'history.md')})`);
    const asked = await buildProjectMemoryLayers('owner', sessionId, 'Why did we drop RabbitMQ? And what did order export and make dev do?');
    expect(asked.stable).toBe(quiet.stable);
    expect(asked.volatile).toContain(`[topic=history] ${HIST}`);
    expect(asked.volatile).not.toContain('order export'); // 归档的不召回
    expect(asked.volatile).not.toContain('make dev'); // 常驻里已经给了
    await flushMemoryUseForTests();
    expect(existsSync(join(ref.dir, '.memory-usage.json'))).toBe(true);
  });
});

describe('挪走的别再记回来', () => {
  const remember = memoryLogProvider.tools().find((t) => t.name === 'remember')!;
  const call = (sessionId: string, args: Record<string, unknown>) =>
    runWithAgentSlug('xyra', async () => String(await remember.execute(args, { userId: 'owner', sessionId, appId: 'tangu', execMode: 'host', runId: `run-${sessionId}`, modelId: 'run-model' } as any)));
  it('前台 remember 和后台判官:详情(含归档)里已有的一句、或已有某一条里的一段原话 → 不写进常驻', async () => {
    const { ref, sessionId, project } = await fresh();
    await seed(ref, sessionId);
    await org(ref);
    const before = await residentTexts(project);
    const receipt = JSON.parse(await call(sessionId, { action: 'add', fact: HIST, scope: 'project' }));
    expect(receipt).toMatchObject({ ok: true, duplicate: true, note: expect.stringContaining('topic "history"') });
    expect(await addProjectFact(ref, PROG, 'other-session')).toBe('duplicate'); // 归档里的
    expect(await addProjectFact(ref, 'the queue moved from RabbitMQ to NATS because RabbitMQ used over 2 GB of memory', 'other-session')).toBe('duplicate');
    expect(await residentTexts(project)).toEqual(before);
    expect(await addProjectFact(ref, 'Feature flags live in config/features.json.', 'other-session')).toBe('added');
  });
});

describe('图钉', () => {
  it('钉住常驻的一条:行尾记号,注入时去掉;详情里的钉回常驻 = 挪回来并钉住', async () => {
    const { ref, sessionId, project } = await fresh();
    const ids = await seed(ref, sessionId);
    await org(ref);
    const v0 = await projectMemoryView(project);
    const pinned = await pinProjectMemory(project, { id: ids[CMD], pinned: true, expectedVersion: v0.version! });
    expect(pinned.entries.find((e) => e.id === ids[CMD])).toMatchObject({ content: CMD, pinned: true });
    expect(readFileSync(join(ref.dir, 'MEMORY.md'), 'utf8')).toMatch(/make dev; it starts postgres and redis first\. <!--tg pin by=agent-->/);
    expect((await buildProjectMemoryLayers('owner', sessionId, '')).stable).not.toContain('<!--');
    const detail = pinned.topics![0].entries.find((e) => e.text === HIST)!;
    const back = await pinProjectMemory(project, { id: detail.id, pinned: true });
    expect(back.entries.find((e) => e.content === HIST)).toMatchObject({ pinned: true });
    expect(back.topics![0].entries.map((e) => e.text)).not.toContain(HIST);
    // 钉住的整理不碰:再整理一次,分堆方案里它是 pinned,方案要挪也挪不动
    organizeAnswer = (input) => ({ keep: [], move: input.entries.map((e) => ({ id: e.id, topic: 'history' })), archive: [], topics: [] });
    await org(ref, { manual: true });
    expect((await residentTexts(project))).toEqual(expect.arrayContaining([CMD, HIST]));
  });
});

describe('老目录并进来(absorbStrays)带上 Library/', () => {
  it('同一个仓的旧目录:详情按条并集、并过来的常驻条目已经在详情里的不再加回常驻;旧目录清空', async () => {
    const root = join(work, 'repo-absorb'); mkdirSync(join(root, '.git'), { recursive: true }); mkdirSync(join(root, 'sub'));
    // 11-03 以前按文件夹哈希建的旧目录(子文件夹那份),里面已经整理过
    const old = join(home, 'project-memory', createHash('sha256').update(join(root, 'sub')).digest('hex').slice(0, 32));
    mkdirSync(join(old, 'Library'), { recursive: true });
    writeFileSync(join(old, 'PROJECT.json'), JSON.stringify({ project: join(root, 'sub') }));
    writeFileSync(join(old, 'MEMORY.md'), `${CMD}\n${HIST}\n`);
    writeFileSync(join(old, 'Library', 'history.md'), `# History\n\n${HISTORY_TOPIC.about}\n\n- ${HIST} <!--tg by=agent-->\n- 2026-03 deploys moved to Kubernetes after a two-hour manual scale-up. <!--tg by=agent-->\n`);
    resetProjectMemoryAbsorbForTests();
    database.prepare('INSERT INTO chat_sessions (id, user_id, app_id, title, project_path, projectless) VALUES (?, ?, ?, ?, ?, 0)').run('s-absorb', 'owner', 'tangu', 's-absorb', root);
    const ref = (await resolveProjectMemory('owner', 's-absorb'))!;
    // 新目录里已经有一份 history(另一台 / 另一个 worktree 整理出来的)
    mkdirSync(join(ref.dir, 'Library'), { recursive: true });
    writeFileSync(join(ref.dir, 'Library', 'history.md'), `# History\n\n${HISTORY_TOPIC.about}\n\n- 2026-01 the repo became a pnpm workspace. <!--tg by=agent-->\n`);
    const view = await projectMemoryView(root);
    expect(view.entries.map((e) => e.content)).toEqual([CMD]);
    expect(view.topics![0].entries.map((e) => e.text).sort()).toEqual(['2026-01 the repo became a pnpm workspace.', '2026-03 deploys moved to Kubernetes after a two-hour manual scale-up.', HIST].sort());
    expect(readFileSync(join(ref.dir, 'MEMORY.md'), 'utf8')).not.toContain('RabbitMQ');
    expect(existsSync(join(old, 'Library'))).toBe(false);
  });
});
