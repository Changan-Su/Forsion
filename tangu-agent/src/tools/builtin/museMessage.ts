/**
 * message_user —— Muse 周期里直接给用户发一条私聊消息(2026-10-18,方案 B「按性质分」)。
 *
 * 要用户回话 / 拍板的、一屏看得完的提醒进私聊(即时);做好的成品照旧进收件箱(inbox_send / 日报)。
 * 消息落在那条长期的 Muse 私聊里(services/museDm.ts),用户在那里回话 = 和 Muse 手聊一轮。
 *
 * 可见性:仅 Muse 周期(ctx.muse);delegate 出去的子代理会 spread 继承 muse:true,显式排除。普通 run 不可见 → tooldefs 快照零漂移。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { MUSE_DM_MAX_CHARS, MUSE_DM_PER_HOUR, postMuseDm } from '../../services/museDm.js';

export const museMessageProvider: ToolProvider = {
  id: 'builtin:message_user',
  tools: () => [
    {
      name: 'message_user',
      mode: 'both',
      isEnabledFor: (profile, ctx) => !!profile.capabilities.hostExec && !!(ctx as any).muse && !((ctx.subAgentDepth || 0) >= 1),
      definition: {
        type: 'function',
        function: {
          name: 'message_user',
          description:
            'Send the user a short message in your direct chat with them; they see it right away. ' +
            'Use it for what needs their reply or decision, or a heads-up that fits on one screen ' +
            '(e.g. "CI failed on main; I re-ran it and it passed. Treat this test as known flakiness?"). ' +
            'Finished work for them to read later (a report, research, a write-up) goes to their inbox instead, not here. ' +
            'add_muse_todo and actions waiting for approval already post in this chat, so do not announce them again. ' +
            `At most ${MUSE_DM_PER_HOUR} messages per hour, ${MUSE_DM_MAX_CHARS} characters each; write in the user's language. ` +
            'If they reply, that conversation saves what they ask for to your memory or log; check read_log next cycle.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The message (markdown). End with a question when you need an answer.' },
            },
            required: ['text'],
          },
        },
      },
      execute: async (args, ctx) => {
        const text = String(args.text || '').trim();
        if (!text) return 'Error: text is required';
        if (text.length > MUSE_DM_MAX_CHARS) {
          return `Error: the message is ${text.length} characters; the limit is ${MUSE_DM_MAX_CHARS}. Shorten it, or send longer finished work to the inbox.`;
        }
        const r = await postMuseDm(ctx.userId, text, 'proactive');
        return r.ok ? 'Sent to the user in your direct chat.' : r.error;
      },
    },
  ],
};
