#!/usr/bin/env node
/**
 * 缓存命中归属报表(A1,2026-09-14 评审 §五 A 档):回答「prompt token 花在哪、未命中的 20% 归谁」。
 * 把当时散在会话 scratchpad 的 attrib / anysess / intrarun2 / fullshare / ttl / toolsizes 收进仓,
 * 口径固定、可跨次比对 —— 每条缓存类改动前后各跑一次,不再靠估。
 *
 *   node scripts/cache-hit-report.mjs                                  # 缺省 dev 引擎库,近 60 天
 *   node scripts/cache-hit-report.mjs ~/.forsion/tangu/state.db        # 安装版库
 *   node scripts/cache-hit-report.mjs tangu-session-xxx.json           # 设置→高级→导出日志(单会话,维度有限)
 *   node scripts/cache-hit-report.mjs --since 2026-09-01 --until 2026-09-14T12:00:00Z
 *   node scripts/cache-hit-report.mjs --days 14                       # 相对窗口(缺省 60)
 *   node scripts/cache-hit-report.mjs --json > before.json             # 结构化,供前后 diff
 *
 * ⚠️ 口径与 stall-timeline **不同**:本表的命中率是 **token 加权**(Σcached/Σprompt),
 *    stall-timeline 那张是**逐次调用取均值**。同一份数据两个数字都对,别互相引用。
 * 只出聚合数,不打印任何行内容(消息正文 / 工具结果 / 系统提示原文都不读出来)。
 * ponytail: 桶是**互斥划分**,和必须等于未命中总量(脚本自检,不等就报 BUG);
 *           「新内容」桶的估算列只作参考,不参与划分。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['since', 'until', 'days'].includes(argv[i - 1]?.replace(/^--/, ''))));
// 引擎自己的库名:core/tanguHome.ts `stateDbPath() = join(tanguHome(), 'state.db')`;dev 壳的 TANGU_HOME 是 ~/.forsion-dev/tangu。
const DEFAULT_DB = join(homedir(), '.forsion-dev', 'tangu', 'state.db');
const FILE = positional[0] || DEFAULT_DB;
const AS_JSON = flag('json');
const DAYS = Number(opt('days', 60));
const toSqlTs = (iso, what) => {
  const d = new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) || !iso.includes(':') ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) { console.error(`--${what} 不是可解析的时间:${iso}`); process.exit(2); }
  return d.toISOString().replace('T', ' ').slice(0, 19); // created_at 是无时区标记的 UTC
};
const SINCE = opt('since', null) ? toSqlTs(opt('since'), 'since') : null;
const UNTIL = opt('until', null) ? toSqlTs(opt('until'), 'until') : null;

const parseTs = (v) => { // 与 stall-timeline.mjs 同款:SQLite CURRENT_TIMESTAMP = 无时区 UTC
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? '');
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOf = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
/** 中文 1 token/字、其余 ~3.6 字符/token(intrarun2 同款);只用于「新内容」桶的参考列。 */
const estTokens = (s) => {
  const text = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  let cjk = 0;
  for (const ch of text) { const c = ch.codePointAt(0); if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk++; }
  return Math.round(cjk + (text.length - cjk) / 3.6);
};

// ── 装载:SQLite(全维度)/ 导出 JSON(单会话时间线,维度受限)────────────────
/** 引擎缺省 Agent(= src/core/tanguHome.ts 的 `DEFAULT_AGENT_SLUG`;脚本不依赖 dist,那边改了这里也要改)。
 *  普通 run 多半不在 input.agentConfig 里显式写 agentSlug,引擎实际用的就是它 —— 记成 `(none)` 会把
 *  「显式 xyra」和「缺省 xyra」拆成两条 agent/模型链,跨会话间隔与共享率全错(评审 #9)。 */
const DEFAULT_AGENT_SLUG = 'xyra';
/** run 的 agent 身份;群聊 run 没有单一 agent(逐发言人用量另按 usage.agentId 单列)。 */
export const agentOf = (slug, groupChat, agentId) => slug || (groupChat ? 'group-chat' : (agentId || DEFAULT_AGENT_SLUG));
/** 事件里能拿到的 agent 身份:只认**非群聊**的那种(群聊 usage 的 agentId 是发言人,不是 run 的 agent)。 */
const eventAgentId = (events) => {
  for (const e of events) {
    const id = e.p?.agentId;
    if (id && (e.type === 'cache_probe' || (e.type === 'usage' && e.p?.iteration != null))) return String(id);
  }
  return null;
};
const SKIP_TYPES = `type NOT IN ('token','reasoning','tool_stream')`; // 流式帧一个 run 几万行,对本表零信息
/** 窗口按**事件** created_at 截,不是按 run 的:窗口前创建、窗口内还在调用的长 run 必须进来,
 *  run 落在 --until 之后的事件必须出去(评审 #3)。 */
const eventWindow = (col) => {
  const w = []; const args = [];
  if (SINCE) { w.push(`${col} >= ?`); args.push(SINCE); }
  if (UNTIL) { w.push(`${col} <= ?`); args.push(UNTIL); }
  if (!SINCE && !UNTIL) { w.push(`${col} > datetime('now', ?)`); args.push(`-${DAYS} days`); }
  return { sql: w.join(' AND '), args };
};
/** 窗口下界的 SQL 表达式(边界预取用);只给了 --until 时窗口从库头开始,没有下界。 */
const lowerBound = () => (SINCE ? { sql: '?', args: [SINCE] } : UNTIL ? null : { sql: `datetime('now', ?)`, args: [`-${DAYS} days`] });

/** 统一中间表示:runs[] = { id, sessionId, model, agent, isMuse, events[] };events 已按 seq 有序。 */
async function fromDb(file) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const SLUG = `json_extract(r.input,'$.agentConfig.agentSlug')`;
  const GROUP = `json_extract(r.input,'$.agentConfig.groupChat')`;
  const win = eventWindow('e.created_at');
  // 排序按**窗口内第一条事件**,不是 r.created_at:窗口前创建的长 run 会被排到最前,
  // 会话链 / 跨会话链的先后就错了。
  const runs = db.prepare(`SELECT r.id AS id, r.session_id AS session_id, r.model_id AS model_id, r.created_at AS created_at,
      ${SLUG} AS slug, json_extract(r.input,'$.background') AS background, ${GROUP} AS group_chat,
      MIN(e.created_at) AS first_ev
    FROM agent_runs r JOIN agent_run_events e ON e.run_id = r.id
    WHERE e.${SKIP_TYPES} AND ${win.sql}
    GROUP BY r.id ORDER BY first_ev, r.id`).all(...win.args);
  const evWin = eventWindow('created_at');
  const evq = db.prepare(`SELECT seq, type, payload, created_at FROM agent_run_events
    WHERE run_id = ? AND ${SKIP_TYPES} AND ${evWin.sql} ORDER BY seq`);
  const out = runs.map((r) => {
    const events = evq.all(r.id, ...evWin.args).map((row) => {
      let p = null; if (row.payload) { try { p = JSON.parse(row.payload); } catch { /* legacy */ } }
      return { seq: row.seq, type: row.type, t: parseTs(row.created_at), p: p || {} };
    });
    return {
      id: r.id, sessionId: r.session_id, model: r.model_id || '(none)', created: parseTs(r.created_at),
      agent: agentOf(r.slug, r.group_chat, eventAgentId(events)),
      isMuse: r.slug === 'muse' || r.background === 'muse',
      events,
    };
  });
  // 边界态:窗口**之前**每个会话 / 每个 (agent,模型) 的最后一次主循环 usage。没有它,窗口前就有历史的
  // 会话其窗口内首条会被误标成 session-first/cold-start/no-prior,造出一片假冷启动(评审 #3)。
  // 后台 usage(带 phase)不算「上次活动」,与主循环链同口径(评审 #1)。
  const boundary = { session: new Map(), agentModel: new Map() };
  const lo = lowerBound();
  if (lo) {
    const rows = db.prepare(`SELECT r.session_id AS sid, ${SLUG} AS slug, ${GROUP} AS group_chat,
        r.model_id AS model_id, MAX(e.created_at) AS last_at
      FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id
      WHERE e.type = 'usage' AND e.created_at < ${lo.sql} AND json_extract(e.payload,'$.phase') IS NULL
      GROUP BY r.session_id, slug, group_chat, r.model_id`).all(...lo.args);
    for (const row of rows) {
      const t = parseTs(row.last_at);
      if (!Number.isFinite(t)) continue;
      if (!(boundary.session.get(row.sid) >= t)) boundary.session.set(row.sid, t);
      const ak = `${agentOf(row.slug, row.group_chat, null)}|${row.model_id || '(none)'}`;
      if (!(boundary.agentModel.get(ak) >= t)) boundary.agentModel.set(ak, t);
    }
  }
  db.close();
  return { runs: out, source: 'db', full: true, boundary, boundaryKnown: true };
}
function fromExport(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const raw = Array.isArray(j.timeline) ? j.timeline : (j.timeline?.runs || j.runs || []);
  if (!raw.length) throw new Error('导出里没有 timeline(需要 ≥ 2.9.8 的桌面端导出)');
  // 窗口同样按**事件**时刻截,并补上缺省的 --days(此前导出模式完全没应用它,评审 #3)。
  const lo = SINCE ? parseTs(SINCE) : UNTIL ? null : Date.now() - DAYS * 86_400_000;
  const hi = UNTIL ? parseTs(UNTIL) : null;
  const inWin = (t) => (lo == null || t >= lo) && (hi == null || t <= hi);
  // 导出是**单会话**骨架:没有 session_id / agentSlug / 工具结果正文 → 会话与 agent 维度整节不出。
  const runs = raw.map((r) => ({
    id: r.id, sessionId: '(export)', model: r.model_id || '(none)', created: parseTs(r.created_at),
    agent: '(export)', isMuse: false,
    events: (r.events || []).filter((e) => !['token', 'reasoning', 'tool_stream'].includes(e.type))
      .map((e) => ({ seq: e.seq, type: e.type, t: parseTs(e.t), p: e })).filter((e) => inWin(e.t)),
  })).filter((r) => r.events.length);
  // 取不到窗口前的历史 → boundaryKnown=false,首条只能标 window-first,不敢当冷启动算。
  return { runs, source: 'export', full: false, boundary: { session: new Map(), agentModel: new Map() }, boundaryKnown: false };
}

// ── 归属 ────────────────────────────────────────────────────────────────────
const BUCKETS = [
  ['cold-start', '冷启动:会话首调 或 距上次调用 ≥10min(上游 TTL 过期 + 新会话头部不共享)'],
  ['first-3-10min', '首调,距上次调用 3–10min'],
  ['short-gap-structure', '首调,距上次调用 <3min —— 纯结构性(记忆块位置 + 回放形态)'],
  ['window-first', '窗口内该会话的首调,但窗口前的历史取不到(导出模式)—— 不敢当冷启动算'],
  ['compaction', '机械折叠 compactContext(status=compacted)后的调用'],
  ['final-turn-no-tools', '末轮剥 tools(上一发带、这一发 toolsBytes=0:agentLoop 顶到迭代上限那一发)—— 工具定义在前缀里,整段作废;引擎所致,不是上游路由'],
  ['load_tools', 'load_tools 解锁后的调用(工具数组变 → 工具及其后全废)'],
  ['steer', 'steer 注入(turn_boundary / steering_applied)后的调用'],
  ['cache-unreported', '缓存量**未知**的调用(cacheReported=false,或老事件缺字段且 cached=0)—— 未命中记 0,不参与命中率与划分'],
  ['later-full-miss', '后续调用整次未命中:hit<5% 且间隔 <60s 且引擎无任何改写事件 —— 多为上游路由不粘(grok cli-chat-proxy 实测续发约 1/3,见 scripts/grok-cache.probe.mjs)'],
  ['later-low-hit-slow', '后续调用 hit<5% 但间隔 ≥60s(上游 TTL,不是结构问题)'],
  ['new-content', '后续调用·纯新内容(上一轮工具结果 / 参数 / 正文)'],
  ['group-chat', '群聊 run 的逐发言人用量(payload 带 agentId、无 iteration;不参与首/后续链)'],
];
const STATIC_BUCKETS = new Set(BUCKETS.map(([k]) => k));
/** 后台桶(usage.phase)的说明:桶名是 `background:<phase>`,phase 由引擎给,列表不固定。 */
const bucketDesc = (k) => (k.startsWith('background:')
  ? `后台调用 usage.phase=${k.slice('background:'.length)}(压缩 / 子代理 / Muse 判官 / 头脑风暴)—— 不在主循环首/后续链上`
  : '(未知桶)');
const isSteer = (e) => e.type === 'turn_boundary' || (e.type === 'status' && e.p?.phase === 'steering_applied');
const isCompacted = (e) => e.type === 'status' && String(e.p?.phase ?? e.p?.state ?? '').startsWith('compacted');

export function analyze({ runs, full, boundary, boundaryKnown }) {
  // knownPrompt/knownCached = 供应商**确实上报过**缓存量的那部分,命中率与未命中划分只认它(评审 #2)。
  const totals = { prompt: 0, cached: 0, completion: 0, calls: 0, runs: runs.length, knownCalls: 0, unknownCalls: 0, knownPrompt: 0, knownCached: 0, unknownPrompt: 0 };
  const buckets = Object.fromEntries(BUCKETS.map(([k]) => [k, { n: 0, uncached: 0, prompt: 0, estNew: 0 }]));
  const firstGap = { 'session-first': mk(), '<3min': mk(), '3-10min': mk(), '>=10min': mk(), 'window-first': mk() };
  const xsess = { 'no-prior': mk(), '<3min': mk(), '3-10min': mk(), '>=10min': mk() };
  const byAgent = {}; const byModel = {}; const toolRuns = {}; const toolCalls = {};
  const muse = { runs: 0, withCalls: new Set(), calls: 0, prompt: 0, cached: 0, knownPrompt: 0, knownCached: 0 };
  const speakers = {};
  const probe = { events: 0, laterCalls: 0, headDiffers: 0, changed: {}, headSame: 0, headNull: 0 };
  const phases = {};
  function mk() { return { n: 0, prompt: 0, cached: 0 }; }
  const hitAdd = (b, u) => { b.n++; b.prompt += u.prompt; b.cached += u.cached; };

  // 窗口前的边界态先灌进来:有它,窗口内首条才不会被误判成会话首调 / 无跨会话历史(评审 #3)。
  const lastUsageTsInSession = new Map(boundary?.session ?? []);   // sessionId → ts(任意 run)
  const seenSession = new Set(lastUsageTsInSession.keys());
  const lastTsByAgentModel = new Map(boundary?.agentModel ?? []);  // `${agent}|${model}` → ts(跨会话)

  for (const r of runs) {
    if (r.isMuse) muse.runs++;
    const toolsHere = new Set();
    let prev = null;          // 上一次 usage 的 payload
    let prevTs = null;        // 上一次 usage 的时刻
    let flags = new Set();    // 两次 usage 之间的引擎事件
    let newChars = 0;         // 两次 usage 之间新增的模型可见字符
    let firstDone = false;
    const agent = r.agent;
    for (const e of r.events) {
      if (e.type === 'tool_call') { const n = e.p?.name; if (n) { toolsHere.add(n); toolCalls[n] = (toolCalls[n] || 0) + 1; if (n === 'load_tools') flags.add('load_tools'); } newChars += estTokens(e.p?.arguments ?? e.p?.args ?? '') + 15; }
      else if (e.type === 'tool_result') { const body = e.p?.result ?? e.p?.content; newChars += (typeof body === 'string' ? estTokens(body) : Math.round(num(e.p?.outputChars) / 3.6)) + 20; }
      else if (isCompacted(e)) flags.add('compaction');
      else if (isSteer(e)) flags.add('steer');
      else if (e.type === 'status') { const ph = e.p?.phase ?? e.p?.state; if (ph) phases[ph] = (phases[ph] || 0) + 1; }
      else if (e.type === 'cache_probe') {
        probe.events++;
        for (const s of e.p?.changedSegments || []) probe.changed[s] = (probe.changed[s] || 0) + 1;
        const same = e.p?.headHashSameAsAgentModel;
        if (same === null || same === undefined) probe.headNull++; else if (same) probe.headSame++; else probe.headDiffers++;
        if (num(e.p?.probeSeq) > 0 || num(e.p?.iteration) > 0) probe.laterCalls++;
      }
      if (e.type !== 'usage') continue;

      const u = { prompt: num(e.p.prompt), cached: num(e.p.cached), completion: num(e.p.completion) };
      const uncached = Math.max(0, u.prompt - u.cached);
      // C-2:`cacheReported===true` 才算上报过;老事件没有这个字段时,只有 cached>0 才能反推「上报过」,
      // 否则是**未知**(与同仓 hosted usage 的「缺字段且 cached=0 = 未知」同契约)。未知的 prompt 不进命中率
      // 分子分母、也不进任何未命中桶 —— 否则整份 prompt 被当成未命中,报表系统性压低命中率(评审 #2)。
      const known = e.p.cacheReported === true || (e.p.cacheReported == null && u.cached > 0);
      totals.prompt += u.prompt; totals.cached += u.cached; totals.completion += u.completion; totals.calls++;
      if (known) { totals.knownCalls++; totals.knownPrompt += u.prompt; totals.knownCached += u.cached; }
      else { totals.unknownCalls++; totals.unknownPrompt += u.prompt; }
      /** 未知缓存量的调用一律落 cache-unreported 桶,且 uncached 记 0 —— 划分自检(桶和 = 未命中总量)照样成立。 */
      const put = (k) => {
        const b = (buckets[known ? k : 'cache-unreported'] ||= { n: 0, uncached: 0, prompt: 0, estNew: 0 });
        b.n++; b.prompt += u.prompt; if (known) b.uncached += uncached;
        return b;
      };
      if (r.isMuse) { muse.calls++; muse.withCalls.add(r.id); muse.prompt += u.prompt; muse.cached += u.cached; if (known) { muse.knownPrompt += u.prompt; muse.knownCached += u.cached; } }
      // 群聊 run 的逐发言人用量:payload 带 agentId、无 iteration。发言人叫 xyra 时**不能**并进普通 xyra 那行
      // (会把「每 run 调用数」这类数字搅烂),后缀 (group) 分开。
      const isGroupUsage = e.p.agentId != null && e.p.iteration == null;
      const speaker = e.p.agentId ? String(e.p.agentId).replace(/^historian-[0-9a-f]+$/, 'historian-assist') : agent;
      const label = isGroupUsage ? `${speaker} (group)` : agent;
      const a = (byAgent[label] ||= { runs: new Set(), calls: 0, prompt: 0, cached: 0, knownPrompt: 0, knownCached: 0 });
      a.runs.add(r.id); a.calls++; a.prompt += u.prompt; a.cached += u.cached;
      if (known) { a.knownPrompt += u.prompt; a.knownCached += u.cached; }
      const m = (byModel[r.model] ||= { calls: 0, prompt: 0, cached: 0, knownPrompt: 0, knownCached: 0, first: mk(), later: mk() });
      m.calls++; m.prompt += u.prompt; m.cached += u.cached;
      if (known) { m.knownPrompt += u.prompt; m.knownCached += u.cached; }

      // C-5 后台调用(压缩 / delegate / muse-judge / brainstorm)自成一桶:**绝不动**首/后续链的任何状态。
      // 否则自动压缩先发的那条 phase=compaction usage 会占掉 firstDone 并落进 cold-start,
      // 随后真正的主循环首调反被算成「后续 compaction」(评审 #1)。flags/newChars 也不清 ——
      // 压缩事件的标记要留给它后面那次真调用。
      if (e.p.phase) {
        const ph = String(e.p.phase);
        phases[`usage:${ph}`] = (phases[`usage:${ph}`] || 0) + 1;
        put(`background:${ph}`);
        continue;
      }

      // 自成一桶:它们不在同一条首/后续链上。
      if (isGroupUsage) {
        put('group-chat');
        speakers[speaker] = (speakers[speaker] || 0) + 1;
        // 不进首/后续链,但会话与 (agent,模型) 的「上次活动」照记:否则同会话的下一个 run 会被误判成会话首调。
        seenSession.add(r.sessionId); lastUsageTsInSession.set(r.sessionId, e.t); lastTsByAgentModel.set(`${agent}|${r.model}`, e.t);
        flags = new Set(); newChars = 0;
        continue;
      }

      let key;
      if (!firstDone) {
        firstDone = true;
        const prevInSession = lastUsageTsInSession.get(r.sessionId) ?? null;
        const isNewSession = !seenSession.has(r.sessionId);
        // 边界态不可知(导出模式)时,窗口内该会话的首条既可能是真冷启动、也可能是长会话被窗口切了一刀 →
        // 单列 window-first,不往 cold-start 里灌假冷启动。
        const windowFirst = isNewSession && !boundaryKnown;
        const gapS = prevInSession == null ? Infinity : (e.t - prevInSession) / 1000;
        key = windowFirst ? 'window-first'
          : (isNewSession || gapS >= 600) ? 'cold-start' : gapS >= 180 ? 'first-3-10min' : 'short-gap-structure';
        if (known) {
          hitAdd(firstGap[windowFirst ? 'window-first' : isNewSession ? 'session-first' : gapS < 180 ? '<3min' : gapS < 600 ? '3-10min' : '>=10min'], u);
          hitAdd(m.first, u);
        }
        if (isNewSession && full) { // 跨会话头部共享:同 agent+模型在**任意**会话的上次活动
          const ak = `${agent}|${r.model}`;
          const last = lastTsByAgentModel.get(ak);
          const g = last == null ? Infinity : (e.t - last) / 1000;
          if (known) hitAdd(xsess[g === Infinity ? 'no-prior' : g < 180 ? '<3min' : g < 600 ? '3-10min' : '>=10min'], u);
        }
        seenSession.add(r.sessionId);
      } else {
        const gapS = prevTs == null ? Infinity : (e.t - prevTs) / 1000;
        const fullMiss = u.cached < 0.05 * (u.prompt || 1);
        // toolsBytes 缺字段(老事件)→ 不判,照旧落后面的桶。
        const toolsStripped = e.p.toolsBytes !== undefined && num(e.p.toolsBytes) === 0 && num(prev?.toolsBytes) > 0;
        key = flags.has('compaction') ? 'compaction'
          : toolsStripped ? 'final-turn-no-tools'
            : flags.has('load_tools') ? 'load_tools'
              : flags.has('steer') ? 'steer'
                : fullMiss && gapS < 60 ? 'later-full-miss'
                  : fullMiss ? 'later-low-hit-slow'
                    : 'new-content';
        if (known) hitAdd(m.later, u);
      }
      const b = put(key);
      if (prev) b.estNew += newChars + num(prev.completion);

      lastUsageTsInSession.set(r.sessionId, e.t);
      lastTsByAgentModel.set(`${agent}|${r.model}`, e.t);
      prev = e.p; prevTs = e.t; flags = new Set(); newChars = 0;
    }
    for (const t of toolsHere) toolRuns[t] = (toolRuns[t] || 0) + 1;
  }

  const uncachedTotal = totals.knownPrompt - totals.knownCached; // 未知缓存量的那部分不算未命中
  const bucketSum = Object.values(buckets).reduce((s, b) => s + b.uncached, 0);
  return { totals, uncachedTotal, bucketSum, buckets, firstGap, xsess, byAgent, byModel, toolRuns, toolCalls, muse, speakers, probe, phases };
}

// ── 报表 ────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
function report(a, meta) {
  const L = [];
  const window = SINCE || UNTIL ? `${SINCE || '(不限)'} → ${UNTIL || '(不限)'} UTC` : `近 ${DAYS} 天`;
  L.push(`# 缓存命中归属  源 ${meta.file}(${meta.source})  窗口 ${window}`);
  L.push('');
  const t = a.totals;
  L.push('## 总量(命中率 = token 加权 Σcached/Σprompt,只算**上报了缓存量**的那部分;与 stall-timeline 的逐次均值不是同一个数)');
  L.push(`run ${t.runs}  模型调用 ${t.calls}  prompt ${fmt(t.prompt)}  completion ${fmt(t.completion)}`);
  L.push(`已上报缓存量的调用 ${t.knownCalls}/${t.calls}:prompt ${fmt(t.knownPrompt)}  命中 ${fmt(t.knownCached)}(${pctOf(t.knownCached, t.knownPrompt)})  未命中 ${fmt(a.uncachedTotal)}(${pctOf(a.uncachedTotal, t.knownPrompt)})`);
  if (t.unknownCalls) L.push(`缓存量**未知**的调用 ${t.unknownCalls}/${t.calls},prompt ${fmt(t.unknownPrompt)}(占总 ${pctOf(t.unknownPrompt, t.prompt)})—— cacheReported=false,或老事件缺字段且 cached=0;不进命中率、也不进未命中划分(C-2)`);
  L.push('');
  L.push('## 未命中归属(互斥划分,和 = 未命中总量)');
  L.push(`${pad('桶', 22)}${rpad('次', 6)}${rpad('未命中', 12)}${rpad('占未命中', 9)}${rpad('该桶命中', 9)}  说明`);
  const dynamic = Object.keys(a.buckets).filter((k) => !STATIC_BUCKETS.has(k)).sort().map((k) => [k, bucketDesc(k)]);
  for (const [k, desc] of [...BUCKETS, ...dynamic]) {
    const b = a.buckets[k];
    if (!b?.n) continue;
    const hit = k === 'cache-unreported' ? '未知' : pctOf(b.prompt - b.uncached, b.prompt);
    L.push(`${pad(k, 22)}${rpad(b.n, 6)}${rpad(fmt(b.uncached), 12)}${rpad(pctOf(b.uncached, a.uncachedTotal), 9)}${rpad(hit, 9)}  ${desc}`);
  }
  const nc = a.buckets['new-content'];
  if (nc.n) L.push(`(参考,不参与划分)new-content 每次未命中均值 ${Math.round(nc.uncached / nc.n)},其中可由「上轮输出 + 新工具内容」解释 ~${Math.round(nc.estNew / nc.n)} → 剩余 ~${Math.round((nc.uncached - nc.estNew) / nc.n)}/次`);
  L.push(a.bucketSum === a.uncachedTotal ? `划分自检 ✓ ${fmt(a.bucketSum)}` : `划分自检 ✗ BUG:桶和 ${fmt(a.bucketSum)} ≠ 未命中 ${fmt(a.uncachedTotal)}`);
  L.push('');
  L.push('## run 首调命中,按距同会话上次调用的间隔分桶(判别「结构」还是「TTL」)');
  L.push(`${pad('间隔', 16)}${rpad('n', 5)}${rpad('命中', 7)}${rpad('均 prompt', 11)}`);
  for (const [k, v] of Object.entries(a.firstGap)) if (v.n) L.push(`${pad(k, 16)}${rpad(v.n, 5)}${rpad(pctOf(v.cached, v.prompt), 7)}${rpad(fmt(Math.round(v.prompt / v.n)), 11)}`);
  L.push('');
  if (meta.full) {
    L.push('## 跨会话头部共享:**新会话**首调,按同 agent+模型在任意会话的上次活动间隔分桶');
    L.push('  (<3min 桶若远低于 100%,说明新会话连稳定头 + 工具定义都没共享到 —— §2.4)');
    L.push(`${pad('间隔', 16)}${rpad('n', 5)}${rpad('命中', 7)}${rpad('均 prompt', 11)}`);
    for (const [k, v] of Object.entries(a.xsess)) if (v.n) L.push(`${pad(k, 16)}${rpad(v.n, 5)}${rpad(pctOf(v.cached, v.prompt), 7)}${rpad(fmt(Math.round(v.prompt / v.n)), 11)}`);
    L.push('');
    L.push('## 按 agent(群聊 run 的逐发言人用量按 usage.agentId 单列)');
    L.push(`${pad('agent', 20)}${rpad('run', 5)}${rpad('调用', 6)}${rpad('调用/run', 10)}${rpad('prompt', 12)}${rpad('占比', 7)}${rpad('每 run', 10)}${rpad('每次', 9)}${rpad('命中', 7)}`);
    for (const [k, v] of Object.entries(a.byAgent).sort((x, y) => y[1].prompt - x[1].prompt)) {
      const runs = v.runs.size;
      L.push(`${pad(k, 20)}${rpad(runs, 5)}${rpad(v.calls, 6)}${rpad((v.calls / runs).toFixed(1), 10)}${rpad(fmt(v.prompt), 12)}${rpad(pctOf(v.prompt, a.totals.prompt), 7)}${rpad(fmt(Math.round(v.prompt / runs)), 10)}${rpad(fmt(Math.round(v.prompt / v.calls)), 9)}${rpad(pctOf(v.knownCached, v.knownPrompt), 7)}`);
    }
    if (Object.keys(a.speakers).length) L.push(`群聊发言人用量条数:${Object.entries(a.speakers).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    L.push('');
    L.push(`## Muse(判据:agentConfig.agentSlug='muse' 或 input.background='muse')`);
    L.push(a.muse.runs
      ? `run ${a.muse.runs}(其中 ${a.muse.withCalls.size} 个真发了模型调用,其余周期空转)  调用 ${a.muse.calls}  prompt ${fmt(a.muse.prompt)}(占总 ${pctOf(a.muse.prompt, a.totals.prompt)})  每次 ${fmt(Math.round(a.muse.prompt / (a.muse.calls || 1)))}  命中 ${pctOf(a.muse.knownCached, a.muse.knownPrompt)}`
      : '窗口内没有 Muse run(用户未开 Muse,或不在窗口里)');
    L.push('');
  } else {
    L.push('## 跨会话 / 按 agent / Muse —— **需要 state.db**');
    L.push('  导出 JSON 只含单个会话的时间线骨架(无 session_id、无 agentSlug、无工具结果正文),这三节不出数。');
    L.push('');
  }
  L.push('## 按模型');
  L.push(`${pad('模型', 34)}${rpad('调用', 6)}${rpad('prompt', 12)}${rpad('命中', 7)}${rpad('首调命中', 10)}${rpad('后续命中', 10)}`);
  for (const [k, v] of Object.entries(a.byModel).sort((x, y) => y[1].prompt - x[1].prompt)) {
    L.push(`${pad(String(k).slice(0, 33), 34)}${rpad(v.calls, 6)}${rpad(fmt(v.prompt), 12)}${rpad(pctOf(v.knownCached, v.knownPrompt), 7)}${rpad(v.first.n ? `${pctOf(v.first.cached, v.first.prompt)}/${v.first.n}` : '-', 10)}${rpad(v.later.n ? `${pctOf(v.later.cached, v.later.prompt)}/${v.later.n}` : '-', 10)}`);
  }
  L.push('');
  L.push('## 工具使用频率(E2 延迟候选的盈亏平衡:用到它的 run 占比 <2.3–3.1% 才值得延迟)');
  L.push(`${pad('工具', 26)}${rpad('用到的 run', 11)}${rpad('占 run', 8)}${rpad('调用次数', 9)}`);
  for (const [k, v] of Object.entries(a.toolRuns).sort((x, y) => y[1] - x[1])) {
    L.push(`${pad(String(k).slice(0, 25), 26)}${rpad(v, 11)}${rpad(pctOf(v, a.totals.runs), 8)}${rpad(a.toolCalls[k] || 0, 9)}`);
  }
  L.push('');
  L.push('## cache_probe(A2 探针;要 TANGU_CACHE_PROBE=1 + agentConfig.cacheProbe 双闸才有)');
  if (!a.probe.events) L.push('窗口内没有 cache_probe 事件 —— 探针未开,或这批数据早于它落地。');
  else {
    L.push(`探针事件 ${a.probe.events};其中后续调用 ${a.probe.laterCalls}`);
    L.push(`headHash 与同 (agentId, modelId) 上次**不同**:${a.probe.headDiffers}(${pctOf(a.probe.headDiffers, a.probe.headDiffers + a.probe.headSame)});相同 ${a.probe.headSame};无历史可比 ${a.probe.headNull}`);
    const ch = Object.entries(a.probe.changed).sort((x, y) => y[1] - x[1]);
    if (ch.length) L.push(`变化最频繁的段:${ch.map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  }
  return L.join('\n');
}
const fmt = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : String(Math.round(n)));

// ── 主(直接跑才执行;import 进来只拿 analyze,和 stall-timeline.mjs 同款守卫)──────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let loaded;
  try {
    loaded = FILE.endsWith('.json') ? fromExport(FILE) : await fromDb(FILE);
  } catch (e) {
    console.error(`读不了 ${FILE}:${e?.message || e}`);
    if (String(e?.code) === 'SQLITE_CANTOPEN' || /fileMustExist|no such file/i.test(String(e?.message))) {
      console.error(`缺省库是 dev 引擎的 ${DEFAULT_DB};安装版在 ~/.forsion/tangu/state.db。先 .backup 一份再跑更安全。`);
    }
    process.exit(2);
  }
  const a = analyze(loaded);
  if (AS_JSON) {
    const plain = { ...a, muse: { ...a.muse, withCalls: a.muse.withCalls.size }, byAgent: Object.fromEntries(Object.entries(a.byAgent).map(([k, v]) => [k, { ...v, runs: v.runs.size }])) };
    console.log(JSON.stringify({ file: FILE, source: loaded.source, since: SINCE, until: UNTIL, days: SINCE || UNTIL ? null : DAYS, ...plain }, null, 2));
  } else {
    console.log(report(a, { file: FILE, source: loaded.source, full: loaded.full }));
  }
  if (a.bucketSum !== a.uncachedTotal) process.exit(1); // 划分自检不过 = 脚本的 bug,别让它静默出错数
}
