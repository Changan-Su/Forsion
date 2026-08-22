import { describe, expect, it } from 'vitest';
import { createTanguProfile, createAiStudioProfile } from '../profiles/index.js';
import { getToolDefinitions, getToolCapabilities, executeTool } from './registry.js';
import type { ToolContext } from './toolTypes.js';
import { SKETCH_SECTION, sketchEnabledFor, sketchTurnSignalFor } from './builtin/sketch.js';

const toolNames = (ctx: ToolContext): string[] => getToolDefinitions(ctx).map((t) => t.function.name);

const tangu = createTanguProfile({ sandboxMode: 'none' });
const aiStudio = createAiStudioProfile();
const base = { userId: 'u1', sessionId: 's1' };

describe('sketch visibility gating (GUI client tag)', () => {
  it('is visible for a desktop client on the local tangu profile', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.8.0' })).toContain('sketch');
  });

  it('is visible for web clients on the cloud ai-studio profile (sandbox mode)', () => {
    expect(toolNames({ ...base, appId: aiStudio.appId, profile: aiStudio, execMode: 'sandbox', client: 'web/1.2.3' })).toContain('sketch');
  });

  it('is hidden on the Capacitor-native mobile app (addJavascriptInterface bridge reaches sandboxed frames)', () => {
    expect(toolNames({ ...base, appId: aiStudio.appId, profile: aiStudio, execMode: 'sandbox', client: 'mobile/2.7.9' })).not.toContain('sketch');
  });

  it('is hidden without a client tag (TUI / channels / automation)', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host' })).not.toContain('sketch');
  });

  it('is hidden in a channel-bound desktop session (the remote surface is plain text)', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.8.0', channelSession: true })).not.toContain('sketch');
    expect(sketchEnabledFor({ client: 'desktop/2.8.0', channelSession: true })).toBe(false);
  });

  it('is hidden for cli/tui client tags', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'cli/1.0.0' })).not.toContain('sketch');
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'tui/1.0.0' })).not.toContain('sketch');
  });

  it('is hidden inside delegated subagents even under a GUI client (client leaks via ctx spread)', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.8.0', subAgentDepth: 1 })).not.toContain('sketch');
  });

  it('is appended after existing tools (append-only prefix discipline)', () => {
    const names = toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.8.0' });
    expect(names.indexOf('sketch')).toBeGreaterThan(names.indexOf('search_sessions'));
  });
});

describe('sketch prompt section (trigger)', () => {
  it('is gated by the same predicate as the tool itself (no drift between the two sites)', () => {
    const gui = { client: 'desktop/2.8.0' };
    expect(sketchEnabledFor(gui)).toBe(true);
    expect(sketchEnabledFor({ client: 'cli/1.0.0' })).toBe(false);
    expect(sketchEnabledFor({})).toBe(false);
    expect(sketchEnabledFor({ ...gui, subAgentDepth: 1 })).toBe(false);
    // 判定源真的是同一个:门开着时工具在场,门关着时不在场
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', ...gui })).toContain('sketch');
  });

  it('stays out of plan mode, where a central read-only filter already drops the tool', () => {
    // 提示段在场 ⟺ 工具在场。计划模式的只读白名单里没有 sketch,提示段也必须一起缺席,
    // 否则模型照着段落去调一个不存在的工具,白烧一轮。
    const plan = { ...base, appId: tangu.appId, profile: tangu, execMode: 'host' as const, client: 'desktop/2.8.0', planMode: true };
    expect(toolNames(plan)).not.toContain('sketch');
    expect(sketchEnabledFor({ client: 'desktop/2.8.0', planMode: true })).toBe(false);
  });

  it('tells the model when to draw and gives it a composition floor', () => {
    expect(SKETCH_SECTION).toContain('sketch');
    expect(SKETCH_SECTION.toLowerCase()).toContain('compare');
    expect(SKETCH_SECTION.toLowerCase()).toContain('timeline');
    expect(SKETCH_SECTION).toContain('Do not wait for the user');
    expect(SKETCH_SECTION).toContain('Every finished card needs four parts');
    expect(SKETCH_SECTION).toContain('comparison/ranking');
    expect(SKETCH_SECTION).toContain('hierarchy/architecture');
  });

  it('description carries the theme contract (the model can only use vars it is told about)', () => {
    const def = getToolDefinitions({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.8.0' })
      .find((t) => t.function.name === 'sketch');
    const d = def?.function.description || '';
    for (const v of ['--fs-bg', '--fs-text', '--fs-muted', '--fs-border', '--fs-rule', '--fs-accent', '--fs-s1']) {
      expect(d).toContain(v);
    }
    expect(d).toContain('never hardcode colors');
    expect(d).toContain('transparent card canvas');
    for (const cls of ['fs-header', 'fs-title', 'fs-subtitle', 'fs-plot', 'fs-source', 'fs-stat-grid', 'fs-bar-track']) {
      expect(d).toContain(cls);
    }
  });
});

describe('sketch proactive turn signal', () => {
  it('treats an explicit visual request as mandatory delivery', () => {
    const s = sketchTurnSignalFor('请画一张从注册到支付的用户旅程图');
    expect(s?.kind).toBe('explicit');
    expect(s?.section).toContain('Call `sketch` before finishing');
  });

  it.each([
    '比较 Notion、Obsidian 和 Logseq 的定位、优缺点和价格',
    '从注册到付款有五个步骤，请解释整个用户旅程',
    '本周指标是 18、25、42、61，帮我分析增长趋势',
    'Give me a decision matrix comparing the three launch options',
  ])('proactively identifies a visual relationship without the word draw: %s', (message) => {
    expect(sketchTurnSignalFor(message)?.kind).toBe('implicit');
  });

  it.each([
    '只用文字比较 Notion 和 Obsidian，不要画图',
    '修复 compare.ts 里的 compare function 并补单测',
    '答案是 42',
    'Refactor the layout function in src/layout.ts',
    '修复图表数据 18、25、42 渲染错误并补单测',
  ])('does not turn prose/code/single facts into visual noise: %s', (message) => {
    expect(sketchTurnSignalFor(message)).toBeUndefined();
  });

  it('ignores visual words that only occur inside a code fence', () => {
    expect(sketchTurnSignalFor('fix this:\n```ts\nconst chart = compare(a, b)\n```')).toBeUndefined();
  });
});

describe('sketch execution', () => {
  const ctx: ToolContext = { ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.8.0' };
  const call = (args: Record<string, unknown>) => ({
    id: 'c1', type: 'function' as const,
    function: { name: 'sketch', arguments: JSON.stringify(args) },
  });

  it('declares itself side-effect free', () => {
    expect(getToolCapabilities('sketch', ctx)).toMatchObject({ sideEffect: 'none', parallel: false });
  });

  it('returns a short confirmation for valid html', async () => {
    const r = await executeTool(call({ html: '<b>hi</b>' }) as any, ctx);
    expect(r.isError).toBe(false);
    expect(r.result).toContain('Sketch card rendered');
  });

  it('rejects empty html', async () => {
    const r = await executeTool(call({ html: '  ' }) as any, ctx);
    expect(r.isError).toBe(true);
  });

  it('rejects oversized html (renderer must not draw rejected sketches)', async () => {
    const r = await executeTool(call({ html: 'x'.repeat(262_145) }) as any, ctx);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('too large');
  });
});
