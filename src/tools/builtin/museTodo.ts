/**
 * add_muse_todo —— Muse（后台常驻 Special Agent）的**唯一写权限**：向 Muse TODO 清单提交待办。
 *
 * 可见性：仅 Muse run（ctx.muse=true）；并列入 PLAN_MODE_TOOLS，使 Muse 在只读 planMode 下仍可用它，
 * 从而实现「读全部 + 只写 TODO」。预算：每滚动窗口最多 maxTodosPerWindow 条（超出即拒绝）。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../core/db.js';
import type { ToolProvider } from '../toolRegistry.js';
import { loadSpecialAgentsConfig } from '../../services/specialAgentsConfig.js';

export const museTodoProvider: ToolProvider = {
  id: 'builtin:add_muse_todo',
  tools: () => [
    {
      name: 'add_muse_todo',
      mode: 'both',
      isEnabledFor: (_profile, ctx) => !!(ctx as any).muse, // 仅 Muse run 可见
      definition: {
        type: 'function',
        function: {
          name: 'add_muse_todo',
          description:
            '向 Muse TODO 清单提交一条高价值、可执行的待办（这是你唯一的写操作）。请珍惜每次机会，' +
            '只提交真正值得用户花时间、且现在就能着手的建议；title 简洁，detail 写清为什么有价值与怎么做。',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '简洁的待办标题' },
              detail: { type: 'string', description: '为什么有价值 + 建议怎么做（将来可一键注入会话执行）' },
            },
            required: ['title'],
          },
        },
      },
      execute: async (args, ctx) => {
        const title = String(args.title || '').trim().slice(0, 200);
        if (!title) return 'Error: title 必填';
        const detail = String(args.detail || '').trim().slice(0, 4000);
        let maxPerWindow = 5;
        let windowHours = 1;
        try {
          const m = loadSpecialAgentsConfig().muse;
          maxPerWindow = m.maxTodosPerWindow;
          windowHours = m.restartWindowHours;
        } catch { /* 用默认 */ }
        if (maxPerWindow <= 0) return '已达本时段 TODO 上限（0），暂不能新增。请专注思考、择机再提。';
        try {
          const since = Date.now() - windowHours * 3600_000;
          // created_at 用 CURRENT_TIMESTAMP(文本/时间戳两方言)；窗口判断改用 id 无法，故按 created_at 比较。
          const cntRows = await query<any[]>(
            `SELECT COUNT(*)::int AS n FROM muse_todos
             WHERE user_id = ? AND created_at >= CURRENT_TIMESTAMP - make_interval(hours => ?)`,
            [ctx.userId, windowHours],
          ).catch(async () =>
            // SQLite 无 make_interval：退回不限窗的总 pending 计数兜底（仍受 maxPerWindow 约束）。
            query<any[]>(`SELECT COUNT(*)::int AS n FROM muse_todos WHERE user_id = ? AND status = 'pending'`, [ctx.userId]),
          );
          void since;
          const n = Number(cntRows?.[0]?.n) || 0;
          if (n >= maxPerWindow) {
            return `已达本时段 TODO 上限（${maxPerWindow} 条）。请暂停提交、继续观察，下个时段再提最有价值的。`;
          }
          await query(
            `INSERT INTO muse_todos (id, user_id, title, detail, status, source_session_id) VALUES (?, ?, ?, ?, 'pending', ?)`,
            [uuidv4(), ctx.userId, title, detail, ctx.sessionId],
          );
          return `已记录 TODO：「${title}」（本时段还可提 ${Math.max(0, maxPerWindow - n - 1)} 条）。`;
        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
