/**
 * 记忆 / 判官 / human 的遥测落点(契约 §7 daily_memory、daily_judge、daily_human):真 SQLite + 临时 TANGU_HOME,走真的写口,看账本里落了什么。
 * 账本里只有枚举键和次数:记忆原文只在本机比一下是不是同一句,比完只记次数。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { configureTangu } from '../seams/runtime.js';
import { currentAgentSlug } from '../seams/runContext.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { runMigration } from '../db/migrate.js';
import { STANDALONE_SCHEMA } from '../db/schemaStandalone.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { agentsDir, humanDir } from '../core/tanguHome.js';
import { utcDay } from './telemetryLedger.js';
import { createMemoryRepository, type MemorySnapshot } from './memoryRepository.js';
import { countRemember, noteRetell, noteUserDocumentEdit, noteUserEntryEdit, noteUserRestore } from './memoryTelemetry.js';
import { snapshotHuman, snapshotMemory } from './telemetrySnapshot.js';
import { noteColdstartPersonWrite } from './humanTelemetry.js';
import { appendCandidates } from './memoryCandidates.js';
import { configureMemoryDream, getMemoryDream, resetMemoryDreamForTests, startMemoryDream } from './memoryDream.js';
import { correctionVerdict, CORRECTION_SIGNAL, NUDGE_SIGNAL, noteRunSignals, noteUserStop, resetJudgeSignals, toolLoopSignal } from './judgeSignals.js';
import { applyHarnessEdit } from '../agents/harnessStore.js';
import { readHuman, writeHuman } from '../agents/humanStore.js';
import { mutatePortrait } from '../agents/humanPortrait.js';
import { saveAgent } from '../agents/agentRegistry.js';

const DAY = 86_400_000;
let db: Database.Database;
let home: string;
let prevHome: string | undefined;
let provider: (payload: any) => any;

const result = (content: unknown) => ({ content: JSON.stringify(content), toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const repoOf = (slug: string) => createMemoryRepository(join(agentsDir(), slug));

beforeEach(async () => {
  prevHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'tangu-ledger-mem-'));
  process.env.TANGU_HOME = home;
  const made = createSqliteHost({ dataDir: 'memory', localToken: 't', userId: 'u' });
  db = made.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  provider = (payload) => payload.messages[0].content.startsWith('Consolidate')
    ? result({ groups: JSON.parse(payload.messages[1].content).map((s: any) => ({ fact: s.fact, sourceIds: [s.id] })), discarded: [] })
    : result({ ok: true });
  configureTangu({
    host: { ...made.host, log: () => {}, warn: () => {} }, profile: createTanguProfile({ sandboxMode: 'none' }),
    billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    brain: {
      memory: {
        getMemorySnapshot: async () => repoOf(currentAgentSlug()!).snapshot(),
        commitMemory: async (_u: string, input: any) => repoOf(currentAgentSlug()!).commit(input),
      },
      llm: {
        resolveModelAndKey: async () => ({ model: { name: 'test', provider: 'test' }, apiKey: 'k', baseUrl: '', apiModelId: 'test' }),
        buildProviderPayload: async (p: any) => p,
        streamProviderCompletion: async (p: any) => provider(p.payload),
      },
    } as any,
  });
  await runMigration();
  resetJudgeSignals();
});
afterEach(() => {
  resetMemoryDreamForTests();
  db.close();
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const cell = (event: string, field: string, dim = '', day = utcDay()) =>
  (db.prepare(`SELECT n FROM telemetry_ledger WHERE day = ? AND event = ? AND dim = ? AND field = ?`).get(day, event, dim, field) as any)?.n;
const allText = () => JSON.stringify(db.prepare(`SELECT * FROM telemetry_ledger`).all());

describe('daily_memory', () => {
  it('提交来源按 agentRole 计;项目记忆等别的目录不计', async () => {
    repoOf('coding').add('Use pnpm here', { source: { kind: 'explicit' } });
    repoOf('my-private-agent').add('The user likes tea', { source: { kind: 'historian' } });
    createMemoryRepository(join(home, 'projects', 'p1')).add('Project fact', { source: { kind: 'manual' } });
    await settle();
    expect(cell('daily_memory', 'srcExplicit', 'coding')).toBe(1);
    expect(cell('daily_memory', 'srcHistorian', 'custom')).toBe(1);
    expect(cell('daily_memory', 'srcManual', 'custom')).toBeUndefined();
    expect(allText()).not.toContain('my-private-agent');
  });

  it('remember 回执分类:写成的按 action × scope,原样已有的 add 不算写入,错误分三类', async () => {
    const run = (out: string, args: any = { action: 'add', fact: 'x' }) => countRemember('xyra', args, async () => out);
    await run(JSON.stringify({ ok: true, action: 'add', scope: 'agent' }));
    await run(JSON.stringify({ ok: true, action: 'add', scope: 'project', duplicate: true }));
    await run(JSON.stringify({ ok: true, action: 'add', scope: 'person', duplicate: true }));
    await run(JSON.stringify({ ok: true, action: 'update', scope: 'project', moved: { from: 'agent' } }), { action: 'update', fact: 'y' });
    await run(JSON.stringify({ ok: true, action: 'forget', scope: 'agent' }), { action: 'forget' });
    await run('Error: long-term memory is full (5000/5000 characters).');
    await run('Error: the portrait is full (900/900 characters, the part every agent reads).');
    await run('Error: expectedVersion is not current. Nothing was written.');
    await run('Error: expectedVersion is required; use action list first'); // 缺参数,不是冲突
    await expect(countRemember('xyra', {}, async () => { throw Object.assign(new Error('c'), { code: 'MEMORY_VERSION_CONFLICT' }); })).rejects.toThrow();
    await settle();
    expect(cell('daily_memory', 'addAgent', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'addProject', 'xyra')).toBeUndefined();
    expect(cell('daily_memory', 'retellExisting', 'xyra')).toBe(1); // 画像那条重复
    expect(cell('daily_memory', 'updateProject', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'moveScope', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'forgetAgent', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'errFull', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'errPortraitFull', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'errVersionConflict', 'xyra')).toBe(2);
  });

  it('重述:与现有条目归一后相同 / 被忘过;同一个 run 刚写的不算', async () => {
    const repo = repoOf('aria');
    repo.add('User prefers short answers.', { source: { kind: 'explicit', runId: 'r1' } });
    repo.add('User lives in Berlin.', { source: { kind: 'explicit', runId: 'r0' } });
    const s = repo.snapshot();
    repo.forget(s.entries.find((e) => e.content.includes('Berlin'))!.id, { expectedVersion: s.version });
    const before = repo.snapshot();
    noteRetell('aria', before, '- user prefers  SHORT answers.', 'r2');
    noteRetell('aria', before, 'User prefers short answers.', 'r1'); // 同 run
    noteRetell('aria', before, 'User lives in Berlin.', 'r3');
    await settle();
    expect(cell('daily_memory', 'retellExisting', 'aria')).toBe(1);
    expect(cell('daily_memory', 'retellForgotten', 'aria')).toBe(1);
  });

  it('用户改 / 删 Agent 7 天内写的条目单记;整份编辑按 id 比;还原越过 Dream 的单记', async () => {
    const recent = { id: 'a', content: 'x', createdAt: Date.now() - DAY, source: { kind: 'historian' } } as any;
    const old = { id: 'b', content: 'y', createdAt: Date.now() - 9 * DAY, source: { kind: 'explicit' } } as any;
    const mine = { id: 'c', content: 'z', createdAt: Date.now(), source: { kind: 'manual' } } as any;
    noteUserEntryEdit('xyra', 'update', recent);
    noteUserEntryEdit('xyra', 'forget', old);
    noteUserEntryEdit('xyra', 'forget', mine);
    noteUserEntryEdit('xyra', 'add', undefined);
    const snap = (entries: any[]) => ({ entries } as MemorySnapshot);
    noteUserDocumentEdit('xyra', snap([recent, old, mine]), snap([old, { id: 'd', content: 'w' }]));
    const revisions = [{ version: 'v3', source: { kind: 'manual' } }, { version: 'v2', source: { kind: 'dream' } }, { version: 'v1', source: { kind: 'explicit' } }] as any;
    noteUserRestore('xyra', revisions, 'v1', snap([{ id: 'k', content: 'kept' }]), snap([{ id: 'k', content: 'kept' }, { id: 'r', content: 'retired by dream' }]));
    noteUserRestore('xyra', revisions, 'v2', snap([]), snap([{ id: 'q', content: 'q' }])); // 之后没有 Dream
    await settle();
    expect(cell('daily_memory', 'userEdit', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'userEditAgentWritten7d', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'userForget', 'xyra')).toBe(2 + 2);
    expect(cell('daily_memory', 'userForgetAgentWritten7d', 'xyra')).toBe(1);
    expect(cell('daily_memory', 'userAdd', 'xyra')).toBe(2);
    expect(cell('daily_memory', 'userRestoreDreamRetired', 'xyra')).toBe(1);
  });

  it('Dream:来源、结局、调用次数、结构化的数;核验不过记 dreamVerifyFail', async () => {
    configureMemoryDream('recita', { modelId: 'test-model' });
    repoOf('recita').add('Existing fact');
    const sid = 's-dream';
    db.prepare('INSERT INTO chat_sessions (id,user_id,app_id,title,agent_config) VALUES (?,?,?,?,?)').run(sid, 'u', 'tangu', 't', JSON.stringify({ agentSlug: 'recita' }));
    db.prepare('INSERT INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run('m1', sid, 'user', 'I prefer Chinese replies', 1);
    appendCandidates('recita', sid, ['User prefers Chinese replies'], { anchorMessageId: 'm1' });
    startMemoryDream('u', 'recita', { trigger: 'archive' });
    for (let i = 0; i < 400 && getMemoryDream('recita').status.running; i++) await new Promise((r) => setTimeout(r, 25));
    expect(getMemoryDream('recita').status).toMatchObject({ state: 'completed' });
    await settle();
    expect(cell('daily_memory', 'dreamArchive', 'recita')).toBe(1);
    expect(cell('daily_memory', 'dreamCompleted', 'recita')).toBe(1);
    expect(cell('daily_memory', 'dreamCalls', 'recita')).toBe(2);
    expect(cell('daily_memory', 'dreamSources', 'recita')).toBe(2);
    expect(cell('daily_memory', 'dreamGroups', 'recita')).toBe(2);
    expect(cell('daily_memory', 'dreamMerges', 'recita')).toBeUndefined();
    expect(cell('daily_memory', 'srcDream', 'recita')).toBe(1);

    provider = (payload) => payload.messages[0].content.startsWith('Consolidate')
      ? result({ groups: JSON.parse(payload.messages[1].content).map((s: any) => ({ fact: s.fact, sourceIds: [s.id] })), discarded: [] })
      : result({ ok: false, reason: 'no' });
    startMemoryDream('u', 'recita');
    for (let i = 0; i < 400 && getMemoryDream('recita').status.running; i++) await new Promise((r) => setTimeout(r, 25));
    expect(getMemoryDream('recita').status.state).toBe('failed');
    await settle();
    expect(cell('daily_memory', 'dreamManual', 'recita')).toBe(1);
    expect(cell('daily_memory', 'dreamVerifyFail', 'recita')).toBe(1);
    expect(cell('daily_memory', 'dreamFailed', 'recita')).toBe(1);
  });

  it('工作笔记的改动按谁写的计', async () => {
    await applyHarnessEdit('coding', { action: 'upsert', title: 'Read first', body: 'Read the file before answering.', evidence: 'Checked line 2.' });
    await applyHarnessEdit('coding', { action: 'upsert', title: 'Run tests', body: 'Run the tests after edits.', evidence: 'Failed once.' }, { by: 'user' });
    await settle();
    expect(cell('daily_memory', 'harnessUpsertAgent', 'coding')).toBe(1);
    expect(cell('daily_memory', 'harnessUpsertUser', 'coding')).toBe(1);
  });

  it('每日快照:按角色汇总;没有状态文件的记忆目录不读、不写', async () => {
    await saveAgent({ slug: 'helper', name: 'Helper', systemPrompt: 'Help.' } as any);
    await saveAgent({ slug: 'fresh', name: 'Fresh', systemPrompt: 'Help.' } as any); // 还没读过记忆(没有状态文件)
    repoOf('helper').add('One');
    repoOf('helper').add('Two');
    await snapshotMemory();
    await settle();
    expect(cell('daily_memory', 'gEntries', 'custom')).toBe(2);
    expect(cell('daily_memory', 'gCandidatesPending', 'custom')).toBe(0);
    expect(cell('daily_memory', 'gHarnessEntries', 'custom')).toBe(0);
    expect(allText()).not.toMatch(/helper|fresh/);
  });
});

describe('daily_judge', () => {
  it('信号:按停(够 3 个工具才算)、催办、工具死循环、纠正(决策闸 / 词面分开)', async () => {
    noteUserStop('s1', ['a', 'b']);
    noteUserStop('s1', ['a', 'b', 'c']);
    noteRunSignals([NUDGE_SIGNAL, toolLoopSignal(['read_file']), CORRECTION_SIGNAL], false);
    noteRunSignals([CORRECTION_SIGNAL], true); // 问过决策闸:这里不重复记
    await correctionVerdict({ decide: async () => ({ answers: { correction: { noul: 0.9 } } }) } as any, 'prev', 'no, that is wrong');
    await correctionVerdict({ decide: async () => { throw new Error('down'); } } as any, 'prev', 'no, that is wrong');
    await correctionVerdict({ decide: async () => ({ answers: { correction: { noul: 0.1 } } }) } as any, 'prev', 'thanks');
    await settle();
    expect(cell('daily_judge', 'signalStop')).toBe(1);
    expect(cell('daily_judge', 'signalNudge')).toBe(1);
    expect(cell('daily_judge', 'signalToolLoop')).toBe(1);
    expect(cell('daily_judge', 'signalCorrectionDecision')).toBe(1);
    expect(cell('daily_judge', 'signalCorrectionLexical')).toBe(2);
  });
});

describe('daily_human', () => {
  it('写入按 actor × 目标与来源计;人 7 天内撤回 Agent 写的单记;原文不进账本', async () => {
    const doc = await readHuman({ kind: 'human', file: 'HUMAN.md' });
    const w = await writeHuman({ kind: 'human', file: 'HUMAN.md' }, { content: '- Send the brief before noon\n', expectedVersion: doc.version, summary: 'add', evidence: 'late briefs twice' }, 'agent');
    await writeHuman({ kind: 'human', file: 'HUMAN.md' }, { expectedVersion: w.document.version, undoId: w.change!.id }, 'user');
    await mutatePortrait({ action: 'add', fact: 'The user is a nurse.', actor: 'agent', source: { kind: 'remember', agent: 'xyra' } });
    await settle();
    expect(cell('daily_human', 'wAgentShared')).toBe(1);
    expect(cell('daily_human', 'wUserShared')).toBe(1);
    expect(cell('daily_human', 'userUndoAgentWrite7d')).toBe(1);
    expect(cell('daily_human', 'wAgentPortrait')).toBe(1);
    expect(cell('daily_human', 'srcRemember')).toBe(1);
    expect(allText()).not.toMatch(/nurse|brief/);
  });

  it('冷启动:建好 7 天内往画像写的计数,共识里已有的算重学', async () => {
    mkdirSync(humanDir(), { recursive: true });
    writeFileSync(join(humanDir(), 'HUMAN.md'), '- Reply in Chinese\n');
    noteColdstartPersonWrite(new Date(Date.now() - DAY).toISOString(), 'reply in chinese', false);
    noteColdstartPersonWrite(new Date(Date.now() - DAY).toISOString(), 'Works night shifts', false);
    noteColdstartPersonWrite(new Date(Date.now() - 9 * DAY).toISOString(), 'Old agent', false);
    await settle();
    expect(cell('daily_human', 'coldstartPersonWrites')).toBe(2);
    expect(cell('daily_human', 'coldstartRelearned')).toBe(1);
  });

  it('每日快照:条数与行数;读不懂的日历不写 0', async () => {
    mkdirSync(humanDir(), { recursive: true });
    writeFileSync(join(humanDir(), 'HUMAN.md'), '# Notes\n- one\n- two\n\ntext\n');
    writeFileSync(join(humanDir(), 'CALENDAR.db'), '{not json');
    await snapshotHuman();
    await settle();
    expect(cell('daily_human', 'gHumanMdEntries')).toBe(2);
    expect(cell('daily_human', 'gCalendarRows')).toBeUndefined();
    expect(cell('daily_human', 'gAgentsTotal')).toBeGreaterThanOrEqual(0);
  });
});
