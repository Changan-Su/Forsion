#!/usr/bin/env node
/** Read-only Muse delivery diagnosis; prints counts and dates, never message bodies or credentials.
 * node scripts/muse-delivery-report.mjs --db ~/.forsion/tangu/state.db --since 2026-11-07
 */
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
const { values } = parseArgs({ options: { db: { type: 'string' }, since: { type: 'string' } } });
if (!values.db || !/^\d{4}-\d{2}-\d{2}$/.test(values.since || '') || !Number.isFinite(Date.parse(values.since))) {
  throw new Error('Usage: --db <existing state.db> --since YYYY-MM-DD');
}
const db = new Database(values.db, { readonly: true, fileMustExist: true });
try {
  const runs = db.prepare(`SELECT id, status, created_at FROM agent_runs
    WHERE created_at >= ? AND json_valid(input) AND json_extract(input, '$.agentConfig.muse') = 1
    ORDER BY created_at`).all(values.since);
  const events = db.prepare(`SELECT payload FROM agent_run_events WHERE run_id = ? AND type = 'tool_call'`);
  const calls = {};
  for (const run of runs) for (const event of events.all(run.id)) {
    const name = JSON.parse(event.payload).name;
    if (typeof name === 'string') calls[name] = (calls[name] || 0) + 1;
  }
  const messages = db.prepare(`SELECT origin, COUNT(*) AS count, MAX(timestamp) AS latest
    FROM chat_messages WHERE agent_slug = 'muse' AND origin LIKE 'proactive%'
    GROUP BY origin`).all();
  console.log(JSON.stringify({
    since: values.since, cycles: runs.length,
    statuses: runs.reduce((all, r) => ({ ...all, [r.status]: (all[r.status] || 0) + 1 }), {}),
    latestCycle: runs.at(-1)?.created_at ?? null,
    sendAttempts: { message_user: calls.message_user || 0, inbox_send: calls.inbox_send || 0 },
    maintenanceCalls: { muse_space: calls.muse_space || 0, set_chat_starters: calls.set_chat_starters || 0 },
    // Stored messages cover all history; attempts above cover only --since.
    storedMessages: messages.map(r => ({ origin: r.origin, count: r.count, latestUtc: new Date(Number(r.latest)).toISOString() })),
  }, null, 2));
} finally { db.close(); }
