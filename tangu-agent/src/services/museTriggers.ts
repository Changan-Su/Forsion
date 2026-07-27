/**
 * Muse 触发规则(watch)—— `~/.tangu/agents/muse/triggers.json`。
 *
 * 「帮我盯着 xxx.md 写满 100 字」「明早 9 点提醒我」由任意本地 agent 经 manage_automation 工具写成结构化规则;
 * muse.ts 的 supervisor tick(已有 5min 轮询)零 token 评估,命中才起 Muse 周期(kickoff 带触发说明)。
 * 五种条件:
 *   file_chars_gte —— 文件非空白字符数 ≥ n(粗粒度"写满 X 字");
 *   event_seen     —— lastFiredAt(或创建)之后的活动日志行含子串(数据源=userActivity);
 *   daily_at       —— 每天过 HH:MM **钉锚**触发(今天过点+今天未触+规则在锚点前已存在;停机跨天恢复补当天的);
 *   at / every     —— 一次性本地时刻 / 锚点算术滚动间隔(只补最近一次)。定时类不吃 cooldown gate。
 * lastFiredAt 只在 Muse 周期真正启动后写回——被预算/让位闸挡住不烧 cooldown。
 * 该文件不进云同步(agentFileSync 白名单不含它)、不影响 agent 名册缓存(dirStamp 只看 config/SOUL)。
 */
import { promises as fs } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path, { join } from 'node:path';
import os from 'node:os';
import { agentsDir } from '../core/tanguHome.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';

export type MuseTriggerCond =
  | { type: 'file_chars_gte'; path: string; n: number }
  | { type: 'event_seen'; match: string }
  | { type: 'daily_at'; time: string }
  /** 一次性定时(本地 'YYYY-MM-DDTHH:mm');触发后 markTriggersFired 自动 enabled=false,改期再启用即复用。 */
  | { type: 'at'; datetime: string }
  /** 周期定时(`\d+[mhd]`,锚=createdAt,复用日程「只补最近一次」语义;首触=锚+1 个间隔)。 */
  | { type: 'every'; interval: string };

const EVERY_RE = /^(\d+)([mhd])$/;
const EVERY_UNIT_MS = { m: 60_000, h: 3600_000, d: 86_400_000 } as const;
/** every 间隔毫秒;<15min 或 >365d → null。 */
export function parseEveryInterval(s: string): number | null {
  const m = EVERY_RE.exec(s);
  if (!m) return null;
  const ms = Number(m[1]) * EVERY_UNIT_MS[m[2] as 'm' | 'h' | 'd'];
  return ms >= 15 * 60_000 && ms <= 365 * 86_400_000 ? ms : null;
}

/** 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DDTHH:mm' → 本地 Date(手工拆分量,勿 Date.parse——UTC 午夜坑)。 */
export function parseLocalMinute(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 动作链步骤(services/automation.ts runActions 顺序执行,失败即停):
 *   notify    —— 直插收件箱(inbox_send 投递内核,0 token,享频控+通道转发);
 *   agent_run —— 现原语,无人值守 run(launchUnattendedRun);
 *   tool_call —— executeTool 定参直执行(0 token)。**只允许桌面构建器创建**(保存即人工预批;
 *                agent 经 manage_automation 只能建 notify/agent_run,堵"聊天 agent 自建 run_bash 自动化"提权链)。
 */
export type ActionSpec =
  | { type: 'notify'; title: string; body?: string }
  | { type: 'agent_run'; agentSlug: string; prompt: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> };

export const MAX_ACTIONS = 10;

function parseActionsInput(raw: unknown, allowToolCall: boolean):
  | { ok: true; value: ActionSpec[] | null | undefined }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined }; // 缺席=更新时保留旧值(防旧客户端整量 upsert 抹链)
  if (raw === null) return { ok: true, value: null }; // 显式清空(回到 agentSlug/Muse 旧语义)
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'actions 须为非空数组、null(清空)或省略(保留旧值)' };
  if (raw.length > MAX_ACTIONS) return { ok: false, error: `动作链最多 ${MAX_ACTIONS} 步` };
  const out: ActionSpec[] = [];
  for (const a of raw as any[]) {
    const type = String(a?.type || '');
    if (type === 'notify') {
      const title = String(a.title || '').trim().slice(0, 200);
      if (!title) return { ok: false, error: 'notify 步骤需要 title' };
      const body = String(a.body || '').trim().slice(0, 4000);
      out.push({ type: 'notify', title, body: body || undefined });
    } else if (type === 'agent_run') {
      const slug = String(a.agentSlug || a.agent_slug || '').trim();
      const prompt = String(a.prompt || '').trim().slice(0, 500);
      if (!slug || !prompt) return { ok: false, error: 'agent_run 步骤需要 agentSlug 和 prompt' };
      if (slug === MUSE_AGENT_SLUG) return { ok: false, error: 'agent_run 不能指向 muse(full-auto 会绕穿其 planMode 安全设计)' };
      out.push({ type: 'agent_run', agentSlug: slug, prompt });
    } else if (type === 'tool_call') {
      if (!allowToolCall) return { ok: false, error: 'tool_call 步骤只能在桌面自动化构建器里创建(需人工授权)' };
      const tool = String(a.tool || '').trim();
      if (!tool) return { ok: false, error: 'tool_call 步骤需要 tool' };
      const args = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? (a.args as Record<string, unknown>) : {};
      let size = 0;
      try { size = JSON.stringify(args).length; } catch { return { ok: false, error: 'tool_call 参数必须可 JSON 序列化' }; }
      if (size > 4096) return { ok: false, error: 'tool_call 参数过大(≤4KB)' };
      out.push({ type: 'tool_call', tool, args });
    } else {
      return { ok: false, error: 'action.type 须为 notify/agent_run/tool_call' };
    }
  }
  return { ok: true, value: out };
}

/** event_seen 消费游标:上次命中行的 12 位时间戳+内容 hash(分钟级时间戳区分不了同分钟的旧行)。 */
export interface EventCursor { ts: string; hash: string }

export interface MuseTrigger {
  id: string;
  /** 人话描述(面板/列表展示)。 */
  desc: string;
  cond: MuseTriggerCond;
  /** 命中时给 Muse 的附加指令(可空;英文最佳)。 */
  prompt?: string;
  /** 触发后的冷却(小时);期间不复触。 */
  cooldownHours: number;
  /** 上次真正触发 Muse 周期的时刻(ISO);null=从未。 */
  lastFiredAt: string | null;
  enabled: boolean;
  createdAt: string;
  /** 命中后由哪个 agent 执行(services/automation.ts 无人值守 run);缺省/'muse'=老路唤醒 Muse 周期。 */
  agentSlug?: string;
  /** event_seen 上次消费到的行游标(markTriggersFired 随 lastFiredAt 一并写回)。 */
  lastEventCursor?: EventCursor;
  /** 动作链(有则取代 agentSlug/Muse 旧语义;undefined=老路,兼容零迁移)。 */
  actions?: ActionSpec[];
}

export const triggersFile = (): string => join(agentsDir(), MUSE_AGENT_SLUG, 'triggers.json');

export async function loadTriggers(): Promise<MuseTrigger[]> {
  let raw: string;
  try {
    raw = await fs.readFile(triggersFile(), 'utf8');
  } catch {
    return []; // 无文件 → 空(manage_automation set 时重建)
  }
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => t && typeof t.id === 'string' && t.cond?.type) : [];
  } catch {
    // 损坏:先把原文挪去备份再空启——否则「读空→下次保存」会把整份规则静默抹成新文件。
    await fs.rename(triggersFile(), `${triggersFile()}.bad-${Date.now()}`).catch(() => {});
    return [];
  }
}

// 全部 read-modify-write 走同一条 promise 链:upsert/remove/markFired 都是整文件回写,
// 进程内并发交错(tick 评估写回 × HTTP/工具保存)会互相丢更新。
let writeChain: Promise<unknown> = Promise.resolve();
function withTriggersLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.then(() => undefined, () => undefined);
  return next;
}

export async function saveTriggers(list: MuseTrigger[]): Promise<void> {
  const dir = join(agentsDir(), MUSE_AGENT_SLUG);
  await fs.mkdir(dir, { recursive: true });
  // tmp+rename 原子落位:进程中途死掉不会留下半截 JSON。
  const tmp = join(dir, `.triggers.json.tmp-${process.pid}`);
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fs.rename(tmp, triggersFile());
}

export async function removeTrigger(id: string): Promise<boolean> {
  return withTriggersLock(async () => {
    const list = await loadTriggers();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) return false;
    await saveTriggers(next);
    return true;
  });
}

/** 触发后写回 lastFiredAt(仅在动作真正执行后调用);event_seen 规则一并写回消费游标。 */
export async function markTriggersFired(ids: string[], at = new Date(), cursors?: Record<string, EventCursor>): Promise<void> {
  if (!ids.length) return;
  await withTriggersLock(async () => {
    const list = await loadTriggers();
    const iso = at.toISOString();
    for (const t of list) {
      if (!ids.includes(t.id)) continue;
      t.lastFiredAt = iso;
      if (cursors?.[t.id]) t.lastEventCursor = cursors[t.id];
      if (t.cond?.type === 'at') t.enabled = false; // 一次性:触发即熄(留痕;改期+启用即复用)
    }
    await saveTriggers(list);
  });
}

export const MAX_TRIGGERS = 50;

function resolveTriggerPath(raw: string, cwd?: string): string {
  let p = raw.trim();
  if (p.startsWith('~/') || p === '~') p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd || process.cwd(), p);
}

/** 校验入参(manage_automation 工具与 HTTP 路由共用;snake_case 键对齐工具参数)。 */
export interface TriggerInput {
  id?: unknown;
  desc?: unknown;
  cond_type?: unknown;
  path?: unknown;
  n?: unknown;
  match?: unknown;
  time?: unknown;
  datetime?: unknown;
  interval?: unknown;
  prompt?: unknown;
  cooldown_hours?: unknown;
  agent_slug?: unknown;
  enabled?: unknown;
  actions?: unknown;
}

export interface ValidatedTrigger {
  desc: string;
  cond: MuseTriggerCond;
  prompt?: string;
  cooldownHours: number;
  agentSlug?: string;
  enabled: boolean;
  /** undefined=未提交(更新时保留旧值);null=显式清空;数组=设置。 */
  actions?: ActionSpec[] | null;
}

/**
 * 纯校验(不查 agent 名册——slug 存在性由调用方各自验,避免此模块依赖注册表加载)。
 * agentSlug 规则 cooldown 下限 1h:agent 自动运行会写 agent.edit 活动行,event_seen 匹配到
 * 自己改的文件会形成自激回路,冷却是唯一护栏。
 */
export function validateTriggerInput(input: TriggerInput, opts: { cwd?: string; allowToolCall?: boolean } = {}):
  | { ok: true; value: ValidatedTrigger }
  | { ok: false; error: string } {
  const desc = String(input.desc || '').trim().slice(0, 200);
  if (!desc) return { ok: false, error: 'desc 必填(一句人话描述盯什么)' };
  const condType = String(input.cond_type || '');
  let cond: MuseTriggerCond;
  if (condType === 'file_chars_gte') {
    const p = String(input.path || '').trim();
    const n = Math.floor(Number(input.n));
    if (!p || !Number.isFinite(n) || n <= 0) return { ok: false, error: 'file_chars_gte 需要 path 和正整数 n' };
    cond = { type: 'file_chars_gte', path: resolveTriggerPath(p, opts.cwd), n };
  } else if (condType === 'event_seen') {
    const match = String(input.match || '').trim().slice(0, 120);
    if (!match) return { ok: false, error: 'event_seen 需要 match 子串' };
    cond = { type: 'event_seen', match };
  } else if (condType === 'daily_at') {
    const time = String(input.time || '').trim();
    if (!/^\d{1,2}:\d{2}$/.test(time)) return { ok: false, error: 'daily_at 需要 time "HH:MM"' };
    cond = { type: 'daily_at', time };
  } else if (condType === 'at') {
    const raw = String(input.datetime || '').trim().replace(' ', 'T');
    const d = parseLocalMinute(raw);
    if (!d) return { ok: false, error: 'at 需要 datetime "YYYY-MM-DD HH:mm"(本地时区)' };
    if (d.getTime() < Date.now() - 5 * 60_000) return { ok: false, error: 'at 时刻已过去' };
    if (d.getTime() > Date.now() + 366 * 86_400_000) return { ok: false, error: 'at 最远一年内' };
    cond = { type: 'at', datetime: raw };
  } else if (condType === 'every') {
    const interval = String(input.interval || '').trim();
    if (!parseEveryInterval(interval)) return { ok: false, error: 'every 需要 interval 如 "30m"/"2h"/"1d"(≥15m ≤365d)' };
    cond = { type: 'every', interval };
  } else {
    return { ok: false, error: 'cond_type 须为 file_chars_gte/event_seen/daily_at/at/every' };
  }
  let agentSlug = String(input.agent_slug || '').trim() || undefined;
  if (agentSlug === MUSE_AGENT_SLUG) agentSlug = undefined; // 'muse' 归一为缺省=老路
  const pa = parseActionsInput(input.actions, !!opts.allowToolCall);
  if (!pa.ok) return pa;
  const actions = pa.value;
  if (actions?.length && agentSlug) return { ok: false, error: 'actions 与 agent_slug 互斥(动作链里用 agent_run 步骤指定执行者)' };
  // 含 LLM run 的规则(动作链 agent_run 或旧式 agentSlug)冷却下限 1h——自激回路唯一硬护栏;
  // 纯直执链(notify/tool_call)0 token,放宽到 15min。
  const hasLLM = !!agentSlug || !!actions?.some((a) => a.type === 'agent_run');
  const rawCd = Number(input.cooldown_hours);
  let cooldownHours = Number.isFinite(rawCd) && rawCd > 0 ? Math.min(24 * 30, rawCd) : 24;
  if (hasLLM) cooldownHours = Math.max(1, cooldownHours);
  else if (actions?.length) cooldownHours = Math.max(0.25, cooldownHours);
  if (cond.type === 'at' || cond.type === 'every' || cond.type === 'daily_at') {
    // 定时类自带节奏(at 一次性/every 锚点算术/daily_at 每日钉锚),cooldown 反而会吞触发
    // (如 every 30m × cooldown 24h;daily_at × 24h 会把"每天"吞成隔天)。evaluate 侧同款豁免兜存量。
    cooldownHours = 0;
    if (hasLLM && cond.type === 'every' && (parseEveryInterval(cond.interval) ?? 0) < 3600_000) {
      return { ok: false, error: 'agent 动作的 every 下限 1h(无人值守自激护栏)' };
    }
  }
  return {
    ok: true,
    value: {
      desc,
      cond,
      prompt: String(input.prompt || '').trim().slice(0, 500) || undefined,
      cooldownHours,
      agentSlug,
      enabled: input.enabled === undefined ? true : !!input.enabled,
      actions,
    },
  };
}

/**
 * upsert:带 id=更新(**保留 lastFiredAt/createdAt**,否则改个描述就重置 cooldown);无 id=新建(50 条帽)。
 * 例外:cond 实质变化=触发语义换了 → 重置触发状态(createdAt=now/lastFiredAt=null/游标清)——
 * 否则把长期规则的 daily_at 改到已过时刻会按旧 createdAt 立即补发;every 改间隔也应从改动时刻重新起算。
 */
export async function upsertTrigger(v: ValidatedTrigger, id?: string):
  Promise<{ ok: true; trigger: MuseTrigger; created: boolean } | { ok: false; error: string }> {
  return withTriggersLock(async () => {
    const list = await loadTriggers();
    if (id) {
      const cur = list.find((t) => t.id === id);
      if (!cur) return { ok: false as const, error: `未找到规则 ${id}` };
      if (JSON.stringify(cur.cond) !== JSON.stringify(v.cond)) {
        cur.createdAt = new Date().toISOString();
        cur.lastFiredAt = null;
        cur.lastEventCursor = undefined;
      }
      cur.desc = v.desc;
      cur.cond = v.cond;
      cur.prompt = v.prompt;
      cur.cooldownHours = v.cooldownHours;
      cur.agentSlug = v.agentSlug;
      cur.enabled = v.enabled;
      // actions 缺席=保留(旧客户端启停翻转是整量 upsert,不带此键——不加保留会把动作链抹掉,saveAgent 同款教训);
      // null=显式清空;数组=覆写。
      if (v.actions !== undefined) cur.actions = v.actions ?? undefined;
      await saveTriggers(list);
      return { ok: true as const, trigger: cur, created: false };
    }
    if (list.length >= MAX_TRIGGERS) return { ok: false as const, error: `规则已达上限(${MAX_TRIGGERS}),请先删除一些` };
    const rule: MuseTrigger = {
      id: `w-${randomUUID().slice(0, 6)}`,
      desc: v.desc,
      cond: v.cond,
      prompt: v.prompt,
      cooldownHours: v.cooldownHours,
      lastFiredAt: null,
      enabled: v.enabled,
      createdAt: new Date().toISOString(),
      agentSlug: v.agentSlug,
      actions: v.actions ?? undefined,
    };
    list.push(rule);
    await saveTriggers(list);
    return { ok: true as const, trigger: rule, created: true };
  });
}

/** 关停规则(tool_call 目标不可用等不可恢复错误时由执行器调用;用户在面板可再启用)。 */
export async function disableTrigger(id: string): Promise<void> {
  await withTriggersLock(async () => {
    const list = await loadTriggers();
    const t = list.find((x) => x.id === id);
    if (!t || !t.enabled) return;
    t.enabled = false;
    await saveTriggers(list);
  });
}

export interface EvaluateEnv {
  now?: Date;
  /** 活动日志行(event_seen 数据源;调用方给近窗口行,规则内再按 lastFiredAt 过滤)。 */
  activityLines?: string[];
  /** 文件非空白字符数;不存在/不可读 → null。测试可注入。 */
  readFileChars?: (path: string) => Promise<number | null>;
  /** 出参:event_seen 命中规则的新消费游标(调用方随 markTriggersFired 写回)。 */
  outCursors?: Record<string, EventCursor>;
}

/** 行内容 hash(游标用;截 12 位够区分同分钟内的不同行)。 */
function lineHash(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 12);
}

async function defaultReadFileChars(path: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    // ponytail: 全文非空白字符数(含 frontmatter/块标记),"写满 X 字"的粗粒度语义够用
    return raw.replace(/\s/g, '').length;
  } catch {
    return null;
  }
}

/** 行首 12 位本地时间戳(userActivity 格式)。 */
function lineTs(line: string): string {
  return line.slice(0, 12);
}

function toActivityTs(d: Date): string {
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 评估到期规则(纯读,不写回)。返回本轮命中的规则列表。 */
export async function evaluateTriggers(triggers: MuseTrigger[], env: EvaluateEnv = {}): Promise<MuseTrigger[]> {
  const now = env.now ?? new Date();
  const readChars = env.readFileChars ?? defaultReadFileChars;
  const lines = env.activityLines ?? [];
  const fired: MuseTrigger[] = [];
  for (const t of triggers) {
    if (!t.enabled) continue;
    const lastMs = t.lastFiredAt ? Date.parse(t.lastFiredAt) : 0;
    const c = t.cond;
    // cooldown 只约束事件/文件类;定时类自带时刻语义,gate 会吞触发
    // (存量规则可能带 cooldown=24 的 daily_at——validate 已改强制 0,这里兜旧数据)。
    const timed = c.type === 'daily_at' || c.type === 'at' || c.type === 'every';
    const cooldownMs = Math.max(0, Number(t.cooldownHours) || 0) * 3600_000;
    if (!timed && lastMs && now.getTime() - lastMs < cooldownMs) continue;
    try {
      if (c.type === 'file_chars_gte') {
        const chars = await readChars(c.path);
        if (chars !== null && chars >= c.n) fired.push(t);
      } else if (c.type === 'event_seen') {
        // 只看「上次触发(或规则创建)之后」的行——不吃存量旧事件。
        const sinceIso = t.lastFiredAt || t.createdAt || '';
        const since = sinceIso ? toActivityTs(new Date(sinceIso)) : '';
        const cur = t.lastEventCursor;
        const hits = lines.filter((l) => {
          if (!l.includes(c.match)) return false;
          if (since && lineTs(l) < since) return false;
          // 精确游标:since 是分钟粒度,冷却结束后同分钟旧行会被重复消费——按上次消费行的 ts+hash 排除。
          if (cur && (lineTs(l) < cur.ts || (lineTs(l) === cur.ts && lineHash(l) === cur.hash))) return false;
          // 自激防护:本规则自己的无人值守 run 产生的活动行带 o=<规则id>,不吃。
          if (l.includes(` o=${t.id}`)) return false;
          return true;
        });
        if (hits.length) {
          fired.push(t);
          const last = hits[hits.length - 1];
          if (env.outCursors) env.outCursors[t.id] = { ts: lineTs(last), hash: lineHash(last) };
        }
      } else if (c.type === 'daily_at') {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(c.time || ''));
        if (!m) continue;
        const due = new Date(now);
        due.setHours(Number(m[1]), Number(m[2]), 0, 0);
        // 钉锚:今天已过点、今天这个锚点还没触过、且规则在锚点前已存在。
        // (旧「距上次>20h」窗会让触发时刻按 lastFired 漂移;createdAt 闸防"晚上建每天早8点"当场补发。)
        const createdMs = Date.parse(t.createdAt || '') || 0;
        if (now >= due && lastMs < due.getTime() && createdMs < due.getTime()) fired.push(t);
      } else if (c.type === 'at') {
        const due = parseLocalMinute(c.datetime);
        // 一次性:过点且从未在点后触过(markTriggersFired 会顺手 enabled=false,这里的 lastMs 判断兜双保险)。
        if (due && now.getTime() >= due.getTime() && lastMs < due.getTime()) fired.push(t);
      } else if (c.type === 'every') {
        const ivl = parseEveryInterval(c.interval);
        const anchor = Date.parse(t.createdAt || '');
        if (!ivl || !Number.isFinite(anchor)) continue;
        const k = Math.floor((now.getTime() - anchor) / ivl);
        if (k < 1) continue; // 首触=锚+1 个间隔(创建当刻不触)
        const latest = anchor + k * ivl;
        // 与日程 repeat 同款:停机再久只补最近一次;时钟回拨时 latest≤last,静默等待。
        if (lastMs < latest) fired.push(t);
      }
    } catch { /* 单规则失败不阻断其余 */ }
  }
  return fired;
}

/** cond → 人读英文摘要(kickoff/automation message/工具回执共用单源)。 */
export function condSummary(c: MuseTriggerCond): string {
  switch (c.type) {
    case 'file_chars_gte': return `file ${c.path} reached ${c.n}+ non-whitespace chars`;
    case 'event_seen': return `activity matched "${c.match}"`;
    case 'daily_at': return `daily at ${c.time}`;
    case 'at': return `at ${c.datetime.replace('T', ' ')}`;
    case 'every': return `every ${c.interval}`;
    default: return 'unknown condition';
  }
}

/**
 * 下一次应触时刻(服务端权威计算,GET triggers 附给桌面展示;事件/文件类无时刻概念 → null)。
 * 展示语义:at=锚点(过点未触也返回它,下个 tick 就补);every=锚点算术的下一格;daily_at=今天/明天的 HH:MM。
 */
export function nextRunAt(t: MuseTrigger, from: Date = new Date()): string | null {
  if (!t.enabled) return null;
  const c = t.cond;
  if (c.type === 'at') {
    const due = parseLocalMinute(c.datetime);
    return due ? due.toISOString() : null;
  }
  if (c.type === 'every') {
    const ivl = parseEveryInterval(c.interval);
    const anchor = Date.parse(t.createdAt || '');
    if (!ivl || !Number.isFinite(anchor)) return null;
    const k = Math.floor((from.getTime() - anchor) / ivl);
    const latest = anchor + Math.max(1, k) * ivl;
    const lastMs = t.lastFiredAt ? Date.parse(t.lastFiredAt) : 0;
    // 有欠账(latest 未触)→ 下个 tick 就补,报 latest;否则报下一格。
    return new Date(k >= 1 && lastMs < latest ? latest : anchor + (Math.max(1, k) + 1) * ivl).toISOString();
  }
  if (c.type === 'daily_at') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(c.time || ''));
    if (!m) return null;
    const due = new Date(from);
    due.setHours(Number(m[1]), Number(m[2]), 0, 0);
    const lastMs = t.lastFiredAt ? Date.parse(t.lastFiredAt) : 0;
    const createdMs = Date.parse(t.createdAt || '') || 0;
    // 与 evaluate 钉锚同判:今天的锚点还欠着 → 就是"现在";否则明天。
    if (from >= due && lastMs < due.getTime() && createdMs < due.getTime()) return due.toISOString();
    if (from >= due) due.setDate(due.getDate() + 1);
    return due.toISOString();
  }
  return null;
}

/** 命中规则 → Muse kickoff 附加段(英文,进模型)。 */
export function buildTriggerKickoff(fired: MuseTrigger[]): string {
  if (!fired.length) return '';
  const lines = fired.slice(0, 5).map((t) => `- ${t.desc} (${condSummary(t.cond)})${t.prompt ? ` — ${t.prompt}` : ''}`);
  return (
    '\n\n[Watch triggers fired this cycle — the user explicitly asked to be told about these; handle them FIRST via add_muse_todo]\n' +
    lines.join('\n')
  );
}
