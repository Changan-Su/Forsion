/**
 * add_muse_todo —— Muse（后台常驻 Special Agent）向用户提交待办建议。
 *
 * 可见性：仅 Muse run（ctx.muse=true）；并列入 PLAN_MODE_TOOLS（历史上 Muse 跑只读 planMode 时的唯一写口;
 * 2026-09-10 起 Muse 按权限档工作,本工具仍是「向用户提议」的正式通道）。预算：每滚动窗口最多
 * maxTodosPerWindow 条（超出即拒绝）。落库后顺手直插一条收件箱消息(0 token,08-20 评审的第①刀):
 * 产出不再只躺在 AgentsDetailView 里,全局角标 + 系统通知那条轨道自然带到。
 * 09-11:信的末尾由引擎拼一张任务卡(todoMailBody)—— 从前只把 detail 原样当正文,收件箱里没有任何可点的执行入口。
 */
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../core/db.js';
import type { ToolProvider } from '../toolRegistry.js';
import { loadSpecialAgentsConfig } from '../../services/specialAgentsConfig.js';
import { sendInboxMessage, MUSE_SENDER_ID } from './inboxSend.js';

/** TODO 的收件箱正文 = detail + 末尾一张任务卡(引擎拼,不靠 Muse 自觉;围栏放最后,与审批信同一纪律)。
 *  `todo:` 头让桌面把落点回写这条 TODO(交给 Muse = 批准它去做 / 新会话 = injected / 忽略 = dismissed);
 *  任务书 = 标题 + detail,与 MuseView「新会话执行」、/todos/inject 同一形状。围栏比任务书里最长的反引号串多一个 ——
 *  detail 里写了 ``` 也收不了它(桌面解析器认变长围栏)。桌面 suggest.test 与 e2e:inboxamadeus 读 test/fixtures/muse-todo-mail.md。 */
/** detail 末尾若留着没收口的围栏(``` / ~~~),补一行收口 —— 否则后面的任务卡被当成那段代码块的内容,卡直接消失(Codex 09-11 P1)。
 *  规则与桌面 splitSuggestions 同一套 CommonMark:≤3 空格缩进;反引号开栏的 info 不许含反引号;同种字符、数量 ≥ 开栏数、info 为空才收口。 */
export function closeOpenFence(md: string): string {
  let open = '';
  for (const line of md.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*?)[ \t]*\r?$/.exec(line); // 与桌面 suggest.ts 的 FENCE 逐字一致(只剥空格 / Tab)
    if (!m) continue;
    if (!open) { if (m[1][0] === '~' || !m[2].includes('`')) open = m[1]; }
    else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2]) open = '';
  }
  return open ? `${md}\n${open}` : md;
}

export function todoMailBody(t: { id: string; title: string; detail: string }): string {
  const prompt = t.detail ? `${t.title}\n\n${t.detail}` : t.title;
  const fence = '`'.repeat(Math.max(3, ...(prompt.match(/`+/g) || []).map((r) => r.length + 1)));
  const card = `${fence}forsion-task\ntitle: ${t.title.replace(/\s+/g, ' ')}\ntodo: ${t.id}\n---\n${prompt}\n${fence}`;
  return t.detail ? `${closeOpenFence(t.detail)}\n\n${card}` : card;
}

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
            'Propose one high-value, actionable todo to the user. It lands on the Muse TODO list and in their inbox: the detail becomes the message body ' +
            '(rendered as an Amadeus note — markdown, callouts, `[[note]]` links; mention files outside the vault by absolute path), and the app appends an ' +
            'action card (let Muse do it / run in a new session / ignore) whose brief is the title plus the detail — so make the detail self-contained: ' +
            'why it matters, concrete steps, exact paths or symptoms, and how to verify. Do not write forsion-task fences yourself. ' +
            'Use each opportunity wisely; only submit suggestions truly worth the user\'s time and actionable right now; keep the title concise.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A concise todo title' },
              detail: { type: 'string', description: 'Message body and execution brief (markdown): why it is valuable + concrete how-to, self-contained (paths, symptoms, acceptance criteria)' },
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
          const id = uuidv4();
          await query(
            `INSERT INTO muse_todos (id, user_id, title, detail, status, source_session_id) VALUES (?, ?, ?, ?, 'pending', ?)`,
            [id, ctx.userId, title, detail, ctx.sessionId],
          );
          // 收件箱投影(失败不影响 TODO 本身;标题沿用模型写的原文=跟随用户语言,不硬编码文案)。
          // digest 档不逐条打扰:日报里再汇总(muse.ts 写 Journal),这里只落 TODO。
          let digest = false;
          try { digest = loadSpecialAgentsConfig().muse.notify === 'digest'; } catch { /* 默认 immediate */ }
          if (!digest) {
            // 正文长度由构造封顶(detail ≤ 4000、标题 ≤ 200、围栏 ≤ 最长反引号串 + 1),照实传上限:截一个字就是半张卡。
            const body = todoMailBody({ id, title, detail });
            await sendInboxMessage(ctx.userId, { title, body, senderId: MUSE_SENDER_ID, maxBody: body.length }).catch(() => {});
          }
          return `已记录 TODO：「${title}」（本时段还可提 ${Math.max(0, maxPerWindow - n - 1)} 条）。`;

        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
