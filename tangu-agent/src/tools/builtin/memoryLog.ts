/**
 * 记忆/日志工具:remember / log_event / read_log(execute 体从 registry.ts 原样搬移)。
 * 经 deps().brain.memory 落云端(或 standalone 的 httpBrain)。
 */
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const appendMemoryEntry = (userId: string, text: string, opts?: { dedup?: boolean; cap?: number }) =>
  deps().brain.memory.appendMemoryEntry(userId, text, opts);
const appendLogEntry = (userId: string, text: string) => deps().brain.memory.appendLogEntry(userId, text);
const getLog = (userId: string, date?: string) => deps().brain.memory.getLog(userId, date);

export const memoryLogProvider: ToolProvider = {
  id: 'builtin:memory-log',
  tools: () => [
    {
      name: 'remember',
      isEnabledFor: (profile) => profile.capabilities.memory,
      definition: {
        type: 'function',
        function: {
          name: 'remember',
          description:
            'Write a stable, durably useful fact/preference about the user into long-term memory (kept across sessions, injected into later conversations). ' +
            'Use only for persistent information (such as long-term preferences, background, how to address the user); do not record one-off task details or temporary context. Duplicate content is ignored automatically.',
          parameters: {
            type: 'object',
            properties: { fact: { type: 'string', description: 'A one-sentence fact/preference to remember long-term' } },
            required: ['fact'],
          },
        },
      },
      execute: async (args, ctx) => {
        const fact = String(args.fact ?? '').trim();
        if (!fact) return 'Error: fact is required';
        const r = await appendMemoryEntry(ctx.userId, fact, { dedup: true });
        if (r.appended) return '已记入长期记忆。';
        if (r.reason === 'duplicate') return '已存在相同记忆，无需重复记录。';
        if (r.reason === 'full') return '长期记忆已接近上限，本条未写入。可提醒用户在账户中心整理记忆。';
        return 'Error: fact is required';
      },
    },
    {
      name: 'log_event',
      isEnabledFor: (profile) => profile.capabilities.log,
      definition: {
        type: 'function',
        function: {
          name: 'log_event',
          description:
            'Append a noteworthy event/progress from this interaction to the user\'s "today" activity log (archived by date, viewable by the user in the account center). ' +
            'Use to record completed work, conclusions reached, files produced, etc.; do not record trivial chit-chat.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'A one-sentence event/progress to record in today\'s log' } },
            required: ['text'],
          },
        },
      },
      execute: async (args, ctx) => {
        const text = String(args.text ?? '').trim();
        if (!text) return 'Error: text is required';
        const r = await appendLogEntry(ctx.userId, text);
        return `已记入 ${r.date} 日志（${r.time}）。`;
      },
    },
    {
      name: 'read_log',
      isEnabledFor: (profile) => profile.capabilities.log,
      definition: {
        type: 'function',
        function: {
          name: 'read_log',
          description: 'Read the user\'s activity log for a given day (markdown). Date format YYYY-MM-DD; defaults to today.',
          parameters: {
            type: 'object',
            properties: { date: { type: 'string', description: 'Date YYYY-MM-DD; defaults to today' } },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        const date = String(args.date ?? '').trim() || undefined;
        const r = await getLog(ctx.userId, date);
        return r.content?.trim() ? r.content : `（${r.date} 暂无日志）`;
      },
    },
  ],
};
