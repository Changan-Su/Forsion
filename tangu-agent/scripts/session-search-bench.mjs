#!/usr/bin/env node
/**
 * 会话搜索基准:在**真库**上量现状 SQL(services/sessionSearchSql.ts 管理路径的 LIKE + EXISTS),
 * 以及可选的合成数据对照(现状 vs sqlite FTS5 trigram),用于回答「搜索慢不慢 / 该不该换索引」。
 *
 *   node scripts/session-search-bench.mjs                      # 默认 ~/.forsion-dev/tangu/state.db(或 $TANGU_HOME/state.db),只读
 *   node scripts/session-search-bench.mjs path/to/state.db --q "记忆" --q "插件 electron"
 *   node scripts/session-search-bench.mjs --synthetic [会话数=2000] [每会话消息数=100]   # 内存库,现状 vs FTS5
 *
 * 2026-10-09 实测(dev 库 4448 条消息):五种查询含无命中最坏全部 ≤1.3ms;合成 20 万条时 LIKE 最坏 45ms,
 * FTS5 只在生僻词上赢、常见词更慢、trigram 索引 = 正文字节的 2.3-3.5x、短于 3 字的词返回空。结论:不换。
 * 什么时候重看:真库上下面打印的「最坏」超过 ~200ms(约 100 万条消息量级)。
 *
 * 这里的 SQL 是手抄 sessionSearchSql.ts 的管理路径;改了那边的查询形状记得同步,否则量的不是线上那条。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { default: Database } = await import('better-sqlite3');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1) && true : false; };
const flagValues = (name) => { const out = []; for (let i; (i = args.indexOf(name)) >= 0;) { out.push(args[i + 1]); args.splice(i, 2); } return out; };
const synthetic = flag('--synthetic');
const customQueries = flagValues('--q');

/** 与 services/sessionSearch.ts 的 likePattern 一致:小写 + 转义 \ % _ + 两侧通配。 */
const like = (t) => '%' + t.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const likeTerm = () => `(LOWER(COALESCE(s.title,'') || ' ' || COALESCE(s.summary,'')) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND LOWER(m.content) LIKE ? ESCAPE '\\'))`;
const ftsTerm = () => `(LOWER(COALESCE(s.title,'') || ' ' || COALESCE(s.summary,'')) LIKE ? ESCAPE '\\' OR s.id IN (SELECT f.session_id FROM chat_messages_fts f WHERE f.chat_messages_fts MATCH ?))`;
const sessionsSql = (perTerm) => `SELECT s.id FROM chat_sessions s WHERE s.user_id = ? AND s.app_id = ? AND s.kind = 'user' AND ${perTerm} ORDER BY s.updated_at DESC LIMIT 20`;

function timeit(stmt, params, n = 5) {
  stmt.all(...params);
  const t = process.hrtime.bigint();
  let rows;
  for (let i = 0; i < n; i++) rows = stmt.all(...params);
  return { ms: Number(process.hrtime.bigint() - t) / 1e6 / n, rows: rows.length };
}

const DEFAULT_QUERIES = [['记忆'], ['localStorage'], ['插件', 'electron'], ['zzqx不存在的词'], ['压缩的 sqlite 窗口']];
const queries = customQueries.length ? customQueries.map((q) => q.trim().split(/\s+/).filter(Boolean)) : DEFAULT_QUERIES;

if (!synthetic) {
  const file = args[0] || path.join(process.env.TANGU_HOME || path.join(os.homedir(), '.forsion-dev', 'tangu'), 'state.db');
  if (!fs.existsSync(file)) { console.error(`没有这个库: ${file}`); process.exit(2); }
  const db = new Database(file, { readonly: true });
  const n = db.prepare('SELECT count(*) n, sum(length(content)) c FROM chat_messages').get();
  const owner = db.prepare('SELECT user_id, app_id, count(*) n FROM chat_sessions GROUP BY 1, 2 ORDER BY n DESC LIMIT 1').get();
  console.log(`${file}\n消息 ${n.n} 条 / 正文 ${(n.c / 1e6).toFixed(1)}M 字;按会话最多的归属 (${owner.user_id}, ${owner.app_id}) 量现状 SQL(只读)`);
  let worst = 0;
  for (const terms of queries) {
    const stmt = db.prepare(sessionsSql(terms.map(likeTerm).join(' AND ')));
    const r = timeit(stmt, [owner.user_id, owner.app_id, ...terms.flatMap((t) => [like(t), like(t)])]);
    worst = Math.max(worst, r.ms);
    console.log(`  ${JSON.stringify(terms).padEnd(34)} ${r.ms.toFixed(1).padStart(7)} ms  ${r.rows} 行`);
  }
  console.log(`最坏 ${worst.toFixed(1)} ms ${worst < 200 ? '—— 不用动索引' : '—— 超过 200ms,该重看 FTS5(先跑 --synthetic 看代价)'}`);
  process.exit(0);
}

// ── 合成对照:现状 LIKE vs FTS5 trigram(体积 + 耗时 + 语义边角)──────────────────────────
const S = Number(args[0]) || 2000, M = Number(args[1]) || 100;
const db = new Database(':memory:');
db.exec(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, user_id TEXT, app_id TEXT, title TEXT, summary TEXT, archived INTEGER DEFAULT 0, kind TEXT DEFAULT 'user', updated_at TEXT);
CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER);
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id);`);
const zh = ['记忆', '插件', '会话', '搜索', '桌面', '引擎', '模型', '审批', '压缩', '语音', '图标', '商店', '同步', '日志', '测试'];
const en = ['memory', 'plugin', 'session', 'search', 'desktop', 'engine', 'model', 'approval', 'compaction', 'voice', 'icon', 'store', 'sync', 'log', 'test', 'localStorage', 'torrent', 'vite', 'electron', 'sqlite'];
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sentence = () => { let s = ''; for (let i = 0; i < 8; i++) s += (rnd() < 0.5 ? pick(zh) : ' ' + pick(en) + ' ') + (rnd() < 0.3 ? '的' : ''); return `${s} 然后我们看了一下 ${pick(en)} 相关的实现细节,大概是这样 ${Math.floor(rnd() * 1e6)}`; };
const is = db.prepare('INSERT INTO chat_sessions VALUES (?,?,?,?,?,?,?,?)'), im = db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?)');
db.transaction(() => {
  for (let s = 0; s < S; s++) {
    is.run(`s${s}`, 'u1', 'tangu', `${pick(zh)}${pick(en)} 话题 ${s}`, pick(zh), 0, 'user', `2026-${String(1 + s % 9).padStart(2, '0')}-${String(1 + s % 27).padStart(2, '0')} 10:00:00`);
    for (let m = 0; m < M; m++) im.run(`s${s}-m${m}`, `s${s}`, m % 2 ? 'model' : 'user', sentence(), 1e12 + s * 1e5 + m);
  }
})();
const sizeMB = () => db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size / 1e6;
const bytes = db.prepare('SELECT sum(length(CAST(content AS BLOB))) b FROM chat_messages').get().b;
const base = sizeMB();
let t0 = Date.now();
// 子串语义必须 detail=full(none/column 下 phrase MATCH 报错);自存 message_id 以免被 VACUUM 重编 rowid 拆散
db.exec(`CREATE VIRTUAL TABLE chat_messages_fts USING fts5(content, message_id UNINDEXED, session_id UNINDEXED, tokenize='trigram');
INSERT INTO chat_messages_fts(content, message_id, session_id) SELECT content, id, session_id FROM chat_messages;
INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('optimize');`);
console.log(`合成 ${S} 会话 × ${M} 消息 = ${S * M} 条,正文 ${(bytes / 1e6).toFixed(1)}MB;FTS5 trigram 建索引 ${Date.now() - t0}ms,索引 ${(sizeMB() - base).toFixed(1)}MB(= 正文的 ${((sizeMB() - base) / (bytes / 1e6)).toFixed(1)}x)\n`);
const q = (s) => '"' + s.replace(/"/g, '""') + '"';
for (const terms of queries) {
  const a = timeit(db.prepare(sessionsSql(terms.map(likeTerm).join(' AND '))), ['u1', 'tangu', ...terms.flatMap((t) => [like(t), like(t)])]);
  const b = timeit(db.prepare(sessionsSql(terms.map(ftsTerm).join(' AND '))), ['u1', 'tangu', ...terms.flatMap((t) => [like(t), q(t)])]);
  const short = terms.some((t) => [...t].length < 3);
  console.log(`  ${JSON.stringify(terms).padEnd(34)} 现状 LIKE ${a.ms.toFixed(1).padStart(6)} ms (${a.rows} 行) | FTS5 MATCH ${b.ms.toFixed(1).padStart(6)} ms (${b.rows} 行)${short ? '  ← 含 <3 字的词,trigram 搜不到,得回退 LIKE' : ''}`);
}
