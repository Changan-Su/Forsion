/**
 * Muse 主动发私聊(2026-10-18,方案 docs/ToBeImproved/Muse私聊与收件箱分工方案_2026-10-17,用户选 B「按性质分」):
 * 要用户回话 / 拍板的 —— 一句提醒、待办提议、后台审批 —— 写进那条长期的 Muse 私聊(就是用户点 Muse 行进的那条);
 * 做好的成品(调研、日报)照旧进收件箱。
 *
 * 落一条 role=model、origin=proactive* 的消息;会话 proactive_at 前移 = 未读(routes/sessions.ts 的 attention 端点按它报);
 * message_user 发的一句以问号结尾 → 等你(下一轮开始由 childSessions.onRunStart 清)。审批的「等你」不走这一列:
 * 用户在托盘里批完不起轮,清不掉 —— 那份由 attention 端点按 pending_approvals 现算。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../core/db.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { endsWithQuestion } from './childSessions.js';
import { isWithinActiveHours, loadSpecialAgentsConfig } from './specialAgentsConfig.js';
import { MUSE_ONBOARDING_DAILY_CAP, onboardingActive, readMuseOnboarding } from './museState.js';

/** proactive = message_user;todo / approval = 引擎替 add_muse_todo / 审批入队发的;card = Muse 发起的、要用户点的卡(services/museCards.ts);
 *  notice = 不是 Muse 自己要开口的卡(用户要的设置卡、引擎发的第一次见面 / 小结),不计今天的额度;
 *  remind = 规则的「直接提醒」(用户自己定的,不叫模型),同样不计今天的额度。 */
export type ProactiveOrigin = 'proactive' | 'proactive:todo' | 'proactive:approval' | 'proactive:card' | 'proactive:notice' | 'proactive:remind';
export const MUSE_DM_PER_HOUR = 3;
export const MUSE_DM_MAX_CHARS = 1500;

export type MuseDmResult = { ok: true; sessionId: string; messageId: string } | { ok: false; error: string };

/** 这句在等用户回话:以问号收尾,或问号后面只跟一小句(「…要不要记成已知抖动？我先不替你定。」—— 10-18 live 四次里两次这样收尾,
 *  工具描述写了「问句放最后」也没拦住)。ponytail: 尾巴 ≤40 字按字数判,「CI 红了？没事,重跑过了。」这类自问自答也会亮等你,
 *  要更准就让模型显式声明。 */
export function asksUser(text: string): boolean {
  return endsWithQuestion(text) || /[?？][^?？]{1,40}$/.test(text.trim()); // 尾巴另起一行也算
}

export async function postMuseDm(userId: string, content: string, origin: ProactiveOrigin = 'proactive'): Promise<MuseDmResult> {
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'Error: the message is empty' };
  // 动态导入:routes/solo → routes/sessions → agentLoop → 工具注册表 → 本文件,静态导入会成环。
  const { ensureSoloSession } = await import('../routes/solo.js');
  const s = await ensureSoloSession(userId, 'agent', MUSE_AGENT_SLUG).catch(() => null);
  if (!s) return { ok: false, error: 'Error: the direct chat with the user is not available here' };
  const now = Date.now();
  if (origin === 'proactive') {
    const [r] = await query<any[]>(
      `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND origin = 'proactive' AND timestamp >= ?`,
      [s.id, now - 3600_000],
    );
    if ((Number(r?.n) || 0) >= MUSE_DM_PER_HOUR) {
      return { ok: false, error: `Error: you already sent the user ${MUSE_DM_PER_HOUR} messages in the last hour. Fold this into your next message, or write it in your journal.` };
    }
  }
  if (origin === 'proactive' || origin === 'proactive:card') {
    // 一天的上限来自配置(0 = 不限);磨合期再封一道,作息外也不发(周期被规则 / 日程叫醒时会走到这里)
    const muse = loadSpecialAgentsConfig().muse;
    const onboarding = onboardingActive(await readMuseOnboarding().catch(() => null));
    if (onboarding && !isWithinActiveHours(muse, new Date().getHours())) return { ok: false, error: 'Error: it is outside the user\'s active hours. Keep this for your next cycle.' };
    const cap = onboarding ? Math.min(muse.maxDmPerDay || MUSE_ONBOARDING_DAILY_CAP, MUSE_ONBOARDING_DAILY_CAP) : muse.maxDmPerDay;
    if (cap) {
      const [r] = await query<any[]>(
        `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND origin IN ('proactive', 'proactive:card') AND timestamp >= ?`,
        [s.id, now - 86_400_000],
      );
      if ((Number(r?.n) || 0) >= cap) return { ok: false, error: `Error: you already reached the user ${cap} times in the last 24 hours. Save this for your journal or the next day.` };
    }
  }
  const id = uuidv4();
  await query(
    `INSERT INTO chat_messages (id, session_id, role, content, timestamp, model_id, is_error, agent_slug, origin)
     VALUES (?, ?, 'model', ?, ?, NULL, ?, ?, ?)`,
    [id, s.id, text, now, false, MUSE_AGENT_SLUG, origin],
  );
  const ask = origin === 'proactive' && asksUser(text);
  await query(
    `UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP, proactive_at = ?${ask ? ', awaiting_user = TRUE' : ''} WHERE id = ?`,
    [now, s.id],
  );
  return { ok: true, sessionId: s.id, messageId: id };
}

/** Muse 私聊会话 id(不建)。attention 端点据此把 Muse 后台待批算到这条私聊上。 */
export async function museDmSessionId(userId: string, appId: string): Promise<string | null> {
  const { activeSoloId } = await import('../routes/solo.js');
  return activeSoloId(userId, appId, 'agent', MUSE_AGENT_SLUG);
}
