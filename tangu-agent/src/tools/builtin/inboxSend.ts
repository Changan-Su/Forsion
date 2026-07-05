/**
 * inbox_send —— agent 给用户收件箱(Inbox Space)发消息,可选 deliver_at 一次性定时。
 *
 * 可见性:本地限定(profile.capabilities.hostExec;云端 worker/ai-studio 不可见,快照零扰动)。
 * 定时投递无定时器:落库 deliver_at,读端过滤即到期可见。频控 20 条/小时(失控 agent 防刷屏)。
 * 不进 PLAN_MODE_TOOLS(写操作;Muse 走 planMode 白名单故对 Muse 不可见——要给 Muse 用时再白名单)。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../core/db.js';
import type { ToolProvider } from '../toolRegistry.js';
import { DEFAULT_AGENT_SLUG } from '../../core/tanguHome.js';

const MAX_PER_HOUR = 20;

/**
 * 解析 deliver_at:裸 'YYYY-MM-DD HH:mm(:ss)' 按**本机本地时区**(工具只在本地跑,与用户对话即本地时间);
 * 其余交 new Date(含时区后缀的 ISO)。返回 UTC 'YYYY-MM-DD HH:MM:SS' 或错误串。
 */
function parseDeliverAt(raw: string): { utc: string | null; error?: string; latePastTolerated?: boolean } {
  const s = raw.trim();
  if (!s) return { utc: null };
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    d = new Date(s.replace(' ', 'T')); // 无时区后缀 → JS 按本地时区解释,正是想要的语义
  } else {
    d = new Date(s);
  }
  if (isNaN(+d)) return { utc: null, error: 'Error: deliver_at 无法解析(支持 ISO 8601 或 "YYYY-MM-DD HH:mm" 本地时间)' };
  const diff = d.getTime() - Date.now();
  if (diff > 366 * 24 * 3600_000) return { utc: null, error: 'Error: deliver_at 不能超过一年后' };
  if (diff < -5 * 60_000) return { utc: null, error: 'Error: deliver_at 是过去时间,请给出未来时刻或省略该参数' };
  // 过去 ≤5 分钟:容忍(代理常算出略过期的时刻,硬拒会引发重试循环)→ 立即投递。
  if (diff <= 0) return { utc: null, latePastTolerated: true };
  return { utc: d.toISOString().slice(0, 19).replace('T', ' ') };
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
            'Optionally set deliver_at to schedule a one-time future delivery; there is no recurring schedule.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise message title shown in the inbox list' },
              body: { type: 'string', description: 'Optional message body (plain text or simple markdown)' },
              deliver_at: {
                type: 'string',
                description:
                  'Optional one-time delivery time: ISO 8601 (e.g. "2026-07-02T18:30:00+08:00") or "YYYY-MM-DD HH:mm" ' +
                  "interpreted in the user's local timezone. Omit to deliver immediately.",
              },
            },
            required: ['title'],
          },
        },
      },
      execute: async (args, ctx) => {
        const title = String(args.title || '').trim().slice(0, 200);
        if (!title) return 'Error: title 必填';
        const body = String(args.body || '').trim().slice(0, 4000);
        const parsed = parseDeliverAt(String(args.deliver_at || ''));
        if (parsed.error) return parsed.error;
        try {
          // 方言无关的窗口计数(muse_todos 同款 cutoff 法;禁 PG 专有 make_interval/::int)。
          const cutoff = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ');
          const cntRows = await query<any[]>(
            `SELECT COUNT(*) AS n FROM inbox_messages WHERE user_id = ? AND sender_kind = 'agent' AND created_at >= ?`,
            [ctx.userId, cutoff],
          );
          if ((Number(cntRows?.[0]?.n) || 0) >= MAX_PER_HOUR) {
            return `已达本小时收件箱发送上限(${MAX_PER_HOUR} 条),请稍后再发或合并内容。`;
          }
          await query(
            `INSERT INTO inbox_messages (id, user_id, title, body, sender_kind, sender_id, deliver_at)
             VALUES (?, ?, ?, ?, 'agent', ?, ?)`,
            [uuidv4(), ctx.userId, title, body, ctx.agentSlug || DEFAULT_AGENT_SLUG, parsed.utc],
          );
          if (parsed.utc) {
            const local = new Date(`${parsed.utc.replace(' ', 'T')}Z`).toLocaleString('zh-CN');
            return `已安排定时投递：「${title}」（预计 ${local} 送达）。`;
          }
          if (parsed.latePastTolerated) return `deliver_at 已过期，已立即投递：「${title}」。`;
          return `已投递到用户收件箱：「${title}」。`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
