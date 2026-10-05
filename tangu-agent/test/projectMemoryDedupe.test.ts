/**
 * 项目记忆:换了说法的重复(10-05)。
 * 钉的病理:项目记忆没有 Dream 那样的整理步骤,落库去重只认一字不差 —— 同一件事跨会话换个说法就再记一条;
 * 而判官认「这件事已经记过」靠的那段 [Project memory],以前是「条目 + 候选」拼成一串截最后 1500 字,候选一多条目就整个被挤出去。
 *   ① 给判官看的那一段:条目与候选各有额度,候选再多条目也在;放不下时留新的并写明少了几条;
 *   ② 词面闸(不用模型,只认最保险的一种):新的一句是已有某条里连着的一段原话 → 不另记;多说了东西(补充 / 更正)、
 *      拼出来的另一句话、已有那条多出来的部分带否定或限定的,都照记;太短的不判;
 *   ③ 后台写入:被说全了的不写;把后台自己以前记的那条说全了还多说 → 就地换(同一个 id);用户 / 前台记的不改写;
 *      待确认清单同理:已有条目、排着的或丢弃过的候选里已有这段原话 → 不再排;
 *   ④ 前台 remember(scope=project):被说全了的不另记,回执里把已有那条给模型;agent 级不走这道。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import {
  addProjectFact, coveringProjectEntry, openProjectMemory, pendingProjectFacts, projectKnownForJudge, queueProjectFact, resolveProjectMemory,
  PROJECT_KNOWN_ENTRY_CHARS, PROJECT_KNOWN_PROPOSED_CHARS,
} from '../src/services/projectMemory.js';

let home: string, work: string, database: any;
let seq = 0;
let sid = '';
const previousHome = process.env.TANGU_HOME;
const remember = memoryLogProvider.tools().find((t) => t.name === 'remember')!;
const call = (sessionId: string, args: Record<string, unknown>) =>
  runWithAgentSlug('xyra', async () => String(await remember.execute(args, { userId: 'owner', sessionId, appId: 'tangu', execMode: 'host', runId: `run-${sessionId}` } as any)));
const ref = async () => (await resolveProjectMemory('owner', sid))!;
const facts = async (): Promise<string[]> => (await openProjectMemory(await ref())).snapshot().entries.map((e) => e.content);

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-projmem-dedupe-'))); process.env.TANGU_HOME = home;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-projmem-dedupe-work-')));
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});
// 每条用例一个新项目(一份空的项目记忆)
beforeEach(() => {
  const n = ++seq;
  sid = `s-${n}`;
  mkdirSync(join(work, `p${n}`));
  database.prepare('INSERT INTO chat_sessions (id, user_id, app_id, title, project_path, projectless) VALUES (?, ?, ?, ?, ?, 0)').run(sid, 'owner', 'tangu', sid, join(work, `p${n}`));
});

describe('① 给判官看的「已经记着的 / 已经提过的」', () => {
  it('候选再多,已有条目一条不少(以前拼成一串截尾,条目会被整个挤出去)', () => {
    const entries = Array.from({ length: 20 }, (_, i) => `Saved fact number ${i} about the build pipeline`);
    const proposed = Array.from({ length: 50 }, (_, i) => `Proposed fact number ${i} that the user has not confirmed, padded so that the list is long enough to matter`);
    const out = projectKnownForJudge(entries, proposed);
    for (const e of entries) expect(out).toContain(`- ${e}`);
    expect(out.indexOf('- Saved fact number 0 ')).toBeLessThan(out.indexOf('Already proposed'));
    expect(out).toContain(`- ${proposed[49]}`);              // 候选留新的
    expect(out).not.toContain(`- ${proposed[0]}`);
    expect(out).toMatch(/\(\d+ older proposals not shown\)/);
    expect(out.length).toBeLessThanOrEqual(PROJECT_KNOWN_ENTRY_CHARS + PROJECT_KNOWN_PROPOSED_CHARS + 200);
  });
  it('条目放不下:留新的,写明少了几条;什么都没有 → 空串', () => {
    const entries = Array.from({ length: 60 }, (_, i) => `Entry ${i}: ${'x'.repeat(120)}`);
    const out = projectKnownForJudge(entries, []);
    expect(out).toContain(`- ${entries[59]}`);
    expect(out).not.toContain(`- ${entries[0]}`);
    const hidden = Number(out.match(/^\((\d+) older saved entries not shown\)/)?.[1]);
    expect(hidden).toBeGreaterThan(0);
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(60 - hidden);
    expect(out).not.toContain('Already proposed');
    expect(projectKnownForJudge([], [])).toBe('');
  });
});

describe('② 词面闸:新的一句是已有某条里连着的一段原话才算重复', () => {
  const e = (content: string) => ({ content });
  it('少说几个字 / 截了半句 / 只差标点 → 已有那条把它说全了', () => {
    const long = e('用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。');
    expect(coveringProjectEntry([long], '用户的项目都使用 pnpm。')).toBe(long);
    const en = e('Tests here run with npm run test:unit from the tangu-agent folder.');
    expect(coveringProjectEntry([en], 'Tests here run with npm run test:unit')).toBe(en);
    const dot = e('Deploys go out on Fridays.');
    expect(coveringProjectEntry([dot], 'Deploys go out on Fridays')).toBe(dot);
    const tail = e('周报每周四下午发给组长，抄送给项目经理');
    expect(coveringProjectEntry([tail], '抄送给项目经理')).toBe(tail);
  });
  it('多说了东西(补充 / 更正)不算:哪怕只多一个词', () => {
    expect(coveringProjectEntry([e('用户的项目都使用 pnpm。')], '用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。')).toBeNull();
    expect(coveringProjectEntry([e('The default branch is main')], 'The default branch is master')).toBeNull();
    expect(coveringProjectEntry([e('部署到预发环境用 deploy.sh --env staging')], '部署到预发环境用 deploy.sh --env prod')).toBeNull();
    expect(coveringProjectEntry([e('周报每周四下午发给组长')], '周报每周五下午发给组长')).toBeNull();
    expect(coveringProjectEntry([e('提交说明用英文，并以 fix: 这类前缀开头')], '提交说明用中文')).toBeNull();
  });
  // 词都在、但不是连着的一段:那是把两处的词拼成了另一句话
  it('词都在别的条目里、却不是连着的一段原话 → 不算', () => {
    expect(coveringProjectEntry([e('Run tests with vitest in tangu-agent and with jest in server')], 'Run tests with jest in tangu-agent')).toBeNull();
    expect(coveringProjectEntry([e('部署到预发环境用 A 脚本，部署到生产环境用 B 脚本')], '部署到生产环境用 A 脚本')).toBeNull();
    expect(coveringProjectEntry([e('Tests run with vitest'), e('Deploys go out on Fridays')], 'Tests go out on Fridays with vitest')).toBeNull();
  });
  // 已有那条多出来的部分带否定 / 转折 / 限定:那段原话的意思可能正相反
  it('已有那条多出来的部分带否定、限定 → 不算(意思可能正相反)', () => {
    expect(coveringProjectEntry([e('不要用 npm 安装依赖')], '用 npm 安装依赖')).toBeNull();
    expect(coveringProjectEntry([e('Never deploy from main on Fridays')], 'Deploy from main on Fridays')).toBeNull();
    expect(coveringProjectEntry([e("Don't run the migration script on the staging box")], 'Run the migration script on the staging box')).toBeNull();
    expect(coveringProjectEntry([e('Deploy from main on Fridays only when the release manager signs off')], 'Deploy from main on Fridays')).toBeNull();
    expect(coveringProjectEntry([e('用 npm 安装依赖是不行的')], '用 npm 安装依赖')).toBeNull();
  });
  it('太短的不判;一字不差(只差大小写 / 空白)的不归它管', () => {
    expect(coveringProjectEntry([e('这个项目用 npm，也用 pnpm')], '用 npm')).toBeNull();
    expect(coveringProjectEntry([e('Deploys go out on Fridays')], 'deploys go out on  fridays')).toBeNull();
  });
});

describe('③ 后台写入(addProjectFact)', () => {
  it('被已有条目说全了的不写', async () => {
    expect(await addProjectFact(await ref(), '用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。', 'other')).toBe('added');
    expect(await addProjectFact(await ref(), '用户的项目都使用 pnpm。', sid)).toBe('duplicate');
    expect(await facts()).toEqual(['用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。']);
  });
  it('把后台自己以前记的那条说全了还多说 → 就地换成新的:同一个 id,两个会话的记号都在', async () => {
    expect(await addProjectFact(await ref(), '用户的项目都使用 pnpm。', 'first')).toBe('added');
    const repo = await openProjectMemory(await ref());
    const old = repo.snapshot().entries[0];
    expect(await addProjectFact(await ref(), '用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。', 'second')).toBe('added');
    const now = repo.snapshot().entries;
    expect(now.map((x) => x.content)).toEqual(['用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。']);
    expect(now[0].id).toBe(old.id);
    expect(now[0].evidenceIds).toEqual(expect.arrayContaining(['session:first', 'session:second']));
    expect(now[0].source).toMatchObject({ kind: 'historian', sessionId: 'second' });
  });
  it('用户 / 前台记的条目后台不改写:多说了东西就另记一条', async () => {
    const repo = await openProjectMemory(await ref());
    repo.mutate({ action: 'add', fact: '用户的项目都使用 pnpm。', source: { kind: 'explicit', sessionId: 'another-session' } });
    const mine = repo.snapshot().entries[0];
    expect(await addProjectFact(await ref(), '用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。', sid)).toBe('added');
    const now = repo.snapshot().entries;
    expect(now.map((x) => x.content)).toEqual(['用户的项目都使用 pnpm。', '用户的项目都使用 pnpm；提供项目命令时应优先给出 pnpm 命令。']);
    expect(now[0]).toMatchObject({ id: mine.id, source: { kind: 'explicit' } });
  });
  it('后台以前记的那条被新的一句否定了 → 不就地换,另记一条(分不清是更正还是另一件事)', async () => {
    expect(await addProjectFact(await ref(), '用 npm 安装这个项目的依赖', 'first')).toBe('added');
    expect(await addProjectFact(await ref(), '不要用 npm 安装这个项目的依赖', sid)).toBe('added');
    expect(await facts()).toEqual(['用 npm 安装这个项目的依赖', '不要用 npm 安装这个项目的依赖']);
  });
  it('待确认清单:已有条目里、排着的或丢弃过的候选里已有这段原话 → 不再排;别的照排', async () => {
    const r = await ref();
    (await openProjectMemory(r)).mutate({ action: 'add', fact: 'Fetch the fixtures from https://example.test/fixtures before running the suite.' });
    expect(await queueProjectFact(r, 'Fetch the fixtures from https://example.test/fixtures', sid)).toBe(false);
    expect(await queueProjectFact(r, 'Install the signing tool from https://example.test/sign and run it before every release.', 'other')).toBe(true);
    expect(await queueProjectFact(r, 'Install the signing tool from https://example.test/sign', sid)).toBe(false);
    expect(pendingProjectFacts(r)).toHaveLength(1);
    expect(await queueProjectFact(r, 'Install the notarising tool from https://example.test/notary', sid)).toBe(true);
    expect(pendingProjectFacts(r)).toHaveLength(2);
  });
  it('更正(多一个不同的词)照记,不被闸掉', async () => {
    expect(await addProjectFact(await ref(), 'The default branch is main', 'first')).toBe('added');
    expect(await addProjectFact(await ref(), 'The default branch is master', sid)).toBe('added');
    expect(await facts()).toEqual(['The default branch is main', 'The default branch is master']);
  });
});

describe('④ 前台 remember(scope=project)', () => {
  it('被已有条目说全了的不另记:回执标 duplicate 并把已有那条给模型;换个不同的事实照记', async () => {
    const first = JSON.parse(await call(sid, { action: 'add', scope: 'project', fact: 'Tests here run with npm run test:unit from the tangu-agent folder.' }));
    expect(first).toMatchObject({ ok: true, count: 1 });
    const again = JSON.parse(await call(sid, { action: 'add', scope: 'project', fact: 'Tests here run with npm run test:unit' }));
    expect(again).toMatchObject({ ok: true, scope: 'project', duplicate: true, count: 1, version: first.version });
    expect(again.note).toContain('nothing was written');
    expect(again.entry).toMatchObject({ id: first.entry.id });
    expect(await facts()).toHaveLength(1);
    expect(JSON.parse(await call(sid, { action: 'add', scope: 'project', fact: 'Deploys go out on Fridays from the release branch' }))).toMatchObject({ ok: true, count: 2 });
  });
  it('agent 级不走这道(那边有 Dream 归并)', async () => {
    expect(JSON.parse(await call(sid, { action: 'add', scope: 'agent', fact: 'The user writes commit messages in English, with a fix: style prefix.' }))).toMatchObject({ ok: true, scope: 'agent' });
    const again = JSON.parse(await call(sid, { action: 'add', scope: 'agent', fact: 'The user writes commit messages in English' }));
    expect(again.duplicate).toBeUndefined();
    expect(again.count).toBe(2);
  });
});
