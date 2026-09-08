#!/usr/bin/env node
/**
 * 「秒数去哪了」归属器:把每个 run 的事件时间线按「前一事件之后处于什么状态」切成桶,回答用户报的
 * 「任务中间卡住 / 慢」到底是在等模型首帧、模型生成、跑工具、还是等审批。
 *
 *   node scripts/stall-timeline.mjs ~/.forsion/tangu/state.db [days=60]   # 直接读 SQLite(只读打开)
 *   node scripts/stall-timeline.mjs tangu-session-xxxx.json               # 设置→高级→导出日志(含 timeline)
 *
 * 桶:llm_wait(等首帧,含上传)/ stream(生成:token+reasoning+工具参数)/ tool / approval / inquiry /
 *     retry / compaction / queue / post_llm。usage 事件带 ttftMs/uploadMs/requestBytes(≥ 2.9.8 引擎)时
 *     按测量值报首帧与上传;老数据退回事件间隙(秒级精度)。
 * 2026-09-06 本机取证:llm_wait 52% / stream 43% / tool 2%(见 docs/Log/v2.0_2026-09-06.md)。
 * attribute()/collapse()/stateAfter() 是纯函数,test/stallTimeline.test.ts 钉它们。
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STREAM = new Set(['token', 'reasoning', 'tool_stream']);

/** 事件 e 之后、下一事件 n 之前,run 处于什么状态。 */
export function stateAfter(e, n) {
  switch (e.type) {
    case 'tool_call': return n?.type === 'approval_request' ? 'approval' : 'tool';
    case 'approval_request': return 'approval';
    case 'inquiry_request': return 'inquiry';
    case 'approval_result': case 'inquiry_result': return 'tool';
    case 'tool_result': return n && (n.type === 'tool_result' || n.type === 'subagent') ? 'tool' : 'llm_wait';
    case 'subagent': return 'tool';
    case 'status':
      if (e.phase === 'generating') return 'stream';
      if (e.phase === 'llm_retry') return 'retry';
      if (e.phase === 'compacting') return 'compaction';
      if (e.phase === 'queued') return 'queue';
      return 'llm_wait';
    case 'usage': return 'post_llm';
    default: return STREAM.has(e.type) ? 'stream' : 'llm_wait';
  }
}

/** 连续同类的流式帧折叠成一段 {type,t,tEnd,n};其余事件原样。输入须按 seq 有序,t 为毫秒。 */
export function collapse(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (STREAM.has(e.type)) {
      if (last && last.type === e.type && last.n) { last.tEnd = e.t; last.n++; continue; }
      out.push({ ...e, tEnd: e.t, n: 1 });
      continue;
    }
    out.push(e);
  }
  return out;
}

/** runs: [{ id, model, created(ms), events: collapse() 后的事件 }] → 各桶毫秒、每模型分位原料、工具耗时、审批等待、最长间隙。 */
export function attribute(runs) {
  const tot = {}; const gaps = {}; const big = []; const perRun = []; const perModel = {}; const tools = {};
  const approvals = []; let unanswered = 0;
  const add = (k, dt) => { tot[k] = (tot[k] || 0) + dt; (gaps[k] ||= []).push(dt); };
  for (const r of runs) {
    const es = r.events || [];
    if (!es.length) continue;
    const m = r.model || '?';
    const pm = (perModel[m] ||= { n: 0, ttft: [], ttftMeasured: [], upload: [], prompt: [], cached: [], silent: [] });
    pm.n++;
    let silent = 0; let stream = 0;
    for (let i = 0; i < es.length; i++) {
      const e = es[i]; const n = es[i + 1];
      const span = (e.tEnd ?? e.t) - e.t; // 折叠流段自身的时长
      if (span > 0) { add('stream', span); stream += span; }
      if (e.type === 'usage') {
        if (e.prompt) { pm.prompt.push(e.prompt); pm.cached.push((e.cached || 0) / e.prompt); }
        if (e.ttftMs != null) pm.ttftMeasured.push(e.ttftMs);
        if (e.uploadMs != null) pm.upload.push(e.uploadMs);
      }
      if (e.type === 'tool_result' && e.elapsedMs != null) (tools[e.name || '?'] ||= []).push(e.elapsedMs);
      if (e.type === 'approval_request') {
        const res = es.slice(i + 1).find((x) => x.type === 'approval_result');
        if (res) approvals.push(res.t - e.t); else unanswered++;
      }
      if (!n) break;
      const dt = n.t - (e.tEnd ?? e.t);
      if (dt < 0) continue;
      const k = stateAfter(e, n);
      add(k, dt);
      if (k === 'stream') stream += dt;
      if (k === 'llm_wait') {
        silent += dt;
        if (STREAM.has(n.type) || n.type === 'tool_call' || (n.type === 'status' && n.phase === 'generating')) pm.ttft.push(dt);
      }
      if (dt >= 10_000) big.push({ dt, k, model: m, run: r.id, from: e.type, to: n.type, phase: n.phase });
    }
    const last = es[es.length - 1];
    perRun.push({ id: r.id, model: m, wall: (last.tEnd ?? last.t) - (r.created ?? es[0].t), silent, stream });
    pm.silent.push(silent);
  }
  big.sort((a, b) => b.dt - a.dt);
  return { tot, gaps, big, perRun, perModel, tools, approvals, unanswered };
}

// ── 装载:SQLite / 导出 JSON ─────────────────────────────────────────────────
const parseTs = (v) => {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? '');
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z'); // SQLite CURRENT_TIMESTAMP=无时区 UTC
};
const pick = (type, p) => {
  switch (type) {
    case 'tool_call': case 'approval_request': return { name: p?.name };
    case 'tool_result': return { name: p?.name, elapsedMs: p?.elapsedMs, isError: !!p?.isError };
    case 'status': return { phase: p?.phase ?? p?.state, stage: p?.stage, bytes: p?.bytes, uploadMs: p?.uploadMs };
    case 'usage': return { prompt: p?.prompt, cached: p?.cached, ttftMs: p?.ttftMs, uploadMs: p?.uploadMs, llmMs: p?.llmMs, requestBytes: p?.requestBytes };
    case 'error': return { error: String(p?.error ?? '').slice(0, 120) };
    default: return {};
  }
};

async function fromDb(file, days) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const runs = db.prepare(`SELECT id, model_id, status, error, created_at FROM agent_runs WHERE created_at > datetime('now', ?) ORDER BY created_at`).all(`-${days} days`);
  const evq = db.prepare(`SELECT seq, type, CASE WHEN type IN ('token','reasoning','tool_stream') THEN NULL ELSE payload END AS payload, created_at FROM agent_run_events WHERE run_id = ? ORDER BY seq`);
  return runs.map((r) => ({
    id: r.id, model: r.model_id, status: r.status, error: r.error, created: parseTs(r.created_at),
    events: collapse(evq.all(r.id).map((row) => {
      let p = null;
      if (row.payload) { try { p = JSON.parse(row.payload); } catch { /* ignore */ } }
      return { seq: row.seq, type: row.type, t: parseTs(row.created_at), ...pick(row.type, p) };
    })),
  }));
}

function fromExport(file) {
  const j = JSON.parse(readFileSync(file, 'utf-8'));
  const runs = Array.isArray(j.timeline) ? j.timeline : (j.timeline?.runs || []);
  if (!runs.length) throw new Error('导出里没有 timeline(需要 ≥ 2.9.8 的桌面端导出)');
  return runs.map((r) => ({
    id: r.id, model: r.model_id, status: r.status, error: r.error, created: parseTs(r.created_at),
    events: (r.events || []).map((e) => ({ ...e, t: parseTs(e.t), ...(e.tEnd ? { tEnd: parseTs(e.tEnd) } : {}) })),
  }));
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const pct = (xs, q) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))]; };
const sec = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(0) : '-');
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function report(runs) {
  const r = attribute(runs);
  const T = Object.values(r.tot).reduce((a, b) => a + b, 0) || 1;
  const lines = [];
  lines.push(`runs=${runs.length}  状态: ${Object.entries(runs.reduce((a, x) => ((a[x.status || '?'] = (a[x.status || '?'] || 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  lines.push('\n## 墙钟归属(全部 run 求和)');
  for (const [k, v] of Object.entries(r.tot).sort((a, b) => b[1] - a[1])) {
    const g = r.gaps[k];
    lines.push(`${k.padEnd(11)} ${sec(v).padStart(7)}s ${(100 * v / T).toFixed(1).padStart(5)}%  间隙≥10s:${String(g.filter((x) => x >= 10_000).length).padStart(4)}  ≥30s:${String(g.filter((x) => x >= 30_000).length).padStart(4)}  ≥60s:${String(g.filter((x) => x >= 60_000).length).padStart(3)}`);
  }
  const silent = r.perRun.map((x) => x.silent); const wall = r.perRun.map((x) => x.wall);
  lines.push(`\n每 run 墙钟 p50=${sec(pct(wall, 0.5))}s p90=${sec(pct(wall, 0.9))}s;静默(等首帧)p50=${sec(pct(silent, 0.5))}s p90=${sec(pct(silent, 0.9))}s;静默≥60s 的 run ${silent.filter((x) => x >= 60_000).length}/${silent.length}`);
  lines.push('\n## 每模型:首帧 p50/p90(测量值优先,否则事件间隙)| 上传 p50 | prompt p50/p90 | 缓存命中 | 每 run 静默 p50/p90');
  for (const [m, pm] of Object.entries(r.perModel).sort((a, b) => b[1].n - a[1].n)) {
    const tt = pm.ttftMeasured.length ? pm.ttftMeasured : pm.ttft;
    lines.push(`${m.padEnd(40)} n=${String(pm.n).padStart(3)} 首帧 ${sec(pct(tt, 0.5)).padStart(3)}/${sec(pct(tt, 0.9)).padStart(3)}s${pm.ttftMeasured.length ? '' : '(间隙)'} | 上传 ${sec(pct(pm.upload, 0.5))}s | prompt ${Math.round(pct(pm.prompt, 0.5) || 0)}/${Math.round(pct(pm.prompt, 0.9) || 0)} | 缓存 ${(100 * (mean(pm.cached) || 0)).toFixed(0)}% | 静默 ${sec(pct(pm.silent, 0.5))}/${sec(pct(pm.silent, 0.9))}s`);
  }
  lines.push('\n## 工具耗时(秒)');
  for (const [name, xs] of Object.entries(r.tools).sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).slice(0, 12)) {
    lines.push(`${name.padEnd(22)} n=${String(xs.length).padStart(4)} sum=${sec(xs.reduce((a, b) => a + b, 0)).padStart(6)} p50=${(pct(xs, 0.5) / 1000).toFixed(1).padStart(6)} p90=${(pct(xs, 0.9) / 1000).toFixed(1).padStart(6)} max=${(Math.max(...xs) / 1000).toFixed(1).padStart(6)}`);
  }
  lines.push(`\n## 审批:请求 ${r.approvals.length + r.unanswered},未应答 ${r.unanswered},等待 p50=${sec(pct(r.approvals, 0.5))}s max=${sec(Math.max(0, ...r.approvals))}s`);
  lines.push('\n## 最长间隙 top 20');
  for (const b of r.big.slice(0, 20)) lines.push(`${sec(b.dt).padStart(5)}s ${b.k.padEnd(10)} ${String(b.model).slice(0, 28).padEnd(28)} run=${String(b.run).slice(0, 8)} ${b.from}->${b.to}${b.phase ? ' ' + b.phase : ''}`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('用法: node scripts/stall-timeline.mjs <state.db|导出.json> [days=60]'); process.exit(2); }
  const runs = file.endsWith('.json') ? fromExport(file) : await fromDb(file, Number(process.argv[3]) || 60);
  console.log(report(runs));
}
