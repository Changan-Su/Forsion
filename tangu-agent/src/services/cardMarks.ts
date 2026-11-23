/**
 * 任务卡(```forsion-task)/ 作品卡(```forsion-creation)「处理过了」的记录,跟会话走(chat_sessions.card_marks)。
 *
 * 以前只记在各端自己的 localStorage:同一台引擎上的另一个客户端(手机 / 网页 / 另一台连过来的电脑)打开同一会话,
 * 卡又回到对话末尾的「N 件等你」,还能再执行一次。现在落在会话行上,客户端的 localStorage 只当缓存(并集)。
 *
 * 形状:{ <卡键>: { l: 落点, t: 记下的时刻(ms), c?: 开出的子会话 id } };卡键 = 客户端 doneKey 去掉「会话 id:」前缀
 * (`creation:<哈希>` / `todo:<id>` / `id:<id>` / `<内容哈希>`)。不进 agent_config:配置写口有整对象替换 / 按顶层键覆盖,
 * 会连带冲掉(与 title_manual 放独立列同一理由);也不进 SESSION_COLS,分支不抄 —— 与原来按会话 id 记的口径一致。
 *
 * 合并只加不减(按键):
 *   - 没有 → 收下;
 *   - 已有「不用了 / 忽略」(ignore),来的是真做了的落点 → 换成做了的(另一端同时点了忽略和执行,执行才是事实);
 *   - 其余一律留已有的(先到先得,保住先开出的子会话 id;「忽略」盖不掉已执行)。
 * 过期:任务卡 7 天有效,记录多留一天(TTL 8 天,和客户端同一条);作品卡记录一直留。条数封顶,先丢最旧的任务卡记录。
 */
import type { CardMarkRecord, CardMarkLanding } from '../contracts/clientTypes.js';

export const CARD_MARK_TTL_MS = 8 * 24 * 3600_000;
/** 一个会话最多留几条(真实会话一条回答最多几张卡,封顶只防坏客户端灌爆这一格)。 */
export const CARD_MARKS_MAX = 500;
/** 一次 POST 最多带几条(客户端补传本机老记录时分批)。 */
export const CARD_MARKS_BATCH_MAX = 200;
const KEY_MAX = 200;
const LANDINGS: ReadonlySet<string> = new Set<CardMarkLanding>(['child', 'here', 'new', 'muse', 'ignore']);
/** 子会话 id 是引擎生成的 UUID;只放宽到 id 常见字符,别的(含路径 / 控制符)一律不收。 */
const CHILD_RE = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type CardMarks = Record<string, CardMarkRecord>;

/** 存值读不出来(非 NULL 却不是 JSON 对象)。路由按 500 报,**不**当空表往回写 —— 读失败 ≠ 没有记录。 */
export class CardMarksCorruptError extends Error {
  constructor() { super('card_marks is unreadable'); this.name = 'CardMarksCorruptError'; }
}

const isCreationKey = (k: string): boolean => k.startsWith('creation:');

/** 列原值 → 记录表。NULL / undefined = 还没有记录(空表);PG 给对象、SQLite 给 JSON 串;别的形状一律抛 CardMarksCorruptError。
 *  表里单条坏记录(落点不认识之类)只跳过,不连累整表。 */
export function parseStoredCardMarks(raw: unknown, now: number): CardMarks {
  if (raw == null) return {};
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { throw new CardMarksCorruptError(); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CardMarksCorruptError();
  const out: CardMarks = {};
  for (const [k, rec] of Object.entries(v as Record<string, unknown>)) {
    const ok = cleanRecord(k, rec, now);
    if (ok) out[k] = ok;
  }
  return out;
}

/** 单条记录的校验 + 归一:不合格 → null。t 缺 / 非数 → now;比 now 还晚 → now(客户端钟快了不能让记录永不过期)。 */
function cleanRecord(key: string, rec: unknown, now: number): CardMarkRecord | null {
  if (typeof key !== 'string' || !key || key.length > KEY_MAX || CONTROL_RE.test(key)) return null;
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const r = rec as { l?: unknown; t?: unknown; c?: unknown };
  if (typeof r.l !== 'string' || !LANDINGS.has(r.l)) return null;
  const t = typeof r.t === 'number' && Number.isFinite(r.t) && r.t >= 0 ? Math.min(r.t, now) : now;
  const out: CardMarkRecord = { l: r.l as CardMarkLanding, t };
  if (typeof r.c === 'string' && CHILD_RE.test(r.c)) out.c = r.c;
  return out;
}

/** POST 体 → 要并进去的记录。体形状不对(marks 不是对象 / 条数超了)→ 字符串错误(路由回 400);
 *  单条不合格的跳过(客户端补传本机老记录时,一条坏的不能把整批卡住)。 */
export function readCardMarksBody(body: unknown, now: number): CardMarks | string {
  const marks = body && typeof body === 'object' && !Array.isArray(body) ? (body as { marks?: unknown }).marks : undefined;
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) return 'marks must be an object';
  const entries = Object.entries(marks as Record<string, unknown>);
  if (entries.length > CARD_MARKS_BATCH_MAX) return `at most ${CARD_MARKS_BATCH_MAX} marks per request`;
  const out: CardMarks = {};
  for (const [k, rec] of entries) {
    const ok = cleanRecord(k, rec, now);
    if (ok) out[k] = ok;
  }
  return out;
}

/** 一条记录还算不算数:任务卡过了 TTL 就不算(卡本身也过期了),作品卡记录一直算。 */
export function cardMarkLive(key: string, rec: CardMarkRecord, now: number): boolean {
  return isCreationKey(key) || rec.t > now - CARD_MARK_TTL_MS;
}

/** 两条同键记录取哪条(见文件头):ignore 被真执行的换掉;其余留已有的。 */
export function pickCardMark(existing: CardMarkRecord | undefined, incoming: CardMarkRecord): CardMarkRecord {
  if (!existing) return incoming;
  if (existing.l === 'ignore' && incoming.l !== 'ignore') return incoming;
  return existing;
}

/** 按键并进存值(只加不减,除了过期 / 封顶)。返回新表,不改入参。 */
export function mergeCardMarks(stored: CardMarks, incoming: CardMarks, now: number): CardMarks {
  const out: CardMarks = { ...stored };
  for (const [k, rec] of Object.entries(incoming)) out[k] = pickCardMark(out[k], rec);
  return pruneCardMarks(out, now);
}

/** 丢掉过期的任务卡记录;超过封顶再按时间丢最旧的(先任务卡,还超才动作品卡)。 */
export function pruneCardMarks(marks: CardMarks, now: number): CardMarks {
  const live = Object.entries(marks).filter(([k, r]) => cardMarkLive(k, r, now));
  if (live.length <= CARD_MARKS_MAX) return Object.fromEntries(live);
  const byAge = (a: [string, CardMarkRecord], b: [string, CardMarkRecord]): number => a[1].t - b[1].t;
  const tasks = live.filter(([k]) => !isCreationKey(k)).sort(byAge);
  const creations = live.filter(([k]) => isCreationKey(k)).sort(byAge);
  let drop = live.length - CARD_MARKS_MAX;
  const dropTasks = Math.min(drop, tasks.length);
  drop -= dropTasks;
  return Object.fromEntries([...tasks.slice(dropTasks), ...creations.slice(drop)]);
}

/** 给 GET 用:只回还算数的(不写回;清理在下一次写时顺带做)。 */
export function liveCardMarks(marks: CardMarks, now: number): CardMarks {
  return Object.fromEntries(Object.entries(marks).filter(([k, r]) => cardMarkLive(k, r, now)));
}
