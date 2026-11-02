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
import { MUSE_FEATURES, inboxAskBlocked, inboxListBlocked, inboxListItems, postMuseCard, postSummaryCard, recommendBlocked } from '../../services/museCards.js';
import { loadSpecialAgentsConfig } from '../../services/specialAgentsConfig.js';
import { deps } from '../../seams/runtime.js';
import { marketplaceId, marketplaceItemsOf } from '../../shared/marketplace.js';

/** text 带一张卡发出去:卡的类型白名单、目标校验、频控都在这里,模型写什么都到不了别的 kind。 */
async function sendCard(userId: string, text: string, card: any, signal?: AbortSignal): Promise<string> {
  if (card?.type === 'plugin') {
    const id = String(card.plugin_id || '');
    if (!marketplaceId(id)) return 'Error: plugin_id must be an id from search_marketplace.';
    const block = await recommendBlocked(userId, `plugin:${id}`);
    if (block) return block;
    const detail = await deps().brain.marketplace?.detail(id, signal).catch(() => null);
    const [item] = marketplaceItemsOf({ kind: 'marketplace', version: 1, items: detail ? [detail] : [] });
    if (!item) return 'Error: that store entry is unavailable.';
    const { readme: _skip, ...shown } = item;
    const r = await postMuseCard(userId, { kind: 'plugin', key: `plugin:${id}`, payload: { item: shown }, text });
    return r.ok ? `Sent. The plugin card follows your message; the user installs it from there, or dismisses it.` : r.error;
  }
  if (card?.type === 'feature') {
    const feature = String(card.feature || '');
    if (!(MUSE_FEATURES as readonly string[]).includes(feature)) return `Error: feature must be one of ${MUSE_FEATURES.join(', ')}.`;
    const title = String(card.title || '').trim().slice(0, 80);
    if (!title) return 'Error: a feature card needs a short title in the user\'s language.';
    const block = await recommendBlocked(userId, `feature:${feature}`);
    if (block) return block;
    const r = await postMuseCard(userId, { kind: 'feature', key: `feature:${feature}`, payload: { feature, title, why: text }, text });
    return r.ok ? 'Sent. The card is at the end of your direct chat with them.' : r.error;
  }
  if (card?.type === 'inbox_ask') {
    const category = String(card.category || '');
    const block = await inboxAskBlocked(userId, category, loadSpecialAgentsConfig().muse);
    if (block) return block;
    const r = await postMuseCard(userId, { kind: 'inbox-ask', key: `inbox-ask:${category}`, payload: { category, question: text }, text });
    return r.ok ? 'Sent. Their answer shows up in your log.' : r.error;
  }
  if (card?.type === 'inbox_list') {
    const block = await inboxListBlocked(userId);
    if (block) return block;
    const items = await inboxListItems(userId, Array.isArray(card.items) ? card.items : []);
    if (!items.length) return 'Error: none of those are unread messages that need the user to act.';
    const r = await postMuseCard(userId, { kind: 'inbox-list', key: 'inbox-list', payload: { items, lead: text }, text });
    return r.ok ? `Sent a list of ${items.length}.` : r.error;
  }
  if (card?.type === 'channel') {
    const r = await postMuseCard(userId, { kind: 'channel', key: 'channel', payload: { why: text }, text });
    return r.ok ? 'Sent.' : r.error;
  }
  if (card?.type === 'summary') return postSummaryCard(userId, text, Array.isArray(card.items) ? card.items : []);
  return 'Error: unknown card type.';
}

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
              // 10-18 live 首跑:问句后面又补了一句「我没有替你定。」→ 引擎按结尾问号判等你,判不到。
              text: { type: 'string', description: 'The message (markdown). When you need an answer, make the question the very last sentence, with nothing after it; that is what marks the chat as waiting for them.' },
              card: {
                type: 'object',
                description: 'Attach one card to this message. Use it only as your cycle brief describes.',
                properties: {
                  type: { type: 'string', enum: ['plugin', 'feature', 'inbox_ask', 'inbox_list', 'channel', 'summary'] },
                  plugin_id: { type: 'string', description: 'plugin: the id from search_marketplace.' },
                  feature: { type: 'string', enum: [...MUSE_FEATURES], description: 'feature: the settings page to open.' },
                  title: { type: 'string', description: 'feature: short title, in the user\'s language.' },
                  category: { type: 'string', description: 'inbox_ask: the mail category.' },
                  items: { type: 'array', description: 'inbox_list: [{id, note}], what needs the user. summary: 3-5 one-line strings.', items: {} },
                },
                required: ['type'],
              },
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
        if (args.card) return sendCard(ctx.userId, text, args.card, ctx.signal);
        const r = await postMuseDm(ctx.userId, text, 'proactive');
        return r.ok ? 'Sent to the user in your direct chat.' : r.error;
      },
    },
  ],
};
