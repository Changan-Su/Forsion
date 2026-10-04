/** 装备层(10-04):agent 经 manage_harness kind:"equip" 收起工具 / 技能 —— 只动上下文体量,不动能力边界。 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { manageHarnessProvider } from '../src/tools/builtin/manageHarness.js';
import { loadToolsProvider } from '../src/tools/builtin/loadTools.js';
import { getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { resolveTools, isShelvable } from '../src/tools/toolRegistry.js';
import { loadHarness, shelvedOf } from '../src/agents/harnessStore.js';
import { loadSkillLoadout } from '../src/services/skillLoadout.js';

let home: string;
const previousHome = process.env.TANGU_HOME;
const tool = manageHarnessProvider.tools()[0];
const SKILLS = [
  { id: 'local:foo', name: 'Foo', description: 'foo skill' },
  { id: 'local:bar', name: 'Bar', description: 'bar skill' },
];
const base = { userId: 'owner', sessionId: 's1', appId: 'tangu', execMode: 'host' as const, enabledSkillIds: SKILLS.map((s) => s.id) };
const ctx = () => ({ ...base, profile: deps().profile });
const call = (args: Record<string, unknown>, slug = 'equipper') => runWithAgentSlug(slug, async () => String(await tool.execute(args, ctx() as any)));
const visible = (extra = {}) => getToolDefinitions({ ...ctx(), unlockTools: () => {}, ...extra } as any).map((t) => t.function.name);
const catalog = (extra = {}) => listDeferredTools({ ...ctx(), ...extra } as any).map((t) => t.name);

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-equip-'))); process.env.TANGU_HOME = home;
  const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });
  const assets: any = { listSkills: async () => SKILLS, getSkill: async (id: string) => SKILLS.find((s) => s.id === id) || null };
  configureTangu({ host: hostStub, brain: { assets } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }), state: {} as any });
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('收起工具 = 走按需目录,不是删能力', () => {
  // 从真实工具面里挑两个常驻、可收的工具,别把名字写死在测试里(工具增删不该连累这条)
  const pick = () => visible().filter((n) => isShelvable(n) && !['manage_human', 'remember'].includes(n)).slice(0, 2);

  it('收起的工具:定义出 defs、进目录、load_tools 取得回;解析表里它一直都在', async () => {
    const [a, b] = pick();
    const shelvedTools = new Set([a, b]);
    expect(visible({ shelvedTools })).not.toContain(a);
    expect(visible({ shelvedTools })).not.toContain(b);
    expect(catalog({ shelvedTools })).toEqual(expect.arrayContaining([a, b]));
    expect(catalog()).not.toContain(a); // 负对照:不收起就不在目录里
    expect(resolveTools(deps().profile, { ...ctx(), shelvedTools } as any).has(a)).toBe(true); // 按名直调照常解析得到
    const unlocked = new Set<string>();
    const out = String(await loadToolsProvider.tools()[0].execute({ names: [a] }, { ...ctx(), shelvedTools, unlockTools: (n: string[]) => { n.forEach((x) => unlocked.add(x)); } } as any));
    expect(out).toContain(`Loaded tool(s): ${a}`);
    expect(visible({ shelvedTools, unlockedTools: unlocked })).toContain(a);
    expect(visible({ shelvedTools, unlockedTools: unlocked })).not.toContain(b);
  });

  it('收不得的那几个:盘面写了也不认', () => {
    const shelvedTools = new Set(['manage_harness', 'load_tools', 'use_skill', 'ask_user', 'exit_plan_mode']);
    const defs = visible({ shelvedTools });
    for (const n of ['manage_harness', 'use_skill', 'ask_user']) expect(defs, n).toContain(n);
    for (const n of shelvedTools) expect(catalog({ shelvedTools }), n).not.toContain(n);
  });

  it('Muse / 自动化这类系统 run 不吃这套(全量可见)', () => {
    const [a] = pick();
    expect(visible({ shelvedTools: new Set([a]), muse: true })).toContain(a);
  });
});

describe('manage_harness kind:"equip"', () => {
  it('名字核不过就不落盘:未知工具 / 收不得 / 本来就按需 / 未知技能', async () => {
    const eq = (extra: Record<string, unknown>) => call({ action: 'upsert', kind: 'equip', title: 'Shelf', body: 'unused', evidence: 'review', ...extra });
    expect(await eq({ tools: ['no_such_tool'] })).toMatch(/^Error: unknown tool name\(s\): no_such_tool/);
    expect(await eq({ tools: ['load_tools'] })).toMatch(/^Error: load_tools cannot be shelved/);
    expect(await eq({ tools: [catalog()[0]] })).toMatch(/already load on demand/);
    expect(await eq({ skills: ['local:nope'] })).toMatch(/^Error: unknown skill id\(s\): local:nope/);
    expect(await eq({})).toMatch(/^Error: an "equip" entry must shelve at least one/);
    expect(await loadHarness('equipper')).toEqual([]);
  });

  it('收起 → 回执带名字 → 下一次 run 的工具面 / 技能目录跟着变;删掉条目全部回来', async () => {
    const [a] = visible().filter((n) => isShelvable(n) && !['manage_human', 'remember'].includes(n));
    const created = JSON.parse(await call({ action: 'upsert', kind: 'equip', title: 'Shelf', body: 'Unused for a month.', evidence: 'usage review', tools: [a], skills: ['local:foo'] }));
    expect(created.change).toMatchObject({ action: 'create', kind: 'equip', tools: [a], skills: ['local:foo'] });
    const shelved = shelvedOf(await loadHarness('equipper'));
    expect(visible({ shelvedTools: shelved.tools })).not.toContain(a);
    // 技能:目录里少一行,use_skill 的准许清单一个不少
    const full = await loadSkillLoadout('owner', 'tangu', { execMode: 'host' });
    const lean = await loadSkillLoadout('owner', 'tangu', { execMode: 'host' }, shelved.skills);
    expect(full.sections.join('\n')).toContain('local:foo');
    expect(lean.sections.join('\n')).not.toContain('local:foo');
    expect(lean.sections.join('\n')).toContain('local:bar');
    expect(lean.enabledSkillIds).toEqual(full.enabledSkillIds);
    // /skill 点名收起的那个:照常进 requested
    expect((await loadSkillLoadout('owner', 'tangu', { execMode: 'host', requestedSkillIds: ['local:foo'] }, shelved.skills)).requested.map((r) => r.id)).toEqual(['local:foo']);
    // 修订时名单里带着自己已经收起的那个:不算「本来就按需」
    const revised = JSON.parse(await runWithAgentSlug('equipper', async () => String(await tool.execute({ action: 'upsert', id: created.change.entryId, tools: [a] }, { ...ctx(), shelvedTools: shelved.tools } as any))));
    expect(revised.change).toMatchObject({ action: 'revise', tools: [a] });
    expect(await call({ action: 'list' })).toContain(`tools: ${a}; skills: local:foo;`);
    JSON.parse(await call({ action: 'delete', id: created.change.entryId }));
    expect(shelvedOf(await loadHarness('equipper')).tools.size).toBe(0);
  });
});
