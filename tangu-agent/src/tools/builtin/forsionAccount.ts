/**
 * forsion_account / forsion_account_action —— agent 读得到用户的 Forsion 账号(套餐、AI 额度、后台额度、积分、背包、近期用量),
 * 并能代办三件事:用一张额度重置卡、把 AI 额度挪一部分到后台额度、提交反馈。
 *
 * 为什么住在引擎核心、不放 Forsion-Extend 插件:网页 / 手机的 run 跑在云端执行节点上,那里只激活节点自己的插件;
 * chat 预设又一律藏起插件工具。放这里三端同一份。
 *
 * 口径:
 *   - 数从 brain.cloud.request 拿(身份由 brain 带,工具拿不到令牌)。没有这条接缝的形态(内嵌引擎)→ 两个工具都不存在。
 *   - AI 额度 / 后台额度只报百分比、不报点数(产品口径;算法与设置页 Extend quota.ts 逐条一致:向下取整、<1%、limit<0 不限、limit==0 → 0%)。
 *     积分是普通数字。
 *   - 没登录(brain 没凭据)/ 登录失效(服务端 401)/ 连不上 分开说 —— 别让模型把「没登录」讲成「额度用完了」。
 *   - 读工具:只给「人在这轮对话里」的前台 run(同 session_status);通道来的 run 不给(对面不一定是账号本人)。
 *   - 动作工具:capabilities.approval:'always' —— 每次由用户本人在卡上确认,完全通行 / 总允许都不跳过,云端会话照样问;
 *     无人值守、代批、远程污点的 run 由审批闸直接拒(approvals.gateToolCall)。execute 里再兜一次同样的判定。
 *   - 不做:买东西 / 兑换 / 「后台额度用尽后自动用主额度」的开关(服务端给执行节点的派生令牌也没放这几条)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import type { CloudAccountBrain, CloudResponse } from '../../seams/cloudBrain.js';
import { deps } from '../../seams/runtime.js';
import { effectiveRemote } from '../../services/remoteOrigin.js';

const cloud = (): CloudAccountBrain | undefined => {
  try { return deps().brain?.cloud; } catch { return undefined; }
};

function readable(_p: unknown, ctx: ToolContext): boolean {
  return !!cloud() && !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.inDiscussion && !ctx.muse && !ctx.automationOrigin && !ctx.ephemeral
    && ctx.runOrigin !== 'channel';
}
function actionable(p: unknown, ctx: ToolContext): boolean {
  return readable(p, ctx) && !ctx.approvalDeferral && ctx.runOrigin !== 'unattended' && !effectiveRemote(ctx);
}

const SIGN_IN = 'Settings → Forsion Cloud';
const ok = (r: CloudResponse): boolean => r.status >= 200 && r.status < 300;
const errCode = (r: CloudResponse): string => String(r.json?.error ?? r.json?.code ?? r.json?.detail ?? '').slice(0, 120);

/** 读失败时给模型的那句(成功 → null)。 */
function failure(r: CloudResponse): string | null {
  if (ok(r)) return null;
  if (r.error === 'not_signed_in') return `The user is not signed in to a Forsion account in this app, so there is no account to read. They can sign in under ${SIGN_IN}.`;
  if (r.status === 401) return `The Forsion sign-in has expired. Ask the user to sign in again (${SIGN_IN}), then retry.`;
  if (r.status === 0) return `Forsion Cloud could not be reached (${r.error || 'network error'}). Try again later.`;
  if (r.status === 403) return 'Forsion Cloud does not allow account access from this kind of session (403).';
  return `Forsion Cloud answered ${r.status}${errCode(r) ? ` (${errCode(r)})` : ''}.`;
}

const toNum = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const x = Number(v); return Number.isFinite(x) ? x : null; }
  return null;
};
const int = (v: unknown): string => Math.max(0, Math.round(toNum(v) ?? 0)).toLocaleString('en-US');

/** 剩余额度的写法:「unlimited」/「37% left」/「<1% left」。与 Extend quota.ts 的 quotaDisplay 同口径。 */
export function quotaLeft(remaining: unknown, limit: unknown): string {
  const lim = toNum(limit);
  if (lim === null || lim < 0) return 'unlimited';
  if (lim === 0) return '0% left';
  const rem = Math.max(0, toNum(remaining) ?? 0);
  const pct = Math.min(100, Math.max(0, Math.floor((rem / lim) * 100)));
  return `${pct === 0 && rem > 0 ? '<1' : pct}% left`;
}
/** 消耗占今日额度上限的百分比(同 Extend consumptionText);算不出 → null。 */
export function shareOfDaily(points: unknown, dailyLimit: unknown): string | null {
  const lim = toNum(dailyLimit);
  const raw = toNum(points);
  if (lim === null || lim <= 0 || raw === null) return null;
  const x = (Math.max(0, raw) / lim) * 100;
  if (x === 0) return '0%';
  if (x < 0.1) return '<0.1%';
  const one = Math.round(x * 10) / 10;
  return one < 10 ? `${one}%` : `${Math.round(x).toLocaleString('en-US')}%`;
}

const PCT_ONLY = 'AI quota is only ever shown as a percentage: do not state or estimate a token or point count for it.';

function quotaLines(q: any): string[] {
  const lines = [
    `AI quota: today ${quotaLeft(q.dailyRemaining, q.dailyLimit)} · this week ${quotaLeft(q.weeklyRemaining, q.weeklyLimit)}. ` +
    `The daily quota resets at 0:00 Beijing time${q.weeklyResetAt ? `; the weekly quota resets on ${String(q.weeklyResetAt).slice(0, 10)} at 0:00 Beijing time` : ''}.`,
  ];
  const b = q.background;
  if (b && b.modelId) {
    lines.push(
      `Background quota (used by Muse and automations, counted separately from the AI quota): today ${quotaLeft(b.dailyRemaining, b.dailyLimit)} · this week ${quotaLeft(b.weeklyRemaining, b.weeklyLimit)}. ` +
      (b.autoMain ? 'When it runs out, background work continues on the AI quota.' : 'When it runs out, Muse and automations pause until it resets.'),
    );
  }
  if (toNum(q.resetCards) !== null) lines.push(`Quota reset cards: ${int(q.resetCards)} (using one restores today's and this week's AI quota to 100%).`);
  return lines;
}

async function overview(c: CloudAccountBrain, ctx: ToolContext): Promise<string> {
  const get = (path: string) => c.request({ path, signal: ctx.signal });
  const [quota, me, member, credits] = await Promise.all([
    get('/api/token-quota/my'), get('/api/brain/users/me'), get('/api/membership/my'), get('/api/credits/balance'),
  ]);
  const bad = failure(quota);
  if (bad) return bad;
  const lines: string[] = [];
  const u = ok(me) ? me.json : null;
  if (u?.username) lines.push(`Signed in as: ${u.nickname ? `${u.nickname} (@${u.username})` : `@${u.username}`}`);
  if (ok(member)) {
    const m = member.json?.membership;
    lines.push(m
      ? `Plan: ${m.plan?.name || m.tier || 'member'}${m.expiresAt ? ` · ${m.autoRenew ? 'renews' : 'ends'} ${String(m.expiresAt).slice(0, 10)}` : ''}`
      : 'Plan: free (no active membership)');
  }
  lines.push(...quotaLines(quota.json ?? {}));
  if (ok(credits) && toNum(credits.json?.balance) !== null) lines.push(`Points: ${int(credits.json.balance)}`);
  lines.push(PCT_ONLY, "This is the user's account allowance. For this conversation's own context window and token use, call session_status.");
  return lines.join('\n');
}

async function usage(c: CloudAccountBrain, ctx: ToolContext, daysArg: unknown): Promise<string> {
  const days = Math.min(30, Math.max(1, Math.round(toNum(daysArg) ?? 7)));
  const get = (path: string) => c.request({ path, signal: ctx.signal });
  const [stats, logs, quota] = await Promise.all([
    get(`/api/usage/stats?days=${days}`), get('/api/token-quota/my/logs?limit=10&offset=0'), get('/api/token-quota/my'),
  ]);
  const bad = failure(stats);
  if (bad) return bad;
  const s = stats.json ?? {};
  const daily = ok(quota) ? quota.json?.dailyLimit : null;
  const cost = (points: unknown): string => { const t = shareOfDaily(points, daily); return t ? ` · ${t} of one day's AI quota` : ''; };
  const lines = [`Last ${days} day${days === 1 ? '' : 's'}: ${int(s.totalRequests)} requests${toNum(s.successRate) !== null ? ` · ${Math.round(toNum(s.successRate)!)}% succeeded` : ''}${cost(s.totalPointsCost)}`];
  const top = (rows: unknown, label: (r: any) => string): void => {
    for (const r of (Array.isArray(rows) ? rows : []).slice(0, 8)) lines.push(`  - ${label(r)}: ${int(r.count)} requests${cost(r.pointsCost)}`);
  };
  if (Array.isArray(s.byModel) && s.byModel.length) { lines.push('By model:'); top(s.byModel, (r) => String(r.modelName || r.modelId || 'unknown')); }
  if (Array.isArray(s.byProject) && s.byProject.length) { lines.push('By app:'); top(s.byProject, (r) => String(r.projectSource || 'unknown')); }
  const recent: any[] = ok(logs) && Array.isArray(logs.json?.logs) ? logs.json.logs : [];
  if (recent.length) {
    lines.push('Most recent requests:');
    for (const l of recent) lines.push(`  - ${String(l.createdAt ?? '').slice(0, 16).replace('T', ' ')} · ${l.modelName || l.modelId || 'unknown'} · ${l.projectSource || 'unknown'}${l.success === false ? ' · failed' : ''}${cost(l.pointsCost)}`);
  }
  lines.push(PCT_ONLY);
  return lines.join('\n');
}

async function backpack(c: CloudAccountBrain, ctx: ToolContext): Promise<string> {
  const r = await c.request({ path: '/api/shop/inventory', signal: ctx.signal });
  if (r.status === 404) return 'The backpack / shop is not enabled on this Forsion server.';
  const bad = failure(r);
  if (bad) return bad;
  const items: any[] = Array.isArray(r.json) ? r.json : [];
  if (!items.length) return 'The backpack is empty.';
  // 同名的并成一行(重置卡一张一条);兑换码 / 密钥(key、codeName)不进模型上下文。
  const counts = new Map<string, number>();
  for (const it of items) {
    const name = String(it.displayName || it.itemDefinition?.name?.en || it.itemDefinition?.name?.zh || it.itemType || 'item');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return ['Backpack:', ...[...counts].map(([name, k]) => `  - ${name}${k > 1 ? ` × ${k}` : ''}`), 'Redeem codes and keys in the backpack are not shown here; the user opens them in the Backpack page.'].join('\n');
}

const ACTIONS = ['use_reset_card', 'move_quota_to_background', 'send_feedback'] as const;
type Action = (typeof ACTIONS)[number];

/** 动作参数的校验(审批卡的预览与 execute 用同一份,卡上写的就是会发出去的)。 */
export function parseAccountAction(args: any): { ok: true; action: Action; percent?: number; message?: string } | { ok: false; error: string } {
  const action = args?.action as Action;
  if (!ACTIONS.includes(action)) return { ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` };
  if (action === 'move_quota_to_background') {
    const p = toNum(args?.percent);
    if (p === null || !Number.isInteger(p) || p < 1 || p > 100) return { ok: false, error: 'percent must be a whole number from 1 to 100' };
    return { ok: true, action, percent: p };
  }
  if (action === 'send_feedback') {
    const message = typeof args?.message === 'string' ? args.message.trim() : '';
    if (!message) return { ok: false, error: 'message is required' };
    if (message.length > 10_000) return { ok: false, error: 'message is too long (10,000 characters at most)' };
    return { ok: true, action, message };
  }
  return { ok: true, action };
}

/** 审批卡上的那段话:用户批的是这句,不是一坨 JSON。 */
export function accountActionPreview(args: any): string {
  const a = parseAccountAction(args);
  if (!a.ok) return `Forsion account: invalid request (${a.error})`;
  if (a.action === 'use_reset_card') return "Forsion account: use 1 quota reset card — restores today's and this week's AI quota to 100%. The card is spent.";
  if (a.action === 'move_quota_to_background') return `Forsion account: move ${a.percent}% of the AI quota limit (or as much as is left) to the background quota (Muse and automations) for the current period. It cannot be moved back.`;
  return `Forsion account: send this feedback to the Forsion team:\n${a.message}`;
}

async function act(c: CloudAccountBrain, ctx: ToolContext, args: any): Promise<string> {
  const a = parseAccountAction(args);
  if (!a.ok) return `Error: ${a.error}`;
  const post = (path: string, body: unknown) => c.request({ path, method: 'POST', body, signal: ctx.signal });
  const r = a.action === 'use_reset_card' ? await post('/api/token-quota/reset-card/use', { type: 'both' })
    : a.action === 'move_quota_to_background' ? await post('/api/token-quota/background/convert', { percent: a.percent })
    : await post('/api/feedback', { description: a.message });
  if (!ok(r)) {
    const code = errCode(r);
    // 服务端点名的拒绝:事务没做。
    if (code === 'no_reset_card') return 'Error: the user has no quota reset card. Nothing was changed.';
    if (code === 'insufficient_main_quota') return 'Error: there is no AI quota left to move. Nothing was changed.';
    if (code === 'background_unavailable') return 'Error: the background quota is not available on this server. Nothing was changed.';
    // 没应答(超时 / 断线)、3xx、5xx:请求可能已经做完 —— 服务端是先扣卡 / 转额度、再读一遍额度回给我们,后一步失败就是 500。
    // 这时说「什么都没变」会让模型再来一次,多扣一张卡(Codex 10-10 #5)。只有没发出去(未登录 / 没配云端)和 4xx 才是确定没做。
    const notSent = r.error === 'not_signed_in' || r.error === 'no_cloud_url' || r.error === 'path_not_allowed' || r.error === 'invalid_method';
    if (!notSent && (r.status < 400 || r.status >= 500)) {
      return `Error: Forsion Cloud did not confirm this (${r.status === 0 ? r.error || 'no answer' : `status ${r.status}`}), so it is not known whether it went through. Call forsion_account to check before trying again.`;
    }
    return `Error: ${failure(r)} Nothing was changed.`;
  }
  if (a.action === 'send_feedback') return 'Feedback sent to the Forsion team.';
  const q = r.json?.quota;
  const after = q ? `\n${quotaLines({ ...q, ...(a.action === 'use_reset_card' && toNum(r.json.resetCards) !== null ? { resetCards: r.json.resetCards } : {}) }).join('\n')}` : '';
  if (a.action === 'use_reset_card') return `Used one quota reset card.${after}`;
  // 服务端按「限额 × percent%」转,但钳到主额度的余量 —— 回执写实际转了多少(占限额的百分比,不出点数),别照请求的数报(Codex 10-10 #8)。
  const moved = [['daily', q?.dailyLimit], ['weekly', q?.weeklyLimit]]
    .map(([axis, limit]) => { const t = shareOfDaily(r.json?.converted?.[axis as string], limit); return t ? `${t} of the ${axis} limit` : ''; }).filter(Boolean);
  return `Moved AI quota to the background quota${moved.length ? `: ${moved.join(' and ')}` : ''} (asked for ${a.percent}%; the server moves at most what is left).${after}`;
}

export const forsionAccountProvider: ToolProvider = {
  id: 'builtin:forsion_account',
  tools: () => [
    {
      name: 'forsion_account',
      deferred: true,
      deferGroup: 'forsion_account',
      deferHint: "The user's Forsion account: plan, AI quota left today / this week, background quota, quota reset cards, points, backpack, recent usage. Check it when the user asks how much quota, how many tokens or how many points they have left, or what their plan is. A bare \"how many tokens do I have left\" can mean this or the conversation's context window (session_status): read both and answer both.",
      isEnabledFor: readable,
      definition: {
        type: 'function',
        function: {
          name: 'forsion_account',
          description:
            "Read the signed-in user's Forsion account. `overview` (default): who is signed in, plan, AI quota left today and this week and when each resets, background quota, quota reset cards, points. " +
            '`usage`: requests over the last days by model and by app, and the latest requests. `backpack`: items the user owns. ' +
            'Read-only. AI quota comes back as percentages only — never tell the user a token or point count for it. ' +
            "This is the account allowance, not this conversation's context window (that is session_status).",
          parameters: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: ['overview', 'usage', 'backpack'], description: 'What to read (default: overview)' },
              days: { type: 'number', description: 'For usage: how many days back, 1-30 (default 7)' },
            },
          },
        },
      },
      execute: async (args, ctx) => {
        const c = cloud();
        if (!c) return 'Forsion account access is not available in this kind of run.';
        const section = typeof args?.section === 'string' ? args.section : 'overview';
        if (section === 'usage') return usage(c, ctx, args?.days);
        if (section === 'backpack') return backpack(c, ctx);
        return overview(c, ctx);
      },
    },
    {
      name: 'forsion_account_action',
      deferred: true,
      deferGroup: 'forsion_account',
      deferHint: "Do something on the user's Forsion account, each time confirmed by the user: use a quota reset card, move part of the AI quota to the background quota, or send feedback to the Forsion team.",
      isEnabledFor: actionable,
      capabilities: { approval: 'always' },
      definition: {
        type: 'function',
        function: {
          name: 'forsion_account_action',
          description:
            "Act on the user's Forsion account. Only when the user asked for it in this conversation; the user confirms every call on an approval prompt. " +
            "`use_reset_card`: spend one quota reset card to restore today's and this week's AI quota to 100% (check forsion_account first that they have one and that the quota is actually low). " +
            '`move_quota_to_background`: move `percent` of the AI quota limit (capped by what is left) to the background quota used by Muse and automations, for the current period; it cannot be moved back. ' +
            '`send_feedback`: send `message` to the Forsion team as the user — write it in their words and include what they were doing. ' +
            'Buying, redeeming and plan changes cannot be done with this tool; tell the user to do those in Settings → Forsion Cloud.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: [...ACTIONS] },
              percent: { type: 'number', description: 'For move_quota_to_background: whole number 1-100' },
              message: { type: 'string', description: 'For send_feedback: the feedback text' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        const c = cloud();
        if (!c) return 'Error: Forsion account access is not available in this kind of run.';
        // 审批闸已拒;这里是同一判定的兜底(run 中途被远端插话染色、或有人绕过闸直调)。
        if (!actionable(undefined, ctx)) return 'Error: Account actions need the user to confirm them in the conversation on their own device; this run cannot do that.';
        return act(c, ctx, args);
      },
    },
  ],
};
