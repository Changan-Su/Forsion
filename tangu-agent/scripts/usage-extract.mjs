#!/usr/bin/env node
/**
 * 从一个真实的引擎库里抽出「用量结构」,给 live-harness 的 `--only realuse --usage-db <抽取库>` 用(Muse 装备巡检吃真实用量)。
 * 只带:会话 / run 的归属字段(agentSlug / execMode / preset / groupChat)、工具名、调用时间;use_skill 另带技能 id。
 * 不带:对话内容、标题、工具参数与结果、用户 id。源库以只读方式打开,不会被改;输出库必须是个新路径。
 *
 *   node scripts/usage-extract.mjs ~/.forsion-dev/tangu/state.db /tmp/usage.db        # 近 95 天
 *   node scripts/usage-extract.mjs <源 state.db> <输出库> 30
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const [src, out, daysArg] = process.argv.slice(2);
const days = Number(daysArg) > 0 ? Math.floor(Number(daysArg)) : 95;
if (!src || !out) { console.error('usage: node scripts/usage-extract.mjs <source state.db> <new extract db> [days]'); process.exit(2); }
if (existsSync(out)) { console.error(`${out} already exists: pick a new path (the extract is never merged into an existing file)`); process.exit(2); }

const FIELDS = ['agentSlug', 'execMode', 'preset', 'groupChat'];
/** 只留归属字段;解析不了的当空。 */
const only = (json, at = (o) => o) => {
  let o = null;
  try { o = at(JSON.parse(json || 'null')); } catch { /* 不是 JSON */ }
  return JSON.stringify(Object.fromEntries(FIELDS.map((k) => [k, o?.[k] ?? null])));
};
const skillId = (args) => { try { return String(JSON.parse(typeof args === 'string' ? args : JSON.stringify(args ?? {}))?.skill_id || ''); } catch { return ''; } };

const from = new Database(src, { readonly: true, fileMustExist: true });
const to = new Database(out);
to.exec(`CREATE TABLE chat_sessions(id TEXT PRIMARY KEY, kind TEXT, agent_config TEXT);
  CREATE TABLE agent_runs(id TEXT PRIMARY KEY, session_id TEXT, status TEXT, input TEXT, created_at TEXT);
  CREATE TABLE agent_run_events(run_id TEXT, seq INTEGER, type TEXT, payload TEXT, created_at TEXT);`);
const since = `datetime('now','-${days} days')`;
// ponytail: 整表读进内存再写(几万行没问题);库再大就改成 iterate()。
const sessions = from.prepare('SELECT id, kind, agent_config FROM chat_sessions').all();
const runs = from.prepare(`SELECT id, session_id, status, input, created_at FROM agent_runs WHERE created_at >= ${since}`).all();
const events = from.prepare(`SELECT run_id, seq, json_extract(payload,'$.name') AS name, json_extract(payload,'$.arguments') AS args, created_at
  FROM agent_run_events WHERE type = 'tool_call' AND json_valid(payload) AND created_at >= ${since}`).all();
from.close();
to.transaction(() => {
  const s = to.prepare('INSERT INTO chat_sessions VALUES (?, ?, ?)');
  for (const r of sessions) s.run(r.id, r.kind, only(r.agent_config));
  const u = to.prepare('INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?)');
  for (const r of runs) u.run(r.id, r.session_id, r.status, JSON.stringify({ agentConfig: JSON.parse(only(r.input, (o) => o?.agentConfig)) }), r.created_at);
  const e = to.prepare("INSERT INTO agent_run_events VALUES (?, ?, 'tool_call', ?, ?)");
  for (const r of events) {
    if (typeof r.name !== 'string' || !r.name) continue;
    e.run(r.run_id, r.seq, JSON.stringify({ name: r.name, arguments: r.name === 'use_skill' ? JSON.stringify({ skill_id: skillId(r.args) }) : '{}' }), r.created_at);
  }
})();
const n = (t) => to.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log(`extract written: ${n('chat_sessions')} sessions, ${n('agent_runs')} runs, ${n('agent_run_events')} tool calls (last ${days} days) → ${out}`);
to.close();
