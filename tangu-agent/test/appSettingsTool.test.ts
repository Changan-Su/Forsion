/**
 * agent 读、改本机设置(app_settings / update_app_settings,方案 9.3 的 S2a):
 *   ① 可见性:只给前台 host run、全 deferred;子代理 / 讨论 / Muse / 自动化 / 临时成员 / 沙箱不可见;通道来的 run 只有读工具;
 *   ② 读:表里的段与字段带现值(没写过 = 缺省值)、密钥只报「已配置 / 未配置」;表外的段(云端地址与令牌、提供方密钥与地址、
 *      MCP、钩子、通道、沙箱、远程、审批规则……)一个字都不出现;语音通话的模型 / 音色读得到、改不了(音色绑在通话模型上);
 *   ③ 写:只动点名的字段,段里其余键(含密钥)与别的段原样保留;整批校验(一个字段不合法 = 文件一个字节都不变);
 *      模型名解析成完整 id;没填密钥的搜索服务切不过去;默认工作目录只收「已存在、不是家目录及其上级、不在应用配置区」的目录;
 *      值没变不写盘、不发事件;
 *   ④ 审批:控制面 —— 询问我批准 / 替我批准 每次都问、不进「总允许」;完全放行自动过,但默认工作目录任何档位都问;
 *      远程污点 run 直接拒(不弹卡);卡上写的是「现值 → 新值」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { getToolDefinitions, listDeferredTools, executeTool, type ToolContext } from '../src/tools/registry.js';
import { subscribe } from '../src/services/eventBus.js';
import { controlPlaneCall, gateToolCall, resolveApproval, toolNeedsApproval, type ApprovalAction } from '../src/services/approvals.js';
import { APP_SETTINGS, renderAppSettings, updateAppSettings } from '../src/services/appSettings.js';
import { ZHIPU_ENGINES } from '../src/adapters/standalone/localSearch.js';
import { clearRunRemoteTaint, taintRunRemote } from '../src/services/remoteOrigin.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const USER = 'u1';
const CLOUD = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'text-only-1', name: 'Text Only', provider: 'x', supportsVision: false },
  { id: 'img-1', name: 'Image One', provider: 'x', modelType: 'image_gen' },
];
/** 取模型目录的那一刻要做的事(模拟「校验等网络时 run 被远端染色」)。 */
let onCatalog: (() => void) | undefined;
const brain: any = {
  models: {
    listModelsForProject: async () => { onCatalog?.(); return { models: CLOUD, defaultModelId: 'claude-sonnet-5' }; },
    listDirectProviders: () => [{ providerId: 'bailian', baseUrl: 'https://provider-host.example/v1', modelIds: ['qwen-max'], imageModelIds: ['wan-1'], ttsModelIds: ['cosy-2'] }],
    hasDirectModel: () => false,
  },
};

/** 每个值都带 SECRET,读出来的任何文本里都不该有这个词。 */
const SEEDED = {
  cloud: { url: 'https://SECRET-cloud.example', token: 'SECRET_CLOUD_TOKEN', defaultModel: 'claude-sonnet-5' },
  providers: [{ providerId: 'bailian', apiKey: 'SECRET_PROVIDER_KEY', baseUrl: 'https://SECRET-host.example', modelIds: ['qwen-max'] }],
  mcp: { mcpServers: { x: { command: 'SECRET_MCP_CMD', env: { K: 'SECRET_MCP_ENV' } } } },
  hooks: { PreToolUse: [{ command: 'SECRET_HOOK' }] },
  channels: { telegram: { token: 'SECRET_TG' } },
  approval: { base: 'full-auto', allow: ['SECRET_RULE'] },
  remote: { maxApprovalMode: 'readonly', note: 'SECRET_REMOTE' },
  sandbox: 'none',
  tts: { modelId: 'bailian/cosy-2', voice: 'alloy', realtimeModel: 'bailian/qwen3.5-omni-plus-realtime', realtimeVoice: 'Tina', futureKey: 'kept-as-is' },
  webSearch: { provider: 'tavily', tavilyApiKey: 'SECRET_TAVILY', bochaApiKey: null },
};

let home: string;
let outside: string; // 家目录域之外的一个真实目录(当默认工作目录的候选)
const cfgPath = (): string => join(home, 'config.json');
const readCfg = (): any => JSON.parse(readFileSync(cfgPath(), 'utf8'));
const seed = (c: Record<string, unknown> = SEEDED): void => writeFileSync(cfgPath(), JSON.stringify(c, null, 2));
const base = (): ToolContext => ({ userId: USER, sessionId: 'S', appId: 'tangu', profile, execMode: 'host', cwd: outside, unlockTools: () => {}, unlockedTools: new Set(['app_settings', 'update_app_settings']) });
const call = (name: string, args: Record<string, unknown>): any =>
  ({ id: `c-${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-appset-'));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-appset-ws-')));
  process.env.TANGU_HOME = home;
  onCatalog = undefined;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain, billing: stub, profile });
  await runMigration();
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES ('S', ?, 'tangu', 't', 'm1', 'user')`, [USER]);
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  for (const d of [home, outside]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('① 可见性', () => {
  const catalog = (ctx: ToolContext) => listDeferredTools(ctx).map((d) => d.name);
  const all = (ctx: ToolContext) => [...catalog(ctx), ...getToolDefinitions(ctx).map((t: any) => t.function?.name)];

  it('前台 host run:两件都在按需目录里、不占常驻定义;解锁后都在', () => {
    const locked = { ...base(), unlockedTools: undefined };
    expect(catalog(locked)).toEqual(expect.arrayContaining(['app_settings', 'update_app_settings']));
    expect(getToolDefinitions(locked).map((t: any) => t.function?.name)).not.toContain('app_settings');
    expect(getToolDefinitions(base()).map((t: any) => t.function?.name)).toEqual(expect.arrayContaining(['app_settings', 'update_app_settings']));
  });

  it('子代理 / 讨论 / Muse / 自动化 / 临时成员 / 无人值守 / 沙箱:两件都不可见', () => {
    for (const ctx of [
      { ...base(), subAgentDepth: 1 }, { ...base(), inDiscussion: true }, { ...base(), muse: true }, { ...base(), automationOrigin: 'rule-1' },
      { ...base(), ephemeral: true }, { ...base(), approvalDeferral: 'queue' as const }, { ...base(), execMode: 'sandbox' as const },
    ]) {
      expect(all(ctx)).not.toContain('app_settings');
      expect(all(ctx)).not.toContain('update_app_settings');
    }
  });

  it('通道来的 run:能读不能改(写工具不可见,凭名字硬调也执行不了)', async () => {
    seed();
    const ctx: ToolContext = { ...base(), runOrigin: 'channel' };
    expect(all(ctx)).toContain('app_settings');
    expect(all(ctx)).not.toContain('update_app_settings');
    const before = readFileSync(cfgPath(), 'utf8');
    const r = await executeTool(call('update_app_settings', { section: 'tts', values: { voice: 'nova' }, reason: 'x' }), ctx);
    expect(r.isError).toBe(true);
    expect(readFileSync(cfgPath(), 'utf8')).toBe(before);
    expect((await executeTool(call('app_settings', {}), ctx)).result).toContain('can read them but not change them');
  });

  it('写工具不靠 command 档(那一档进「总允许」),读工具不过闸', () => {
    expect(toolNeedsApproval('update_app_settings', 'readonly')).toBe(false);
    expect(toolNeedsApproval('app_settings', 'readonly')).toBe(false);
    expect(controlPlaneCall('update_app_settings', { section: 'tts', values: { voice: 'a' } })).toBe(true);
    expect(controlPlaneCall('app_settings', {})).toBe(false);
  });
});

describe('② 读', () => {
  it('现值、缺省值、取值范围与落点;密钥只报有没有', () => {
    seed();
    const out = renderAppSettings({ writable: true });
    expect(out).toContain('defaultModel = "claude-sonnet-5"');
    expect(out).toContain('voice = "alloy"');
    expect(out).toContain('speed = 1  (0.5–2)'); // 没写过 = 缺省
    expect(out).toContain('autoSpeak = false');
    expect(out).toContain('visionMode = "auto"  (auto | always | off)');
    expect(out).toContain('provider = "tavily"');
    expect(out).toContain('API keys: Bocha not set · Tavily set · Zhipu not set');
    expect(out).toContain('open-settings "voice"');
    // 语音通话:现值读得到,但标了只读、不给「可填什么」
    expect(out).toMatch(/realtimeModel = "bailian\/qwen3\.5-omni-plus-realtime" — .* \[read-only here: a call voice only works with the call model/);
    expect(out).toMatch(/realtimeVoice = "Tina" — .* \[read-only here: /);
    expect(out).toContain('bailian — chat: qwen-max; image: wan-1; read-aloud: cosy-2');
    expect(out).toContain('update_app_settings');
  });

  it('表外的段、段里表外的键、任何密钥和地址,一个字都不出现', () => {
    seed();
    for (const out of [renderAppSettings({ writable: true }), ...Object.keys(APP_SETTINGS).map((s) => renderAppSettings({ section: s, writable: false })), renderAppSettings({ section: 'providers', writable: true })]) {
      expect(out).not.toMatch(/SECRET/i);
      expect(out).not.toContain('provider-host.example');
      expect(out).not.toContain('futureKey');
      expect(out).not.toMatch(/\[(mcp|hooks|channels|approval|remote|sandbox)\]/);
    }
  });

  it('没有 config.json / 段缺失:全是缺省值,不报错;不认识的段名报可读的段', () => {
    const out = renderAppSettings({ writable: true });
    expect(out).toContain('defaultModel = ""');
    expect(out).toContain('path = ""');
    expect(renderAppSettings({ section: 'mcp', writable: true })).toMatch(/^Error: unknown section "mcp"\. Sections you can read: cloud, models, tts, asr, webSearch, workspace, providers\./);
    expect(renderAppSettings({ section: 'tts', writable: true })).not.toContain('[webSearch]');
  });

  it('联网搜索的档位表与搜索实现是同一份', () => {
    expect((APP_SETTINGS.webSearch.fields.zhipuEngine as any).values).toBe(ZHIPU_ENGINES);
  });
});

describe('③ 写', () => {
  it('只动点名的字段:段里其余键(含密钥、不认识的键)与别的段原样保留', async () => {
    seed();
    const r = await updateAppSettings(profile, 'tts', { voice: ' nova ', speed: 1.25, autoSpeak: true });
    expect(r).toMatchObject({ ok: true, changed: ['voice', 'speed', 'autoSpeak'] });
    expect(r.text).toContain('voice: "alloy" → "nova"');
    expect(r.text).toContain('Applies from the next read-aloud');
    expect(readCfg()).toEqual({ ...SEEDED, tts: { ...SEEDED.tts, voice: 'nova', speed: 1.25, autoSpeak: true } });

    const w = await updateAppSettings(profile, 'webSearch', { provider: 'duckduckgo', zhipuEngine: 'search_pro' });
    expect(w.ok).toBe(true);
    expect(readCfg().webSearch).toEqual({ provider: 'duckduckgo', tavilyApiKey: 'SECRET_TAVILY', bochaApiKey: null, zhipuEngine: 'search_pro' });
    expect(w.text).not.toMatch(/SECRET/);
  });

  it('联网搜索:填了密钥的服务才切得过去(agent 填不了密钥,切过去只会悄悄回落)', async () => {
    seed({ webSearch: { provider: 'auto', tavilyApiKey: 'SECRET_TAVILY', bochaApiKey: null, zhipuApiKey: '  ' } });
    const before = readFileSync(cfgPath(), 'utf8');
    for (const [p, label] of [['bocha', 'Bocha'], ['zhipu', 'Zhipu']]) {
      const r = await updateAppSettings(profile, 'webSearch', { provider: p, zhipuEngine: 'search_std' });
      expect(r.ok).toBe(false);
      expect(r.text).toContain(`provider: ${label} has no API key yet`);
      expect(r.text).not.toMatch(/SECRET/);
    }
    expect(readFileSync(cfgPath(), 'utf8')).toBe(before); // 连同一批里合法的 zhipuEngine 也没写
    expect((await updateAppSettings(profile, 'webSearch', { provider: 'tavily' })).changed).toEqual(['provider']);
    expect((await updateAppSettings(profile, 'webSearch', { provider: 'auto' })).changed).toEqual(['provider']);
  });

  it('默认模型写在 cloud 段里,但云端地址和令牌不动', async () => {
    seed();
    const r = await updateAppSettings(profile, 'cloud', { defaultModel: 'opus' }); // 不完整的名字 → 完整 id
    expect(r).toMatchObject({ ok: true, changed: ['defaultModel'] });
    expect(readCfg().cloud).toEqual({ url: 'https://SECRET-cloud.example', token: 'SECRET_CLOUD_TOKEN', defaultModel: 'claude-opus-5-5' });
    for (const bad of [{ url: 'https://evil.example' }, { token: 'x' }]) {
      const before = readFileSync(cfgPath(), 'utf8');
      expect((await updateAppSettings(profile, 'cloud', bad)).ok).toBe(false);
      expect(readFileSync(cfgPath(), 'utf8')).toBe(before);
    }
  });

  it('模型字段:歧义 / 找不到 / 生图模型 / 看不了图的模型当识图模型 → 都不写;"" = 跟随缺省', async () => {
    seed();
    const before = readFileSync(cfgPath(), 'utf8');
    expect((await updateAppSettings(profile, 'models', { background: 'claude' })).text).toMatch(/matches several models \(claude-opus-5-5, claude-sonnet-5\)/);
    expect((await updateAppSettings(profile, 'models', { background: 'llama' })).text).toMatch(/no model matches "llama"/);
    expect((await updateAppSettings(profile, 'models', { background: 'img-1' })).ok).toBe(false);
    expect((await updateAppSettings(profile, 'models', { vision: 'text-only-1' })).text).toMatch(/no vision-capable model matches/);
    expect(readFileSync(cfgPath(), 'utf8')).toBe(before);
    expect((await updateAppSettings(profile, 'models', { background: 'text-only-1', vision: 'sonnet', visionMode: 'always' })).ok).toBe(true);
    expect(readCfg().models).toEqual({ background: 'text-only-1', vision: 'claude-sonnet-5', visionMode: 'always' });
    expect((await updateAppSettings(profile, 'models', { background: '' })).changed).toEqual(['background']);
    expect(readCfg().models.background).toBe('');
  });

  it('整批校验:一个字段不合法,文件一个字节都不变,并逐条说明', async () => {
    seed();
    const before = readFileSync(cfgPath(), 'utf8');
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
      ['tts', { voice: 'nova', speed: 9 }, /speed must be a number between 0\.5 and 2/],
      ['tts', { speed: '1.2' }, /speed must be a number/],
      ['tts', { autoSpeak: 'yes' }, /autoSpeak must be true or false/],
      ['tts', { voice: 'a\nb' }, /control characters/],
      ['tts', { voice: 'x'.repeat(121) }, /too long/],
      ['tts', { voice: 42 }, /voice must be a string/],
      ['tts', { nope: 1 }, /nope is not a field of tts \(fields: modelId, voice, speed, autoSpeak, realtimeModel, realtimeVoice\)/],
      ['tts', { voice: 'nova', realtimeVoice: 'Cindy' }, /realtimeVoice is read-only here: a call voice only works with the call model .* open-settings "voice"/],
      ['tts', { realtimeModel: '' }, /realtimeModel is read-only here/],
      ['asr', { backend: 'remote' }, /backend must be one of: local, cloud/],
      ['webSearch', { tavilyApiKey: 'k' }, /API keys can only be entered by the user/],
      ['webSearch', { provider: 'google' }, /provider must be one of/],
      ['providers', { x: 1 }, /providers are read-only here/],
      ['mcp', { mcpServers: {} }, /unknown section "mcp"\. Sections you can change: cloud, models, tts, asr, webSearch, workspace\./],
      ['hooks', {}, /unknown section/],
      ['tts', {}, /`values` must be an object/],
      ['tts', [1] as any, /`values` must be an object/],
      ['tts', JSON.parse('{"__proto__": {"voice": "x"}}'), /__proto__ is not a field/],
      ['tts', { constructor: 'x' }, /constructor is not a field/],
    ];
    for (const [section, values, re] of bad) {
      const r = await updateAppSettings(profile, section, values);
      expect(r.ok, `${section} ${JSON.stringify(values)}`).toBe(false);
      expect(r.changed).toEqual([]);
      expect(r.text, `${section} ${JSON.stringify(values)}`).toMatch(re);
      expect(readFileSync(cfgPath(), 'utf8'), `${section} ${JSON.stringify(values)}`).toBe(before);
    }
  });

  it('默认工作目录:只收已存在的、家目录域之外的绝对目录', async () => {
    seed();
    const file = join(outside, 'a.txt');
    writeFileSync(file, 'x');
    const inside = join(home, 'agents', 'xyra', 'Library');
    mkdirSync(inside, { recursive: true });
    const homeLink = join(outside, 'to-home');
    symlinkSync(homedir(), homeLink);
    const before = readFileSync(cfgPath(), 'utf8');
    const bad: Array<[string, RegExp]> = [
      ['relative/dir', /must be an absolute path/],
      [join(outside, 'missing'), /does not exist/],
      [file, /is not a folder/],
      ['/', /cannot be set as the workspace by you/],
      [homedir(), /cannot be set as the workspace by you/],
      [dirname(homedir()), /cannot be set as the workspace by you/],
      [home, /cannot be set as the workspace by you/], // 应用自己的目录
      [inside, /cannot be set as the workspace by you/], // 其中的 agent 目录
      [fileURLToPath(new URL('../src', import.meta.url)), /cannot be set as the workspace by you/], // 引擎包目录里面(选进来 = 以后改审批代码不用问)
      [homeLink, /cannot be set as the workspace by you/], // 指向家目录的软链
    ];
    for (const [p, re] of bad) {
      const r = await updateAppSettings(profile, 'workspace', { path: p });
      expect(r.ok, p).toBe(false);
      expect(r.text, p).toMatch(re);
    }
    expect(readFileSync(cfgPath(), 'utf8')).toBe(before);

    const r = await updateAppSettings(profile, 'workspace', { path: outside });
    expect(r).toMatchObject({ ok: true, changed: ['path'] });
    expect(readCfg().workspace).toBe(outside); // 段本身就是这个字符串
    expect(renderAppSettings({ section: 'workspace', writable: true })).toContain(`path = ${JSON.stringify(outside)}`);
    expect((await updateAppSettings(profile, 'workspace', { path: '' })).ok).toBe(true);
    expect(readCfg().workspace).toBe('');

    // 软链:存的是它此刻指向的真实目录(存链接本身的话,之后改指别处,免审批的可写根就跟着换了)
    const target = join(outside, 'proj');
    mkdirSync(target);
    const link = join(outside, 'link');
    symlinkSync(target, link);
    expect((await updateAppSettings(profile, 'workspace', { path: link })).text).toContain(`path: "" → ${JSON.stringify(target)}`);
    expect(readCfg().workspace).toBe(target);
  });

  it('落盘前最后再问一次:校验等模型目录时 run 被远端染色 → 不写', async () => {
    seed();
    const before = readFileSync(cfgPath(), 'utf8');
    expect(await updateAppSettings(profile, 'tts', { voice: 'nova' }, () => 'not now')).toEqual({ ok: false, text: 'Error: not now', changed: [] });
    expect(readFileSync(cfgPath(), 'utf8')).toBe(before);

    const ctx: ToolContext = { ...base(), runId: 'RT-taint' };
    onCatalog = () => taintRunRemote('RT-taint', { via: 'tunnel', marked: true });
    try {
      const r = await executeTool(call('update_app_settings', { section: 'models', values: { background: 'sonnet' }, reason: 'x' }), ctx);
      expect(r.isError).toBe(true);
      expect(r.result).toContain('Remote sessions cannot change app settings');
      expect(readFileSync(cfgPath(), 'utf8')).toBe(before);
    } finally { clearRunRemoteTaint('RT-taint'); }
    // 对照:没被染色的同一次调用写得进去
    onCatalog = undefined;
    expect((await executeTool(call('update_app_settings', { section: 'models', values: { background: 'sonnet' }, reason: 'x' }), ctx)).isError).toBe(false);
    expect(readCfg().models).toEqual({ background: 'claude-sonnet-5' });
  });

  it('值没变:不写盘(连文件都不建)、不发事件;变了才发 app_settings_changed', async () => {
    expect((await updateAppSettings(profile, 'tts', { speed: 1, autoSpeak: false })).text).toMatch(/^Nothing to change/);
    expect(existsSync(cfgPath())).toBe(false);

    const events: any[] = [];
    const off = subscribe('R1', (ev) => events.push(ev));
    try {
      const ctx: ToolContext = { ...base(), runId: 'R1' };
      await executeTool(call('update_app_settings', { section: 'tts', values: { speed: 1 }, reason: 'x' }), ctx);
      expect(events.filter((e) => e.type === 'app_settings_changed')).toEqual([]);
      const r = await executeTool(call('update_app_settings', { section: 'tts', values: { speed: 1.5 }, reason: 'x' }), ctx);
      expect(r.isError).toBe(false);
      expect(readCfg()).toEqual({ tts: { speed: 1.5 } });
      expect(events.filter((e) => e.type === 'app_settings_changed').map((e) => e.payload)).toEqual([{ section: 'tts', fields: ['speed'], source: 'agent' }]);
      const bad = await executeTool(call('update_app_settings', { section: 'tts', values: { speed: 99 }, reason: 'x' }), ctx);
      expect(bad.isError).toBe(true);
      expect(events.filter((e) => e.type === 'app_settings_changed')).toHaveLength(1);
    } finally { off(); }
  });

  it('config.json 坏了 / 段的形状不对:不写,原文件不动', async () => {
    writeFileSync(cfgPath(), '{ not json');
    expect((await updateAppSettings(profile, 'tts', { voice: 'nova' })).text).toMatch(/^Error: could not save — nothing was changed/);
    expect(readFileSync(cfgPath(), 'utf8')).toBe('{ not json');
    seed({ tts: 'oops', keep: 1 });
    expect((await updateAppSettings(profile, 'tts', { voice: 'nova' })).text).toMatch(/is not an object/);
    expect(readCfg()).toEqual({ tts: 'oops', keep: 1 });
  });
});

describe('④ 审批', () => {
  let gateSeq = 0;
  async function gate(c: any, ctx: Record<string, unknown>, answer: ApprovalAction = 'reject'): Promise<{ d: any; asked: any[] }> {
    const runId = `AS${++gateSeq}`;
    const asked: any[] = [];
    const off = subscribe(runId, (ev) => {
      if (ev.type !== 'approval_request') return;
      asked.push(ev.payload);
      resolveApproval(ev.payload.approvalId, { action: answer });
    });
    try {
      return { d: await gateToolCall(runId, c, { sessionId: 'S', execMode: 'host', cwd: outside, ...ctx } as any), asked };
    } finally { off(); }
  }
  const TTS = () => call('update_app_settings', { section: 'tts', values: { voice: 'nova', speed: 1.2 }, reason: 'the user asked for a different voice' });
  const WS = () => call('update_app_settings', { section: 'workspace', values: { path: outside }, reason: 'move the workspace' });

  it.each(['readonly', 'auto-edit'] as const)('%s:每次都问(控制面);卡上是「现值 → 新值」,没有密钥', async (mode) => {
    seed();
    const { d, asked } = await gate(TTS(), { approvalMode: mode });
    expect(d.action).toBe('reject');
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'control', mode }]);
    expect(asked[0].preview).toBe('app settings\ntts.voice: "alloy" → "nova"\ntts.speed: 1 → 1.2\nreason: the user asked for a different voice');
    const ws = await gate(call('update_app_settings', { section: 'webSearch', values: { tavilyApiKey: 'new', provider: 'bocha' }, reason: 'r' }), { approvalMode: mode });
    expect(ws.asked[0].preview).toContain('webSearch.tavilyApiKey: (not a setting) → "new"');
    expect(ws.asked[0].preview).not.toMatch(/SECRET/);
  });

  it('「总允许」只批这一次,下一次照问', async () => {
    const ctx = { approvalMode: 'auto-edit', sessionId: 'S-appset-always' };
    expect((await gate(TTS(), ctx, 'approve_always')).d.action).toBe('approve');
    const second = await gate(TTS(), ctx, 'reject');
    expect(second.asked).toHaveLength(1);
    expect(second.d.action).toBe('reject');
  });

  it('完全放行:语音 / 模型 / 联网搜索自动过;默认工作目录照问(保护配置),也不进「总允许」', async () => {
    const tts = await gate(TTS(), { approvalMode: 'full-auto' });
    expect(tts).toEqual({ d: { action: 'approve' }, asked: [] });

    const ctx = { approvalMode: 'full-auto', sessionId: 'S-appset-ws' };
    const first = await gate(WS(), ctx, 'approve_always');
    expect(first.asked.map((x) => x.reason)).toEqual([{ kind: 'protected', mode: 'full-auto' }]);
    expect(first.asked[0].preview).toMatch(/^⚠ Protected config or credentials · app settings\nworkspace\.path: "" → /);
    // 模型给的是软链:卡上写出它实际指向哪
    const link = join(outside, 'card-link');
    mkdirSync(join(outside, 'card-target'));
    symlinkSync(join(outside, 'card-target'), link);
    const viaLink = await gate(call('update_app_settings', { section: 'workspace', values: { path: link }, reason: 'r' }), ctx, 'reject');
    expect(viaLink.asked[0].preview).toContain(`→ ${JSON.stringify(link)} (resolves to ${join(outside, 'card-target')})`);
    expect(first.d.action).toBe('approve');
    expect((await gate(WS(), ctx, 'reject')).asked).toHaveLength(1);
  });

  it('custom 档的 allow 规则放得过语音,放不过默认工作目录', async () => {
    seed({ approval: { base: 'readonly', allow: ['update_app_settings'] } });
    expect((await gate(TTS(), { approvalMode: 'custom' })).asked).toEqual([]);
    expect((await gate(WS(), { approvalMode: 'custom' })).asked.map((x) => x.reason?.kind)).toEqual(['protected']);
  });

  it('无人值守又没有审批通道:默认工作目录直接拒', async () => {
    const { d, asked } = await gate(WS(), { approvalMode: 'full-auto', unattended: true });
    expect(asked).toEqual([]);
    expect(d).toMatchObject({ action: 'reject' });
    expect(d.rejectReason).toMatch(/Unattended runs cannot write protected configuration/);
  });

  it('远程污点 run:不弹卡直接拒;工具自己也拒(中途被染色 / 绕过闸直调)', async () => {
    seed();
    const remote = { via: 'tunnel', marked: true };
    for (const mode of ['readonly', 'full-auto'] as const) {
      const { d, asked } = await gate(TTS(), { approvalMode: mode, remote });
      expect(asked).toEqual([]);
      expect(d).toEqual({ action: 'reject', rejectReason: 'Remote sessions cannot change app settings on the host computer. Tell the user to change it in Settings there.' });
    }
    const before = readFileSync(cfgPath(), 'utf8');
    const r = await executeTool(TTS(), { ...base(), remote } as ToolContext);
    expect(r.isError).toBe(true);
    expect(r.result).toContain('Remote sessions cannot change app settings');
    expect(readFileSync(cfgPath(), 'utf8')).toBe(before);
    expect((await executeTool(call('app_settings', { section: 'tts' }), { ...base(), remote } as ToolContext)).result).toContain('can read them but not change them');
  });
});
