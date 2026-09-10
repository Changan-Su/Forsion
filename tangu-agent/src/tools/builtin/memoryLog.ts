/**
 * 记忆/日志工具:remember / log_event / read_log(execute 体从 registry.ts 原样搬移)。
 * 经 deps().brain.memory 落云端(或 standalone 的 httpBrain)。
 */
import { deps } from '../../seams/runtime.js';
import type { ToolProvider } from '../toolRegistry.js';

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const appendMemoryEntry = (userId: string, text: string, opts?: { dedup?: boolean; cap?: number; signal?: AbortSignal }) =>
  deps().brain.memory.appendMemoryEntry(userId, text, opts);
const appendLogEntry = (userId: string, text: string, signal?: AbortSignal) => deps().brain.memory.appendLogEntry(userId, text, { signal });
const getLog = (userId: string, date?: string, signal?: AbortSignal) => deps().brain.memory.getLog(userId, date, { signal });

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
            'Use only for persistent information, not temporary tasks. action defaults to add; list returns entry IDs, update corrects a listed entry, forget removes a listed entry and prevents automatic replay. Use update/forget only when the user requests that correction or forgetting. Memory belongs only to the current Agent. Never choose another Agent.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'list', 'update', 'forget'], description: 'Defaults to add. List before update/forget to obtain the current entry ID.' },
              fact: { type: 'string', description: 'A one-sentence fact; required for add/update.' },
              id: { type: 'string', description: 'An entry ID returned by list for this Agent; required for update/forget.' },
              expectedVersion: { type: 'string', description: 'Version returned by list; include when modifying an existing entry.' },
            },
            required: [],
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        const action = String(args.action ?? 'add');
        const brain = deps().brain.memory;
        if (!['add', 'list', 'update', 'forget'].includes(action)) return 'Error: unknown memory action';
        if (action === 'list') {
          if (!brain.getMemorySnapshot) return 'Error: this memory backend does not support entry management.';
          const snapshot = await brain.getMemorySnapshot(ctx.userId);
          return JSON.stringify({ version: snapshot.version, entries: snapshot.entries });
        }
        const fact = String(args.fact ?? '').trim();
        if (action !== 'forget' && !fact) return 'Error: fact is required';
        if (action !== 'add' && !String(args.id ?? '').trim()) return 'Error: id is required; use action list first';
        if (action !== 'add' && !String(args.expectedVersion ?? '').trim()) return 'Error: expectedVersion is required; use action list first';
        if (brain.mutateMemory) {
          const snapshot = await brain.mutateMemory(ctx.userId, {
            action: action as 'add' | 'update' | 'forget', fact, id: args.id ? String(args.id) : undefined,
            expectedVersion: args.expectedVersion ? String(args.expectedVersion) : undefined,
            source: { kind: 'explicit', sessionId: ctx.sessionId, runId: ctx.runId }, signal: ctx.signal,
          });
          return JSON.stringify({ ok: true, action, version: snapshot.version, entries: snapshot.entries });
        }
        if (action !== 'add') return 'Error: this memory backend does not support entry management.';
        const r = await appendMemoryEntry(ctx.userId, fact, { dedup: true, signal: ctx.signal });
        if (r.appended) return '已记入长期记忆。';
        if (r.reason === 'duplicate') return '已存在相同记忆，无需重复记录。';
        if (r.reason === 'full') return '长期记忆已接近上限，本条未写入。';
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
        ctx.signal?.throwIfAborted();
        const text = String(args.text ?? '').trim();
        if (!text) return 'Error: text is required';
        const r = await appendLogEntry(ctx.userId, text, ctx.signal);
        if (ctx.signal?.aborted) return `已记入 ${r.date} 日志（${r.time}）；取消在写入确认后到达，本条不会回滚。`;
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
        ctx.signal?.throwIfAborted();
        const date = String(args.date ?? '').trim() || undefined;
        const r = await getLog(ctx.userId, date, ctx.signal);
        ctx.signal?.throwIfAborted();
        // 空结果给出路:日志记「做了什么」,不含对话原文——找当时说了什么该走 search_sessions
        // (真实失败样本里模型正是从 read_log 空手而归后宣布「无历史可查」)。
        return r.content?.trim()
          ? r.content
          : `（${r.date} 暂无日志）\nNote: the log records what was DONE, not what was said. For past conversation content, use \`search_sessions\`.`;
      },
    },
  ],
};
