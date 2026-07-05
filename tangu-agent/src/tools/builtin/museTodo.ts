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
            'Submit one high-value, actionable todo to the Muse TODO list (this is your only write operation). Use each opportunity wisely; ' +
            'only submit suggestions truly worth the user\'s time and actionable right now; keep the title concise, and in detail explain why it is valuable and how to do it.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A concise todo title' },
              detail: { type: 'string', description: 'Why it is valuable + suggested how-to (can later be injected into a session to execute with one click)' },
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
          // 方言无关的窗口计数:把「now - windowHours」格式化成 'YYYY-MM-DD HH:MM:SS'(UTC,与 SQLite
          // CURRENT_TIMESTAMP 同格式)按字符串比较——SQLite(文本列,ISO 字典序)与 Postgres(转 timestamp)
          // 皆成立。**绝不**用 `::int` / `make_interval`(PG 专有,SQLite 报 unrecognized token)。
          const cutoff = new Date(Date.now() - windowHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
          const cntRows = await query<any[]>(
            `SELECT COUNT(*) AS n FROM muse_todos WHERE user_id = ? AND created_at >= ?`,
            [ctx.userId, cutoff],
          );
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
