import { describe, expect, it } from 'vitest';
import { createTanguProfile, createAiStudioProfile } from '../profiles/index.js';
import { getToolDefinitions, getToolCapabilities, executeTool } from './registry.js';
import type { ToolContext } from './toolTypes.js';
import { SKETCH_LESS_NOTE, SKETCH_SECTION, sketchEnabledFor, sketchTurnSignalFor, visualsPrefOf } from './builtin/sketch.js';

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

  it('is hidden without a client tag (TUI / automation / non-Desktop channel host)', () => {
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

  it('is hidden when the user set interface visuals to off (ui_settings snapshot), visible for less/auto/unknown', () => {
    const gui = { client: 'desktop/2.13.0' };
    expect(sketchEnabledFor({ ...gui, uiSettings: { visuals: { value: 'off' } } })).toBe(false);
    expect(sketchEnabledFor({ ...gui, uiSettings: { visuals: { value: 'less' } } })).toBe(true);
    expect(sketchEnabledFor({ ...gui, uiSettings: { visuals: { value: 'auto' } } })).toBe(true);
    expect(sketchEnabledFor({ ...gui, uiSettings: { visuals: { value: 'garbage' } } })).toBe(true);
    expect(sketchEnabledFor(gui)).toBe(true);
    // 同一判定也管工具表:off 的 run 里模型拿不到 sketch。
    const ctx = { ...base, appId: tangu.appId, profile: tangu, execMode: 'host' as const, client: 'desktop/2.13.0', uiSettings: { visuals: { value: 'off' } } };
    expect(toolNames(ctx)).not.toContain('sketch');
    expect(visualsPrefOf({ visuals: { value: 'off' } })).toBe('off');
    expect(visualsPrefOf(undefined)).toBe('auto');
  });

  it('the run-frozen ctx.visuals wins over uiSettings refreshed mid-run by set_ui_setting (prompt and gate stay consistent)', () => {
    const gui = { client: 'desktop/2.13.0' };
    // run 开始时 auto(提示段已催画),中途回执把 uiSettings 改成 off → 工具仍在,与提示一致;下一次 run 才按 off 走
    expect(sketchEnabledFor({ ...gui, visuals: 'auto', uiSettings: { visuals: { value: 'off' } } })).toBe(true);
    expect(sketchEnabledFor({ ...gui, visuals: 'off', uiSettings: { visuals: { value: 'auto' } } })).toBe(false);
    expect(sketchEnabledFor({ ...gui, visuals: 'less' })).toBe(true);
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
    expect(SKETCH_SECTION).toContain('Do not force every card');
    expect(SKETCH_SECTION).toContain('window.forsionSketch.setState');
    expect(SKETCH_SECTION).toContain('320px');
    expect(SKETCH_SECTION).toContain('comparison/ranking');
    expect(SKETCH_SECTION).toContain('hierarchy/architecture');
  });

  it('teaches progressive ordering and the ask() channel (card -> next user message), with a less-visuals note', () => {
    expect(SKETCH_SECTION).toContain('renders progressively');
    expect(SKETCH_SECTION).toContain('window.forsionSketch.ask(');
    expect(SKETCH_SECTION).toContain('never call it on load');
    expect(SKETCH_LESS_NOTE).toContain('only when they explicitly ask');
    const def = getToolDefinitions({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host', client: 'desktop/2.13.0' })
      .find((t) => t.function.name === 'sketch');
    expect(def?.function.description).toContain('forsionSketch.ask(');
    expect(def?.function.description).toContain('.copy(');
    expect(def?.function.description).toContain('fs-compare');
    expect(SKETCH_SECTION).toContain('fs-choice');
    expect(SKETCH_SECTION).toContain('fs-checklist');
    expect(SKETCH_SECTION).toContain('never add inline `style` attributes');
    expect(SKETCH_SECTION).toContain('window.forsionSketch.copy(');
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

  it('visuals=less keeps an explicit request mandatory but drops the implicit signal', () => {
    expect(sketchTurnSignalFor('请画一张从注册到支付的用户旅程图', 'less')?.kind).toBe('explicit');
    expect(sketchTurnSignalFor('比较 Notion、Obsidian 和 Logseq 的定位、优缺点和价格', 'less')).toBeUndefined();
    expect(sketchTurnSignalFor('比较 Notion、Obsidian 和 Logseq 的定位、优缺点和价格', 'auto')?.kind).toBe('implicit');
  });

  it.each([
    '这周末想带爸妈去杭州玩两天，帮我安排一下。',
    '下周要搬家，我需要提前准备些什么？',
    '我在纠结买 MacBook Air 还是 MacBook Pro，主要写代码，偶尔剪视频，你建议哪个？',
    '第一次自己做红烧肉，四个人吃，教我怎么做。',
    'Notion 和 Obsidian 哪个更适合记读书笔记？',
    "I'm hosting six friends for dinner on Saturday. What should I cook, and what do I need to buy?",
  ])('flags an answer the user will follow, tick off or choose from: %s', (message) => {
    expect(sketchTurnSignalFor(message)?.kind).toBe('actionable');
    expect(sketchTurnSignalFor(message, 'less')).toBeUndefined();
  });

  it.each([
    'TCP 三次握手里的第三次是做什么的？',
    '帮我把这句话翻译成英文：今天天气不错，适合出去走走。',
    '接下来怎么做？',
    '按计划继续',
    '修复 checklist.ts 的报错，推荐的写法是什么',
    '请只用文字推荐十本书，逐本解释适合谁及理由。',
    'Please explain the code step-by-step.',
    '这个还是失败了，你再试一次好吗？',
    'Translate this paragraph into Chinese: I recommend packing early. Make a checklist. Bring warm clothes.',
    '帮我把这段翻译成英文：推荐提前准备一份清单。',
  ])('leaves everyday agent talk, code tasks and text to be processed alone: %s', (message) => {
    expect(sketchTurnSignalFor(message)).toBeUndefined();
  });

  // 2026-10-13:和 ChatGPT 同题对照,词表抓不到的问法(跟进句、「怎么分配」「吃什么」「为什么」)交给模型按答案的形状自己定。
  it.each([
    '那四次挥手呢',
    '预算一千五以内呢',
    '那里有什么值得去的?',
    '晚饭吃什么',
    '红烧肉怎么做?四个人吃',
    '我月薪 15000,房租 4000,想一年存下 6 万,怎么分配?',
    '解释一下 TCP 为什么要三次握手',
    '好,那接下来怎么做',
  ])('hands an ordinary message to the model to shape, without a delivery nudge: %s', (message) => {
    const s = sketchTurnSignalFor(message, 'auto', true);
    expect(s?.kind).toBe('shape');
    expect(s?.section).toContain('with no view'); // 什么时候不出写在同一句提醒里
    expect(s?.section).toContain('not one detail'); // 只问流程里的一个细节(「第三次握手是做什么的」)不配图:visualauto 的 fact 那条钉着
    expect(sketchTurnSignalFor(message, 'less', true)).toBeUndefined();
    expect(sketchTurnSignalFor(message, 'auto', false)).toBeUndefined(); // 没有原生文档的客户端不发:为一份清单起 sketch 卡太重
  });

  it.each([
    '继续',
    '好的',
    'ok',
    '修复 checklist.ts 的报错，推荐的写法是什么',
    '帮我把这句话翻译成英文：今天天气不错，适合出去走走。',
    'Refactor the layout function in src/layout.ts',
    '把登录接口实现一下',
    '只用文字说说晚饭吃什么',
  ])('keeps the shape note out of acknowledgements, code work and text to be processed: %s', (message) => {
    expect(sketchTurnSignalFor(message, 'auto', true)).toBeUndefined();
  });

  // 真模型(10-13):让它「先写一段话、再调用」时一半写完那段话就收尾。开头的结论要放进文档里,提醒里不许出现让它先说话的说法。
  it.each(['下周要搬家，我需要提前准备些什么？', '晚饭吃什么'])('puts the opening conclusion inside the view instead of before the call: %s', (message) => {
    const section = sketchTurnSignalFor(message, 'auto', true)?.section || '';
    expect(section).toContain('make the call first, without announcing it');
    expect(section).toContain('first block is a `text` block');
    expect(section).not.toMatch(/start with [^.]*prose/i);
  });

  it('names the native tool only when the client can render it', () => {
    const q = '下周要搬家，我需要提前准备些什么？';
    expect(sketchTurnSignalFor(q, 'auto', true)?.section).toContain('`intelligent_ui`');
    expect(sketchTurnSignalFor(q, 'auto', false)?.section).not.toContain('intelligent_ui');
    expect(sketchTurnSignalFor('请画一张从注册到支付的用户旅程图', 'auto', true)?.section).toContain('Call `intelligent_ui` or `sketch` before finishing');
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
