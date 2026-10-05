/** 项目记忆写满时的压缩(10-05 用户:「参考 claude 和 codex 的做法,记忆满了就让 agent 压缩一下」):
 *  方案校验、提交与记录、逐句恢复、同一个项目只跑一次、没压成的冷却、前台 remember 写满时的接入。模型是替身。 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
import { openProjectMemory, projectMemoryView, recordProjectCompaction, resolveProjectMemory, restoreCompactedFact, PROJECT_MEMORY_CHAR_BUDGET, type ProjectMemoryRef } from '../src/services/projectMemory.js';
import { compactProjectMemory, resetProjectMemoryCompactionForTests, validateCompaction, COMPACT_ACCEPT_CHARS, COMPACT_ASK_CHARS } from '../src/services/projectMemoryCompact.js';
import { saveSpecialAgentsConfig } from '../src/services/specialAgentsConfig.js';
import { autoAdoptable } from '../src/agents/harnessStore.js';
import { redactSecrets } from '../src/core/redact.js';

let home: string, work: string, database: any;
const previousHome = process.env.TANGU_HOME;
let n = 0;
/** 每个用例一个新项目(压缩的冷却、单飞都按项目目录记)。 */
const fresh = async (): Promise<{ name: string; project: string; sessionId: string; ref: ProjectMemoryRef }> => {
  const name = `p${++n}`; const project = join(work, name); const sessionId = `s-${name}`;
  mkdirSync(project);
  database.prepare('INSERT INTO chat_sessions (id, user_id, app_id, title, project_path, projectless) VALUES (?, ?, ?, ?, ?, 0)').run(sessionId, 'owner', 'tangu', sessionId, project);
  return { name, project, sessionId, ref: (await resolveProjectMemory('owner', sessionId))! };
};

// ── 模型替身:每次调用都记下来;回什么由用例定 ──
type Input = { budget: number; entries: Array<{ id: string; fact: string; by: string }>; fixed: string[] };
let calls: Array<{ modelId: string; system: string; input: Input; thinkingLevel?: string }>;
let answer: (input: Input) => unknown | Promise<unknown>;
let resolved: string[];
const idOf = (input: Input, has: string): string => input.entries.find((e) => e.fact.includes(has))!.id;

const E1 = 'The release branch is release/2026.08.';
const E2 = 'Unit tests run with "pnpm test:unit"; plain "pnpm test" is broken on purpose.';
const E3 = 'Run unit tests using pnpm test:unit.';
const E4 = 'Deploy only from the ops laptop.';
const E5 = 'Staging lives at https://staging.example.test/app.';
const E6 = '10-01 finished the login page refactor.';
const E7 = 'The release branch is now release/2026.10.';
const MERGED = 'Run unit tests with pnpm test:unit; plain pnpm test is broken on purpose.';
const filler = (i: number): string => `Filler ${String(i).padStart(2, '0')} ${'x'.repeat(250)}`;

/** 填一份写满的项目记忆:七条有讲究的 + 填充(最后一条是垫片)。 */
async function fill(ref: ProjectMemoryRef, sessionId: string): Promise<{ ids: Record<string, string>; fillers: string[] }> {
  const repo = await openProjectMemory(ref);
  const add = (fact: string, source: MemorySource): void => { repo.mutate({ action: 'add', fact, cap: PROJECT_MEMORY_CHAR_BUDGET, source }); };
  add(E1, { kind: 'historian', sessionId });
  add(E2, { kind: 'explicit', sessionId, runId: 'r0' });
  add(E3, { kind: 'historian', sessionId });
  add(E4, { kind: 'manual' });
  add(E5, { kind: 'explicit', sessionId, runId: 'r0' });
  add(E6, { kind: 'historian', sessionId });
  add(E7, { kind: 'historian', sessionId });
  const fillers: string[] = [];
  for (let i = 1; repo.snapshot().content.length + filler(i).length + 1 <= PROJECT_MEMORY_CHAR_BUDGET; i++) { add(filler(i), { kind: 'historian', sessionId }); fillers.push(filler(i)); }
  // 垫到只剩二十来个字:再短的一句也放不下
  const pad = `Pad ${'p'.repeat(Math.max(1, PROJECT_MEMORY_CHAR_BUDGET - repo.snapshot().content.length - 1 - 4 - 20))}`;
  add(pad, { kind: 'historian', sessionId }); fillers.push(pad);
  return { ids: Object.fromEntries(repo.snapshot().entries.map((e) => [e.content, e.id])), fillers };
}
/** 一份合格的方案:E2 + E3 合成一句,留 E7 和头两条填充,其余去掉。 */
const goodProposal = (input: Input): unknown => {
  const keep = [idOf(input, 'release/2026.10'), idOf(input, 'Filler 01'), idOf(input, 'Filler 02')];
  const sourceIds = [idOf(input, '"pnpm test:unit"'), idOf(input, 'Run unit tests using')];
  return { keep, groups: [{ fact: MERGED, sourceIds }], discarded: input.entries.map((e) => e.id).filter((id) => !keep.includes(id) && !sourceIds.includes(id)) };
};

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-project-compact-'))); process.env.TANGU_HOME = home;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-project-compact-work-')));
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({
    host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }), llm: {
      resolveModelAndKey: async (id: string) => { resolved.push(id); return { model: { name: id, provider: 'test' }, apiKey: 'k', baseUrl: '', apiModelId: id }; },
      buildProviderPayload: async (p: any) => p,
      streamProviderCompletion: async (o: any) => {
        const input = JSON.parse(o.payload.messages[1].content) as Input;
        calls.push({ modelId: o.payload.apiModelId, system: o.payload.messages[0].content, input, thinkingLevel: o.payload.thinkingLevel });
        const out = await answer(input);
        return typeof out === 'object' && out && 'finishReason' in (out as any) ? out : { content: typeof out === 'string' ? out : JSON.stringify(out), usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    } } as any,
  });
  await runMigration();
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});
// fill() 往真实的库里写三十来条,每条一次落盘:单跑每例 1 秒上下,全量并行时有例子超过 5 秒。
// 超时的那一例没跑完的后半截还会接着改 answer、接着叫替身,把后面的用例一起带红(10-05 合并门禁见过),所以整份文件放宽。
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { calls = []; resolved = []; answer = goodProposal; resetProjectMemoryCompactionForTests(); });

describe('方案校验(validateCompaction)', () => {
  const sources = [
    { id: 'm1', fact: 'Unit tests run with pnpm test:unit on Node 22.', by: 'asked' as const },
    { id: 'm2', fact: 'Run the unit tests using pnpm test:unit.', by: 'auto' as const },
    { id: 'm3', fact: '发布日期是 10-05,走 release/2026.10 分支。', by: 'auto' as const },
    { id: 'm4', fact: 'Lint runs with pnpm lint before every commit.', by: 'auto' as const },
    { id: 'm5', fact: 'The API listens on port 30000.', by: 'auto' as const },
  ];
  const ALL = sources.map((s) => s.id);
  const GOOD = 'Unit tests: pnpm test:unit on Node 22.';
  const check = (p: unknown, fixedChars = 0): string => { try { validateCompaction(p, sources, fixedChars); return 'ok'; } catch (e: any) { return String(e.message); } };

  it('每个 id 分到三类之一;形状不对的整份不收', () => {
    expect(validateCompaction({ keep: ['m3', 'm5'], groups: [{ fact: GOOD, sourceIds: ['m1', 'm2'] }], discarded: ['m4'] }, sources, 0))
      .toEqual({ keep: ['m3', 'm5'], groups: [{ fact: GOOD, sourceIds: ['m1', 'm2'] }], discarded: ['m4'], unsound: [] });
    expect(check({ keep: [], discarded: [] })).toMatch(/not a compaction proposal/);
    expect(check({ keep: [], groups: [] })).toMatch(/not a compaction proposal/);
    expect(check('nope')).toMatch(/not a compaction proposal/);
  });

  it('漏了的、提到不止一次的、不认识的 id:都留原句,不连累整份(真模型 54 个 id 分错过一个,10-05 live)', () => {
    // 漏了 → 留(没有 keep 清单也一样:没明说去掉的都留)
    expect(validateCompaction({ keep: ['m1'], groups: [], discarded: ['m4'] }, sources, 0)).toMatchObject({ keep: ['m1', 'm2', 'm3', 'm5'], discarded: ['m4'] });
    expect(validateCompaction({ groups: [], discarded: ['m4'] }, sources, 0)).toMatchObject({ keep: ['m1', 'm2', 'm3', 'm5'], discarded: ['m4'] });
    // 同一条既说留又说去、去掉的清单里写了两遍 → 留;不认识的、不是字符串的不理
    expect(validateCompaction({ keep: ['m4'], groups: [], discarded: ['m4', 'm5', 'm5', 'm9', 7] }, sources, 0)).toMatchObject({ keep: ALL, discarded: [], unsound: [] });
    // 一条既进了一组又在去掉的清单里(或又在 keep 里)→ 那一组不用,它的来源都留
    expect(validateCompaction({ keep: [], groups: [{ fact: GOOD, sourceIds: ['m1', 'm2'] }], discarded: ['m2', 'm4'] }, sources, 0))
      .toMatchObject({ keep: ['m1', 'm2', 'm3', 'm5'], groups: [], discarded: ['m4'], unsound: [expect.stringMatching(/more than once/)] });
    expect(validateCompaction({ keep: ['m1'], groups: [{ fact: GOOD, sourceIds: ['m1', 'm2'] }], discarded: [] }, sources, 0)).toMatchObject({ keep: ALL, groups: [] });
    // 一条进了两组 → 两组都不用
    expect(validateCompaction({ keep: [], groups: [{ fact: GOOD, sourceIds: ['m1', 'm2'] }, { fact: 'Lint and tests: pnpm lint, pnpm test:unit.', sourceIds: ['m2', 'm4'] }], discarded: [] }, sources, 0))
      .toMatchObject({ keep: ALL, groups: [], unsound: [expect.any(String), expect.any(String)] });
    // 一组里同一个来源写了两遍、来源不认识、来源不是字符串、没有来源、组本身不成形:这一组不用
    for (const sourceIds of [['m1', 'm1'], ['m1', 'm9'], ['m1', 3], [], 'm1'] as unknown[]) {
      expect(validateCompaction({ keep: [], groups: [{ fact: GOOD, sourceIds }], discarded: [] }, sources, 0)).toMatchObject({ keep: ALL, groups: [], unsound: [expect.any(String)] });
    }
    expect(validateCompaction({ keep: [], groups: [{ sourceIds: ['m1'] }, null, 'x'], discarded: [] }, sources, 0)).toMatchObject({ keep: ALL, groups: [] });
  });

  it('replaced:因为「别的条目已经说了」而去掉的,说它的那一条必须自己留着;互相指着对方的一对两条都留(真模型把一对重复的规矩两条都去掉过,10-05 live)', () => {
    const run = (p: Record<string, unknown>, fixedChars = 0) => validateCompaction({ groups: [], discarded: [], ...p }, sources, fixedChars);
    // m2 重复了 m1,m1 留着 → 照办(m1 没提到也算留着)
    expect(run({ keep: ['m1', 'm3', 'm4', 'm5'], replaced: [{ id: 'm2', saidBy: 'm1' }] })).toMatchObject({ keep: ['m1', 'm3', 'm4', 'm5'], discarded: ['m2'], unsound: [] });
    expect(run({ keep: ['m3', 'm4', 'm5'], replaced: [{ id: 'm2', saidBy: 'm1' }] })).toMatchObject({ keep: ['m1', 'm3', 'm4', 'm5'], discarded: ['m2'] });
    // 互相指着对方 → 两条都留;别的照办
    expect(run({ keep: ['m3', 'm5'], replaced: [{ id: 'm1', saidBy: 'm2' }, { id: 'm2', saidBy: 'm1' }], discarded: ['m4'] }))
      .toMatchObject({ keep: ['m1', 'm2', 'm3', 'm5'], discarded: ['m4'], unsound: [expect.stringMatching(/does not stay/), expect.stringMatching(/does not stay/)] });
    // 指向一条当进度去掉的、指向自己、指向不认识的、没写 saidBy、不成形 → 留
    expect(run({ keep: ['m2', 'm3', 'm5'], replaced: [{ id: 'm1', saidBy: 'm4' }], discarded: ['m4'] })).toMatchObject({ keep: ['m1', 'm2', 'm3', 'm5'], discarded: ['m4'] });
    expect(run({ keep: ['m5'], replaced: [{ id: 'm1', saidBy: 'm1' }, { id: 'm2', saidBy: 'm9' }, { id: 'm3', saidBy: 7 }, { id: 'm4' }, null, 'm5'] })).toMatchObject({ keep: ALL, discarded: [] });
    // 同一条既说留、又说被别的说了 → 提到两次,留
    expect(run({ keep: ['m1', 'm2', 'm3', 'm4', 'm5'], replaced: [{ id: 'm2', saidBy: 'm1' }] })).toMatchObject({ keep: ALL, discarded: [] });
    // 说它的那一条是某一组的来源(那件事在合出来的句子里)→ 照办
    expect(run({ keep: ['m4', 'm5'], groups: [{ fact: GOOD, sourceIds: ['m1'] }], replaced: [{ id: 'm2', saidBy: 'm1' }], discarded: ['m3'] })).toMatchObject({ keep: ['m4', 'm5'], discarded: ['m3', 'm2'] });
    // "fixed":有不改写的条目时才认
    expect(run({ keep: ['m1', 'm3', 'm4', 'm5'], replaced: [{ id: 'm2', saidBy: 'fixed' }] })).toMatchObject({ keep: ALL, discarded: [] });
    expect(run({ keep: ['m1', 'm3', 'm4', 'm5'], replaced: [{ id: 'm2', saidBy: 'fixed' }] }, 40)).toMatchObject({ discarded: ['m2'] });
  });

  it('两组写成同一句 → 后一组不用(库只认第一组的来源,后一组的证据会丢);落不了盘的一句 → 不用;来源都留原句(Codex 评审 10-05)', () => {
    const SHORT = 'Unit tests: pnpm test:unit.';
    expect(validateCompaction({ keep: ['m3', 'm4', 'm5'], groups: [{ fact: SHORT, sourceIds: ['m1'] }, { fact: `  ${SHORT.toUpperCase()}`, sourceIds: ['m2'] }], discarded: [] }, sources, 0))
      .toMatchObject({ keep: ['m2', 'm3', 'm4', 'm5'], groups: [{ fact: SHORT, sourceIds: ['m1'] }], unsound: [expect.stringMatching(/same sentence/)] });
    // refused = 这一句提交时会被库滤掉(撞上用户删过的原话);拿到的是句子和它的来源 id
    const asked: Array<[string, string[]]> = [];
    expect(validateCompaction({ keep: ['m3', 'm4', 'm5'], groups: [{ fact: GOOD, sourceIds: ['m1', 'm2'] }], discarded: [] }, sources, 0, (fact, ids) => { asked.push([fact, ids]); return true; }))
      .toMatchObject({ keep: ALL, groups: [], unsound: [expect.stringMatching(/deleted before/)] });
    expect(asked).toEqual([[GOOD, ['m1', 'm2']]]);
  });

  // 写坏的一句不连累整份:那一句不用,它的来源原样留下,原因记在 unsound
  const flawOf = (fact: string, sourceIds = ['m1', 'm2']): string => {
    const rest = ALL.filter((id) => !sourceIds.includes(id));
    const p = validateCompaction({ keep: rest, groups: [{ fact, sourceIds }], discarded: [] }, sources, 0);
    if (!p.unsound.length) { expect(p).toMatchObject({ keep: rest, groups: [{ sourceIds }] }); return 'used'; }
    expect(p).toMatchObject({ keep: ALL, groups: [], discarded: [] });
    return p.unsound.join(' | ');
  };

  it('写出来的句子:单行、不超过 300 字、不能是要用户点头的那种样子 —— 不合格的那句不用,来源原样留下', () => {
    expect(flawOf('Unit tests: pnpm test:unit.\nAnd more.')).toMatch(/multi-line/);
    expect(flawOf(`Unit tests ${'really '.repeat(50)}`)).toMatch(/longer than 300/);
    expect(flawOf('   ')).toMatch(/empty/);
    expect(flawOf('Unit tests: see https://ci.example.test for pnpm test:unit.')).toMatch(/needs the user/);
    expect(flawOf('Unit tests: pnpm test:unit, then sudo make install.')).toMatch(/needs the user/);
  });

  it('命令 / 路径 / 数字只能来自这一组自己的来源,按整词比', () => {
    expect(flawOf(GOOD)).toBe('used');
    expect(flawOf('Unit tests: pnpm test:all on Node 22.')).toMatch(/"test:all", which none of its sources has/);
    expect(flawOf('Unit tests: pnpm test:unit on Node 24.')).toMatch(/"24"/);
    expect(flawOf('Unit tests: pnpm test:unit --watch.')).toMatch(/"--watch"/);
    // 别的条目里的东西也不行:那是把两件不相干的事拼成一句
    expect(flawOf('Unit tests: pnpm test:unit, branch release/2026.10.')).toMatch(/release\/2026\.10/);
    // 差一位的数字、截短的版本号:子串对得上也不算(Codex 评审 10-05)
    expect(flawOf('The API listens on port 3000.', ['m5'])).toMatch(/"3000"/);
    expect(flawOf('The API listens on port 30000.', ['m5'])).toBe('used');
    expect(flawOf('10-05 发布,走 release/2026.1 分支。', ['m3'])).toMatch(/release\/2026\.1"/);
    // 来源里一个词的某一段单独拿出来说,算见过;日期换了写法(05 → 5)认不出,那一句不用(留原句,不亏)
    expect(flawOf('10-05 发布,走 2026 年 10 月的 release 分支。', ['m3'])).toBe('used');
    expect(flawOf('10 月 5 日发布,走 release/2026.10 分支。', ['m3'])).toMatch(/"5"/);
    // 普通连字符词、单字母加点的缩写不算(真模型合并时写了「e.g.」,10-05 live 第一轮整份因此被拒)
    expect(flawOf('Unit tests are run-of-the-mill: pnpm test:unit on Node 22.')).toBe('used');
    expect(flawOf('Unit tests, i.e. the fast ones (e.g. pnpm test:unit), run on Node 22.')).toBe('used');
    // 带点的文件名照查
    expect(flawOf('Unit tests: pnpm test:unit on Node 22, configured in vitest.config.ts.')).toMatch(/vitest\.config\.ts/);
  });

  it('按原样比:大小写不同的路径、丢了 ~ 的路径、丢了负号的数、换了名字的短文件名,都不算来源里有(Codex 评审 10-05)', () => {
    const own = [
      { id: 'm1', fact: 'Settings are read from ~/.config/tool.json and src/Config.ts.', by: 'auto' as const },
      { id: 'm2', fact: 'The temperature offset is -5 and the entry file is main.c.', by: 'auto' as const },
    ];
    const flaw = (fact: string, id: string): string => validateCompaction({ keep: own.filter((s) => s.id !== id).map((s) => s.id), groups: [{ fact, sourceIds: [id] }], discarded: [] }, own, 0).unsound.join(' | ') || 'used';
    expect(flaw('Settings come from ~/.config/tool.json and src/Config.ts.', 'm1')).toBe('used');
    expect(flaw('Settings come from ~/.config/tool.json and src/config.ts.', 'm1')).toMatch(/"src\/config\.ts"/);
    expect(flaw('Settings come from /.config/tool.json and src/Config.ts.', 'm1')).toMatch(/"\/\.config\/tool\.json"/);
    expect(flaw('The temperature offset is -5; entry file main.c.', 'm2')).toBe('used');
    expect(flaw('The temperature offset is 5; entry file main.c.', 'm2')).toMatch(/"5"/);
    expect(flaw('The temperature offset is -5; entry file a.c.', 'm2')).toMatch(/"a\.c"/);
  });

  it('必须真的腾出地方,也不许清空;没采用的改写的来源照样算进总量', () => {
    const all = sources.reduce((n, s) => n + s.fact.length + 1, 0);
    expect(check({ keep: ALL, groups: [], discarded: [] }, COMPACT_ACCEPT_CHARS - all + 1)).toMatch(/still \d+ characters/);
    expect(check({ keep: ALL, groups: [], discarded: [] }, COMPACT_ACCEPT_CHARS - all)).toBe('ok');
    expect(check({ keep: [], groups: [], discarded: ALL })).toMatch(/keeps nothing/);
    // 坏的那句很短、来源很长:按来源的长度算
    const rest = sources.slice(2).reduce((n, s) => n + s.fact.length + 1, 0);
    expect(check({ keep: ['m3', 'm4', 'm5'], groups: [{ fact: 'Tests: pnpm test:all.', sourceIds: ['m1', 'm2'] }], discarded: [] }, COMPACT_ACCEPT_CHARS - rest - 60)).toMatch(/still \d+ characters/);
    expect(check({ keep: ['m3', 'm4', 'm5'], groups: [{ fact: 'Tests: pnpm test:unit.', sourceIds: ['m1', 'm2'] }], discarded: [] }, COMPACT_ACCEPT_CHARS - rest - 60)).toBe('ok');
  });
});

describe('压一遍(compactProjectMemory)', () => {
  it('合的合、去的去:留下的条目原样原 id,合出来的一句落在最晚那个来源的位置;不改写的条目原样留着', async () => {
    const { ref, sessionId, project } = await fresh();
    const { ids, fillers } = await fill(ref, sessionId);
    const total = 7 + fillers.length;
    const outcome = await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    expect(outcome).toMatchObject({ status: 'compacted', before: { count: total }, after: { count: 6 } });
    const snapshot = (await openProjectMemory(ref)).snapshot();
    expect(snapshot.entries.map((e) => e.content)).toEqual([MERGED, E4, E5, E7, filler(1), filler(2)]);
    expect(snapshot.content.length).toBeLessThanOrEqual(COMPACT_ACCEPT_CHARS);
    const by = Object.fromEntries(snapshot.entries.map((e) => [e.content, e]));
    for (const kept of [E4, E5, E7, filler(1)]) expect(by[kept].id).toBe(ids[kept]);
    expect(by[E7].source.kind).toBe('historian');   // 留下的条目来源不变
    expect(by[MERGED].source.kind).toBe('dream');
    expect(by[MERGED].evidenceIds).toEqual(expect.arrayContaining([ids[E2], ids[E3]]));

    // 给模型看的:不改写的条目不在 entries 里;用户采纳的那条作为 fixed 给它参考;带网址的那条连看都不给看
    expect(calls).toHaveLength(1);
    const { input, system } = calls[0];
    expect(system).toMatch(/^Compact the saved memory of ONE software project/);
    expect(input.fixed).toEqual([E4]);
    expect(JSON.stringify(input)).not.toContain('staging.example.test');
    expect(input.entries.map((e) => e.fact)).toEqual([E1, E2, E3, E6, E7, ...fillers]);
    expect(input.entries.find((e) => e.fact === E2)!.by).toBe('asked');
    expect(input.entries.find((e) => e.fact === E3)!.by).toBe('auto');
    expect(input.budget).toBe(COMPACT_ASK_CHARS - (E4.length + 1) - (E5.length + 1));

    // 记录:几条变几条、被合并或去掉的原句(还能逐条恢复)
    const view = await projectMemoryView(project);
    expect(view.compacted).toMatchObject({ before: { count: total }, after: { count: 6, chars: snapshot.content.length } });
    expect(view.compacted!.removed.map((r) => r.content)).toEqual([E1, E2, E3, E6, ...fillers.slice(2)]);
    expect(view.entries).toHaveLength(6);
  });

  it('模型:配了后台模型用后台的;没配用调用方给的;都没有 → 不压,也不叫模型', async () => {
    const a = await fresh(); await fill(a.ref, a.sessionId);
    expect(await compactProjectMemory('owner', a.ref)).toEqual({ status: 'skipped', reason: 'no_model' });
    expect(calls).toHaveLength(0);
    const b = await fresh(); await fill(b.ref, b.sessionId);
    expect((await compactProjectMemory('owner', b.ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
    expect(resolved).toEqual(['run-model']);
    // 配了后台模型 → 用它,不用调用方给的(同一个项目再压一次;这一步只看选了哪个模型,压没压成不论)
    saveSpecialAgentsConfig({ historian: { modelId: 'background-model' } });
    try { await compactProjectMemory('owner', b.ref, { fallbackModelId: 'run-model' }); }
    finally { saveSpecialAgentsConfig({ historian: { modelId: '' } }); }
    expect(resolved).toEqual(['run-model', 'background-model']);
    expect(calls.every((x) => x.thinkingLevel === 'medium')).toBe(true); // 不给档位 = 关思考,真模型就是那样把现行的条目整批误删的(10-05 live)
  });

  it('不合格的方案不落盘;没压成之后一段时间内不再叫模型', async () => {
    const { ref, sessionId, project } = await fresh();
    await fill(ref, sessionId);
    const before = (await openProjectMemory(ref)).snapshot();
    answer = () => ({ keep: [], groups: [], discarded: [] }); // 一条没动 = 没腾出地方
    const outcome = await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'rejected' });
    expect((outcome as any).detail).toMatch(/still \d+ characters/);
    expect((await openProjectMemory(ref)).snapshot().version).toBe(before.version);
    expect((await projectMemoryView(project)).compacted).toBeUndefined();
    answer = goodProposal;
    expect(await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).toEqual({ status: 'skipped', reason: 'cooldown' });
    expect(calls).toHaveLength(1);
  });

  it('写坏的一句不连累整份:那一句不落盘,它的来源原样原 id 留着,别的照压', async () => {
    const { ref, sessionId, project } = await fresh();
    const { ids } = await fill(ref, sessionId);
    answer = (input) => ({ ...(goodProposal(input) as any), groups: [{ fact: 'Run unit tests with pnpm test:all.', sourceIds: [idOf(input, '"pnpm test:unit"'), idOf(input, 'Run unit tests using')] }] });
    expect(await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).toMatchObject({ status: 'compacted', after: { count: 7 } });
    const after = (await openProjectMemory(ref)).snapshot();
    expect(after.content).not.toContain('test:all');
    expect(after.entries.filter((e) => e.content === E2 || e.content === E3).map((e) => e.id)).toEqual([ids[E2], ids[E3]]);
    const removed = (await projectMemoryView(project)).compacted!.removed.map((r) => r.content);
    expect(removed).toEqual(expect.arrayContaining([E1, E6]));
    expect(removed).not.toEqual(expect.arrayContaining([E2]));
  });

  it('合出来的一句落在最晚那个来源的位置:两个来源中间隔着别的条目时不往前挪(注入放不下时留最新的,靠的是这个顺序)', async () => {
    const { ref, sessionId } = await fresh();
    await fill(ref, sessionId);
    const RELEASE = 'The release branch is release/2026.10; release/2026.08 came before it.';
    answer = (input) => {
      const p = goodProposal(input) as any; const old = idOf(input, 'release/2026.08'); const now = idOf(input, 'release/2026.10');
      return { keep: p.keep.filter((id: string) => id !== now), groups: [...p.groups, { fact: RELEASE, sourceIds: [old, now] }], discarded: p.discarded.filter((id: string) => id !== old) };
    };
    expect((await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
    // E1(最早一条)和 E7 合成一句:落在 E7 的位置 —— 用户手加的 E4、带网址的 E5 之后,不是 E1 的位置
    expect((await openProjectMemory(ref)).snapshot().entries.map((e) => e.content)).toEqual([MERGED, E4, E5, RELEASE, filler(1), filler(2)]);
  });

  it('合出来的一句正好是用户删过的原话 → 那一句不用,它的来源原样原 id 留着(库提交时会把撞墓碑的行滤掉:来源去了、这句又没落下)', async () => {
    const { ref, sessionId } = await fresh();
    const repo = await openProjectMemory(ref);
    const once = repo.mutate({ action: 'add', fact: MERGED, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'manual' } }).entries[0];
    repo.mutate({ action: 'forget', id: once.id });
    const { ids } = await fill(ref, sessionId);
    expect((await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
    const after = (await openProjectMemory(ref)).snapshot().entries;
    expect(after.map((e) => e.content)).toEqual([E2, E3, E4, E5, E7, filler(1), filler(2)]);
    expect(after.slice(0, 2).map((e) => e.id)).toEqual([ids[E2], ids[E3]]);
  });

  it('原样留下的两条只差大小写(路径大小写不同就是两个文件)→ 两条都在,不被去重挤掉', async () => {
    const { ref, sessionId } = await fresh();
    const repo = await openProjectMemory(ref);
    const UPPER = 'Build reads src/A.ts.'; const LOWER = 'Build reads src/a.ts.';
    repo.mutate({ action: 'add', fact: UPPER, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian', sessionId } });
    repo.mutate({ action: 'add', fact: LOWER, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian', sessionId }, dedup: false });
    await fill(ref, sessionId);
    answer = (input) => {
      const p = goodProposal(input) as any; const both = input.entries.filter((e) => /src\/a\.ts/i.test(e.fact)).map((e) => e.id);
      return { ...p, keep: [...p.keep, ...both], discarded: p.discarded.filter((id: string) => !both.includes(id)) };
    };
    expect((await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
    expect((await openProjectMemory(ref)).snapshot().entries.map((e) => e.content).slice(0, 2)).toEqual([UPPER, LOWER]);
  });

  it('门槛按真正写下去的内容量:条目带着很长的行首列表符号时,校验里那份(去了符号)过了也不算', async () => {
    const { ref, sessionId } = await fresh();
    const repo = await openProjectMemory(ref);
    for (let i = 1; i <= 22; i++) repo.mutate({ action: 'add', fact: `-${' '.repeat(260)}Fact ${i}.`, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian', sessionId } });
    const version = repo.snapshot().version;
    expect(repo.snapshot().content.length).toBeGreaterThan(COMPACT_ACCEPT_CHARS);
    answer = (input) => ({ keep: input.entries.map((e) => e.id), groups: [], discarded: [] });
    expect(await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).toMatchObject({ status: 'skipped', reason: 'rejected', detail: expect.stringMatching(/once written/) });
    expect(repo.snapshot().version).toBe(version);
  });

  it('整次有时限:模型那头一直不回(连打断都不理)→ 到点算没压成,不把这个项目的槽永远占着', async () => {
    const { ref, sessionId } = await fresh();
    await fill(ref, sessionId);
    let reached!: () => void;
    const asked = new Promise<void>((r) => { reached = r; });
    answer = () => { reached(); return new Promise(() => {}); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
      await asked; // 先等它真的走到模型那一步(之前是真实的磁盘读写,不归假时钟管),再拨表
      await vi.advanceTimersByTimeAsync(66_000);
      expect(await first).toMatchObject({ status: 'skipped', reason: 'failed', detail: 'timed out' });
    } finally { vi.useRealTimers(); }
    // 槽放开了:下一次拿到的是冷却,不是挂在那一次上
    expect(await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).toEqual({ status: 'skipped', reason: 'cooldown' });
    expect(calls).toHaveLength(1);
  });

  it('带密钥样子的条目不给模型看、原样留着;改写出的一句和用户手加的只差大小写 → 不要那一句', async () => {
    const { ref, sessionId } = await fresh();
    const repo = await openProjectMemory(ref);
    const SECRET = `The deploy bot signs in as ghp_${'a1B2c3D4e5'.repeat(3)}.`;
    expect([autoAdoptable(SECRET), redactSecrets(SECRET) === SECRET]).toEqual([true, false]); // 过得了形状闸、但认得出是密钥:这条测的就是这个缝
    repo.mutate({ action: 'add', fact: SECRET, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian', sessionId } });
    await fill(ref, sessionId);
    // 模型把最早那条(E1,排在用户手加的 E4 前面)改写成和 E4 只差大小写的一句
    answer = (input) => { const p = goodProposal(input) as any; const e1 = idOf(input, 'release/2026.08'); return { ...p, groups: [...p.groups, { fact: E4.toUpperCase(), sourceIds: [e1] }], discarded: p.discarded.filter((id: string) => id !== e1) }; };
    expect((await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
    expect(JSON.stringify(calls[0].input)).not.toContain('ghp_');
    const after = (await openProjectMemory(ref)).snapshot().entries.map((e) => e.content);
    expect(after).toContain(SECRET);
    expect(after.filter((c) => c.toLowerCase() === E4.toLowerCase())).toEqual([E4]);
  });

  it('模型的回答被截断、不是 JSON、抛错:都当没压成,记忆不动', async () => {
    // 截断的那一份正文本身是合格的方案:不看 finishReason 就会被收下(正文被截在哪儿没人知道,不能赌它恰好完整)
    const cut = (input: Input): unknown => ({ content: JSON.stringify(goodProposal(input)), finishReason: 'length' });
    for (const bad of [cut, () => 'sorry, I cannot', () => { throw new Error('provider down'); }]) {
      const { ref, sessionId } = await fresh();
      await fill(ref, sessionId);
      const version = (await openProjectMemory(ref)).snapshot().version;
      answer = bad as any;
      const outcome = await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
      expect(outcome.status).toBe('skipped');
      expect((await openProjectMemory(ref)).snapshot().version).toBe(version);
    }
  });

  it('等模型的那几秒里别处改过记忆 → 这一次作废、别处的改动留着;不算没压成,下次照样能试', async () => {
    const { ref, sessionId } = await fresh();
    const { ids } = await fill(ref, sessionId);
    answer = async (input) => { (await openProjectMemory(ref)).mutate({ action: 'forget', id: ids[E6] }); return goodProposal(input); };
    expect(await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).toEqual({ status: 'skipped', reason: 'conflict' });
    const now = (await openProjectMemory(ref)).snapshot().entries.map((e) => e.content);
    expect(now).not.toContain(E6);
    expect(now).toContain(E1);
    answer = goodProposal;
    expect((await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
  });

  it('同一个项目同时只压一次:第二个调用方等同一次的结果;调用方自己不等了不会打断它', async () => {
    const { ref, sessionId } = await fresh();
    await fill(ref, sessionId);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    answer = async (input) => { await gate; return goodProposal(input); };
    const first = compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const second = compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const impatient = new AbortController();
    const third = compactProjectMemory('owner', ref, { fallbackModelId: 'run-model', signal: impatient.signal });
    impatient.abort(new Error('run stopped'));
    await expect(third).rejects.toThrow('run stopped');
    release();
    expect((await first).status).toBe('compacted');
    expect(await second).toEqual(await first);
    expect(calls).toHaveLength(1);
  });

  it('没什么可压的不叫模型:能改写的不到两条;不改写的条目自己就占满了', async () => {
    const a = await fresh();
    const repoA = await openProjectMemory(a.ref);
    repoA.mutate({ action: 'add', fact: E4, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'manual' } });
    repoA.mutate({ action: 'add', fact: E1, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian' } });
    expect(await compactProjectMemory('owner', a.ref, { fallbackModelId: 'run-model' })).toEqual({ status: 'skipped', reason: 'nothing' });
    const b = await fresh();
    const repoB = await openProjectMemory(b.ref);
    for (let i = 1; repoB.snapshot().content.length < COMPACT_ACCEPT_CHARS - 400; i++) repoB.mutate({ action: 'add', fact: filler(i), cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'manual' } });
    repoB.mutate({ action: 'add', fact: E1, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian' } });
    repoB.mutate({ action: 'add', fact: E7, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian' } });
    expect(await compactProjectMemory('owner', b.ref, { fallbackModelId: 'run-model' })).toEqual({ status: 'skipped', reason: 'pinned' });
    expect(calls).toHaveLength(0);
  });
});

describe('逐句恢复(restoreCompactedFact)', () => {
  const code = (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e) => String(e?.code || e?.message));

  it('恢复 = 以用户的名义记回去、从记录里拿掉;恢复的那句以后的压缩不再动', async () => {
    const { ref, sessionId, project } = await fresh();
    await fill(ref, sessionId);
    await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const removed = (await projectMemoryView(project)).compacted!.removed;
    const view = await restoreCompactedFact(project, removed.find((r) => r.content === E1)!.id);
    expect(view.entries.map((e) => e.content)).toContain(E1);
    expect(view.compacted!.removed.map((r) => r.content)).not.toContain(E1);
    expect(view.compacted!.removed).toHaveLength(removed.length - 1);
    expect((await openProjectMemory(ref)).snapshot().entries.find((e) => e.content === E1)!.source.kind).toBe('manual');
    // 再压一遍:恢复的那句在 fixed 里,不在可改写的条目里
    answer = (input) => ({ keep: input.entries.slice(0, 1).map((e) => e.id), groups: [], discarded: input.entries.slice(1).map((e) => e.id) });
    expect((await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' })).status).toBe('compacted');
    expect(calls[1].input.fixed).toEqual(expect.arrayContaining([E1, E4]));
    expect(calls[1].input.entries.map((e) => e.fact)).not.toContain(E1);
    expect((await projectMemoryView(project)).entries.map((e) => e.content)).toContain(E1);
    // 两次压缩去掉的原句都还在记录里,新的在前
    const all = (await projectMemoryView(project)).compacted!.removed.map((r) => r.content);
    expect(all).toContain(E2);
    expect(all.indexOf(filler(2))).toBeLessThan(all.indexOf(E2));
  });

  it('要恢复的那一句已经又在记忆里(压缩之后别处又记了一遍)→ 不重复记,但把那一条钉成用户手加的', async () => {
    const { ref, sessionId, project } = await fresh();
    await fill(ref, sessionId);
    await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const repo = await openProjectMemory(ref);
    repo.mutate({ action: 'add', fact: E1, cap: PROJECT_MEMORY_CHAR_BUDGET, source: { kind: 'historian', sessionId } });
    const item = (await projectMemoryView(project)).compacted!.removed.find((r) => r.content === E1)!;
    const view = await restoreCompactedFact(project, item.id);
    expect(view.entries.filter((e) => e.content === E1)).toHaveLength(1);
    expect(view.compacted!.removed.map((r) => r.content)).not.toContain(E1);
    expect(repo.snapshot().entries.find((e) => e.content === E1)!.source).toMatchObject({ kind: 'manual' });
  });

  it('那一句已经不在记录里 → MEMORY_NOT_FOUND;没压过的项目不会因为这次点击被建出目录', async () => {
    const { ref, sessionId, project } = await fresh();
    expect(await code(restoreCompactedFact(project, 'nope'))).toBe('MEMORY_NOT_FOUND');
    expect(existsSync(ref.dir)).toBe(false);
    await fill(ref, sessionId);
    await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const id = (await projectMemoryView(project)).compacted!.removed[0].id;
    await restoreCompactedFact(project, id);
    expect(await code(restoreCompactedFact(project, id))).toBe('MEMORY_NOT_FOUND');
  });

  it('放不下 → MEMORY_FULL,那一句留在记录里', async () => {
    const { ref, sessionId, project } = await fresh();
    await fill(ref, sessionId);
    await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const repo = await openProjectMemory(ref);
    for (let i = 50; repo.snapshot().content.length + filler(i).length + 1 <= PROJECT_MEMORY_CHAR_BUDGET; i++) repo.mutate({ action: 'add', fact: filler(i), cap: PROJECT_MEMORY_CHAR_BUDGET });
    const removed = (await projectMemoryView(project)).compacted!.removed;
    const big = removed.find((r) => r.content.startsWith('Filler'))!;
    expect(await code(restoreCompactedFact(project, big.id))).toBe('MEMORY_FULL');
    expect((await projectMemoryView(project)).compacted!.removed).toHaveLength(removed.length);
  });

  it('记录只留最近 100 句,新的在前(跨多次压缩累计)', async () => {
    const { ref, project } = await fresh();
    await openProjectMemory(ref);
    const size = { count: 1, chars: 1 };
    recordProjectCompaction(ref, size, size, Array.from({ length: 70 }, (_, i) => `old ${i}`));
    recordProjectCompaction(ref, size, size, Array.from({ length: 70 }, (_, i) => `new ${i}`));
    const removed = (await projectMemoryView(project)).compacted!.removed.map((r) => r.content);
    expect(removed).toHaveLength(100);
    expect([removed[0], removed[69], removed[70], removed[99]]).toEqual(['new 0', 'new 69', 'old 0', 'old 29']);
  });

  it('记录文件写坏了当没有:记忆照常显示', async () => {
    const { ref, sessionId, project } = await fresh();
    await fill(ref, sessionId);
    await compactProjectMemory('owner', ref, { fallbackModelId: 'run-model' });
    const file = join(ref.dir, 'COMPACTED.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).removed.length).toBeGreaterThan(0);
    (await import('node:fs')).writeFileSync(file, '{ not json');
    const view = await projectMemoryView(project);
    expect(view.compacted).toBeUndefined();
    expect(view.entries).toHaveLength(6);
  });
});

describe('前台 remember 写满时', () => {
  const remember = memoryLogProvider.tools().find((t) => t.name === 'remember')!;
  const call = (sessionId: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runWithAgentSlug('xyra', async () => String(await remember.execute(args, { userId: 'owner', sessionId, appId: 'tangu', execMode: 'host', runId: `run-${sessionId}`, modelId: 'run-model', ...extra } as any)));
  const NEW = 'End-to-end tests need the mock service started first with pnpm mock:up.';

  it('先压一遍再记这一句;回执里说明压过了、旧的 id 和版本不能再用', async () => {
    const { ref, sessionId } = await fresh();
    const { fillers } = await fill(ref, sessionId);
    const receipt = JSON.parse(await call(sessionId, { action: 'add', fact: NEW, scope: 'project' }));
    expect(receipt).toMatchObject({ ok: true, action: 'add', scope: 'project', count: 7, entry: { content: NEW } });
    expect(receipt.duplicate).toBeUndefined();
    expect(receipt.compacted).toMatch(new RegExp(`^Project memory was full, so it was compacted before this was saved: ${7 + fillers.length} entries \\(\\d+ characters\\) became 6 \\(\\d+\\)\\. .*list again`));
    expect((await openProjectMemory(ref)).snapshot().entries.at(-1)).toMatchObject({ content: NEW, source: { kind: 'explicit', sessionId } });
    expect(resolved).toEqual(['run-model']); // 没配后台模型 → 用这个 run 的模型
    // 活动里记了一笔,记在这个会话名下(桌面据此提醒用户)
    expect(database.prepare(`SELECT agent, detail FROM special_agent_log WHERE action = 'project_memory_compacted' AND session_ref = ?`).all(sessionId))
      .toEqual([{ agent: 'historian', detail: expect.stringMatching(new RegExp(`^${7 + fillers.length} → 6 entries, \\d+ → \\d+ characters \\(p\\d+\\)$`)) }]);
  });

  it('模型带着刚 list 到的版本号来 add:压缩自己把版本改了,这一句照样记得上', async () => {
    const { ref, sessionId } = await fresh();
    await fill(ref, sessionId);
    const version = (await openProjectMemory(ref)).snapshot().version;
    const receipt = JSON.parse(await call(sessionId, { action: 'add', fact: NEW, scope: 'project', expectedVersion: version }));
    expect(receipt).toMatchObject({ ok: true, entry: { content: NEW }, compacted: expect.any(String) });
  });

  it('压不成 → 照旧回现有条目,让模型自己删旧加新', async () => {
    const { ref, sessionId } = await fresh();
    await fill(ref, sessionId);
    answer = () => 'no';
    const out = await call(sessionId, { action: 'add', fact: NEW, scope: 'project' });
    expect(out).toMatch(/^Error: project memory is full \(\d+\/8000 characters\)\. Forget or shorten stale entries/);
    expect(out).toContain('Current entries:');
    expect((await openProjectMemory(ref)).snapshot().entries.map((e) => e.content)).not.toContain(NEW);
    expect(database.prepare(`SELECT id FROM special_agent_log WHERE action = 'project_memory_compacted' AND session_ref = ?`).all(sessionId)).toEqual([]);
  });

  it('update 写满不压(它带着旧版本号和旧 id)', async () => {
    const { ref, sessionId } = await fresh();
    const { ids } = await fill(ref, sessionId);
    const version = (await openProjectMemory(ref)).snapshot().version;
    const out = await call(sessionId, { action: 'update', id: ids[E1], expectedVersion: version, fact: `The release branch is release/2026.08 ${'and more '.repeat(30)}`.trim().slice(0, 300), scope: 'project' });
    expect(out).toMatch(/^Error: project memory is full/);
    expect(calls).toHaveLength(0);
  });
});
