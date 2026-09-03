/**
 * 单 tick 排空(drain)—— muse.ts tick 里「评估 → 分流 → 起跑 → 提交游标」那一段,抽成依赖全注入的纯流程,
 * 好让「A→B→A 环必须在 20 轮停下」这类负对照有地方跑(muse.test 从不碰 tick)。
 *
 * 每轮:
 *   1. **重载** triggers + cursors(上一轮 runActions 可能 disableTrigger、游标刚写回;复用循环外快照结论必错);
 *      第 2 轮起只评估 db_changed 规则 —— 我们自己的 db 写入改变不了别的条件,且非 db 规则的 lastFiredAt
 *      要到循环末才落盘,重评估会让 at/event_seen 一轮一发。本 drain 已起跑过的规则在内存里覆盖 lastFiredAt,
 *      用户给 db 链设的冷却照样生效。
 *   2. 评估;没命中的规则游标**立刻**提交(baseline),命中的挂 pending。
 *   3. 命中按 hit 逐个起跑(同规则串行);Muse 唤醒类规则跨轮累积、按 id 去重,交给循环外那段(一个 tick 只起一次周期)。
 *   4. **先** ack(pending → 提交)**再** advanceSelfCursors(自写不可见,按精确因果**合并**进 ack 后的游标)——
 *      setCursors 是整条替换,顺序反了合并基底就是评估时的旧快照。
 *   5. 退出:本轮无 agent 命中 / launched 为空但命中非空(整批让位或全 busy,再评估结论相同,别空转)/
 *      本轮没写任何表 / 到 DRAIN_MAX_ROUNDS —— 到顶 = 疑似规则成环:**停用最后一轮起跑的规则**(disableTriggers,
 *      写 disabledReason + disabledBy='engine'),log 一行 `drain cap hit`。不停用的话最后一轮的写入留给下一 tick、
 *      冷却 0 → 每 tick 续跑 20 轮,表无限增长。
 *      ⚠️ **订正(2026-09-02,L10)**:旧注释写「停用后最后一轮的写入留在游标外,用户检查、手动启用后才会再被消费」——
 *      「停用→启用统一重播种」之后**两头都不成立**:停用→启用走 upsertTrigger 的 reEnabled 分支,dropCursors 重播种,那批写入连同
 *      整个停用期的变更一起被算进新基线,**一条都不会被消费**。这是刻意的取舍(误触发批量写坏业务数据且不可逆,
 *      漏一窗事件用户重碰一下行就补回来),不是「留着等消费」。另外 P1-H1 之后,引擎停用(disabledBy='engine')
 *      不再被插件 ensure 的幂等重放开回来 —— 刹车只有用户在面板上显式启用才松。
 * 循环外:pruneCursors 一次、markTriggersFired 一次、**配置性错误一次性停用**(evaluate 经 outIssues 报上来的
 *   「监听列被删 / 监听列不落盘 / where 列无效」→ disableTriggersWithReasons 写 disabledReason,面板可见)——
 *   20 轮 × 整文件落盘不值得。这些规则本轮一次也没起跑过(抛错的连候选行都算不出来),停用不丢事件。
 */
import type { MuseTrigger, EvaluateEnv, EventCursor, TriggerContext, DbLike } from './museTriggers.js';
import type { DbCursor } from './dbCursors.js';
import type { TriggerHit, LaunchResult, TouchedDbs } from './automation.js';
import { MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';

/** 环防线之二:一个 tick 最多重评估这么多轮(之一=自写不可见,之三=让位即退);到顶停用最后一轮的规则。 */
export const DRAIN_MAX_ROUNDS = 20;

export interface DrainDeps {
  loadTriggers: () => Promise<MuseTrigger[]>;
  loadCursors: () => Promise<Record<string, DbCursor>>;
  setCursors: (patch: Record<string, DbCursor>) => Promise<void>;
  evaluate: (triggers: MuseTrigger[], env: EvaluateEnv) => Promise<MuseTrigger[]>;
  launch: (hits: TriggerHit[]) => Promise<LaunchResult>;
  advanceSelfCursors: (touched: Record<string, TouchedDbs>) => Promise<void>;
  markTriggersFired: (ids: string[], at?: Date, cursors?: Record<string, EventCursor>) => Promise<void>;
  /** cap 命中时停用一批规则(写 disabledReason);缺省 = 不停用(老调用方 / 只想观测的测试)。 */
  disableTriggers?: (ids: string[], reason: string) => Promise<void>;
  /** 评估侧的**配置性**错误(监听列被删/不落盘、where 列无效)→ 停用 + 逐条写 disabledReason;
   *  缺省 = 不停用。这些规则每 tick 抛一次且永远不会触发,不给用户侧信号 = 永久冻死还没人知道。 */
  disableTriggersWithReasons?: (reasons: Record<string, string>) => Promise<string[]>;
  /** 活动日志行(event_seen 数据源;调用方读一次,只在第 1 轮用)。 */
  activityLines: string[];
  currentVault?: string;
  readDbFile?: (rel: string) => Promise<DbLike | null>;
  log: (msg: string) => void;
  now?: () => Date;
}

export interface DrainResult {
  /** Muse 唤醒类命中(跨轮去重),调用方在 tick 末尾起周期 + mark。 */
  museFired: MuseTrigger[];
  /** event_seen 消费游标(随 mark 写回)。 */
  trigCursors: Record<string, EventCursor>;
  rounds: number;
  capHit: boolean;
  /** 本 drain 起跑过的规则 id(已 mark)。 */
  launched: string[];
  /** 本 drain 停用的规则 id(排空封顶断环:最后一轮起跑的那批)。 */
  disabled: string[];
  /** 因配置性错误被停用的规则 id → 原因(本 drain 内累计)。 */
  configIssues: Record<string, string>;
  /** **暂时性**状态位(H3):规则 id → 人读原因。**不停用**,调用方留在内存里给面板读
   *  (库不符 / 表暂时读不到 / where 列按名解析不到 …)。每轮以「本轮评估过的规则」为单位刷新:
   *  第 1 轮报、第 2 轮恢复的规则不会留下陈旧误报。 */
  notices: Record<string, string>;
}

const isAgentRule = (t: MuseTrigger): boolean =>
  !!(t.actions && t.actions.length) || !!(t.agentSlug && t.agentSlug !== MUSE_AGENT_SLUG);

export async function drainAutomation(deps: DrainDeps, opts: { maxRounds?: number } = {}): Promise<DrainResult> {
  const maxRounds = Math.max(1, opts.maxRounds ?? DRAIN_MAX_ROUNDS);
  const now = deps.now ?? (() => new Date());
  const trigCursors: Record<string, EventCursor> = {};
  const museMap = new Map<string, MuseTrigger>();
  const launchedAll = new Set<string>();
  const firedAtOverlay = new Map<string, string>();
  let rounds = 0;
  let capHit = false;
  const disabled: string[] = [];
  const configIssues: Record<string, string> = {};
  const notices: Record<string, string> = {};
  for (;;) {
    rounds += 1;
    let triggers = await deps.loadTriggers();
    if (rounds > 1) triggers = triggers.filter((t) => t.cond?.type === 'db_changed');
    // 在**进入 evaluate 之前**做覆盖:evaluate 之后的分流按引用相等,同一轮内必须是同一批对象。
    triggers = triggers.map((t) => (firedAtOverlay.has(t.id) ? { ...t, lastFiredAt: firedAtOverlay.get(t.id)! } : t));
    if (!triggers.length) break;
    const hasDb = triggers.some((t) => t.cond?.type === 'db_changed');
    // ⚠️ **顺序依赖**:loadTriggers(上面)必须先于 loadCursors。upsertTrigger 是「先 dropCursors 再 saveTriggers」,
    // 所以任何读到「已启用/新 cond」的 drain,必然是在那次 drop **之后**才读的游标 —— 停用→启用的积压不会被这一轮打出去。
    // 把这两行调换顺序,这条保证会**静默失效**(读端 cursorMismatch 只兜身份变化,兜不了「同 cond 停用期间的积压」)。
    // 残余(非本行的锅,ms 级窗口):若停用+启用整个发生在**一次 drain 的飞行期内**,本轮 baseline 的 setCursors 仍会把
    // 同身份的旧游标合并写回,cursorMismatch 逐字相符所以照收 —— 与 docs/Log 记的「pruneCursors 残余竞态」同一根因
    // (游标不记规则纪元),要彻底关得给游标存规则的 createdAt。
    const dbCursors = hasDb ? await deps.loadCursors() : {};
    const outDbCursors: Record<string, DbCursor> = {};
    const outHits: Array<{ id: string; ctx: TriggerContext }> = [];
    const outIssues: Record<string, string> = {};
    const outNotices: Record<string, string> = {};
    const fired = await deps.evaluate(triggers, {
      now: now(),
      activityLines: rounds === 1 ? deps.activityLines : [],
      outCursors: trigCursors,
      outHits,
      outIssues,
      outNotices,
      log: deps.log,
      ...(hasDb ? { currentVault: deps.currentVault, dbCursors, outDbCursors, readDbFile: deps.readDbFile } : {}),
    });
    // 游标提交时机(codex 抓的 S0):没命中 → 立刻提交(纯基线推进);命中 → 等动作被**接受**才提交,
    // 否则让位/单飞 busy/无模型这些「本轮没跑成」的路径会把事件当成已消费,事件永久丢。
    // L11/H3(2026-09-02):**以「本轮评估过的规则」为单位刷新**,不再只累加。
    // 从前是 `Object.assign(configIssues, outIssues)` —— 只加不撤:第 1 轮抛错、第 2 轮恢复并真起跑的规则,
    // drain 结束时仍会按那条陈旧原因被停用。notices 同理(否则恢复了还挂着「表读不到」)。
    for (const t of triggers) { delete configIssues[t.id]; delete notices[t.id]; }
    Object.assign(configIssues, outIssues);
    Object.assign(notices, outNotices);
    const firedIds = new Set(fired.map((t) => t.id));
    const baselineCursors: Record<string, DbCursor> = {};
    const pendingCursors: Record<string, DbCursor> = {};
    for (const [id, cur] of Object.entries(outDbCursors)) (firedIds.has(id) ? pendingCursors : baselineCursors)[id] = cur;
    if (Object.keys(baselineCursors).length) await deps.setCursors(baselineCursors);

    const agentFired = fired.filter(isAgentRule);
    const museFiredRound = fired.filter((t) => !agentFired.includes(t));
    for (const t of museFiredRound) museMap.set(t.id, t);
    // 逐 hit 的 ctx 按规则 id 排队消费(outHits 与 fired 同序;不按下标 zip,免得两边一错位全错)。
    const queues = new Map<string, TriggerContext[]>();
    for (const h of outHits) (queues.get(h.id) ?? queues.set(h.id, []).get(h.id)!).push(h.ctx);
    const hits: TriggerHit[] = agentFired.map((t) => ({ t, ctx: queues.get(t.id)?.shift() }));

    // Muse 唤醒类的 pending 游标视同已接受(与从前 tick 末尾无条件 ack 同语义),不然它每轮都会再报一次。
    const ackCursors: Record<string, DbCursor> = {};
    for (const t of museFiredRound) if (pendingCursors[t.id]) ackCursors[t.id] = pendingCursors[t.id];
    if (!hits.length) {
      if (Object.keys(ackCursors).length) await deps.setCursors(ackCursors);
      break;
    }
    deps.log(`agent 自动化命中 ${hits.length} 次(第 ${rounds} 轮):${[...new Set(agentFired.map((t) => t.id))].join(', ')}`);
    const { launched, touched } = await deps.launch(hits);
    const iso = now().toISOString();
    for (const id of launched) {
      if (pendingCursors[id]) ackCursors[id] = pendingCursors[id];
      launchedAll.add(id);
      firedAtOverlay.set(id, iso);
    }
    if (Object.keys(ackCursors).length) await deps.setCursors(ackCursors);
    await deps.advanceSelfCursors(touched);
    if (!launched.length) {
      deps.log(`本轮命中 ${hits.length} 次但无一起跑(让位/单飞),不再重评估`);
      break;
    }
    if (!Object.values(touched).some((byPath) => Object.keys(byPath).length)) break;
    if (rounds >= maxRounds) {
      capHit = true;
      // 最后一轮真起跑(=真写了表)的规则就是环的一环:全部停用,写明原因。只 log 不停用 = 下一 tick 从残留写入续跑。
      const ring = [...launched];
      const reason = `自动化环:${maxRounds} 轮内持续有 db 写入,已停用规则 ${ring.join(', ')};请检查规则后手动启用`;
      deps.log(`[automation] drain cap hit (${maxRounds} 轮仍有 db 写入,疑似规则成环):已停用规则 ${ring.join(', ')};请检查后手动启用`);
      if (deps.disableTriggers) {
        try { await deps.disableTriggers(ring, reason); disabled.push(...ring); }
        catch (e: any) { deps.log(`停用规则失败:${e?.message || e}`); }
      }
      break;
    }
  }
  if (launchedAll.size) await deps.markTriggersFired([...launchedAll], now(), trigCursors);
  // 配置性错误 → 停用 + 写 disabledReason(循环外一次,与 markTriggersFired 同档:20 轮 × 整文件落盘不值得)。
  // 这些规则本轮一次也没起跑过(抛错的规则连候选行都算不出来),停用不会丢事件;游标同样没推进,
  // 用户修好配置后重新启用 → upsertTrigger 的 reEnabled 分支清游标重播种。
  if (Object.keys(configIssues).length && deps.disableTriggersWithReasons) {
    try {
      const off = await deps.disableTriggersWithReasons(configIssues);
      if (off.length) deps.log(`[automation] 规则配置错误,已停用并写明原因(面板可见):${off.map((id) => `${id}(${configIssues[id]})`).join(';')}`);
    } catch (e: any) { deps.log(`停用配置错误的规则失败:${e?.message || e}`); }
  }
  // 被停用的规则不该再挂着「暂时性」状态位(它的失效原因已经是 disabledReason 那条更强的信号)。
  for (const id of Object.keys(configIssues)) delete notices[id];
  return { museFired: [...museMap.values()], trigCursors, rounds, capHit, launched: [...launchedAll], disabled, configIssues, notices };
}
