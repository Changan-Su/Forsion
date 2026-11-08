/**
 * muse_space(卜算子填自己那份今日简报布局,11-08 方案 D 第一期)。真文件系统 + 临时 TANGU_HOME,真 widgetStore。
 *   只给卜算子(子代理 / 别的 Agent / 远程都没有);read 给出有效布局;update 只交差量:
 *   每个 run 那句话最多改一次、最多新提一张;墓碑里的 key、不是自己的小组件、超长的那句话、Library 里没有的「备好的」一律拒,什么都不写;
 *   rev 对不上回最新布局;widget 建 Muse 自己的 Agent 级小组件(项目会话里也不落进项目),只建不摆。
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run src/tools/builtin/museSpaceTool.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { museSpaceToolProvider, resetMuseSpaceRunUsageForTest } from './museSpaceTool.js';
import { museLibraryDir, musePlacementFile, museSpaceDocFile } from '../../services/museSpace.js';
import { createWidget, listWidgets } from '../../services/widgetStore.js';
import { widgetWrite } from '../../services/approvals.js';

const tool = (museSpaceToolProvider.tools() as any[])[0];
const profile = { capabilities: { hostExec: true } };
let home: string;
const prevHome = process.env.TANGU_HOME;
const ctxOf = (runId = 'run1', over: Record<string, unknown> = {}): any => ({ userId: 'local', sessionId: 's1', appId: 'tangu', runId, agentSlug: 'muse', ...over });
const call = (args: any, runId = 'run1', over: Record<string, unknown> = {}): Promise<string> => tool.execute(args, ctxOf(runId, over));
const docNow = (): any => JSON.parse(readFileSync(museSpaceDocFile(), 'utf8'));
const lib = (rel: string, text = 'x'): void => { const f = join(museLibraryDir(), rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); };
const UI_DOC = JSON.stringify({ version: 1, id: 'focus', title: 'Focus this week', inputs: [], resources: [], blocks: [{ id: 't', kind: 'text', markdown: 'Most of your week went to **Genesis**.' }] });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-muse-space-tool-'));
  process.env.TANGU_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(join(home, 'agents'), { recursive: true, force: true });
  rmSync(join(home, 'ui'), { recursive: true, force: true });
  resetMuseSpaceRunUsageForTest();
});

describe('可见性', () => {
  it('只给卜算子:别的 Agent、子代理、远程会话、云端都没有', () => {
    expect(tool.isEnabledFor(profile, { agentSlug: 'muse' })).toBe(true);
    expect(tool.isEnabledFor(profile, { agentSlug: 'xyra' })).toBe(false);
    expect(tool.isEnabledFor(profile, { agentSlug: 'muse', subAgentDepth: 1 })).toBe(false);
    expect(tool.isEnabledFor(profile, { agentSlug: 'muse', remote: { kind: 'tunnel' } })).toBe(false);
    expect(tool.isEnabledFor({ capabilities: {} }, { agentSlug: 'muse' })).toBe(false);
  });

  it('中途被远端染色的 run:执行时拒', async () => {
    expect(await call({ action: 'read' }, 'r', { remote: { kind: 'tunnel' } })).toMatch(/^Error: remote sessions/);
  });

  it('审批档:widget 同写文件(进 widgetWrite),read / update 不进', () => {
    const c = (args: any) => ({ id: 'c', type: 'function', function: { name: 'muse_space', arguments: JSON.stringify(args) } }) as any;
    expect(widgetWrite(c({ action: 'widget', name: 'x' }))).toBe(true);
    expect(widgetWrite(c({ action: 'update', expectedRev: 0 }))).toBe(false);
    expect(widgetWrite(c({ action: 'read' }))).toBe(false);
  });
});

describe('read', () => {
  it('第一次:rev 0,缺省三张,墓碑与挂着的提议照实给出', async () => {
    mkdirSync(join(home, 'ui'), { recursive: true });
    writeFileSync(musePlacementFile(), JSON.stringify({ schemaVersion: 1, rev: 2, order: null, hidden: ['tracking'], added: [], tombstones: [{ key: 'focus-week', at: '2026-11-07T18:20:00Z' }] }));
    const out = JSON.parse(await call({ action: 'read' }));
    expect(out).toMatchObject({ rev: 0, message: null, cards: ['todos', 'today'], hiddenByUser: ['tracking'], rejectedKeys: ['focus-week'], pendingProposals: [], thisRun: { messageChangesLeft: 1, proposalsLeft: 1 } });
    expect(out.hint).toMatch(/^Your message is empty: write one line now with update \{ expectedRev: 0, hero \}/); // live 首跑:空着也不写
    await call({ action: 'update', expectedRev: 0, hero: 'hi' });
    expect(JSON.parse(await call({ action: 'read' }))).not.toHaveProperty('hint');
  });
});

describe('update', () => {
  it('那句话:写进去、时刻由引擎填;同一个 run 第二次改被拒,换一个 run 可以', async () => {
    const r1 = await call({ action: 'update', expectedRev: 0, hero: 'You spent most of today on [[Drafts/plan.md]].' });
    expect(r1).toMatch(/^Saved your layout \(rev 1\): message updated/);
    const d = docNow();
    expect(d.hero.text).toBe('You spent most of today on [[Drafts/plan.md]].');
    expect(Date.parse(d.hero.at)).toBeGreaterThan(Date.now() - 60_000);
    const r2 = await call({ action: 'update', expectedRev: 1, hero: 'Another line' });
    expect(r2).toMatch(/^Error: .*already changed the message in this run/);
    expect(docNow().rev).toBe(1);
    // 同一句不算改(不为刷新时间重写):不报错也不写
    expect(await call({ action: 'update', expectedRev: 1, hero: 'You spent most of today on [[Drafts/plan.md]].' })).toMatch(/^No change/);
    expect(await call({ action: 'update', expectedRev: 1, hero: 'Another line' }, 'run2')).toMatch(/^Saved your layout \(rev 2\)/);
  });

  it('那句话超长:拒绝,不截断,什么都不写', async () => {
    const r = await call({ action: 'update', expectedRev: 0, hero: '字'.repeat(161) });
    expect(r).toMatch(/^Error: the message is 161 characters; the limit is 160/);
    expect(existsSync(museSpaceDocFile())).toBe(false);
  });

  it('rev 对不上:不写,回最新布局', async () => {
    await call({ action: 'update', expectedRev: 0, hero: 'hi' });
    const r = await call({ action: 'update', expectedRev: 0, prepared: [] }, 'run2');
    expect(r).toMatch(/^Error: your layout is at rev 1, not 0\. Nothing was saved\. Latest layout:\n\{/);
    expect(JSON.parse(r.slice(r.indexOf('{'))).message.text).toBe('hi');
  });

  it('备好的:Library 里没有的拒,什么都不写;有的照写', async () => {
    lib('Drafts/agenda.md');
    expect(await call({ action: 'update', expectedRev: 0, prepared: ['Drafts/agenda.md', 'Drafts/missing.md'] })).toMatch(/^Error: prepared: "Drafts\/missing.md" does not exist/);
    expect(await call({ action: 'update', expectedRev: 0, prepared: ['../outside.md'] })).toMatch(/^Error: prepared: .* not a relative path/);
    expect(await call({ action: 'update', expectedRev: 0, prepared: ['a.md', 'b.md', 'c.md', 'd.md'] })).toMatch(/^Error: prepared lists at most 3/);
    expect(existsSync(museSpaceDocFile())).toBe(false);
    expect(await call({ action: 'update', expectedRev: 0, prepared: ['Drafts/agenda.md'] })).toMatch(/^Saved .*prepared: Drafts\/agenda.md/);
  });

  it('提议:墓碑里的 key 拒;不是自己的小组件拒;每个 run 最多一张;已在格子里的拒', async () => {
    mkdirSync(join(home, 'ui'), { recursive: true });
    writeFileSync(musePlacementFile(), JSON.stringify({ schemaVersion: 1, rev: 1, order: null, hidden: [], added: [], tombstones: [{ key: 'focus-week', at: '2026-11-07T18:20:00Z' }] }));
    const mine = (await createWidget({ agentSlug: 'muse' }, { name: 'week-focus', entry: 'widget.json', content: UI_DOC })).widget.manifest.id;
    const theirs = (await createWidget({ agentSlug: 'xyra' }, { name: 'other', entry: 'widget.json', content: UI_DOC })).widget.manifest.id;
    const p = (key: string, extra: any) => call({ action: 'update', expectedRev: 0, propose: { key, why: 'Your week went to Genesis', ...extra } });
    expect(await p('focus-week', { widgetId: mine })).toMatch(/^Error: .*rejected "focus-week"; never propose that key again/);
    expect(await p('other', { widgetId: theirs })).toMatch(/^Error: w_\w+ is not one of your widgets/);
    expect(await p('todos', { builtin: 'todos' })).toMatch(/^Error: "todos" is already on the user's page/);
    expect(existsSync(museSpaceDocFile())).toBe(false);
    expect(await p('week', { widgetId: mine })).toMatch(/^Saved .*proposed "week"/);
    expect(docNow().proposed).toEqual([expect.objectContaining({ key: 'week', ref: { widgetId: mine }, why: 'Your week went to Genesis', at: expect.any(String) })]);
    const second = await call({ action: 'update', expectedRev: 1, propose: { key: 'status', builtin: 'status', why: 'see me' } });
    expect(second).toMatch(/^Error: .*already proposed a card in this run/);
    expect(docNow().proposed).toHaveLength(1);
  });

  it('什么都没给 / 没有 expectedRev:报错', async () => {
    expect(await call({ action: 'update', expectedRev: 0 })).toMatch(/^Error: nothing to change/);
    expect(await call({ action: 'update', hero: 'x' })).toMatch(/^Error: expectedRev is required/);
  });
});

describe('widget', () => {
  it('建 Muse 自己的 Agent 级小组件(项目会话里也不落进项目),回 id,不上页', async () => {
    const proj = join(home, 'proj');
    mkdirSync(proj, { recursive: true });
    const r = await call({ action: 'widget', name: 'focus-week', document: UI_DOC }, 'run1', { projectScoped: true, projectPath: proj });
    expect(r).toMatch(/^Created your widget "focus-week" \(id (w_\w+)\)\. It is not on the user's page/);
    const id = /id (w_\w+)/.exec(r)![1];
    const w = listWidgets({ agentSlug: 'muse' }).widgets.find((x) => x.manifest.id === id)!;
    expect(w.scope).toBe('agent');
    expect(w.manifest.title).toBe('Focus this week');
    expect(existsSync(join(proj, '.tangu'))).toBe(false);
    expect(existsSync(museSpaceDocFile())).toBe(false); // 只建不摆
    // read 里列出来,可以提议
    expect(JSON.parse(await call({ action: 'read' })).yourWidgets).toEqual([{ id, name: 'focus-week', title: 'Focus this week' }]);
  });

  it('坏文档 / app-card / 撞名:Error,不建', async () => {
    expect(await call({ action: 'widget', name: 'bad', document: '{"version":1' })).toMatch(/^Error: invalid intelligent_ui document/);
    const withCard = JSON.stringify({ version: 1, id: 'c', title: 'C', inputs: [], resources: [], blocks: [{ id: 'a', kind: 'app-card', cardId: 'native:calendar' }] });
    expect(await call({ action: 'widget', name: 'card', document: withCard })).toMatch(/^Error: app-card blocks cannot be used/);
    expect(listWidgets({ agentSlug: 'muse' }).widgets).toHaveLength(0);
    await call({ action: 'widget', name: 'dup', document: UI_DOC });
    expect(await call({ action: 'widget', name: 'dup', document: UI_DOC })).toMatch(/^Error: a widget named "dup" already exists/);
  });
});

describe('Codex 11-08 评审', () => {
  it('只在宿主执行:沙箱会话的审批门会直接放行非宿主工具,widget 的写文件审批就被绕过', () => {
    expect(tool.mode).toBe('host');
  });
});
