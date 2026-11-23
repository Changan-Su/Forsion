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
 * 过期:任务卡 7 天有效,记录多留一天(TTL 8 天,和客户端同一条);作品卡记录一直留。比较之前两边都先去掉过期的。
 * 封顶:只挤最旧的任务卡记录;作品卡记录挤不动就整次写拒掉(413),不悄悄丢。
 * 读不懂的存值条目(以后的版本写的)原样留着、照样写回去,不在这一版手里丢掉。
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
/** 存值:读得懂的是 CardMarkRecord;读不懂的条目(以后的版本加了新落点 / 新字段之类)原样保留,不解释、不丢。 */
export type StoredCardMarks = Record<string, unknown>;

/** 存值读不出来(非 NULL 却不是 JSON 对象)。路由按 500 报,**不**当空表往回写 —— 读失败 ≠ 没有记录。 */
export class CardMarksCorruptError extends Error {
  constructor() { super('card_marks is unreadable'); this.name = 'CardMarksCorruptError'; }
}
/** 读得懂的作品卡记录(一直留)已经超过封顶:不挤掉任何一条,整次写拒掉(路由回 413)。 */
export class CardMarksFullError extends Error {
  constructor() { super('too many card marks in this session'); this.name = 'CardMarksFullError'; }
}

const isCreationKey = (k: string): boolean => k.startsWith('creation:');

/** 列原值 → 存值表。NULL / undefined = 还没有记录(空表);PG 给对象、SQLite 给 JSON 串;根不是对象一律抛 CardMarksCorruptError。
 *  条目不在这里筛:读不懂的原样留着(新版本写的、这版不认识的落点),下次写时照样写回去。 */
export function parseStoredCardMarks(raw: unknown): StoredCardMarks {
  if (raw == null) return {};
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { throw new CardMarksCorruptError(); }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CardMarksCorruptError();
  return { ...(v as StoredCardMarks) };
}

/** 读得懂的一条存值(落点认识、t 是数);否则 null。 */
export function readableCardMark(v: unknown): CardMarkRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as { l?: unknown; t?: unknown };
  return typeof r.l === 'string' && LANDINGS.has(r.l) && typeof r.t === 'number' && Number.isFinite(r.t) ? (v as CardMarkRecord) : null;
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

/** 过期了没:任务卡记录(带数字 t)过了 TTL 算过期(卡本身也过期了);作品卡记录、看不出时刻的条目都不算过期。 */
export function cardMarkExpired(key: string, v: unknown, now: number): boolean {
  if (isCreationKey(key) || !v || typeof v !== 'object') return false;
  const t = (v as { t?: unknown }).t;
  return typeof t === 'number' && t <= now - CARD_MARK_TTL_MS;
}

/** 两条同键记录取哪条(见文件头):ignore 被真执行的换掉;其余留已有的。 */
export function pickCardMark(existing: CardMarkRecord | undefined, incoming: CardMarkRecord): CardMarkRecord {
  if (!existing) return incoming;
  if (existing.l === 'ignore' && incoming.l !== 'ignore') return incoming;
  return existing;
}

/** 按键并进存值(只加不减,除了过期 / 封顶)。两边都先去掉过期的再比(重新写出的同键卡不能被一条过期记录挡住)。
 *  已有的读不懂的条目原样留着,不被覆盖。返回新表,不改入参。 */
export function mergeCardMarks(stored: StoredCardMarks, incoming: CardMarks, now: number): StoredCardMarks {
  const out = liveCardMarks(stored, now);
  for (const [k, rec] of Object.entries(incoming)) {
    if (cardMarkExpired(k, rec, now)) continue;
    if (!(k in out)) { out[k] = rec; continue; }
    const have = readableCardMark(out[k]);
    if (have) out[k] = pickCardMark(have, rec);
  }
  return capCardMarks(out);
}

/** 封顶:超了只挤掉最旧的、读得懂的任务卡记录;作品卡记录和读不懂的条目不挤(挤掉 = 卡回到「等你」/ 丢数据),
 *  挤完还超就抛 CardMarksFullError(整次写不落)。 */
export function capCardMarks(marks: StoredCardMarks): StoredCardMarks {
  const keys = Object.keys(marks);
  if (keys.length <= CARD_MARKS_MAX) return marks;
  const tasks = keys
    .map((k) => [k, isCreationKey(k) ? null : readableCardMark(marks[k])] as const)
    .filter((e): e is readonly [string, CardMarkRecord] => !!e[1])
    .sort((a, b) => a[1].t - b[1].t);
  const drop = keys.length - CARD_MARKS_MAX;
  if (drop > tasks.length) throw new CardMarksFullError();
  const out = { ...marks };
  for (const [k] of tasks.slice(0, drop)) delete out[k];
  return out;
}

/** 去掉过期的任务卡记录(GET 回这个;写时先过一遍)。 */
export function liveCardMarks(marks: StoredCardMarks, now: number): StoredCardMarks {
  return Object.fromEntries(Object.entries(marks).filter(([k, v]) => !cardMarkExpired(k, v, now)));
}
