/**
 * Muse 主动发私聊(2026-10-18,方案 docs/ToBeImproved/Muse私聊与收件箱分工方案_2026-10-17,用户选 B「按性质分」):
 * 要用户回话 / 拍板的 —— 一句提醒、待办提议、后台审批 —— 写进那条长期的 Muse 私聊(就是用户点 Muse 行进的那条);
 * 做好的成品(调研、日报)照旧进收件箱。
 *
 * 落一条 role=model、origin=proactive* 的消息;会话 proactive_at 前移 = 未读(routes/sessions.ts 的 attention 端点按它报);
 * message_user 发的一句以问号结尾 → 等你(下一轮开始由 childSessions.onRunStart 清)。审批的「等你」不走这一列:
 * 用户在托盘里批完不起轮,清不掉 —— 那份由 attention 端点按 pending_approvals 现算。
 */
import { query } from '../core/db.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { appendProactiveMessage, asksUser } from './proactiveMessage.js';
export { asksUser } from './proactiveMessage.js';
import { isWithinActiveHours, loadSpecialAgentsConfig } from './specialAgentsConfig.js';
import { MUSE_ONBOARDING_DAILY_CAP, onboardingActive, readMuseOnboarding } from './museState.js';
import { ledger } from './telemetryLedger.js';
import { noteMuseProduced } from './museTelemetry.js';

/** 发出去一条按来源计一次(遥测账本);被每小时 / 每天上限或作息挡下的计 dmSuppressed。 */
const DM_FIELD = {
  proactive: 'dmProactive', 'proactive:todo': 'dmTodo', 'proactive:approval': 'dmApproval',
  'proactive:card': 'dmCard', 'proactive:notice': 'dmNotice', 'proactive:remind': 'dmRemind',
} as const;
const suppressed = (r: MuseDmResult): MuseDmResult => { ledger.inc('daily_muse', 'dmSuppressed'); return r; };

/** proactive = message_user;todo / approval = 引擎替 add_muse_todo / 审批入队发的;card = Muse 发起的、要用户点的卡(services/museCards.ts);
 *  notice = 不是 Muse 自己要开口的卡(用户要的设置卡、引擎发的第一次见面 / 小结),不计今天的额度;
 *  remind = 规则的「直接提醒」(用户自己定的,不叫模型),同样不计今天的额度。 */
export type ProactiveOrigin = 'proactive' | 'proactive:todo' | 'proactive:approval' | 'proactive:card' | 'proactive:notice' | 'proactive:remind';
export const MUSE_DM_PER_HOUR = 3;
export const MUSE_DM_MAX_CHARS = 1500;

export type MuseDmResult = { ok: true; sessionId: string; messageId: string } | { ok: false; error: string };

// Load the route lazily to avoid routes/solo → routes/sessions → agentLoop → tools → this module.
let soloModule: Promise<typeof import('../routes/solo.js')> | undefined;

export async function postMuseDm(userId: string, content: string, origin: ProactiveOrigin = 'proactive'): Promise<MuseDmResult> {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'Error: the message is empty' };
  const { withAgentSoloSession } = await (soloModule ??= import('../routes/solo.js'));
  const sent = await withAgentSoloSession(userId, MUSE_AGENT_SLUG, async (s): Promise<MuseDmResult> => {
    const now = Date.now();
    if (origin === 'proactive') {
      const [r] = await query<any[]>(
        `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND origin = 'proactive' AND timestamp >= ?`,
        [s.id, now - 3600_000],
      );
      if ((Number(r?.n) || 0) >= MUSE_DM_PER_HOUR) {
        return suppressed({ ok: false, error: `Error: you already sent the user ${MUSE_DM_PER_HOUR} messages in the last hour. Fold this into your next message, or write it in your journal.` });
      }
    }
    if (origin === 'proactive' || origin === 'proactive:card') {
      // 一天的上限来自配置(0 = 不限);磨合期再封一道,作息外也不发(周期被规则 / 日程叫醒时会走到这里)
      const muse = loadSpecialAgentsConfig().muse;
      const onboarding = onboardingActive(await readMuseOnboarding().catch(() => null));
      if (onboarding && !isWithinActiveHours(muse, new Date().getHours())) return suppressed({ ok: false, error: 'Error: it is outside the user\'s active hours. Keep this for your next cycle.' });
      const cap = onboarding ? Math.min(muse.maxDmPerDay || MUSE_ONBOARDING_DAILY_CAP, MUSE_ONBOARDING_DAILY_CAP) : muse.maxDmPerDay;
      if (cap) {
        const [r] = await query<any[]>(
          `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND origin IN ('proactive', 'proactive:card') AND timestamp >= ?`,
          [s.id, now - 86_400_000],
        );
        if ((Number(r?.n) || 0) >= cap) return suppressed({ ok: false, error: `Error: you already reached the user ${cap} times in the last 24 hours. Save this for your journal or the next day.` });
      }
    }
    const ask = origin === 'proactive' && asksUser(text);
    const ids = await appendProactiveMessage({ sessionId: s.id, agentSlug: MUSE_AGENT_SLUG, content: text, origin, ask });
    ledger.inc('daily_muse', DM_FIELD[origin]);
    if (ask) ledger.inc('daily_muse', 'dmAwaitingUser');
    if (origin === 'proactive') noteMuseProduced('producedDms');
    return { ok: true, ...ids };
  });
  return sent ?? { ok: false, error: 'Error: the direct chat with the user is not available here' };
}

/** Muse 私聊会话 id(不建)。attention 端点据此把 Muse 后台待批算到这条私聊上。 */
export async function museDmSessionId(userId: string, appId: string): Promise<string | null> {
  const { activeSoloId } = await import('../routes/solo.js');
  return activeSoloId(userId, appId, 'agent', MUSE_AGENT_SLUG);
}
