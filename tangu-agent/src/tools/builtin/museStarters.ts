/**
 * set_chat_starters —— Muse 设定新对话页 Chat Box 下那几行开场建议(最多 3 条,整组替换)。实现与规矩见 services/museStarters.ts。
 * 可见性:仅 Muse run(ctx.muse)且 muse.chatStarters 开着;列入 PLAN_MODE_TOOLS(和 add_muse_todo 一样只是向用户提议,不碰用户资产)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import { loadSpecialAgentsConfig } from '../../services/specialAgentsConfig.js';
import { MAX_STARTERS, STARTER_KINDS, setStarters, validateStarters } from '../../services/museStarters.js';

const startersOn = (): boolean => {
  try { return loadSpecialAgentsConfig().muse.chatStarters; } catch { return true; }
};

export const museStartersProvider: ToolProvider = {
  id: 'builtin:set_chat_starters',
  tools: () => [
    {
      name: 'set_chat_starters',
      mode: 'both',
      isEnabledFor: (_profile, ctx) => !!(ctx as any).muse && startersOn(),
      definition: {
        type: 'function',
        function: {
          name: 'set_chat_starters',
          description:
            `Set the chat starters shown under the input box when the user opens a new chat (at most ${MAX_STARTERS}). This replaces the whole set: ` +
            'pass the ones you want to keep exactly as they are and they stay put; pass an empty list to clear. ' +
            'Each starter is one sentence the user could send as-is to an agent right now, in the user\'s language and in their voice (a request, not a report), e.g. ' +
            '"Tomorrow\'s 10:00 product sync has no agenda yet. Draft one from this week\'s dev log." ' +
            'Ground each one in something concrete you saw — a calendar event, a note, a todo, a recent session, a web page — and name it in source.label: ' +
            'the label must appear verbatim in the text, and the app turns it into a link (so keep it short: the event or note title, not a sentence). ' +
            'Use kind "muse" for something you propose yourself, such as a recurring routine. ' +
            'Prefer timely things the user would actually do in a chat; do not repeat your todos or what is already waiting in your direct chat. ' +
            'Keep a starter until it stops being relevant — swapping them every cycle makes the page jumpy.',
          parameters: {
            type: 'object',
            properties: {
              starters: {
                type: 'array',
                maxItems: MAX_STARTERS,
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'The sentence the user would send (one or two short clauses)' },
                    source: {
                      type: 'object',
                      properties: {
                        kind: { type: 'string', enum: [...STARTER_KINDS] },
                        label: { type: 'string', description: 'The name of the thing, exactly as it appears in text (becomes the link)' },
                        ref: { type: 'string', description: 'note: its path in the vault; session: the session id; web: the URL; calendar: the date (YYYY-MM-DD); otherwise omit' },
                      },
                      required: ['kind', 'label'],
                    },
                  },
                  required: ['text', 'source'],
                },
              },
            },
            required: ['starters'],
          },
        },
      },
      execute: async (args, ctx) => {
        const v = validateStarters(args.starters);
        if ('error' in v) return `Error: ${v.error}. Nothing was changed.`;
        try {
          const { shown, refused } = await setStarters(ctx.userId, v.starters);
          const now = shown.length ? `Now shown: ${shown.map((s) => `"${s.text}"`).join('; ')}.` : 'No starters are shown now.';
          return refused.length
            ? `${now} Not added because the user dismissed them recently: ${refused.map((t) => `"${t}"`).join('; ')}.`
            : now;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
