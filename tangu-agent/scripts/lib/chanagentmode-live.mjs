/**
 * 通道 run 按 Agent 自己设的审批档收紧 —— live-harness 的 `chanagentmode` 场景(11-14)。
 *
 * 通道 run 的生效档 = 通道设置、绑定、Agent 自己的档(设了才算)三者里最严的。用 standin 场景同一个多联系人假通道插件
 * (文件收发),通道设置放成完全放行,三个联系人各开一个会话、各问一句「在工作目录里写一个文件」:
 *   【ro】     通道缺省 Agent = 自己设了只读、关了分身 → 写之前要批(台架拒掉)、文件没写出来;
 *   【standin】通道缺省 Agent = 自己设了只读、分身开着(缺省)→ 这轮由分身跑,分身自己不带档,按本体的只读 → 同上;
 *   【plain】  对照:通道缺省 Agent 没设档、关了分身 → 照通道的完全放行,不问就写出来。
 * 负对照(--kind neg,还原 agentLoop 里那一处收紧):ro / standin 两条应当红(不问就写了)。
 * 自检(不用模型):`node scripts/lib/chanagentmode-live.mjs`。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { KIND } from './standin-live.mjs';

export const AGENTS = {
  ro: { slug: 'live-mode-ro', approvalMode: 'readonly', standInOff: ['im', 'plugin'] },
  standin: { slug: 'live-mode-body', approvalMode: 'readonly' },
  plain: { slug: 'live-mode-plain', standInOff: ['im', 'plugin'] },
};

/** 判一条腿。blocked = 期望被拦(问了且没写);否则期望照通道档(没问、写了)。 */
export function gradeLeg(leg, blocked) {
  if (!leg || leg.error) return { ok: false, why: leg?.error || '没跑' };
  const tried = (leg.toolCalls || []).some((n) => n === 'write_file' || n === 'run_bash' || n === 'edit_file' || n === 'apply_patch');
  if (!tried) return { ok: false, inconclusive: true, why: '模型没去写(没调写类工具),判不了' };
  if (blocked) {
    const ok = leg.approvals >= 1 && !leg.written;
    return { ok, why: ok ? `要批 ${leg.approvals} 次、文件没写` : `审批 ${leg.approvals} 次、文件${leg.written ? '写出来了' : '没写'}` };
  }
  const ok = leg.approvals === 0 && leg.written;
  return { ok, why: ok ? '没问、写出来了' : `审批 ${leg.approvals} 次、文件${leg.written ? '写出来了' : '没写'}` };
}

export async function chanAgentModeLive(h) {
  const { api, sleep, until, MODEL, dbPath, inbox, outbox, followRun, OUT } = h;
  const log = (m) => console.log(`  [chanagentmode] ${m}`);
  const { default: Database } = await import('better-sqlite3');
  const db = () => new Database(dbPath, { readonly: true, fileMustExist: true });
  const sessionOf = (peer) => { const d = db(); try { return d.prepare('SELECT session_id FROM tangu_wechat_bindings WHERE channel = ? AND peer_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(KIND, peer)?.session_id || null; } finally { d.close(); } };
  const runsOf = (sid) => { const d = db(); try { return d.prepare('SELECT id FROM agent_runs WHERE session_id = ? ORDER BY created_at').all(sid); } finally { d.close(); } };
  const cfgOf = (sid) => { const d = db(); try { const raw = d.prepare('SELECT agent_config FROM chat_sessions WHERE id = ?').get(sid)?.agent_config; return raw ? JSON.parse(raw) : {}; } catch { return {}; } finally { d.close(); } };

  for (const a of Object.values(AGENTS)) {
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: a.slug, name: a.slug, description: 'live harness', systemPrompt: 'You are a helpful assistant. Do exactly what the user asks, then reply briefly.', ...(a.approvalMode ? { approvalMode: a.approvalMode } : {}) }) });
    if (a.standInOff) await api(`/agent/agents/${a.slug}`, { method: 'PATCH', body: JSON.stringify({ standInOff: a.standInOff }) });
  }

  let seq = 0;
  const leg = async (key) => {
    const a = AGENTS[key];
    const peer = `mode-${key}-${Date.now().toString(36)}`;
    const file = `note-${key}-${Math.random().toString(36).slice(2, 8)}.txt`;
    // 通道缺省 Agent 换成这条腿的;新联系人的第一句建会话时取它。通道档放成最松,看 Agent 那层收不收紧
    await api(`/agent/channels/${KIND}/config`, { method: 'PUT', body: JSON.stringify({ enabled: true, sessions: true, agentSlug: a.slug, modelId: MODEL, approvalMode: 'full-auto' }) });
    await sleep(1500);
    const text = `Use the write_file tool to create a file named ${file} in the current working directory, with the content "hello". Do only this one thing, then reply "done".`;
    const outBefore = readFileSync(outbox, 'utf8').length;
    appendFileSync(inbox, JSON.stringify({ peer, text, id: `cm${++seq}-${Date.now()}` }) + '\n');
    const runId = await until(() => { const sid = sessionOf(peer); if (!sid) return null; const r = runsOf(sid)[0]; return r ? r.id : null; }, 60_000, 500);
    if (!runId) {
      const tail = readFileSync(outbox, 'utf8').slice(outBefore);
      return { key, peer, error: `没起 run(驱动收到的回复:${tail.slice(0, 300) || '无'})` };
    }
    const ev = await followRun(runId, 300_000, { approve: false }); // 审批一律拒 = 通道里的人没点批准
    await sleep(1500);
    const sid = sessionOf(peer);
    const cfg = cfgOf(sid);
    const cwd = String(cfg.cwd || '');
    const written = !!cwd && existsSync(join(cwd, file));
    return { key, peer, runId, sessionId: sid, agentSlug: cfg.agentSlug || null, cwd, file, written, approvals: ev.approvals, toolCalls: ev.toolCalls,
      toolResults: ev.toolResults.map((r) => ({ name: r.name, isError: r.isError, result: r.full.slice(0, 600) })), content: ev.content, error: ev.error };
  };

  const legs = {};
  for (const key of ['ro', 'standin', 'plain']) {
    legs[key] = await leg(key);
    log(`${key}:${legs[key].error || `agent ${legs[key].agentSlug} · 审批 ${legs[key].approvals} · 写了 ${legs[key].written} · ${String(legs[key].content || '').slice(0, 80)}`}`);
  }
  const g = { ro: gradeLeg(legs.ro, true), standin: gradeLeg(legs.standin, true), plain: gradeLeg(legs.plain, false) };
  const standInUsed = /-standin-/.test(String(legs.standin.agentSlug || ''));
  const ok = g.ro.ok && g.standin.ok && g.plain.ok && standInUsed;
  const inconclusive = !ok && Object.values(g).some((x) => x.inconclusive);
  writeFileSync(join(OUT, 'chanagentmode-evidence.json'), JSON.stringify({ model: MODEL, legs, grade: g, standInUsed }, null, 2));
  return {
    ok,
    ...(inconclusive ? { inconclusive: true } : {}),
    detail: `ro(Agent 只读、通道完全放行):${g.ro.ok ? '✓' : '✗'}${g.ro.why};standin(本体只读、分身跑):${g.standin.ok ? '✓' : '✗'}${g.standin.why}${standInUsed ? '' : ' · ✗这轮没换成分身'};plain(对照,Agent 没设档):${g.plain.ok ? '✓' : '✗'}${g.plain.why}`,
    output: Object.values(legs).map((l) => `【${l.key}】${l.agentSlug || ''} · 工具 ${(l.toolCalls || []).join(',') || '无'} · 审批 ${l.approvals ?? '?'} · 写了 ${l.written}${l.error ? ` · 出错 ${l.error}` : ''}\n→ ${l.content || ''}\n工具结果:${(l.toolResults || []).map((r) => r.result.slice(0, 200)).join(' | ')}`).join('\n\n'),
    toolCalls: Object.values(legs).flatMap((l) => l.toolCalls || []),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = { toolCalls: ['write_file'], approvals: 0, written: false };
  assert.equal(gradeLeg({ ...base, approvals: 1 }, true).ok, true);
  assert.equal(gradeLeg({ ...base, written: true }, true).ok, false); // 没问就写了 = 漏
  assert.equal(gradeLeg({ ...base, approvals: 1, written: true }, true).ok, false);
  assert.equal(gradeLeg({ ...base, written: true }, false).ok, true);
  assert.equal(gradeLeg({ ...base, approvals: 1 }, false).ok, false); // 对照被拦了 = 收紧过头
  assert.equal(gradeLeg({ ...base, toolCalls: [] }, true).inconclusive, true);
  assert.equal(gradeLeg({ error: 'x' }, true).ok, false);
  console.log('chanagentmode-live self-check ok');
}
