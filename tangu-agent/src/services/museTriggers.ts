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
import { dropCursors, CURSOR_V, type DbCursor } from './dbCursors.js';
import type { CellValue, DbColumn, DbFile, DbRow } from './amadeusDb.js';
import { computeRowLookups, isBackLookup } from './dbLookup.js';
import { evalRowFormulas } from './dbFormula.js';

export type MuseTriggerCond =
  | { type: 'file_chars_gte'; path: string; n: number }
  | { type: 'event_seen'; match: string }
  | { type: 'daily_at'; time: string }
  /** 一次性定时(本地 'YYYY-MM-DDTHH:mm');触发后 markTriggersFired 自动 enabled=false,改期再启用即复用。 */
  | { type: 'at'; datetime: string }
  /** 周期定时(`\d+[mhd]`,锚=createdAt,复用日程「只补最近一次」语义;首触=锚+1 个间隔)。 */
  | { type: 'every'; interval: string }
  /**
   * 手动:**永不自动触发**,只能被 fire 端点点起来(Amadeus 按钮块 / 面板试跑)。
   * 存在的意义是信任模型:笔记里的按钮块只存 triggerId,不存可执行的动作——
   * 内联 actions 等于「一篇同步来的笔记可以凭内容发明一个 full-auto agent 的启动权」。
   * 规则本体必须先经人工在构建器里保存(=预批准),按钮只能引用它。
   */
  | { type: 'manual' }
  /**
   * Amadeus 多维表变化(对标 Notion 的 database automation)。
   * `vault` 是**当时那个 vault 的绝对路径**:规则文件是全局的,而 `path` 是库内相对路径,
   * 不钉住 vault 的话切库之后同一条规则会静默作用到另一个库里同名的表(codex 抓的)。
   * `columnId` 存**列 id 不存列名** —— 列名既不唯一也随时能改。
   * 语义诚实:靠巡检比对快照,所以「加完又删」「改走又改回」这两种在两次检查之间自己抵消掉的变化,
   * 是看不见的。要真正的逐次变更需要结构化变更流水,那是另一件事。
   */
  | {
      type: 'db_changed';
      /** vault 相对路径,如 `任务.db`。 */
      path: string;
      /** 建规则时的 vault 根绝对路径;与当前 vault 不符 → 不评估(见 evaluate)。 */
      vault: string;
      event: 'row_added' | 'cell_changed';
      /** cell_changed 必填:被盯那列的 id(多列时 = columnIds[0],老读端仍能拿到一列)。 */
      columnId?: string;
      /** cell_changed 可选:同时盯多列,**任一列变化即命中**(飞书一条规则盯两列的对齐项)。
       *  校验层归一:去重、排序、≥2 列才落此键(单列只落 columnId,存量规则与游标零迁移);
       *  读端一律经 watchedCols() 取 columnIds ∪ columnId,别直接读任一键。 */
      columnIds?: string[];
      /** cell_changed 可选:只有变成这个值才算数(空=任意变化都算)。 */
      equals?: string;
      /** 附加条件(与 equals AND;row_added / cell_changed 都可用),比的是**物化后**的模板字符串值(rowVars)。 */
      where?: DbWhere[];
    };

/** db_changed 的附加条件一条:column = 列 id 或列名;eq/ne 要 value,empty/notempty 不要。
 *  比对的是行的模板字符串图(rowVars):数组列(多选/多选关联)是 `'a, b'` 形,eq 要按这个写。
 *  评估前 column 先按当前 schema 解析成列 id(resolveLikeColumn:先 id,再列名 trim+lowercase;两列同名=二义=错),
 *  解析不到 → 规则错误,本轮整条跳过、不推游标(否则 empty/ne 失败开放、eq/notempty 静默拒绝并吞掉事件)。 */
export interface DbWhere {
  column: string;
  op: 'eq' | 'ne' | 'empty' | 'notempty';
  value?: string;
}
export const DB_WHERE_OPS: DbWhere['op'][] = ['eq', 'ne', 'empty', 'notempty'];
/** 一条 where 对一行(物化后的字符串图,列 id 与列名两种键都在)是否成立。 */
export function whereHolds(w: DbWhere, vars: Record<string, string>): boolean {
  const v = Object.hasOwn(vars, w.column) ? vars[w.column] : '';
  switch (w.op) {
    case 'eq': return v === String(w.value ?? '');
    case 'ne': return v !== String(w.value ?? '');
    case 'empty': return v.trim() === '';
    case 'notempty': return v.trim() !== '';
    default: return false;
  }
}

/** vault 相对路径归一:反斜杠→斜杠、去首尾斜杠、压掉 `./` 与重复斜杠。
 *  自激防线按路径**字符串**比对规则与动作,`Tasks.db` 与 `./Tasks.db` 指同一文件却比不上 → 防线失效。 */
export function normalizeVaultRel(raw: string): string {
  const parts = String(raw || '').trim().replace(/\\/g, '/').split('/');
  return parts.filter((seg) => seg !== '' && seg !== '.').join('/');
}

/**
 * 两个 vault 根路径算不算同一个库(H3,2026-09-02)。
 * 只做**温和归一**:trim、反斜杠→正斜杠、去掉尾部斜杠,然后逐字比。
 * ⚠️ 刻意**不做** realpath / stat 这类 IO —— 它会阻塞、会抛、在网络盘/权限异常时把「评估」变成「可能失败的 IO」,
 * 而这是每 tick 每规则都要过的闸。软链、`/tmp` vs `/private/tmp`、大小写不敏感文件系统这些仍然认不出来 ——
 * 那正是 H3 要求「不符时给可见信号而不是静默 continue」的原因:认不出来时,至少让用户看见「钉的是 X、当前是 Y」。
 */
export function sameVault(a: string | undefined, b: string | undefined): boolean {
  const norm = (x: string | undefined): string => String(x || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

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
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  /**
   * Amadeus 多维表写入(对标 Notion 的 Add page to… / Edit property…)。
   * `cells` 的键 = 列 id(优先)或列名,值 = 模板字符串(`{{row.X}}` 允许插值 —— 白名单里只有
   * notify 文本与这里的单元格值)。`rowId` 缺省 = 触发上下文里那一行(cell_changed/row_added 命中的行)。
   * 列找不到 = **失败即停**,绝不"报成功但什么也没改"(setNamedProps 那种静默跳过在自动化里是数据事故)。
   * `skipIfEmpty` = cells 里的一个键:该值展开后为空 → 本步跳过(记 skipped,不算失败)。
   *   // ponytail: 代替飞书「先建 16 行再清理」的两条规则
   * `db_row_edit` 目标行的三档(互斥优先级 rowId > rowFrom > match > 触发行):
   *   rowFrom —— 触发行的关联列(列 id 或列名),cell 为 string = 一行、string[] = 逐行,每行各自 `{{target.X}}`;
   *   match   —— `{ column, value }`:目标表里 column == value(value 可模板,典型 `{{row.id}}`)的**全部**行。
   * 与 automationTemplate.ts 头部不变量一致:目标由**列**(schema)定,数据只决定指向哪几行,路径永远不插值。
   */
  | { type: 'db_row_add'; path: string; cells: Record<string, string>; skipIfEmpty?: string }
  | {
      type: 'db_row_edit';
      path: string;
      rowId?: string;
      rowFrom?: string;
      match?: { column: string; value: string };
      cells: Record<string, string>;
    };

/** 动作链步数上限。10 → 24:ERP 捆绑包「订单 row_added → 出库 db_row_add × 16 槽位」一条链要 16 步。 */
export const MAX_ACTIONS = 24;

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
    } else if (type === 'db_row_add' || type === 'db_row_edit') {
      const p = normalizeVaultRel(String(a.path || ''));
      if (!p || !/\.db$/i.test(p) || p.split('/').includes('..')) return { ok: false, error: `${type} 需要 path(vault 相对的 .db 文件)` };
      const raw = a.cells;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${type} 需要 cells 对象(列 id/列名 → 值)` };
      const cells: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = String(k).trim();
        if (!key) continue;
        cells[key] = String(v ?? '').slice(0, 2000);
      }
      if (!Object.keys(cells).length) return { ok: false, error: `${type} 的 cells 不能为空` };
      const short = (v: unknown): string => String(v ?? '').trim().slice(0, 200);
      if (type === 'db_row_add') {
        const skipIfEmpty = short(a.skipIfEmpty) || undefined;
        // 键必须真的在 cells 里:写错键名会让每一行都被静默跳过,那比 400 糟得多。
        if (skipIfEmpty && !Object.hasOwn(cells, skipIfEmpty)) return { ok: false, error: `skipIfEmpty 的键 "${skipIfEmpty}" 不在 cells 里` };
        out.push({ type: 'db_row_add', path: p, cells, ...(skipIfEmpty ? { skipIfEmpty } : {}) });
      } else {
        const rowFrom = short(a.rowFrom) || undefined;
        let match: { column: string; value: string } | undefined;
        if (a.match !== undefined && a.match !== null) {
          const m = a.match;
          const column = m && typeof m === 'object' ? short(m.column) : '';
          if (!column) return { ok: false, error: 'db_row_edit 的 match 需要 column(列 id/列名)' };
          match = { column, value: String(m.value ?? '').slice(0, 2000) };
        }
        out.push({
          type: 'db_row_edit', path: p, rowId: String(a.rowId || '').trim() || undefined,
          ...(rowFrom ? { rowFrom } : {}), ...(match ? { match } : {}), cells,
        });
      }
    } else {
      return { ok: false, error: 'action.type 须为 notify/agent_run/tool_call/db_row_add/db_row_edit' };
    }
  }
  return { ok: true, value: out };
}

/** event_seen 消费游标:上次命中行的 12 位时间戳+内容 hash(分钟级时间戳区分不了同分钟的旧行)。 */
export interface EventCursor { ts: string; hash: string }

/** 停用来源(见 MuseTrigger.disabledBy)。 */
export type TriggerDisabledBy = 'engine' | 'user';
/** upsert 的调用来源:'user'=人/agent 显式操作;'plugin-ensure'=插件 ctx.automation.ensure 的幂等重放。
 *  缺省(老客户端 / pluginStore 的插件生命周期停用)= 既不算显式也不算重放。
 *
 *  ⚠️ **边界声明(第四轮)**:这是 HTTP body 里的**自报**字段,不是从鉴权主体推导出来的能力 —— 任何拿得到
 *  引擎 token 的渲染进程代码都能发 `actor:'user'` 来松开断环刹车。它防的是「插件生命周期的幂等重放」这条
 *  **机器**路径(桌面侧 pluginAutomation.ts 重建 payload 时统一打 'plugin-ensure'),不是恶意调用方;
 *  真要强制,得让引擎按 token 的来源(插件 host 通道 vs 用户面板)自己判定,那是另一轮的活。
 *  缺省值刻意选「不算重放」= 放行:老客户端与 pluginStore 的逐条停用都不带 actor,若缺省按 'plugin-ensure'
 *  处理,「用户重新启用插件 → 规则复活」这条既有生命周期会当场断掉。宁可默认放行,也不默认冻死。 */
export type UpsertActor = 'user' | 'plugin-ensure';

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
  /** 被执行器自动停用的原因(自动化环 / tool_call 目标不可用);用户重新启用时清掉。 */
  disabledReason?: string;
  /**
   * **谁**把它关的(H1,2026-09-02)。
   *   'engine' —— 引擎自动停用:排空封顶断环、评估侧配置性错误、tool_call 目标不可用。
   *   'user'   —— 用户/agent **显式**停用(面板开关、构建器保存、manage_automation)。
   *   缺席     —— 没人认领:插件生命周期停用(pluginStore 禁用插件时逐条关,靠该插件下次 ensure 开回来)、
   *               `at` 规则触发自灭。
   *               ⚠️ **升级前的存量停用不算「没人认领」**:那时没有这一位,但引擎停用会留下 disabledReason,
   *               判据统一走 `effectiveDisabledBy()`(P1-2)—— 直接读裸 `disabledBy` 会把存量刹车判成可松开。
   * 存在的意义:插件每次 setup 都 `ctx.automation.ensure` **幂等重放**全部规则,从前那条重放无条件写
   * `enabled:true` —— 引擎按排空封顶拉下的断环刹车(原因写着「请检查规则后手动启用」)下次开 App 就自己松了,
   * `disabledReason` 还被顺手抹掉、游标一并重播种,证据与信号一起没。有了这一位,ensure 的重放只开
   * 「没人认领」的那种(= 插件自己关的),`engine`/`user` 的停用**只有用户显式启用才松**。
   */
  disabledBy?: TriggerDisabledBy;
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
  event?: unknown;
  vault?: unknown;
  column_id?: unknown;
  /** db_changed + cell_changed:多列监听(与 column_id 取并集;任一变化即命中)。 */
  column_ids?: unknown;
  equals?: unknown;
  /** db_changed:附加条件数组(见 DbWhere);snake_case 入参里本键无需改名。 */
  where?: unknown;
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

const MAX_WHERE = 10;
/** where 入参:缺席/null → 无;数组 → 逐条校验(≤10 条,column 非空 ≤200,op 白名单,eq/ne 的 value ≤200)。 */
function parseWhereInput(raw: unknown): { ok: true; value: DbWhere[] | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'where 须为数组' };
  if (!raw.length) return { ok: true, value: undefined }; // 空数组视同没有(否则 cond 每次「变化」重置游标)
  if (raw.length > MAX_WHERE) return { ok: false, error: `where 最多 ${MAX_WHERE} 条` };
  const out: DbWhere[] = [];
  for (const w of raw as any[]) {
    const column = String(w?.column ?? '').trim().slice(0, 200);
    const op = String(w?.op ?? '') as DbWhere['op'];
    if (!column) return { ok: false, error: 'where 每条需要 column(列 id/列名)' };
    if (!DB_WHERE_OPS.includes(op)) return { ok: false, error: `where 的 op 须为 ${DB_WHERE_OPS.join('/')}` };
    if (op === 'eq' || op === 'ne') out.push({ column, op, value: String(w?.value ?? '').slice(0, 200) });
    else out.push({ column, op });
  }
  return { ok: true, value: out };
}

/** cell_changed 监听列上限(与 where 同档;一条规则盯整张表不是「监听」是「轮询」)。 */
export const MAX_WATCH_COLS = 10;
/** column_id + column_ids → 归一列 id 列表:trim、去空、去重、**排序**(upsert/路由按 JSON 比对 cond,
 *  桌面勾选顺序不同的同一集合若不排序会被当成 cond 变了 → 平白丢游标重播种)。 */
function parseColumnIds(single: unknown, multi: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (multi !== undefined && multi !== null && !Array.isArray(multi)) return { ok: false, error: 'column_ids 须为列 id 数组' };
  const raw = [single, ...((multi as unknown[] | null | undefined) ?? [])];
  const out: string[] = [];
  for (const x of raw) {
    const id = String(x ?? '').trim().slice(0, 200);
    if (id && !out.includes(id)) out.push(id);
  }
  if (!out.length) return { ok: false, error: 'cell_changed 需要 column_id 或 column_ids(列 id,不是列名——列随时能改名)' };
  if (out.length > MAX_WATCH_COLS) return { ok: false, error: `column_ids 最多 ${MAX_WATCH_COLS} 列` };
  out.sort();
  return { ok: true, value: out };
}

/**
 * 纯校验(不查 agent 名册——slug 存在性由调用方各自验,避免此模块依赖注册表加载)。
 * agentSlug 规则 cooldown 下限 1h:agent 自动运行会写 agent.edit 活动行,event_seen 匹配到
 * 自己改的文件会形成自激回路,冷却是唯一护栏。
 */
export function validateTriggerInput(input: TriggerInput, opts: { cwd?: string; allowToolCall?: boolean; vaultPath?: string } = {}):
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
  } else if (condType === 'manual') {
    cond = { type: 'manual' };
  } else if (condType === 'db_changed') {
    const p = normalizeVaultRel(String(input.path || ''));
    if (!p || !/\.db$/i.test(p)) return { ok: false, error: 'db_changed 需要 path(vault 相对的 .db 文件)' };
    if (p.split('/').includes('..')) return { ok: false, error: 'db_changed 的 path 不能越出 vault' };
    const event = String(input.event || '');
    if (event !== 'row_added' && event !== 'cell_changed') return { ok: false, error: 'db_changed 的 event 须为 row_added/cell_changed' };
    const vault = String(input.vault || '').trim() || opts.vaultPath || '';
    if (!vault) return { ok: false, error: 'db_changed 需要 vault(建规则时的库根路径)' };
    const pw = parseWhereInput(input.where);
    if (!pw.ok) return pw;
    const whereExtra = pw.value ? { where: pw.value } : {};
    if (event === 'cell_changed') {
      const pc = parseColumnIds(input.column_id, input.column_ids);
      if (!pc.ok) return pc;
      const ids = pc.value;
      const equals = String(input.equals ?? '').trim().slice(0, 200);
      // 单列只落 columnId(存量形状不变);多列 columnId=首列 + columnIds=全部。
      cond = {
        type: 'db_changed', path: p, vault, event, columnId: ids[0],
        ...(ids.length > 1 ? { columnIds: ids } : {}),
        equals: equals || undefined, ...whereExtra,
      };
    } else {
      cond = { type: 'db_changed', path: p, vault, event, ...whereExtra };
    }
  } else {
    return { ok: false, error: 'cond_type 须为 file_chars_gte/event_seen/daily_at/at/every/manual/db_changed' };
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
  // db_changed 纯动作链(0 token,逐行事件):默认 0、下限 0(与 manual 同档)——它是按行触发的,
  // 冷却只会把「加了 3 行」吞成「每天处理 1 行」。显式传 0 必须认(`>= 0`,否则回落 24)。
  const pureDbChain = cond.type === 'db_changed' && !hasLLM && !!actions?.length;
  let cooldownHours = pureDbChain
    ? (Number.isFinite(rawCd) && rawCd >= 0 ? Math.min(24 * 30, rawCd) : 0)
    : (Number.isFinite(rawCd) && rawCd > 0 ? Math.min(24 * 30, rawCd) : 24);
  if (hasLLM) cooldownHours = Math.max(1, cooldownHours);
  else if (actions?.length && !pureDbChain) cooldownHours = Math.max(0.25, cooldownHours);
  if (cond.type === 'manual') {
    // 用户点一次跑一次;冷却会把第二次点击静默吞成「没反应」。防重入由服务端单飞锁负责,不是冷却。
    cooldownHours = 0;
  } else if (cond.type === 'at' || cond.type === 'every' || cond.type === 'daily_at') {
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
 * 「谁把它关的」的**有效**取值:`disabledBy` 缺席但 `disabledReason` 有值 = 升级前(2026-09-02 之前)
 * 由引擎停用的存量规则 —— 那时还没有 disabledBy 这一位,但 disabledReason 只有引擎写得出来。
 * 判据写在这里而不是内联,是因为读端(blockedEnable)与将来任何「这条刹车谁能松」的判断必须同一口径。
 * 只读推导,**不回填字段**:回填要整文件落盘一次,而存量形状本来就该在用户显式启用时被清掉。
 */
export function effectiveDisabledBy(t: Pick<MuseTrigger, 'disabledBy' | 'disabledReason'>): TriggerDisabledBy | undefined {
  return t.disabledBy ?? (t.disabledReason ? 'engine' : undefined);
}

/** 插件种子规则的 id 形态:`plugin:<插件id>:<key>`,两段都只许 [a-z0-9-]。 */
export const PLUGIN_TRIGGER_ID_RE = /^plugin:[a-z0-9-]+:[a-z0-9-]+$/;
export const isPluginTriggerId = (id: string): boolean => id.startsWith('plugin:');

/**
 * upsert:带 id=更新(**保留 lastFiredAt/createdAt**,否则改个描述就重置 cooldown);无 id=新建(50 条帽)。
 * 例外:cond 实质变化=触发语义换了 → 重置触发状态(createdAt=now/lastFiredAt=null/游标清)——
 * 否则把长期规则的 daily_at 改到已过时刻会按旧 createdAt 立即补发;every 改间隔也应从改动时刻重新起算。
 *
 * `allowPluginCreate`:带 id 但不存在时,id 合乎 PLUGIN_TRIGGER_ID_RE 就按该 id 新建(插件 ensure 的幂等种子)。
 * **只有 HTTP 路由传 true**;manage_automation 工具不传——否则聊天 agent 能凭空造出伪装成插件的规则,
 * 还绕过 50 条帽(这条路照样过 MAX_TRIGGERS)。
 */
export async function upsertTrigger(v: ValidatedTrigger, id?: string, opts: { allowPluginCreate?: boolean; actor?: UpsertActor } = {}):
  Promise<{ ok: true; trigger: MuseTrigger; created: boolean } | { ok: false; error: string }> {
  return withTriggersLock(async () => {
    const list = await loadTriggers();
    const cur = id ? list.find((t) => t.id === id) : undefined;
    if (id && !cur) {
      if (!opts.allowPluginCreate || !isPluginTriggerId(id)) return { ok: false as const, error: `未找到规则 ${id}` };
      if (!PLUGIN_TRIGGER_ID_RE.test(id)) return { ok: false as const, error: `插件规则 id 形态须为 plugin:<插件id>:<key>(小写字母/数字/连字符):${id}` };
    }
    if (cur) {
      const condChanged = JSON.stringify(cur.cond) !== JSON.stringify(v.cond);
      // 停用 → 启用:停用期间攒下的全部变更**不能**在重新启用后的第一个 tick 一次引爆动作链。
      // **与规则来源无关**(从前只保护插件规则,而用户规则、以及 drain 排空封顶自动停用的规则都没保护:
      // 撞顶被停 → 用户手动启用 → 同一批积压重新跑满 → 再次撞顶 → 再次停用 = 「启用即再爆」的循环)。
      // H1(2026-09-02):插件 ensure 是**幂等重放**(每次开 App / 重载插件都把全部规则原样再发一遍),
      // 不是一次用户意图。引擎自动停用(disabledBy='engine':排空封顶断环 / 配置错误)与用户显式停用
      // (disabledBy='user')都不许被这种重放开回来 —— 否则安全闸是摆设:撞顶被停 → 下次启动开回 →
      // 再撞顶 → 再停,且 disabledReason 每次都被抹掉,用户永远看不见它曾被停、为什么停。
      // 「没人认领」的停用(disabledBy 缺席 = pluginStore 禁用插件时逐条关的)照旧开回来 ——
      // 那正是「用户重新启用插件 → 它的 setup 再 ensure 一次 → 规则复活」这条既有生命周期。
      // ⚠️ P1-2(第四轮,2026-09-02):判据不能只看 `disabledBy` —— **升级前**被引擎停用的规则形状是
      // 「enabled:false + disabledReason 有值 + disabledBy 缺席」,按上一版判据算「没人认领」,第一次插件
      // ensure 幂等重放就把断环刹车松开、disabledReason 一并抹掉:H1 要防的那件事对**每个既有安装**仍成立一次。
      // `disabledReason` 全仓只有引擎的三个入口写(disableTrigger / disableTriggers / disableTriggersWithReasons),
      // 所以「有 disabledReason 而无 disabledBy」是可靠的「升级前引擎停用」签名 —— 见 effectiveDisabledBy。
      const blockedEnable = opts.actor === 'plugin-ensure' && v.enabled && !cur.enabled && !!effectiveDisabledBy(cur);
      const wasEnabled = cur.enabled;
      const reEnabled = !cur.enabled && v.enabled && !blockedEnable;
      if (condChanged) {
        cur.createdAt = new Date().toISOString();
        cur.lastFiredAt = null;
        cur.lastEventCursor = undefined;
      }
      // db 快照游标作废,**真源在这儿**(从前 enabled 那条分支在 HTTP 路由里、且跑在 saveTriggers 之后:
      // 规则先上线、游标后清,中间任何一次 evaluate 都会把积压打出去)。
      // 归一已排序(parseColumnIds),勾选顺序不同不算 cond 变化,不会平白丢游标。
      // 落盘不进 triggers.json 事务:dropCursors 走 dbCursors 自己的锁链(两条链互不嵌套,不会死锁);
      // **先清游标再存规则** —— 反过来的话中途崩溃会留下「新 cond + 旧游标」这一种最坏组合。
      // 这一步只是快速路径:真正与时序无关的防线是读端的 cursorMismatch(drain 的 setCursors 会把
      // 刚删掉的键合并写回,这里删不干净;换表那类身份变化由游标自证兜住)。
      if (condChanged || reEnabled) await dropCursors([cur.id]).catch(() => {});
      cur.desc = v.desc;
      cur.cond = v.cond;
      cur.prompt = v.prompt;
      cur.cooldownHours = v.cooldownHours;
      cur.agentSlug = v.agentSlug;
      // ⚠️ blockedEnable:enabled / disabledReason / disabledBy **一个都不动**(证据要稳定可见);
      // desc/cond/actions/cooldown 照常更新 —— 插件升级、改规则仍然生效,只是不会自己把闸推上去。
      if (!blockedEnable) {
        cur.enabled = v.enabled;
        if (v.enabled) {
          delete cur.disabledReason; // 显式启用 = 已检查过,停用原因与来源一并作废
          delete cur.disabledBy;
        } else if (wasEnabled) {
          // 只在**真的从启用翻成停用**时记来源:已停用的规则被整量重存(构建器保存 editing.enabled=false)
          // 不许把先前的 'engine' 覆盖掉,否则一次无意义的保存就把断环刹车降级成「没人认领」。
          if (opts.actor === 'user') cur.disabledBy = 'user';
          else delete cur.disabledBy;
        }
      }
      // actions 缺席=保留(旧客户端启停翻转是整量 upsert,不带此键——不加保留会把动作链抹掉,saveAgent 同款教训);
      // null=显式清空;数组=覆写。
      if (v.actions !== undefined) cur.actions = v.actions ?? undefined;
      await saveTriggers(list);
      return { ok: true as const, trigger: cur, created: false };
    }
    if (list.length >= MAX_TRIGGERS) return { ok: false as const, error: `规则已达上限(${MAX_TRIGGERS}),请先删除一些` };
    const newId = id || `w-${randomUUID().slice(0, 6)}`;
    // 新建也清:带 id 新建(插件 ensure 的幂等种子)可能撞上同 id 旧规则留下的游标 —— 同表同事件时
    // 读端自证认不出「换了一条规则」,会拿上一条的基线当自己的,把规则缺席期间的积压一次打出去。
    await dropCursors([newId]).catch(() => {});
    const rule: MuseTrigger = {
      id: newId,
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

/** 关停规则(tool_call 目标不可用 / 自动化环等不可恢复错误时由执行器调用;用户在面板可再启用)。
 *  `reason` 写进 disabledReason(面板展示「为什么停了」;重新启用时 upsertTrigger 清掉)。 */
export async function disableTrigger(id: string, reason?: string): Promise<void> {
  await disableTriggers([id], reason);
}

/** 批量关停(drain cap 命中时一次停一批,整文件只写一次)。 */
export async function disableTriggers(ids: string[], reason?: string): Promise<void> {
  if (!ids.length) return;
  await withTriggersLock(async () => {
    const list = await loadTriggers();
    let hit = false;
    for (const t of list) {
      if (!ids.includes(t.id) || !t.enabled) continue;
      t.enabled = false;
      t.disabledBy = 'engine'; // 引擎拉的刹车:插件 ensure 的幂等重放不许把它松开(H1)
      if (reason) t.disabledReason = reason.slice(0, 500);
      hit = true;
    }
    if (hit) await saveTriggers(list);
  });
}

/** 逐条原因不同的批量停用(评估侧的配置性错误:每条规则错的列不一样);整文件只写一次。
 *  返回真正被停用的 id(本来就停用的不重复写)。 */
export async function disableTriggersWithReasons(reasons: Record<string, string>): Promise<string[]> {
  const ids = Object.keys(reasons);
  if (!ids.length) return [];
  return withTriggersLock(async () => {
    const list = await loadTriggers();
    const done: string[] = [];
    for (const t of list) {
      if (!Object.hasOwn(reasons, t.id) || !t.enabled) continue;
      t.enabled = false;
      t.disabledBy = 'engine'; // 同上:配置错误的停用也只能由用户显式启用来解除
      t.disabledReason = String(reasons[t.id] || '').slice(0, 500);
      done.push(t.id);
    }
    if (done.length) await saveTriggers(list);
    return done;
  });
}

/**
 * 命中时带出的上下文(目前只有 db_changed 产出)。给动作里的模板变量用:
 * `{{row.名称}}` / `{{row.<列 id>}}` —— 两种键都放进 cells,列改名不至于当场失效。
 * **只服务 notify 文本与 db 单元格值**;tool_call 参数与 agent_run 提示词一律不做插值(见 runActions)。
 */
export interface TriggerContext {
  dbPath?: string;
  /** 命中行(**物化后**:lookup/formula 列已算出)。cells=字符串图给 `{{row.X}}`;typed=带类型图给 `{{= }}` 算术。 */
  row?: TriggerRow;
  /** db_row_edit 沿 rowFrom/match 落到的目标行(每个目标各自一份 ctx),给 `{{target.X}}` / `{{= {target.X} }}`。 */
  target?: TriggerRow;
}
export interface TriggerRow {
  id: string;
  cells: Record<string, string>;
  typed?: Record<string, CellValue>;
}

export interface EvaluateEnv {
  now?: Date;
  /** 活动日志行(event_seen 数据源;调用方给近窗口行,规则内再按 lastFiredAt 过滤)。 */
  activityLines?: string[];
  /** 文件非空白字符数;不存在/不可读 → null。测试可注入。 */
  readFileChars?: (path: string) => Promise<number | null>;
  /** 出参:event_seen 命中规则的新消费游标(调用方随 markTriggersFired 写回)。 */
  outCursors?: Record<string, EventCursor>;
  /** db_changed:当前 vault 根(与规则里钉的 vault 不一致就整条跳过)。 */
  currentVault?: string;
  /** db_changed:读一张表;**不存在 → null,坏了(JSON/结构/权限)→ 抛**(amadeusDb.readDbOrNull 口径)。测试注入假表。
   *  主表 null = 表没了,静默跳过(面板另有提示);lookup 依赖表 null 或抛 = 依赖失败,该规则本轮跳过、不推游标(见 preloadLookupDbs)。 */
  readDbFile?: (vaultRelPath: string) => Promise<DbLike | null>;
  /** db_changed:入参游标表(triggerId → 游标)。 */
  dbCursors?: Record<string, DbCursor>;
  /** db_changed 出参:**无论是否命中**都要写回的新游标(不写回=下一轮拿旧快照重复比对)。 */
  outDbCursors?: Record<string, DbCursor>;
  /** 出参:命中规则的上下文 —— **该规则最后一次命中**(老消费者/老测试用;逐 hit 的完整列表在 outHits)。 */
  outContexts?: Record<string, TriggerContext>;
  /** 出参:逐命中一条(同一规则多行命中就有多条,顺序与返回的 fired 数组一致;非 db 规则也占一条、ctx 为 {})。 */
  outHits?: Array<{ id: string; ctx: TriggerContext }>;
  /** 公式 today() 的值(测试注入);缺 = 本机当天。 */
  today?: string;
  /** 出参:**配置性**错误(TriggerConfigError)的规则 id → 原因。调用方据此停用 + 写 disabledReason;
   *  暂时性错误(库不符/表读炸/lookup 依赖表缺/where 列按名解析不到)**绝不**进这里。 */
  outIssues?: Record<string, string>;
  /** 出参:**暂时性**状态位(H3)规则 id → 人读原因。**不停用**,只让面板看得出「它为什么不动」。
   *  从前这些情况一律静默 continue / 只进引擎日志:规则显示「已启用」却一次都不评估,用户零信号。 */
  outNotices?: Record<string, string>;
  /** 单规则评估失败的留痕(缺 = 不打)。 */
  log?: (msg: string) => void;
}

/** 评估只需要表的这一点结构(避免 museTriggers 依赖引擎的 db 模块,单测好注入)。
 *  列只强制 id/name;计算列物化(materializeRow)会读 type/formula/lookup* 等可选字段,缺=当文本列。 */
export interface DbLike {
  source?: { folder: string };
  columns: DbLikeColumn[];
  rows: { id: string; cells: Record<string, unknown> }[];
}
export type DbLikeColumn = Pick<DbColumn, 'id' | 'name'> & Partial<DbColumn>;

/** 单元格值 → 游标比对串(数组按序 join('');null/undefined 一律空串)。**游标 key 的唯一口径**:cursorFor 播种、评估比对、
 *  自游标合并(automationDbAction 的 touch.edited.key)三处必须同一函数 —— amadeusDb.cellKey 用 \u0001 拼数组,
 *  拿它当游标 key 会让多值列的自写在下一轮被当成别人的改动(自触发一次)。 */
export function cellKeyOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('');
  return String(v);
}

/** 模板/where 用的单元格字符串:数组按 `', '` 拼(与渲染层展示同形,且 coerceCell 按 `,` 拆回得来——
 *  `{{row.配件}}` 写进多选关联列要能原样回去;cursor 比对用的 cellKeyOf 仍按 '' 拼,两者别混)。 */
function cellTextOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** 行 → 模板变量可读映射(列 id 与列名两种键都放)。`cells` 应是物化后的(见 materializeRow)。 */
function rowVars(db: DbLike, cells: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of db.columns) {
    const v = cellTextOf(cells?.[c.id]);
    out[c.id] = v;
    if (c.name) out[c.name] = v;
  }
  return out;
}

/** 行 → 带类型图(列 id 与列名两种键;给 `{{= }}` 算术,数字列保持 number)。 */
function rowTyped(db: DbLike, cells: Record<string, unknown>): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const c of db.columns) {
    const raw = cells?.[c.id];
    const v: CellValue = raw === undefined ? null : (raw as CellValue);
    out[c.id] = v;
    if (c.name) out[c.name] = v;
  }
  return out;
}

/** DbLike → dbLookup/dbFormula 要的 DbFile 形状(缺 type 当文本列;version/name 只是占位,不落盘)。 */
function asDbFile(db: DbLike): DbFile {
  return { version: 1, name: '', columns: db.columns.map((c) => ({ type: 'text', ...c })), rows: db.rows as DbRow[] };
}

/** 列 id 或列名 → 列(与 amadeusDb.resolveColumn 同口径:先 id 逐字,再列名 trim+lowercase;找不到/两列同名 → 抛)。
 *  where 的 column 与 db_row_edit 的 rowFrom 都经这里解析——两处都是「解析不到就是规则错误」,绝不折成空串。 */
export function resolveLikeColumn(db: DbLike, idOrName: string): DbLikeColumn {
  const byId = db.columns.find((c) => c.id === idOrName);
  if (byId) return byId;
  const want = String(idOrName).trim().toLowerCase();
  const hit = db.columns.filter((c) => String(c.name || '').trim().toLowerCase() === want);
  if (!hit.length) throw new Error(`column "${idOrName}" not found (have: ${db.columns.map((c) => c.name).join(', ')})`);
  if (hit.length > 1) throw new Error(`column name "${idOrName}" is ambiguous (${hit.length} columns share it) — use the column id`);
  return hit[0];
}

/** 一张表的 lookup 列会读到的其它表路径(反向:refDb;正向:lookupRel 指向的 rowlink 列的 refDb)。 */
export function lookupDepPaths(db: DbLike): string[] {
  const out = new Set<string>();
  for (const c of db.columns) {
    if (c.type !== 'lookup') continue;
    if (isBackLookup(c as DbColumn)) { if (c.refDb) out.add(c.refDb); continue; }
    const rel = db.columns.find((x) => x.id === c.lookupRel && x.type === 'rowlink');
    if (rel?.refDb) out.add(rel.refDb);
  }
  return [...out];
}

/**
 * 把 lookup 依赖的表读进缓存(一次评估/一次动作内共用)。**失败即关**:任一依赖读不到(null=不存在)或读炸(抛)
 * → 抛错(消息含路径),调用方整条规则/整步动作跳过。从前折成 null 会让 lookup 全空、公式算成 0、where 据此误判,
 * 然后事件被当成已消费——那是静默丢事件,不是「宽容」。
 */
export async function preloadLookupDbs(
  db: DbLike,
  readDb: (vaultRelPath: string) => Promise<DbLike | null>,
  cache: Map<string, DbLike | null> = new Map(),
): Promise<Map<string, DbLike | null>> {
  for (const p of lookupDepPaths(db)) {
    if (cache.has(p)) continue;
    let dep: DbLike | null;
    try {
      dep = await readDb(p);
    } catch (e: any) {
      throw new Error(`lookup dependency "${p}" failed to load: ${e?.message || e}`);
    }
    if (!dep) throw new Error(`lookup dependency "${p}" not found`);
    cache.set(p, dep);
  }
  return cache;
}

/**
 * 物化一行(同步版):先 lookup(沿关联取值/反向 rollup)后 formula(公式能引用 lookup 结果),
 * 返回「磁盘 cells + 计算列」合并图。`getDb` 由 preloadLookupDbs 的缓存兜(缺 = null → lookup 得空)。
 * 与渲染层 DatabaseEmbed compRows 同一份 dbLookup/dbFormula(vendor,勿手改),两端算出来的必须一致。
 */
export function materializeRowSync(
  db: DbLike,
  row: { id: string; cells: Record<string, unknown> },
  getDb: (vaultRelPath: string) => DbLike | null,
  opts: { today?: string } = {},
): Record<string, CellValue> {
  const file = asDbFile(db);
  const r: DbRow = { id: row.id, cells: (row.cells ?? {}) as Record<string, CellValue> };
  const get = (p: string): DbFile | null => { const d = getDb(p); return d ? asDbFile(d) : null; };
  const lookups = computeRowLookups(file, r, get, opts);
  const merged: Record<string, CellValue> = { ...r.cells, ...lookups };
  const formulas = evalRowFormulas(file.columns, merged, opts);
  return { ...merged, ...formulas };
}

/** 物化一行(异步版:自己读依赖表;依赖表缺/坏 → 抛,见 preloadLookupDbs)。 */
export async function materializeRow(
  db: DbLike,
  row: { id: string; cells: Record<string, unknown> },
  readDb: (vaultRelPath: string) => Promise<DbLike | null>,
  opts: { today?: string } = {},
): Promise<Record<string, CellValue>> {
  const cache = await preloadLookupDbs(db, readDb);
  return materializeRowSync(db, row, (p) => cache.get(p) ?? null, opts);
}

/** 物化后的行 → 触发上下文里的行(cells 字符串图 + typed 带类型图)。 */
export function triggerRowOf(db: DbLike, rowId: string, materialized: Record<string, unknown>): TriggerRow {
  return { id: rowId, cells: rowVars(db, materialized), typed: rowTyped(db, materialized) };
}

type DbChangedCond = Extract<MuseTriggerCond, { type: 'db_changed' }>;

/** cell_changed 实际监听的列 id:columnIds ∪ columnId,去重保序(手改过的规则文件可能只带其中一个键)。 */
export function watchedCols(c: DbChangedCond): string[] {
  const out: string[] = [];
  for (const raw of [...(Array.isArray(c.columnIds) ? c.columnIds : []), c.columnId]) {
    const id = String(raw ?? '').trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * **配置性**评估错误(与暂时性错误分开):规则本身写错了,重试多少次都是同一个结果 ——
 * 监听列被删 / 监听列不落盘 / where 引用的列无效。drain 拿到它 → 停用规则 + 写 disabledReason,
 * 用户在面板上看得见(从前只进 env.log,规则永久冻死而用户侧零信号)。
 * ⚠️ 暂时性错误(表读炸、lookup 依赖表缺)**绝不**用这个类:那些下一轮可能自己就好了,停用是误伤。
 * 已知取舍:插件若把「删列 + 加列」拆成两次 mutateDb,恰好夹住一个 tick 会被停用;插件 ensure
 * 下一次会以 enabled:true 重新 upsert(顺带清 disabledReason + 重播种),自愈。
 */
export class TriggerConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'TriggerConfigError'; }
}

/**
 * **暂时性**评估错误(与 TriggerConfigError 相对):这一轮评不了,下一轮可能自己就好了 ——
 * 库不符、表暂时读不到、lookup 依赖表缺、**where 的列按名解析不到或重名歧义**。
 * 一律**不停用**,只经 `env.outNotices` 给一个不停用的可见状态位(面板上能看出「为什么它不动」)。
 *
 * ⚠️ 为什么 where 列在这一档(M7,2026-09-02 订正上一轮):`resolveLikeColumn` 对「两列同名」也抛,
 * 而「先加新名列、灌完数据再删旧列」是最常见的列迁移手法 —— 重名窗口内任意一次 tick 就会把所有按列名
 * 写 where 的规则**永久停用**,迁移做完也不自愈。而工具描述恰恰明说 where 的 column 可以写列名。
 * 对比:**监听列**按 id 缺失仍是永久配置错误(DatabaseEmbed 的 delCol 连 cell 一起删、addCol 生成随机新 id,
 * 被盯的列 id 永远回不来),维持停用。
 */
export class TriggerTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'TriggerTransientError'; }
}

/** 值不落盘的列类型:公式列与引用列(含 W2-A 的可编辑投影列 lookupKind='links')—— 值在物化/渲染时算出来,
 *  磁盘 cells 里恒无此键。游标 cursorFor 读的是**裸 cells**,盯这种列 → key 恒空串 → 游标永不变 → 一次都不触发。 */
export const isVirtualColumn = (col: DbLikeColumn | undefined): boolean =>
  col?.type === 'formula' || col?.type === 'lookup';

/**
 * cell_changed 的监听列体检:全在?全是落盘列?不合格返回人读原因(给 TriggerConfigError),合格返回 null。
 * 桌面构建器已经 `filter(c => c.type !== 'formula' && c.type !== 'lookup')`,引擎侧从前没有对等闸 ——
 * `manage_automation` 能建出「盯公式列」的规则:不抛、不报、零日志、面板一切正常,只是**永远不会触发**。
 * 要盯计算结果,盯它依赖的落盘列(投影列则盯对侧表的 rowlink 列)。
 */
export function invalidWatchCols(c: DbChangedCond, db: DbLike): string | null {
  const cols = watchedCols(c);
  if (!cols.length) return '监听列已不存在:(未设监听列)';
  const missing = cols.filter((id) => !db.columns.some((x) => x.id === id));
  if (missing.length) return `监听列已不存在:${missing.join(', ')}`;
  const virt = virtualWatchCols(c, db);
  return virt.length ? virtualColsMessage(virt) : null;
}

/** 监听列里的计算列(公式/引用/投影)。 */
export function virtualWatchCols(c: DbChangedCond, db: DbLike): DbLikeColumn[] {
  return watchedCols(c)
    .map((id) => db.columns.find((x) => x.id === id))
    .filter((col): col is DbLikeColumn => isVirtualColumn(col));
}
export function virtualColsMessage(cols: DbLikeColumn[]): string {
  return `监听列必须是落盘列:${cols.map((c) => c.name || c.id).join(', ')} 是公式/引用列(值不落盘,永远检测不到变化)`
    + ';请改盯它依赖的落盘列(投影列则盯对侧表的关联列)';
}

/**
 * 建/改规则时的监听列预检(需要读表 → 读端注入)。**只拦计算列**这一种毫无歧义的错:
 * 少列不拦(插件可能先建规则后建列,拦了会挡住幂等种子;评估侧的 TriggerConfigError 会在表回来后给信号)。
 * 表读不到 / 读炸 / 不是当前库 → 一律放行。
 */
/**
 * H2:监听列预检**只挂在「让规则更活跃」的那几条路上** —— 新建 / cond 实质变化 / 本次要置为 enabled:true。
 * **关规则永远不许被预检挡住**:一条监听列后来被改成公式列的规则,若每次 POST 都预检,连「关掉」都被 400 挡回;
 * 更糟的是 pluginStore 禁用插件时逐条 upsert 成 enabled:false 走同一条路由,而那边的待停用重放**刻意不封顶**,
 * 400 会让它无限重试成风暴。判据抽成纯函数,是为了让这条闸有地方写断言(路由里内联 = 只能靠端到端撞)。
 */
export function needsWatchColPrecheck(
  prev: Pick<MuseTrigger, 'cond' | 'enabled'> | undefined,
  next: { cond: MuseTriggerCond; enabled: boolean },
): boolean {
  const condChanged = !prev || JSON.stringify(prev.cond) !== JSON.stringify(next.cond);
  const turningOn = next.enabled && !prev?.enabled;
  return condChanged || turningOn;
}

export async function precheckWatchCols(
  cond: MuseTriggerCond,
  readDb: (vaultRelPath: string) => Promise<DbLike | null>,
  currentVault?: string,
): Promise<string | null> {
  if (cond.type !== 'db_changed' || cond.event !== 'cell_changed') return null;
  if (currentVault && cond.vault && !sameVault(currentVault, cond.vault)) return null; // 归一同 evaluate(H3)
  let db: DbLike | null = null;
  try { db = await readDb(cond.path); } catch { return null; }
  if (!db || db.source) return null;
  const virt = virtualWatchCols(cond, db);
  return virt.length ? virtualColsMessage(virt) : null;
}

/** 多列复合 key 的分隔符(单元格值里出现 U+001F 的概率按零算;单列不拼,key 就是裸 cellKey)。 */
const COL_KEY_SEP = '\u001f';
/** 一行在监听列上的游标 key:单列 = cellKeyOf(与旧游标逐字同);多列 = 各列 key 按 cols 顺序拼。 */
function rowKeyOf(cells: Record<string, unknown> | undefined, cols: string[]): string {
  if (cols.length === 1) return cellKeyOf(cells?.[cols[0]]);
  return cols.map((id) => cellKeyOf(cells?.[id])).join(COL_KEY_SEP);
}
/** 游标 key → 逐列 key(n=1 原样一格;缺列位补空串)。 */
export function keyParts(key: string, n: number): string[] {
  if (n <= 1) return [String(key ?? '')];
  const parts = String(key ?? '').split(COL_KEY_SEP);
  while (parts.length < n) parts.push('');
  return parts.slice(0, n);
}
/** 把复合 key 的第 slot 格换成 val(advanceSelfCursors 精确因果合并用;n=1 即整格替换)。 */
export function replaceKeyPart(key: string, n: number, slot: number, val: string): string {
  if (n <= 1) return val;
  const parts = keyParts(key, n);
  parts[slot] = val;
  return parts.join(COL_KEY_SEP);
}
/**
 * 游标形状与规则当前监听列是否相符:**任何列数**都须带同序同集的 cols(n=1 也要)。
 * 不符 = 视为未播种(评估侧重播种、自游标推进侧跳过)。**只管 cols 这一维**,身份三件套见 cursorMismatch。
 *
 * 为什么 n=1 也验列(codex 抓的):从前单列只判「没有 cols 键」,于是**任何**单列游标对**任何**单列规则都
 * 「相符」,不看是哪一列。`manage_automation` 改列走 upsertTrigger,历史上不丢游标(丢游标只写在 HTTP 路由),
 * 于是把 columnId A 改成 B 之后:B 的当前值 × A 的历史值逐行比 → 多数行判「变了」→ 纯动作链同 tick 全部执行。
 * 读端自证比写端兜底更硬:游标自己说得清它是哪几列的,拿错就是拿错。
 */
export function cursorFits(cur: DbCursor | undefined, cols: string[]): boolean {
  if (!cur?.cells) return false;
  return Array.isArray(cur.cols) && cur.cols.length === cols.length && cur.cols.every((id, i) => id === cols[i]);
}

/**
 * **读端唯一的游标信任闸**:这份游标是不是「这条规则此刻的 cond」的快照?不是 → 只重播种、绝不拿它比对。
 * 返回不符的原因(给日志),相符返回 null。
 *
 * 为什么必须在读端判(而不是靠写端 dropCursors):写端那道 drop 与 drain 的读-改-写窗口是并发的 ——
 * `automationDrain` 先 `loadCursors()`,评估期间用户在面板换了表(upsertTrigger 内 dropCursors 已把键删掉),
 * 回来 `setCursors(baseline)` 是 `Object.assign` **合并**,把刚删掉的旧表游标原样写回。下一 tick 拿 A 表的
 * rowIds 基线比 B 表 → B 表满表现有行全被当成「刚加的」,纯 DB 动作链同 tick 全表执行(row_added 尤其危险:
 * 它的 cols 维根本不参与判定)。身份自证与时序无关,这才是总闸;dropCursors 降级为快速路径。
 *
 * ⚠️ 一次性代价(**订正上一轮的说法**):不是「≈ 一个 tick 间隔(约 5min)」。重播种吃掉的是
 * **从游标被冻住的那一刻起的全部积压** —— 凡是上次成功评估后游标就不再推进的规则都算:vault 不一致、
 * 表暂时读不到、where/监听列无效抛错、规则被停用期间。最刺的组合:升级前就已停用的存量规则,升级后手动启用,
 * 整个停用期的变更全被算进基线(**一条都不触发**)。选择理由不变:误触发会批量写坏业务数据且不可逆,
 * 漏一窗事件用户重新碰一下行就补回来。别改成「给旧游标补盖当前身份」——那等于假定它本来就是这一张表。
 */
export function cursorMismatch(cur: DbCursor | undefined, c: DbChangedCond): string | null {
  if (!cur) return null; // 无游标 = 首次见到,由调用方按「播种」处理(不是不符)
  if (cur.v !== CURSOR_V) return `旧版本游标(v${cur.v} ≠ v${CURSOR_V})`;
  if (cur.event !== c.event) return `事件变了(${cur.event} → ${c.event})`;
  if (cur.path !== normalizeVaultRel(c.path)) return `换表了(${cur.path} → ${normalizeVaultRel(c.path)})`;
  if (cur.vault !== String(c.vault || '')) return `换库了(${cur.vault} → ${c.vault})`;
  if (c.event === 'row_added') return Array.isArray(cur.rowIds) ? null : '游标缺 rowIds';
  const cols = watchedCols(c);
  return cursorFits(cur, cols) ? null : `监听列变了(${cur.cols?.join(',') ?? '(无标记)'} → ${cols.join(',')})`;
}

/** 一条 db_changed 规则对一张表的「全消费」游标(播种 / 基线跟上 / 自游标推进 三处共用同一算法)。
 *  身份三件套 path/event/vault 与 cols(n=1 也带)一律写全,让 cursorMismatch 能逐字自证。 */
export function cursorFor(c: DbChangedCond, db: DbLike): DbCursor | null {
  const idy = { v: CURSOR_V, path: normalizeVaultRel(c.path), event: c.event, vault: String(c.vault || '') } as const;
  if (c.event === 'row_added') return { ...idy, event: 'row_added', rowIds: db.rows.map((r) => r.id) };
  const cols = watchedCols(c);
  if (!cols.length) return null;
  const cells: Record<string, string> = {};
  for (const r of db.rows) cells[r.id] = rowKeyOf(r.cells, cols);
  return { ...idy, event: 'cell_changed', cols, cells };
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
  // 非 db 规则一次命中一条(ctx 空);db 规则在自己的分支里逐行 push(带 ctx)。两种都进 outHits,与 fired 一一对应。
  const hit = (t: MuseTrigger): void => { fired.push(t); env.outHits?.push({ id: t.id, ctx: {} }); };
  for (const t of triggers) {
    if (!t.enabled) continue;
    const lastMs = t.lastFiredAt ? Date.parse(t.lastFiredAt) : 0;
    const c = t.cond;
    if (c.type === 'manual') continue; // 手动类只由 fire 端点起跑,巡检永不命中
    // cooldown 只约束事件/文件类;定时类自带时刻语义,gate 会吞触发
    // (存量规则可能带 cooldown=24 的 daily_at——validate 已改强制 0,这里兜旧数据)。
    const timed = c.type === 'daily_at' || c.type === 'at' || c.type === 'every';
    const cooldownMs = Math.max(0, Number(t.cooldownHours) || 0) * 3600_000;
    if (!timed && lastMs && now.getTime() - lastMs < cooldownMs) continue;
    try {
      if (c.type === 'file_chars_gte') {
        const chars = await readChars(c.path);
        if (chars !== null && chars >= c.n) hit(t);
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
          hit(t);
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
        if (now >= due && lastMs < due.getTime() && createdMs < due.getTime()) hit(t);
      } else if (c.type === 'at') {
        const due = parseLocalMinute(c.datetime);
        // 一次性:过点且从未在点后触过(markTriggersFired 会顺手 enabled=false,这里的 lastMs 判断兜双保险)。
        if (due && now.getTime() >= due.getTime() && lastMs < due.getTime()) hit(t);
      } else if (c.type === 'db_changed') {
        // 切库保护:规则文件是全局的,path 却是库内相对路径——不钉 vault 就会静默作用到另一个库
        // 里同名的表。不一致时整条跳过(不评估、不推游标),换回原库即照常工作。
        // ⚠️ H3(2026-09-02):从前是**静默** continue —— 无日志、无状态位,面板照显示「已启用」。
        // 而 vault 取的是配置里的原样字符串:用户把库改名/移动后重开、或换一种写法(多一个尾斜杠)
        // → 全部 db_changed 规则永久冻死且零信号,在面板里编辑或启停都修不好(构建器钉回建规则时的 vault),
        // 只能删了重建。现在:sameVault 做一次温和归一(尾斜杠/反斜杠),仍不符则给**不停用**的可见状态位。
        if (env.currentVault && c.vault && !sameVault(env.currentVault, c.vault)) {
          if (env.outNotices) env.outNotices[t.id] = `本规则钉的库是「${c.vault}」,当前打开的是「${env.currentVault}」—— 暂停评估(切回该库即恢复)`;
          continue;
        }
        const db = env.readDbFile ? await env.readDbFile(c.path) : null; // 坏文件 → 抛 → 下面 catch 留痕、不推游标
        if (!db) { // 表没了(可能只是暂时不在:同步中 / 刚被移走)
          if (env.outNotices) env.outNotices[t.id] = `表「${c.path}」当前读不到 —— 暂停评估(表回来即恢复)`;
          continue;
        }
        if (db.source) { // 「笔记视图」(行是笔记不是 JSON 行),不是能盯的多维表
          if (env.outNotices) env.outNotices[t.id] = `「${c.path}」是笔记视图(行来自文件夹),不能作为 db_changed 的数据源`;
          continue;
        }
        // where 的列先按当前 schema 解析成列 id:解析不到 = **配置性**错误 → 抛(整条跳过、游标冻住)。
        // 从前折成 '' 比对:empty/ne 失败开放、eq/notempty 静默拒绝,两种都把事件当成已消费。
        // where 的 column 允许写列名(工具描述也这么写),所以用户改个列名就会走到这里 —— 冻住的规则由
        // TriggerConfigError 带出去、停用+写 disabledReason,不再只进引擎日志(P3 的不对称由信号覆盖)。
        const where: DbWhere[] = (c.where ?? []).map((w) => {
          try { return { ...w, column: resolveLikeColumn(db, w.column).id }; }
          // ⚠️ M7(2026-09-02 订正上一轮):这里是**暂时性**错误,不是配置性错误 —— 不许自动停用。
          // resolveLikeColumn 对「两列同名」也抛,而「先加新名列、灌完数据再删旧列」是最常见的列迁移手法:
          // 重名窗口内任意一次 tick 就会把所有按列名写 where 的规则永久停用,迁移做完也不自愈。
          // 仍然 fail-closed(整条跳过、游标冻住、绝不误触发),只是改成给可见状态位而非拉闸。
          catch (e: any) { throw new TriggerTransientError(`where 引用的列暂时解析不到:${e?.message || e}`); }
        });
        const cur = env.dbCursors?.[t.id];
        const full = cursorFor(c, db);
        // cell_changed 的监听列必须**全部**还在、且**全是落盘列**(见 invalidWatchCols)。
        // 少一列 = 配置错误(与「where 引用的列无效」同一条教义),抛 → 下面 catch 留痕 + 整条跳过 + **游标冻住**。
        // 从前只要求「至少一列还在」(codex 抓的):盯 [A,B] 删掉 B,游标 cols 没变仍判相符,而所有原先 B 非空的行
        // key 从「a␟b」塌成「a␟」→ 无 equals 时整表成候选,纯 DB 动作链一次跑完全表。
        // ⚠️ **不再是「冻住等列回来」**:DatabaseEmbed 的 delCol 连 cell 一起删、addCol 生成随机新 id,被盯的列 id
        // 永远回不来 —— 上一轮「列是迁移中间态,列回来就续上」的理由被证伪。fail-closed 的方向保留(绝不误触发),
        // 但错误经 env.outIssues 带给 drain → 停用 + disabledReason,用户在面板看得见(不看引擎日志也能发现)。
        if (c.event === 'cell_changed') {
          const bad = invalidWatchCols(c, db);
          if (bad) throw new TriggerConfigError(bad);
        }
        // 游标身份不符(换表/换事件/换库/换列/旧版本)一律只重播种:拿旧快照比新配置,每行都「变了」,
        // 那是满表误触发不是事件。**所有 event 都过这道闸**(row_added 从前只判「有没有 rowIds」)。
        const mismatch = cursorMismatch(cur, c);
        if (mismatch) {
          env.log?.(`规则 ${t.id} 的游标与当前条件不符(${mismatch}),已重播种(本轮不触发)`);
          if (env.outDbCursors && full) env.outDbCursors[t.id] = full;
          continue;
        }
        // 候选行 = 相对游标「新增」(row_added)/「那列变了」(cell_changed)的**全部**行;
        // 再按 equals + where(物化后的字符串值)过滤成命中行。
        let candidates: DbLike['rows'];
        if (c.event === 'row_added') {
          if (!cur?.rowIds) {
            // 首次见到这条规则:只播种,绝不把满表现有行当成"刚加的"
            if (env.outDbCursors && full) env.outDbCursors[t.id] = full;
            continue;
          }
          const known = new Set(cur.rowIds);
          candidates = db.rows.filter((r) => !known.has(r.id));
        } else {
          const cols = watchedCols(c);
          if (!cur?.cells) { // 首次:只播种
            if (env.outDbCursors && full) env.outDbCursors[t.id] = full;
            continue;
          }
          const nowCells = full?.cells ?? {};
          candidates = db.rows.filter((r) => {
            const now2 = nowCells[r.id];
            const was = cur!.cells?.[r.id];
            if (was === undefined) return false; // 新行归 row_added 管,不在这儿重复报
            if (now2 === was) return false;
            if (!c.equals) return true;
            // equals 按**列**比:某个变了的列新值恰等于 equals 才算(复合串整体比 equals 永远不等)。
            const a = keyParts(was, cols.length);
            const b = keyParts(now2, cols.length);
            return b.some((k, i) => k !== a[i] && k === c.equals);
          });
        }
        if (!candidates.length) {
          // 没有候选 = 纯基线推进(已删行掉出游标);推了才不会下一轮拿更旧的快照比。
          if (env.outDbCursors && full) env.outDbCursors[t.id] = full;
          continue;
        }
        // 依赖表读进缓存:缺/坏 → 抛 → 本轮**什么都不推、什么都不报**(失败即关),下轮原样重试。
        const cache = await preloadLookupDbs(db, env.readDbFile ?? (async () => null));
        const getDb = (p: string): DbLike | null => cache.get(p) ?? null;
        const today = env.today;
        const hits: TriggerRow[] = [];
        for (const r of candidates) {
          const mat = materializeRowSync(db, r, getDb, today ? { today } : {});
          const trow = triggerRowOf(db, r.id, mat);
          if (where.length && !where.every((w) => whereHolds(w, trow.cells))) continue;
          hits.push(trow);
        }
        // 游标消费:
        //   纯动作链 / Muse 唤醒类 —— 一次消费**全部**候选行(命中与否):没命中的行是「变了但条件不符」,不推的话下一轮
        //   拿更旧的快照比,结论必错;命中的行每行 push 一次,同一 tick 里全部跑动作(E7 单 tick 排空)。
        //   含 LLM 的规则(旧式 agentSlug / 动作链含 agent_run)—— **每 tick 只取一行、游标只消费那一行**:
        //   第一个 hit 起了常驻会话后,余下 hit 会因 isRunning 被拒;若游标已把整表吞了,那 N-1 行就永久丢了。
        //   其余命中行留在游标外(row_added 剔出 rowIds;cell_changed 回填旧值),下一 tick 再成候选。
        // 调用方拿到的游标是 pending 的:动作被接受才提交(muse.ts / automationDrain 的 S0 语义)。
        const hasLLM = (!!t.agentSlug && t.agentSlug !== MUSE_AGENT_SLUG) || !!t.actions?.some((a) => a.type === 'agent_run');
        const taken = hasLLM ? hits.slice(0, 1) : hits;
        /** 没轮到处理的命中行 id(只可能出自「含 LLM 每 tick 一行」那条闸)—— 必须留在游标外,下个 tick 再成候选。 */
        const restIds = hits.slice(taken.length).map((h) => h.id);
        if (env.outDbCursors && full) {
          let next = full;
          if (restIds.length) {
            const rest = new Set(restIds);
            // ⚠️ 身份三件套(path/event/vault)与 cols 必须原样跟着走:少写一个字段 = 下一轮 cursorMismatch 判不符 → 白重播种。
            if (c.event === 'row_added') next = { ...full, rowIds: (full.rowIds ?? []).filter((id) => !rest.has(id)) };
            else {
              const cells = { ...(full.cells ?? {}) };
              for (const id of rest) cells[id] = cur?.cells?.[id] ?? '';
              next = { ...full, cells };
            }
          }
          env.outDbCursors[t.id] = next;
        }
        for (const trow of taken) {
          // ⚠️ push 的必须是同一个 t 对象引用(muse.ts 按 `includes` 引用相等分流 agentFired/museFired)。
          fired.push(t);
          const ctx: TriggerContext = { dbPath: c.path, row: trow };
          if (env.outContexts) env.outContexts[t.id] = ctx;
          env.outHits?.push({ id: t.id, ctx });
        }
      } else if (c.type === 'every') {
        const ivl = parseEveryInterval(c.interval);
        const anchor = Date.parse(t.createdAt || '');
        if (!ivl || !Number.isFinite(anchor)) continue;
        const k = Math.floor((now.getTime() - anchor) / ivl);
        if (k < 1) continue; // 首触=锚+1 个间隔(创建当刻不触)
        const latest = anchor + k * ivl;
        // 与日程 repeat 同款:停机再久只补最近一次;时钟回拨时 latest≤last,静默等待。
        if (lastMs < latest) hit(t);
      }
    } catch (e: any) {
      // 单规则失败不阻断其余;但必须留痕 —— 物化读不到依赖表之类的错会让这条规则**整轮**的命中行静默消失,
      // 游标也不推进,下一轮原样再错,不打日志就永远查不出来。
      env.log?.(`规则 ${t.id} 评估失败:${e?.message || e}`);
      // 配置性错误单独带出去:调用方停用规则并把原因写进 disabledReason(面板可见)。
      // 暂时性错误(表读炸 / lookup 依赖表缺 / where 列按名解析不到)**绝不**进 outIssues —— 停用是误伤;
      // 但也不再只进引擎日志:进 outNotices,面板上给一个不停用的状态位(H3/M7)。
      if (e instanceof TriggerConfigError) { if (env.outIssues) env.outIssues[t.id] = String(e.message || '规则配置错误'); }
      else if (env.outNotices) env.outNotices[t.id] = String(e?.message || '本轮评估失败(暂时性,下轮重试)');
    }
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
    case 'manual': return 'manual (clicked by the user)';
    case 'db_changed': {
      const cols = watchedCols(c);
      const colText = cols.length > 1 ? `any of columns ${cols.join(', ')}` : `column ${cols[0]}`;
      return (c.event === 'row_added'
        ? `a row was added to ${c.path}`
        : `${colText} changed${c.equals ? ` to "${c.equals}"` : ''} in ${c.path}`) +
        (c.where?.length ? ` where ${c.where.map((w) => `${w.column} ${w.op}${w.value !== undefined ? ` "${w.value}"` : ''}`).join(' and ')}` : '');
    }
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
  // 按 id 去重:E7 后同一条 db_changed 规则一轮可命中多行(fired 含重复引用),不去重会挤占 slice(0,5) 的名额。
  const uniq = [...new Map(fired.map((t) => [t.id, t])).values()];
  const lines = uniq.slice(0, 5).map((t) => `- ${t.desc} (${condSummary(t.cond)})${t.prompt ? ` — ${t.prompt}` : ''}`);
  return (
    '\n\n[Watch triggers fired this cycle — the user explicitly asked to be told about these; handle them FIRST via add_muse_todo]\n' +
    lines.join('\n')
  );
}
