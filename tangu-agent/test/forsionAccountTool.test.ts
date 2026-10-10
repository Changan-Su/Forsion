/**
 * forsion_account / forsion_account_action(agent 读、代办用户的 Forsion 账号):
 *   - 额度只出百分比:点数(限额 / 剩余 / 消耗)一个都不许进模型看到的文本
 *   - 没登录 / 登录失效 / 连不上 / 这种会话不让读 四种说法分开
 *   - 可见性:前台 run 在按需目录里(chat 面、计划模式的读工具);没有账号面接缝、通道 run、子代理 / Muse / 自动化都不给;
 *     动作工具另外不给计划模式、代批 / 无人值守、远程污点 run
 *   - 动作工具每次都问(approval:'always'),审批卡上是人话;参数不合法不发请求;发出去没应答 → 说「不知道成没成」
 * 负对照(实跑):quotaLines 里把 quotaLeft(...) 换成直接写 dailyRemaining → 「只出百分比」那条红;
 *   去掉 readable 里的 `!!cloud()` → 「没有账号面接缝」那条红。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions, listDeferredTools, executeTool, type ToolContext } from '../src/tools/registry.js';
import { toolNeedsApproval } from '../src/services/approvals.js';
import { isHostSandboxToolAllowed } from '../src/sandbox/hostSandboxPolicy.js';
import { accountActionPreview, quotaLeft, shareOfDaily } from '../src/tools/builtin/forsionAccount.js';
import type { CloudRequest, CloudResponse } from '../src/seams/cloudBrain.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp', unlockTools: () => {} };
const BOTH = ['forsion_account', 'forsion_account_action'];

const QUOTA = {
  dailyLimit: 81_337, dailyRemaining: 30_219, weeklyLimit: 406_685, weeklyRemaining: 2_033, weeklyResetAt: '2026-10-12', tier: 'pro', resetCards: 2,
  background: { sharePercent: 20, dailyLimit: 16_267, dailyRemaining: 16_267, weeklyLimit: 81_335, weeklyRemaining: 40_668, autoMain: false, modelId: 'bg-model' },
};
let seen: CloudRequest[] = [];
let routes: Record<string, CloudResponse> = {};
const request = async (req: CloudRequest): Promise<CloudResponse> => {
  seen.push(req);
  return routes[`${req.method || 'GET'} ${req.path.split('?')[0]}`] ?? { status: 404, json: { error: 'not_found' } };
};
const withCloud = (): void => configureTangu({ host: stub, brain: { cloud: { request } } as any, billing: stub, profile });
const call = async (name: string, args: unknown, ctx: Partial<ToolContext> = {}): Promise<string> =>
  String((await executeTool({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } } as any, { ...base, unlockedTools: new Set(BOTH), ...ctx })).result);
const everywhere = (ctx: ToolContext): string[] => [...listDeferredTools(ctx).map((d) => d.name), ...getToolDefinitions(ctx).map((t: any) => t.function?.name)];

beforeEach(() => {
  seen = [];
  routes = {
    'GET /api/token-quota/my': { status: 200, json: QUOTA },
    'GET /api/brain/users/me': { status: 200, json: { username: 'changan', nickname: '长安', email: 'x@example.com', membershipTier: 'pro' } },
    'GET /api/membership/my': { status: 200, json: { membership: { tier: 'pro', status: 'active', expiresAt: '2026-11-03T00:00:00.000Z', autoRenew: true, plan: { name: 'Pro' } } } },
    'GET /api/credits/balance': { status: 200, json: { balance: 1234 } },
  };
  withCloud();
});

describe('forsion_account(读)', () => {
  it('概览:谁、套餐、今日 / 本周剩余百分比与重置时刻、后台额度、重置卡、积分;点数一个都不出现', async () => {
    const text = await call('forsion_account', {});
    expect(text.split('\n')).toEqual([
      'Signed in as: 长安 (@changan)',
      'Plan: Pro · renews 2026-11-03',
      'AI quota: today 37% left · this week <1% left. The daily quota resets at 0:00 Beijing time; the weekly quota resets on 2026-10-12 at 0:00 Beijing time.',
      'Background quota (used by Muse and automations, counted separately from the AI quota): today 100% left · this week 50% left. When it runs out, Muse and automations pause until it resets.',
      "Quota reset cards: 2 (using one restores today's and this week's AI quota to 100%).",
      'Points: 1,234',
      'AI quota is only ever shown as a percentage: do not state or estimate a token or point count for it.',
      "This is the user's account allowance. For this conversation's own context window and token use, call session_status.",
    ]);
    // 只出百分比:限额 / 剩余的原始数(带不带千分位)都不在文本里;邮箱也不进模型上下文
    for (const raw of [81_337, 30_219, 406_685, 2_033, 16_267, 40_668]) {
      expect(text).not.toContain(String(raw));
      expect(text).not.toContain(raw.toLocaleString('en-US'));
    }
    expect(text).not.toContain('example.com');
    expect(seen.every((r) => (r.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('不限 / 上限为 0 / 没有后台模型 / 没有会员 / 积分接口挂了:各自如实,不编', async () => {
    routes['GET /api/token-quota/my'] = { status: 200, json: { dailyLimit: -1, dailyRemaining: -1, weeklyLimit: 0, weeklyRemaining: 0, background: { dailyLimit: 5, dailyRemaining: 5, weeklyLimit: 5, weeklyRemaining: 5, modelId: null } } };
    routes['GET /api/membership/my'] = { status: 200, json: { membership: null } };
    routes['GET /api/credits/balance'] = { status: 500, json: { detail: 'boom' } };
    const text = await call('forsion_account', { section: 'overview' });
    expect(text).toContain('AI quota: today unlimited · this week 0% left. The daily quota resets at 0:00 Beijing time.');
    expect(text).toContain('Plan: free (no active membership)');
    expect(text).not.toContain('Background quota');
    expect(text).not.toContain('Points:');
    expect(text).not.toContain('Quota reset cards');
  });

  it('没登录 / 登录失效 / 连不上 / 这种会话不让读:四种说法分开', async () => {
    const say = async (r: CloudResponse): Promise<string> => { routes['GET /api/token-quota/my'] = r; return call('forsion_account', {}); };
    expect(await say({ status: 401, json: null, error: 'not_signed_in' })).toMatch(/not signed in to a Forsion account/);
    expect(await say({ status: 401, json: { error: 'token_expired' } })).toMatch(/sign-in has expired/);
    expect(await say({ status: 0, error: 'timeout' })).toBe('Forsion Cloud could not be reached (timeout). Try again later.');
    expect(await say({ status: 403, json: { error: 'scope' } })).toMatch(/does not allow account access from this kind of session/);
    expect(await say({ status: 502, json: null })).toBe('Forsion Cloud answered 502.');
  });

  it('用量:消耗写成「占一天额度的百分之几」,不出点数;days 夹在 1-30', async () => {
    routes['GET /api/usage/stats'] = { status: 200, json: { totalRequests: 412, successRate: 98.6, totalPointsCost: 162_674,
      byModel: [{ modelId: 'm1', modelName: 'GPT 6 Luna', count: 400, pointsCost: 40_668 }], byProject: [{ projectSource: 'tangu', count: 412, pointsCost: 73 }] } };
    routes['GET /api/token-quota/my/logs'] = { status: 200, json: { total: 1, logs: [{ createdAt: '2026-10-10T08:15:00.000Z', modelName: 'GPT 6 Luna', projectSource: 'tangu', pointsCost: 813, success: false }] } };
    const text = await call('forsion_account', { section: 'usage', days: 99 });
    expect(seen.map((r) => r.path)).toContain('/api/usage/stats?days=30');
    expect(text.split('\n')).toEqual([
      "Last 30 days: 412 requests · 99% succeeded · 200% of one day's AI quota",
      'By model:',
      "  - GPT 6 Luna: 400 requests · 50% of one day's AI quota",
      'By app:',
      "  - tangu: 412 requests · <0.1% of one day's AI quota",
      'Most recent requests:',
      "  - 2026-10-10 08:15 · GPT 6 Luna · tangu · failed · 1% of one day's AI quota",
      'AI quota is only ever shown as a percentage: do not state or estimate a token or point count for it.',
    ]);
    for (const raw of ['162674', '162,674', '40668', '40,668', '813']) expect(text).not.toContain(raw);
  });

  it('背包:同名并行计数,兑换码 / 密钥不进文本;商店没开(404)与空背包各有说法', async () => {
    routes['GET /api/shop/inventory'] = { status: 200, json: [
      { id: '1', displayName: 'Quota reset card' }, { id: '2', displayName: 'Quota reset card' },
      { id: '3', itemType: 'redeem_code', codeName: 'SECRET-NAME', key: 'KEY-123-SECRET', itemDefinition: { name: { en: 'Gift code', zh: '礼品码' } } },
    ] };
    const text = await call('forsion_account', { section: 'backpack' });
    expect(text).toContain('  - Quota reset card × 2');
    expect(text).toContain('  - Gift code');
    expect(text).not.toMatch(/SECRET/);
    routes['GET /api/shop/inventory'] = { status: 200, json: [] };
    expect(await call('forsion_account', { section: 'backpack' })).toBe('The backpack is empty.');
    routes['GET /api/shop/inventory'] = { status: 404, json: { error: 'FEATURE_DISABLED' } };
    expect(await call('forsion_account', { section: 'backpack' })).toMatch(/not enabled on this Forsion server/);
  });

  it('quotaLeft / shareOfDaily 的边界(与设置页同一口径)', () => {
    expect([quotaLeft(50, 100), quotaLeft(99.9, 100), quotaLeft(0.5, 100), quotaLeft(0, 100), quotaLeft(5, 0), quotaLeft(5, -1), quotaLeft(5, undefined), quotaLeft(undefined, 100), quotaLeft(500, 100)])
      .toEqual(['50% left', '99% left', '<1% left', '0% left', '0% left', 'unlimited', 'unlimited', '0% left', '100% left']);
    expect([shareOfDaily(0, 100), shareOfDaily(0.05, 100), shareOfDaily(3, 100), shareOfDaily(3.26, 100), shareOfDaily(1240, 100), shareOfDaily(null, 100), shareOfDaily(5, 0), shareOfDaily(5, -1)])
      .toEqual(['0%', '<0.1%', '3%', '3.3%', '1,240%', null, null, null]);
  });
});

describe('forsion_account_action(代办)', () => {
  it('每次都问(任何档位),读工具任何档位都不问;宿主沙箱开着两件都放行', () => {
    for (const m of ['readonly', 'auto-edit', 'full-auto', undefined] as const) {
      expect(toolNeedsApproval('forsion_account_action', m)).toBe(true);
      expect(toolNeedsApproval('forsion_account', m)).toBe(false);
    }
    for (const name of BOTH) expect(isHostSandboxToolAllowed(name, { execMode: 'host', hostSandbox: { mode: 'read-only', network: 'deny' } as any })).toBe(true);
  });

  it('审批卡上是人话;不合法的参数在卡上就写明', () => {
    expect(accountActionPreview({ action: 'use_reset_card' })).toMatch(/use 1 quota reset card .* The card is spent\./);
    expect(accountActionPreview({ action: 'move_quota_to_background', percent: 25 })).toMatch(/move 25% of the AI quota limit \(or as much as is left\) to the background quota .* cannot be moved back/);
    expect(accountActionPreview({ action: 'send_feedback', message: '  侧栏拖不动  ' })).toBe('Forsion account: send this feedback to the Forsion team:\n侧栏拖不动');
    expect(accountActionPreview({ action: 'buy' })).toMatch(/invalid request/);
    expect(accountActionPreview({ action: 'move_quota_to_background', percent: 0 })).toMatch(/invalid request \(percent must be/);
  });

  it('用重置卡:发的是固定请求,回执带用后的额度与剩余张数;没有卡 → 说明什么都没变', async () => {
    routes['POST /api/token-quota/reset-card/use'] = { status: 200, json: { success: true, resetCards: 1, quota: { ...QUOTA, dailyRemaining: 81_337, weeklyRemaining: 406_685 } } };
    const text = await call('forsion_account_action', { action: 'use_reset_card' });
    expect(seen).toEqual([expect.objectContaining({ path: '/api/token-quota/reset-card/use', method: 'POST', body: { type: 'both' } })]);
    expect(text).toMatch(/^Used one quota reset card\.\nAI quota: today 100% left · this week 100% left\./);
    expect(text).toContain('Quota reset cards: 1 ');
    routes['POST /api/token-quota/reset-card/use'] = { status: 400, json: { error: 'no_reset_card' } };
    expect(await call('forsion_account_action', { action: 'use_reset_card' })).toBe('Error: the user has no quota reset card. Nothing was changed.');
  });

  it('挪额度 / 发反馈:参数原样发出;参数不合法 → 不发请求', async () => {
    // 请求 25%,但今天只剩得出 10%:回执按实际转入量写(占限额的百分比),不照请求的数报,也不出点数
    routes['POST /api/token-quota/background/convert'] = { status: 200, json: { success: true, converted: { daily: 8_134, weekly: 101_671 }, quota: QUOTA } };
    routes['POST /api/feedback'] = { status: 201, json: { id: 'f1', success: true } };
    const moved = await call('forsion_account_action', { action: 'move_quota_to_background', percent: 25 });
    expect(moved).toMatch(/^Moved AI quota to the background quota: 10% of the daily limit and 25% of the weekly limit \(asked for 25%; the server moves at most what is left\)\.\nAI quota:/);
    for (const raw of ['8134', '8,134', '101671', '101,671']) expect(moved).not.toContain(raw);
    expect(await call('forsion_account_action', { action: 'send_feedback', message: ' 侧栏拖不动 ' })).toBe('Feedback sent to the Forsion team.');
    expect(seen.map((r) => [r.path, r.body])).toEqual([
      ['/api/token-quota/background/convert', { percent: 25 }],
      ['/api/feedback', { description: '侧栏拖不动' }],
    ]);
    seen = [];
    for (const args of [{ action: 'move_quota_to_background', percent: 2.5 }, { action: 'move_quota_to_background', percent: 101 }, { action: 'move_quota_to_background' },
      { action: 'send_feedback', message: '   ' }, { action: 'send_feedback', message: 'x'.repeat(10_001) }, { action: 'buy_reset_card' }, {}]) {
      expect(await call('forsion_account_action', args), JSON.stringify(args).slice(0, 60)).toMatch(/^Error: /);
    }
    expect(seen).toEqual([]);
  });

  it('没应答 / 5xx / 3xx → 说不知道成没成、先查再试(服务端是先扣再读,后一步失败就是 500);点名的拒绝、4xx、没发出去 → 说什么都没变', async () => {
    for (const r of [{ status: 0, error: 'timeout' }, { status: 500, json: { detail: 'Failed to use reset card' } }, { status: 502, json: null }, { status: 307, json: null }] as CloudResponse[]) {
      routes['POST /api/token-quota/reset-card/use'] = r;
      const text = await call('forsion_account_action', { action: 'use_reset_card' });
      expect(text, String(r.status)).toMatch(/not known whether it went through\. Call forsion_account to check before trying again\.$/);
      expect(text, String(r.status)).not.toMatch(/Nothing was changed/);
    }
    routes['POST /api/token-quota/background/convert'] = { status: 400, json: { error: 'insufficient_main_quota' } };
    expect(await call('forsion_account_action', { action: 'move_quota_to_background', percent: 50 })).toMatch(/no AI quota left to move\. Nothing was changed\./);
    routes['POST /api/token-quota/background/convert'] = { status: 503, json: { error: 'background_unavailable' } };
    expect(await call('forsion_account_action', { action: 'move_quota_to_background', percent: 50 })).toMatch(/not available on this server\. Nothing was changed\./);
    routes['POST /api/token-quota/reset-card/use'] = { status: 403, json: { error: 'scope' } };
    expect(await call('forsion_account_action', { action: 'use_reset_card' })).toMatch(/Nothing was changed\.$/);
    routes['POST /api/feedback'] = { status: 401, json: null, error: 'not_signed_in' };
    expect(await call('forsion_account_action', { action: 'send_feedback', message: 'hi' })).toMatch(/^Error: The user is not signed in .* Nothing was changed\.$/);
  });
});

describe('可见性', () => {
  it('前台 run:work / coding / chat 面都在按需目录里、不进常驻定义;计划模式只留读工具', () => {
    for (const ctx of [base, { ...base, preset: 'coding' as const }, { ...base, execMode: 'sandbox' as const }, { ...base, preset: 'chat' as const, execMode: 'sandbox' as const, cwd: undefined }]) {
      const label = JSON.stringify({ preset: ctx.preset, execMode: ctx.execMode });
      expect(listDeferredTools(ctx).map((d) => d.name), label).toEqual(expect.arrayContaining(BOTH));
      expect(getToolDefinitions(ctx).map((t: any) => t.function?.name), label).not.toEqual(expect.arrayContaining(['forsion_account']));
      expect(getToolDefinitions({ ...ctx, unlockedTools: new Set(BOTH) }).map((t: any) => t.function?.name), label).toEqual(expect.arrayContaining(BOTH));
    }
    const plan = everywhere({ ...base, planMode: true });
    expect(plan).toContain('forsion_account');
    expect(plan).not.toContain('forsion_account_action');
  });

  it('没有账号面接缝(内嵌引擎)→ 两件都不存在;直调也如实说没有', async () => {
    configureTangu({ host: stub, brain: {} as any, billing: stub, profile });
    expect(everywhere(base).filter((n) => BOTH.includes(n))).toEqual([]);
    withCloud();
    expect(everywhere(base)).toEqual(expect.arrayContaining(BOTH));
  });

  it('通道 run / 子代理 / 讨论成员 / Muse / 自动化 / 一次性 run:两件都不给', () => {
    for (const ctx of [
      { ...base, runOrigin: 'channel' as const }, { ...base, subAgentDepth: 1 }, { ...base, inDiscussion: true }, { ...base, muse: true },
      { ...base, automationOrigin: 'rule-1' }, { ...base, ephemeral: true },
    ]) expect(everywhere(ctx).filter((n) => BOTH.includes(n)), JSON.stringify(ctx).slice(0, 80)).toEqual([]);
  });

  it('代批 / 无人值守 / 远程污点 run:读得到,动不了(目录里没有动作工具,直调也拒且不发请求)', async () => {
    for (const ctx of [{ approvalDeferral: 'queue' as const }, { runOrigin: 'unattended' as const }, { remote: { via: 'tunnel', marked: true } as any }]) {
      const names = everywhere({ ...base, ...ctx });
      expect(names, JSON.stringify(ctx)).toContain('forsion_account');
      expect(names, JSON.stringify(ctx)).not.toContain('forsion_account_action');
      seen = [];
      const r = await call('forsion_account_action', { action: 'use_reset_card' }, ctx);
      expect(r, JSON.stringify(ctx)).not.toMatch(/^Used one/);
      expect(seen).toEqual([]);
    }
  });
});
