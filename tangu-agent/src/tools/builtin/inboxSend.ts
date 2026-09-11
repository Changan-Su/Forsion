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
/** 正文上限(工具入口超了报错让模型缩短 —— 任务卡在末尾,静默截断会先截掉它;投递内核仍按它截,自动化 notify 行为不变)。 */
const MAX_BODY = 4000;
/** Muse 的发信人 id(与 agent slug 同名)。它的消息缺省**不**转发到微信/TG/QQ(M12):后台产出可能一小时几条,
 *  手机上全推就是打扰;只有 urgent 与日报走通道。 */
export const MUSE_SENDER_ID = 'muse';

export interface InboxSendResult { ok: boolean; error?: string }

/** 投递内核:频控+落库+通道转发。senderId 缺省=默认 agent;自动化 notify 传 `automation:<ruleId>`。
 *  forward 缺省 = 非 Muse 发信人都转发;urgent=true 强制转发。
 *  maxBody 缺省 4000(工具入口的防刷屏上限);引擎自己拼的正文(TODO 投影 = detail + 任务卡)放宽,免得卡被截断成半截代码块。 */
/** 转发到通道的裁决:urgent 强制转发(高于显式 forward:false,与注释一致 —— Codex 09-11 P2);
 *  否则显式 forward 说了算;都没说 = 非 Muse 发信人转发。 */
export function shouldForward(msg: { forward?: boolean; urgent?: boolean }, senderId: string): boolean {
  return !!msg.urgent || (msg.forward ?? senderId !== MUSE_SENDER_ID);
}

export async function sendInboxMessage(
  userId: string,
  msg: { title: string; body?: string; senderId?: string; forward?: boolean; urgent?: boolean; maxBody?: number },
): Promise<InboxSendResult> {
  const title = String(msg.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, error: 'Error: title 必填' };
  const body = String(msg.body || '').trim().slice(0, msg.maxBody ?? MAX_BODY);
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
    const forward = shouldForward(msg, senderId);
    if (forward) forwardInboxToChannels({ userId, title, body, senderKind: 'agent', senderId });
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
      // 本地限定(云端 no-op);Muse 不可见:它的出口是 add_muse_todo + 引擎侧回执/日报,直接发信会绕过 notify=digest(Codex 09-10 P2-10)。
      isEnabledFor: (profile, ctx) => !!profile.capabilities.hostExec && !(ctx as any).muse,

      definition: {
        type: 'function',
        function: {
          name: 'inbox_send',
          description:
            "Send a message to the user's inbox (the app's notification center). Use it for results, reminders, reports, " +
            'or follow-ups the user should notice outside this conversation — not as a substitute for replying here. ' +
            'Delivery is immediate; for a future or recurring reminder, create an automation instead ' +
            '(manage_automation with an at/every trigger and a notify action). ' +
            `The body (max ${MAX_BODY} characters) is rendered as an Amadeus note, so write it as a short document that leads with the conclusion: ` +
            'full markdown (tables, callouts, math, code) and `![[note]]` embeds of notes in the user\'s vault (mention other files by absolute path). ' +
            'To offer a one-click follow-up, end the body with up to two task cards; the user can run one in a new session, hand it to Muse, or ignore it. Format:\n' +
            '```forsion-task\ntitle: Short task title\ntldr: One line for the user (optional)\n---\n' +
            'Self-contained brief for a fresh session: paths, symptoms, acceptance criteria.\n```\n' +
            'Add `track: true` to the header when it needs follow-up over days rather than doing now. ' +
            'A ```forsion-button block may reference an existing manual automation rule id.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Concise message title shown in the inbox list' },
              body: { type: 'string', description: 'Optional message body (markdown; rendered by the Amadeus note renderer, see above)' },
            },
            required: ['title'],
          },
        },
      },
      execute: async (args, ctx) => {
        const body = String(args.body || '').trim();
        if (body.length > MAX_BODY) {
          return `Error: body is ${body.length} characters; the inbox limit is ${MAX_BODY}. Shorten it (keep any task cards at the end) and send again.`;
        }
        const r = await sendInboxMessage(ctx.userId, {
          title: String(args.title || ''),
          body,
          senderId: ctx.agentSlug || DEFAULT_AGENT_SLUG,
        });
        if (!r.ok) return r.error || 'Error: send failed';
        return `已投递到用户收件箱：「${String(args.title || '').trim().slice(0, 200)}」。`;
      },
    },
  ],
};
