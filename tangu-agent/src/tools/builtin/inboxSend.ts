/**
 * inbox_send —— agent 给用户收件箱(Inbox Space)发消息(即时投递)。
 *
 * 可见性:本地限定(profile.capabilities.hostExec;云端 worker/ai-studio 不可见,快照零扰动)。
 * 频控 20 条/小时(失控 agent 防刷屏)。定时投递(deliver_at)已下线——定时提醒改走自动化
 * (manage_automation 的 at/every 触发 + notify 动作:触发时刻插入,通道推送/系统通知全通)。
 * 不进 PLAN_MODE_TOOLS(写操作;Muse 走 planMode 白名单故对 Muse 不可见——要给 Muse 用时再白名单)。
 *
 * sendInboxMessage = 投递内核(落库+频控+通道转发),本工具与自动化 notify 动作共用。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../core/db.js';
import type { ToolProvider } from '../toolRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';
import { forwardInboxToChannels } from '../../channels/forward.js';

const MAX_PER_HOUR = 20;

export interface InboxSendResult { ok: boolean; error?: string }

/** 投递内核:频控+落库+通道转发。senderId 缺省=默认 agent;自动化 notify 传 `automation:<ruleId>`。 */
export async function sendInboxMessage(
  userId: string,
  msg: { title: string; body?: string; senderId?: string },
): Promise<InboxSendResult> {
  const title = String(msg.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Error: title 必填' };
  const body = String(msg.body || '').trim().slice(0, 4000);
  const senderId = String(msg.senderId || DEFAULT_AGENT_SLUG).slice(0, 64);
  try {
    // 方言无关的窗口计数(muse_todos 同款 cutoff 法;禁 PG 专有 make_interval/::int)。
    const cutoff = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    const cntRows = await query<any[]>(
      `SELECT COUNT(*) AS n FROM inbox_messages WHERE user_id = ? AND sender_kind = 'agent' AND created_at >= ?`,
      [userId, cutoff],
    );
    if ((Number(cntRows?.[0]?.n) || 0) >= MAX_PER_HOUR) {
      return { ok: false, error: `已达本小时收件箱发送上限(${MAX_PER_HOUR} 条),请稍后再发或合并内容。` };
    }
    await query(
      `INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id)
       VALUES (?, ?, ?, ?, 'agent', ?)`,
      [uuidv4(), userId, title, body, senderId],
    );
    forwardInboxToChannels({ userId, title, body, senderKind: 'agent', senderId });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `Error: ${e?.message || e}` };
  }
}

export const inboxSendProvider: ToolProvider = {
  id: 'builtin:inbox_send',
  tools: () => [
    {
      name: 'inbox_send',
      mode: 'both',
      isEnabledFor: (profile) => !!profile.capabilities.hostExec, // 本地限定;云端 no-op 由此达成
      definition: {
        type: 'function',
        function: {
          name: 'inbox_send',
          description:
            "Send a message to the user's inbox (the app's notification center). Use it for results, reminders, reports, " +
            'or follow-ups the user should notice outside this conversation — not as a substitute for replying here. ' +
            'Delivery is immediate; for a future or recurring reminder, create an automation instead ' +
            '(manage_automation with an at/every trigger and a notify action).',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise message title shown in the inbox list' },
              body: { type: 'string', description: 'Optional message body (plain text or simple markdown)' },
            },
            required: ['title'],
          },
        },
      },
      execute: async (args, ctx) => {
        const r = await sendInboxMessage(ctx.userId, {
          title: String(args.title || ''),
          body: String(args.body || ''),
          senderId: ctx.agentSlug || DEFAULT_AGENT_SLUG,
        });
        if (!r.ok) return r.error || 'Error: send failed';
        return `已投递到用户收件箱：「${String(args.title || '').trim().slice(0, 200)}」。`;
      },
    },
  ],
};
