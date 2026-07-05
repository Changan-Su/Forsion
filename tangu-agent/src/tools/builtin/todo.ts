/**
 * todo 任务清单工具:todo_write(整单替换)+ todo_read。多步任务的过程性短期记忆,
 * 防止长 run 中途忘步骤(对齐 Claude Code TodoWrite / hermes todo 的用法)。
 * 持久化在 chat_sessions.todos(JSONB,migrate.ts 幂等加列);写入即向 run 事件总线发
 * `todo` 事件,TUI/桌面可实时渲染清单。
 */
import { deps } from '../../seams/runtime.js';
import { publish } from '../../services/eventBus.js';
import type { ToolProvider } from '../toolRegistry.js';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const MAX_ITEMS = 50;
const MAX_CONTENT_CHARS = 500;

function renderTodos(todos: TodoItem[]): string {
  if (!todos.length) return '(empty todo list)';
  const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
  return todos.map((t, i) => `${i + 1}. ${mark[t.status]} ${t.content}`).join('\n');
}

async function loadTodos(sessionId: string): Promise<TodoItem[]> {
  const raw = await deps().state.loadTodos(sessionId);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? parsed : [];
}

export const todoProvider: ToolProvider = {
  id: 'builtin:todo',
  tools: () => [
    {
      name: 'todo_write',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'todo_write',
          description:
            'Maintain this session\'s todo list (replaces the whole list). Write a list before planning a multi-step task; update the status after each step before continuing. ' +
            'status ∈ pending | in_progress | completed; at most one item in_progress at a time.',
          parameters: {
            type: 'object',
            properties: {
              todos: {
                type: 'array',
                description: 'The complete todo list (replaces the old list in full)',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string', description: 'Task description (imperative)' },
                    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status' },
                  },
                  required: ['content', 'status'],
                },
              },
            },
            required: ['todos'],
          },
        },
      },
      execute: async (args, ctx) => {
        const input = Array.isArray(args.todos) ? args.todos : null;
        if (!input) return 'Error: todos 必须是数组';
        const todos: TodoItem[] = input.slice(0, MAX_ITEMS).map((t: any) => ({
          content: String(t?.content ?? '').slice(0, MAX_CONTENT_CHARS),
          status: (['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending') as TodoItem['status'],
        })).filter((t: TodoItem) => t.content);
        await deps().state.writeTodos(ctx.sessionId, JSON.stringify(todos));
        if (ctx.runId) void publish(ctx.runId, 'todo', { todos });
        const done = todos.filter((t) => t.status === 'completed').length;
        return `todo list updated (${done}/${todos.length} done)\n${renderTodos(todos)}`;
      },
    },
    {
      name: 'todo_read',
      mode: 'both',
      definition: {
        type: 'function',
        function: {
          name: 'todo_read',
          description: 'Read this session\'s current todo list (use it to restore context or check remaining steps).',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      execute: async (_args, ctx) => {
        try {
          return renderTodos(await loadTodos(ctx.sessionId));
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
