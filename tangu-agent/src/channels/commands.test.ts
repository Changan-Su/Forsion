/**
 * 通道命令面(commands.ts + messages.ts)的回归:解析归一 / 旧别名 / 目录驱动的 /help / /model 列表→回数字→
 * 模糊→无匹配 / /think 校验 / /status 内容 / /approval 只读 / /loop / /agent 带模型 / 双语文案表。
 * 运行时全部走假的 ChannelCommandRuntime —— 不碰 DB / agentLoop,命令逻辑坏了这里先红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_MODE_META, commandsFor } from '../core/commandCatalog.js';
import type { CatalogModel } from '../services/modelCatalog.js';
import type { NormalAgentDef } from '../agents/agentRegistry.js';
import { ChannelCommandCenter, PICK_TTL_MS, channelHelp, normalizeChannelText, parseChannelCommand, stopReply, type ChannelCommandRuntime, type ChannelSessionView } from './commands.js';
import { CHANNEL_MESSAGES, CHANNEL_REPLY_MAX, resolveChannelLocale } from './messages.js';

const HAN = /[一-鿿]/;

const model = (id: string, name: string, thinkingLevels: CatalogModel['thinkingLevels'], extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id, name, provider: 'forsion', source: 'forsion', modelType: 'llm', contextWindow: 200_000, contextWindowSource: 'default', supportsVision: true, thinkingLevels, ...extra,
});
const MODELS: CatalogModel[] = [
  model('pr-aaa', 'Claude Opus 5.5', ['off', 'low', 'medium', 'high', 'max']),
  model('pr-bbb', 'Claude Sonnet 5', ['off', 'low', 'medium', 'high']),
  model('codex/gpt-5.6-luna', 'gpt-5.6-luna', ['off', 'low', 'medium', 'high', 'xhigh'], { provider: 'codex', source: 'direct' }),
  model('deepseek-chat', 'DeepSeek Chat', ['off']),
];
const agent = (slug: string, extra: Partial<NormalAgentDef> = {}): NormalAgentDef => ({
  slug, name: slug === 'xyra' ? 'Xyra' : 'Coder', version: '1.0.0', description: '', model: '', tools: [], thinkingLevel: '' as any,
  maxIterations: null, approvalMode: '' as any, createdBy: 'user', createdAt: '', systemPrompt: '', ...extra,
});
const AGENTS = [agent('xyra'), agent('coder', { model: 'pr-bbb', maxIterations: 40 })];

function fake(over: Partial<ChannelCommandRuntime> = {}, session: Partial<ChannelSessionView> = {}) {
  const s: ChannelSessionView = { modelId: 'pr-aaa', title: 'WeChat Remote', agentConfig: { agentSlug: 'xyra', cwd: '/tmp/webot' }, ...session };
  const calls = { patch: [] as Record<string, unknown>[], setModel: [] as string[], saveDefault: [] as string[], thinking: [] as unknown[][], stop: 0 };
  const rt: ChannelCommandRuntime = {
    kind: 'wechat',
    locale: 'zh',
    approvalMode: 'auto-edit',
    channelDefaults: () => ({ agentSlug: '', modelId: '' }),
    defaultAgentSlug: () => 'xyra',
    workspaceDir: () => '/tmp/webot',
    readSession: async () => ({ ...s, agentConfig: { ...s.agentConfig } }),
    patchConfig: async (p) => {
      calls.patch.push(p);
      for (const [k, v] of Object.entries(p)) { if (v === null) delete s.agentConfig[k]; else s.agentConfig[k] = v; }
      return s.agentConfig;
    },
    setModel: async (id) => { calls.setModel.push(id); s.modelId = id; },
    listModels: async () => MODELS,
    listAgents: async () => AGENTS,
    getAgent: async (slug) => AGENTS.find((a) => a.slug === slug) ?? null,
    agentLoopCap: (def) => def.maxIterations ?? null,
    defaultLoopCap: 90,
    newSession: async () => {},
    listSessions: async () => [
      { id: 'sess-1111-aaaa', title: 'First', connected: true },
      { id: 'sess-2222-bbbb', title: '', connected: false },
    ],
    connectSession: async () => {},
    compact: async () => ({ ok: true, summarizedCount: 12 }),
    usage: async () => ({ tokens: 12345, runs: 3, cost: 0.5, cached: 100 }),
    sessionBusy: () => false,
    peerRunIds: () => [],
    stopPeer: () => { calls.stop += 1; return 0; },
    pendingState: () => ({ approval: false, inquiry: false }),
    requestRunThinking: (id, lv) => { calls.thinking.push([id, lv]); },
    saveDefaultModel: (id) => { calls.saveDefault.push(id); },
    setVoice: async () => {},
    ...over,
  };
  return { rt, calls, s };
}

const run = (c: ChannelCommandCenter, rt: ChannelCommandRuntime, text: string, key = 'acc:peer') => {
  const cmd = parseChannelCommand(text);
  if (!cmd) throw new Error(`not a command: ${text}`);
  return c.dispatch(rt, key, cmd);
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('parseChannelCommand / normalizeChannelText', () => {
  it('全角斜杠、全角空格、Telegram @bot 后缀都归一', () => {
    expect(normalizeChannelText('　／status　')).toBe('/status');
    expect(parseChannelCommand('／model opus')).toMatchObject({ name: '/model', arg: 'opus' });
    expect(parseChannelCommand('/model@MyTanguBot opus 5')).toMatchObject({ name: '/model', token: '/model', arg: 'opus 5' });
    expect(parseChannelCommand('/STATUS')?.name).toBe('/status');
    expect(parseChannelCommand('hello /model')).toBeNull();
  });

  it('旧通道别名 + 目录别名都落到正名', () => {
    const cases: Array<[string, string]> = [
      ['/n', '/new'], ['/新建 标题', '/new'], ['/ls', '/sessions'], ['/列表', '/sessions'], ['/list', '/sessions'],
      ['/sw 2', '/resume'], ['/切换 2', '/resume'], ['/switch 2', '/resume'], ['/h', '/help'], ['/帮助', '/help'], ['/?', '/help'],
      ['/语音', '/voice'], ['/文字', '/text'], ['/agentlist', '/agents'], ['/effort high', '/think'], ['/permissions', '/approval'],
      ['/stop', '/stop'], ['/停止', '/stop'],
    ];
    for (const [input, name] of cases) expect(parseChannelCommand(input)?.name, input).toBe(name);
    expect(parseChannelCommand('/新建 标题')?.arg).toBe('标题');
  });

  it('非通道命令 / 不认识的 → name=null(调用方回「未知命令」,绝不转给模型)', () => {
    expect(parseChannelCommand('/plan')?.name).toBeNull(); // 目录里有,但不在 channel 面
    expect(parseChannelCommand('/Users/me/a.txt 看看')?.name).toBeNull();
  });
});

describe('/help', () => {
  it('从目录生成,zh / en 各一种,英文里没有汉字,不超单条上限', () => {
    const zh = channelHelp('zh');
    const en = channelHelp('en');
    for (const c of commandsFor('channel')) {
      expect(zh).toContain(c.name);
      expect(en).toContain(c.name);
    }
    expect(zh).toContain('停止');
    expect(zh).toContain('批准');
    expect(en).toContain('approve / reject');
    expect(HAN.test(en)).toBe(false);
    expect(zh.length).toBeLessThanOrEqual(CHANNEL_REPLY_MAX);
    expect(en.length).toBeLessThanOrEqual(CHANNEL_REPLY_MAX);
  });

  it('未知命令回提示', async () => {
    const { rt } = fake();
    const out = await run(new ChannelCommandCenter(), rt, '/foo bar');
    expect(out).toContain('/foo');
    expect(out).toContain('/help');
  });
});

describe('/model', () => {
  it('无参列出 → 10 分钟内回数字选中 → 选完即忘', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake();
    const list = await run(c, rt, '/model');
    expect(list).toContain('1. ● Claude Opus 5.5');
    expect(list).toContain('3. gpt-5.6-luna [codex]');
    const picked = await c.tryPickNumber(rt, 'acc:peer', '2');
    expect(calls.setModel).toEqual(['pr-bbb']);
    expect(picked).toContain('只影响本会话');
    expect(picked).toContain('下一条消息');
    expect(await c.tryPickNumber(rt, 'acc:peer', '2')).toBeNull(); // 列表已消费
  });

  it('列表过期(10 分钟)后纯数字不再当选模型', async () => {
    vi.useFakeTimers();
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake();
    await run(c, rt, '/model');
    vi.advanceTimersByTime(PICK_TTL_MS + 1);
    expect(await c.tryPickNumber(rt, 'acc:peer', '2')).toBeNull();
    expect(calls.setModel).toEqual([]);
  });

  it('/model <n> 没列过也按完整目录序号选;越界报错', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake();
    await run(c, rt, '/model 3');
    expect(calls.setModel).toEqual(['codex/gpt-5.6-luna']);
    expect(await run(c, rt, '/model 99')).toContain('1–4');
  });

  it('关键词:命中直接切;模糊列候选(回数字选);无匹配不动', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake();
    await run(c, rt, '/model sonnet');
    expect(calls.setModel).toEqual(['pr-bbb']);

    const amb = await run(c, rt, '/model claude');
    expect(amb).toContain('1. Claude Opus 5.5');
    expect(amb).toContain('2. ● Claude Sonnet 5');
    await c.tryPickNumber(rt, 'acc:peer', '1');
    expect(calls.setModel).toEqual(['pr-bbb', 'pr-aaa']);

    const none = await run(c, rt, '/model gemini');
    expect(none).toContain('gemini');
    expect(calls.setModel).toEqual(['pr-bbb', 'pr-aaa']);
  });

  it('已是当前模型不重写;--default 同时存为通道默认;有任务在跑时说明旧任务用旧模型', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake({ peerRunIds: () => ['run-1'] });
    expect(await run(c, rt, '/model opus')).toContain('已经在用');
    expect(calls.setModel).toEqual([]);
    const out = await run(c, rt, '/model deepseek --default');
    expect(calls.setModel).toEqual(['deepseek-chat']);
    expect(calls.saveDefault).toEqual(['deepseek-chat']);
    expect(out).toContain('原来的模型');
    expect(out).toContain('默认模型');
  });

  it('切到不支持当前思考档的模型 → 说明按哪档跑', async () => {
    const c = new ChannelCommandCenter();
    const { rt } = fake({}, { agentConfig: { agentSlug: 'xyra', thinkingLevel: 'max' } });
    const out = await run(c, rt, '/model sonnet');
    expect(out).toContain('max');
    expect(out).toContain('high');
  });

  it('英文界面整条回复不含汉字', async () => {
    const c = new ChannelCommandCenter();
    const { rt } = fake({ locale: 'en' });
    expect(HAN.test(await run(c, rt, '/model'))).toBe(false);
    expect(HAN.test(await c.tryPickNumber(rt, 'acc:peer', '2') ?? '')).toBe(false);
  });
});

describe('/think', () => {
  it('无参显示当前档 + 本模型支持的档', async () => {
    const { rt } = fake();
    const out = await run(new ChannelCommandCenter(), rt, '/think');
    expect(out).toContain('medium');
    expect(out).toContain('off / low / medium / high / max');
  });

  it('认不得的档报错且不写;别名归一后写入', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake();
    const bad = await run(c, rt, '/think banana');
    expect(bad).toContain('banana');
    expect(bad).toContain('xhigh');
    expect(calls.patch).toEqual([]);
    await run(c, rt, '/think HIGH');
    await run(c, rt, '/effort none');
    expect(calls.patch).toEqual([{ thinkingLevel: 'high' }, { thinkingLevel: 'off' }]);
  });

  it('模型不支持的档:如实说按哪档跑;有任务在跑 → 下一步起生效', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake({ peerRunIds: () => ['run-9'] }, { modelId: 'deepseek-chat' });
    const out = await run(c, rt, '/think max');
    expect(out).toContain('off');
    expect(calls.thinking).toEqual([['run-9', 'max']]);
    expect(out).toContain('下一步');
  });
});

describe('/status /approval /loop /agent /compact /cost /stop', () => {
  it('/status 报模型、思考档、审批档(绑定上的真实档)、轮数、状态', async () => {
    const { rt } = fake({ approvalMode: 'readonly', pendingState: () => ({ approval: true, inquiry: false }) });
    const out = await run(new ChannelCommandCenter(), rt, '/status');
    expect(out).toContain('Claude Opus 5.5 (pr-aaa)');
    expect(out).toContain('medium');
    expect(out).toContain(APPROVAL_MODE_META.readonly.zh);
    expect(out).toContain(APPROVAL_MODE_META.readonly.descZh);
    expect(out).toContain('90');
    expect(out).toContain('等你批准');
    expect(out).toContain('/tmp/webot');
  });

  it('/status:桌面在同一会话发起的任务在跑 → 不报「空闲」(与 /compact 的拒绝口径一致)', async () => {
    const { rt } = fake({ sessionBusy: () => true });
    const out = await run(new ChannelCommandCenter(), rt, '/status');
    expect(out).toContain('不是从这个聊天发起的');
    expect(out).not.toContain('空闲');
    expect(await run(new ChannelCommandCenter(), rt, '/compact')).toContain('有任务正在运行');
  });

  it('/status 英文', async () => {
    const { rt } = fake({ locale: 'en', approvalMode: 'full-auto' });
    const out = await run(new ChannelCommandCenter(), rt, '/status');
    expect(out).toContain(APPROVAL_MODE_META['full-auto'].en);
    expect(out).toContain('idle');
    expect(HAN.test(out)).toBe(false);
  });

  it('/approval 只显示、带参也不改,并说明为什么', async () => {
    const { rt, calls } = fake({ approvalMode: 'readonly' });
    const out = await run(new ChannelCommandCenter(), rt, '/permissions full-auto');
    expect(out).toContain(APPROVAL_MODE_META.readonly.zh);
    expect(out).toContain('不能改');
    expect(out).toContain('群聊');
    expect(calls.patch).toEqual([]);
  });

  it('/loop 显示来源 / 设置 / 恢复默认 / 越界', async () => {
    const c = new ChannelCommandCenter();
    const { rt, calls } = fake({}, { agentConfig: { agentSlug: 'coder' } });
    expect(await run(c, rt, '/loop')).toContain('40');
    await run(c, rt, '/loop 50');
    expect(await run(c, rt, '/loop 0')).toContain('1–200');
    expect(await run(c, rt, '/loop 201')).toContain('1–200');
    await run(c, rt, '/loop default');
    expect(calls.patch).toEqual([{ maxIterations: 50 }, { maxIterations: null }]);
  });

  it('/agent 切人格;定义带模型 → 会话模型一起切(桌面同口径)', async () => {
    const { rt, calls } = fake();
    const out = await run(new ChannelCommandCenter(), rt, '/agent coder');
    expect(calls.patch).toEqual([{ agentSlug: 'coder' }]);
    expect(calls.setModel).toEqual(['pr-bbb']);
    expect(out).toContain('pr-bbb');
    expect(await run(new ChannelCommandCenter(), rt, '/agent nobody')).toContain('nobody');
  });

  it('/compact 在跑时拒绝;空闲时带关注点压缩', async () => {
    const compact = vi.fn(async () => ({ ok: true, summarizedCount: 7 }));
    const busy = fake({ peerRunIds: () => ['r'], compact });
    expect(await run(new ChannelCommandCenter(), busy.rt, '/compact')).toContain('正在运行');
    expect(compact).not.toHaveBeenCalled();
    const idle = fake({ compact });
    expect(await run(new ChannelCommandCenter(), idle.rt, '/compact 只留结论')).toContain('7');
    expect(compact).toHaveBeenCalledWith('只留结论', 'pr-aaa', expect.any(Object));
  });

  it('/cost 与 /stop', async () => {
    const { rt } = fake({ stopPeer: () => 2 });
    expect(await run(new ChannelCommandCenter(), rt, '/cost')).toContain('12,345');
    expect(await run(new ChannelCommandCenter(), rt, '/stop')).toContain('2');
    expect(stopReply('en', 0)).toBe(CHANNEL_MESSAGES.stopNone.en);
  });

  it('/resume 按序号或 id 前缀', async () => {
    const connectSession = vi.fn(async () => {});
    const { rt } = fake({ connectSession });
    const c = new ChannelCommandCenter();
    expect(await run(c, rt, '/resume 2')).toContain('2');
    expect(await run(c, rt, '/switch sess-1111')).toContain('First');
    expect(connectSession.mock.calls.map((x: unknown[]) => x[0])).toEqual(['sess-2222-bbbb', 'sess-1111-aaaa']);
    expect(await run(c, rt, '/resume 9')).toContain('2');
  });
});

describe('messages', () => {
  it('每条都有 zh + en,en 不含汉字,占位符两边一致', () => {
    for (const [key, pair] of Object.entries(CHANNEL_MESSAGES)) {
      expect(pair.zh, key).toBeTruthy();
      expect(pair.en, key).toBeTruthy();
      expect(HAN.test(pair.en), key).toBe(false);
      const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(pair.en), key).toEqual(vars(pair.zh));
    }
  });

  it('语言判定:手选 > TANGU_LANG(与 TUI 同名)> LANG > Intl(zh)> 平台缺省', () => {
    expect(resolveChannelLocale('wechat', 'en', { LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveChannelLocale('telegram', undefined, { TANGU_LANG: 'zh-CN', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(resolveChannelLocale('wechat', undefined, { TANGU_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(resolveChannelLocale('wechat', undefined, { LANG: 'en_US.UTF-8' })).toBe('en');
    expect(resolveChannelLocale('telegram', undefined, { LANG: 'zh_TW.UTF-8' })).toBe('zh');
    // 无任何系统信号(Finder 启动的桌面端:无 LANG,ICU 恒报 en-US)→ 平台缺省
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ resolvedOptions: () => ({ locale: 'en-US' }) } as any);
    expect(resolveChannelLocale('wechat', undefined, {})).toBe('zh');
    expect(resolveChannelLocale('qq', undefined, { LANG: 'C.UTF-8' })).toBe('zh');
    expect(resolveChannelLocale('telegram', undefined, {})).toBe('en');
  });
});
