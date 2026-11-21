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
import { sendInboxMessage, stripTodoHeaders, MUSE_SENDER_ID } from './inboxSend.js';
import { postMuseDm } from '../../services/museDm.js';
import { ledger } from '../../services/telemetryLedger.js';
import { noteMuseProduced } from '../../services/museTelemetry.js';
import { MUSE_TODO_EVIDENCE_KINDS, type MuseTodoEvidence, type MuseTodoEvidenceKind } from '../../contracts/clientTypes.js';

/** 依据(借鉴 dsh-superagent 方案第 2 条,2026-11-20):提议必须说清根据什么。1–3 条,每条来源 + 短摘(≤80 字)。
 *  存在 muse_todos.evidence,卡片按 id 读 —— 不写进 forsion-task 围栏,模型写在正文里的「依据」冒充不了卡上那一行。
 *  宽松收:JSON 串照解、单个对象当一条、多于 3 条取前 3、来源 / 短摘过长截断、kind 不认识落 other;
 *  一条有效的都没有才拒(拒在配额计数之前,不占配额)。 */
export const EVIDENCE_MAX_ITEMS = 3;
export const EVIDENCE_QUOTE_MAX = 80;
export const EVIDENCE_SOURCE_MAX = 120;
const EVIDENCE_KIND_SET = new Set<string>(MUSE_TODO_EVIDENCE_KINDS);
/** 按字符(码点)截,超了留一个省略号,总长不超过 max。 */
function clipChars(s: string, max: number): string {
  const a = Array.from(s);
  return a.length > max ? `${a.slice(0, max - 1).join('')}…` : s;
}
/** 只收字符串:对象 / 布尔不 String() 成「[object Object]」「false」混进来(Codex 11-20 P2),库里被改坏的行也不会在这里抛。 */
const flat = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

export function normalizeEvidence(raw: unknown): MuseTodoEvidence[] {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  const out: MuseTodoEvidence[] = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const source = clipChars(flat(o.source), EVIDENCE_SOURCE_MAX);
    const quote = clipChars(flat(o.quote), EVIDENCE_QUOTE_MAX);
    if (!source || !quote) continue;
    const k = flat(o.kind).toLowerCase();
    out.push({ kind: (EVIDENCE_KIND_SET.has(k) ? k : 'other') as MuseTodoEvidenceKind, source, quote });
    if (out.length >= EVIDENCE_MAX_ITEMS) break;
  }
  return out;
}

/** 库里那一列 → 数组(老行 NULL / 坏 JSON → 空数组,卡上不画这一行)。 */
export function parseStoredEvidence(v: unknown): MuseTodoEvidence[] {
  if (v == null || v === '') return [];
  try { return normalizeEvidence(v); } catch { return []; } // 一行坏数据不许把整个列表接口打成 500
}

export const EVIDENCE_REQUIRED_ERROR =
  'Error: evidence is required — 1 to 3 items, each with a source (where you saw it: the user\'s own words with their date and time, a file path, a calendar event, an activity line, the watch rule that fired) ' +
  `and a quote (a short excerpt, at most ${EVIDENCE_QUOTE_MAX} characters). Look it up with your tools; if nothing you can point to shows the user wants this, do not propose it. Nothing was saved.`;

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
  const detail = stripTodoHeaders(t.detail); // 只有下面这张卡的 `todo:` 是真的
  const prompt = detail ? `${t.title}\n\n${detail}` : t.title;
  const fence = '`'.repeat(Math.max(3, ...(prompt.match(/`+/g) || []).map((r) => r.length + 1)));
  const card = `${fence}forsion-task\ntitle: ${t.title.replace(/\s+/g, ' ')}\ntodo: ${t.id}\n---\n${prompt}\n${fence}`;
  return detail ? `${closeOpenFence(detail)}\n\n${card}` : card;
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
            'Propose one high-value, actionable todo to the user. It lands on the Muse TODO list and as a message in your direct chat with the user (it waits for their go-ahead there): the detail becomes the message body ' +
            '(rendered as an Amadeus note — markdown, callouts, `[[note]]` links; mention files outside the vault by absolute path), and the app appends an ' +
            'action card (let Muse do it / run in a new session / ignore) whose brief is the title plus the detail — so make the detail self-contained: ' +
            'why it matters, concrete steps, exact paths or symptoms, and how to verify. Do not write forsion-task fences yourself. ' +
            'Use each opportunity wisely; only submit suggestions truly worth the user\'s time and actionable right now; keep the title concise.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A concise todo title' },
              detail: { type: 'string', description: 'Message body and execution brief (markdown): why it is valuable + concrete how-to, self-contained (paths, symptoms, acceptance criteria)' },
              evidence: {
                type: 'array',
                minItems: 1,
                maxItems: EVIDENCE_MAX_ITEMS,
                // 借鉴 dsh-superagent 第 2 条(11-20):三个判断 + 三条反例。11-21 从工具描述挪到这里:写在工具描述里时,
                // 它对「把做完的成品投进收件箱」也变犹豫(live musedm 只删这段的隔离臂 4/6,对照 main 3/6;整版另一轮 3/6 对 main 6/6)。
                // 这里只在填依据时读到;末句写明门槛只管提待办。不进 kickoff(有长度帽,10-30 实测会忘 set_next_wake),不进人格(老装机拿不到)。
                description:
                  'Required. 1 to 3 items showing the todo is the user\'s own matter and that they want it (they asked for it or plainly showed it), and that doing it needs no choice made on their behalf. ' +
                  'These alone are not evidence: often reading about a topic does not mean they want to act on it; saying a screen looks bad does not authorize changing it; discussing a plan does not mean the plan is decided. ' +
                  'A watch rule the user set that fired is evidence in itself (kind "rule"). If you cannot cite anything, keep looking or drop the todo. ' +
                  'This bar is for proposing todos only; finished work still goes to the inbox as usual. ' +
                  'The app lists these on the card under "Evidence". Use absolute dates, not "today" (the card stays up for days).',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: [...MUSE_TODO_EVIDENCE_KINDS], description: 'chat = the user\'s own words; file; calendar; activity = an in-app or computer-history line; rule = a watch rule that fired; web; other' },
                    source: { type: 'string', description: 'Where you saw it, e.g. "You, in chat · 2026-11-20 10:12", a file path, "Calendar · Fri 2026-11-21 23:59"' },
                    quote: { type: 'string', description: `A short excerpt in the original wording, at most ${EVIDENCE_QUOTE_MAX} characters` },
                  },
                  required: ['source', 'quote'],
                },
              },
            },
            required: ['title', 'evidence'],
          },
        },
      },
      execute: async (args, ctx) => {
        const title = String(args.title || '').trim().slice(0, 200);
        if (!title) return 'Error: title 必填';
        const detail = String(args.detail || '').trim().slice(0, 4000);
        const evidence = normalizeEvidence(args.evidence);
        if (!evidence.length) return EVIDENCE_REQUIRED_ERROR; // 先于配额:被拒的不占这一时段的名额
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
            `INSERT INTO muse_todos (id, user_id, title, detail, status, source_session_id, evidence) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
            [id, ctx.userId, title, detail, ctx.sessionId, JSON.stringify(evidence)],
          );
          ledger.inc('daily_muse', 'todoCreated');
          noteMuseProduced('producedTodos');
          // 私聊投影(10-18 方案 B:待办在等用户点头,不是成品 → 进 Muse 私聊,不管日报档开没开)。失败不影响 TODO 本身;
          // 私聊不可用(没有 Muse 这个 agent 目录等)才退回收件箱。标题沿用模型原文 = 跟随用户语言,不硬编码文案。
          // 正文长度由构造封顶(detail ≤ 4000、标题 ≤ 200、围栏 ≤ 最长反引号串 + 1),照实传上限:截一个字就是半张卡。
          const body = todoMailBody({ id, title, detail });
          const dm = await postMuseDm(ctx.userId, body, 'proactive:todo').catch((e: any) => ({ ok: false as const, error: String(e?.message || e) }));
          if (!dm.ok) await sendInboxMessage(ctx.userId, { title, body, senderId: MUSE_SENDER_ID, maxBody: body.length }).catch(() => {});
          return `已记录 TODO：「${title}」（本时段还可提 ${Math.max(0, maxPerWindow - n - 1)} 条）。`;

        } catch (e: any) {
          return `Error: ${e?.message || e}`;
        }
      },
    },
  ],
};
