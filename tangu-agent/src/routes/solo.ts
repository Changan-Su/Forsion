/**
 * 私聊(Agent 轨道 / 独立 State)会话端点 —— host-only(与 routes/agents.ts 的 ensureLocal 同形,云端 404)。
 *   POST /agent/solo/:kind/:id/open    → { session, created }  该 Agent / 外部引擎的活动私聊会话;没有就建一条
 *   POST /agent/solo/:kind/:id/rotate  → { session, memory }   「新会话(先总结记忆)」:旧会话有活动 run → 409;
 *                                         Agent:强制 Historian 采一次候选(后台,含标题/摘要)→ 归档旧会话 → 建新 → 候选采完后 Dream 整固
 *                                         引擎:没有 Tangu 记忆,只归档 + 建新(memory:'none')
 * kind = 'agent' | 'engine'。会话形状(方案 §5.1):kind='user' + projectless + agent_config{ soloAgentSlug | soloEngineId,
 * execMode:'host', cwd:<Library>, preset:null };轨道身份键由 routes/sessions.ts 的锁与 agentLoop 的条件绑定钉死。
 * 单点建会话:多窗口/多设备同时点头像也只会得到同一条活动会话(先查后建,与 open 同一条查询)。
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync } from 'node:fs';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { query, getDbType, getNowSql } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { getAgent, isValidSlug, libDirOf, resolveMemorySlug } from '../agents/agentRegistry.js';
import { engineLibDir } from '../core/tanguHome.js';
import { SESSION_COLS, rowToSession } from './sessions.js';
import { forceHistorianForSession } from '../services/localHistorian.js';
import { startMemoryDream } from '../services/memoryDream.js';
import { withKeyLock } from '../core/keyLock.js';

const router = Router();
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
type SoloKind = 'agent' | 'engine';

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: '私聊仅在本地(桌面/TUI)可用' });
    return false;
  }
  return true;
}

/** 解析路径参数:agent 要存在于本地 agents 目录;engine 要在引擎管理器里注册。返回建会话所需的三样东西。 */
async function resolveSolo(kind: string, id: string): Promise<{ kind: SoloKind; title: string; cwd: string; agentConfig: Record<string, unknown>; modelId: string | null; memSlug: string | null } | null> {
  if (kind === 'agent') {
    if (!isValidSlug(id)) return null;
    const def = await getAgent(id);
    if (!def) return null;
    const cwd = def.libraryDir || libDirOf(id);
    return {
      kind, title: def.name, cwd, memSlug: resolveMemorySlug(def),
      modelId: def.model || null,
      agentConfig: { soloAgentSlug: id, agentSlug: id, execMode: 'host', cwd, preset: null },
    };
  }
  if (kind === 'engine') {
    if (!ENGINE_ID_RE.test(id)) return null;
    const engines = deps().engines;
    if (!engines?.has(id)) return null;
    const item = engines.list().find((e) => e.id === id);
    const cwd = engineLibDir(id);
    return {
      kind, title: item?.name || id, cwd, memSlug: null, modelId: null,
      agentConfig: { soloEngineId: id, engineId: id, execMode: 'host', cwd, preset: null },
    };
  }
  return null;
}

/** 活动私聊会话:未归档 + kind='user' + agent_config 里的轨道身份键等于 id(按方言取 JSON;不写 COALESCE 默认值——
 *  历史会话缺键就是不是私聊,绝不能把它们算进默认 agent 的私聊集合)。 */
async function activeSolo(userId: string, appId: string, kind: SoloKind, id: string): Promise<any | null> {
  const key = kind === 'agent' ? 'soloAgentSlug' : 'soloEngineId';
  const pred = getDbType() === 'sqlite'
    ? `(agent_config IS NOT NULL AND json_valid(agent_config) AND json_type(agent_config) = 'object' AND json_extract(agent_config, '$.${key}') = ?)`
    : `(agent_config IS NOT NULL AND jsonb_typeof(agent_config) = 'object' AND (agent_config ->> '${key}') = ?)`;
  const rows = await query<any[]>(
    `SELECT ${SESSION_COLS} FROM chat_sessions WHERE user_id = ? AND app_id = ? AND archived = ? AND kind = 'user' AND ${pred}
     ORDER BY updated_at DESC LIMIT 1`,
    [userId, appId, false, id],
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

async function hasActiveRun(sessionId: string): Promise<boolean> {
  const rows = await query<any[]>(`SELECT 1 FROM agent_runs WHERE session_id = ? AND status IN ('queued','running') LIMIT 1`, [sessionId]);
  return rows.length > 0;
}

async function createSolo(userId: string, appId: string, r: NonNullable<Awaited<ReturnType<typeof resolveSolo>>>): Promise<any> {
  try { mkdirSync(r.cwd, { recursive: true }); } catch { /* 目录建不了也让会话建起来:cwd 缺失时 fs 工具会按越界/不存在报错,可见可修 */ }
  const id = uuidv4();
  await query(
    `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, emoji, project_path, project_name, projectless, agent_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, appId, r.title.slice(0, 200), r.modelId || deps().profile.defaultModelId || null, null, null, null, true, JSON.stringify(r.agentConfig)],
  );
  const rows = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [id]);
  return rowToSession(rows[0]);
}

router.post('/agent/solo/:kind/:id/open', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const appId = deps().profile.appId;
    const r = await resolveSolo(req.params.kind, req.params.id);
    if (!r) return res.status(404).json({ detail: 'unknown agent or engine' });
    // 先查后建按 (user, kind, id) 串行:两个窗口同时点头像只得一条(creview 09-16 P1)。
    const out = await withKeyLock(`solo:${userId}:${r.kind}:${req.params.id}`, async () => {
      const cur = await activeSolo(userId, appId, r.kind, req.params.id);
      if (cur) return { session: cur, created: false };
      return { session: await createSolo(userId, appId, r), created: true };
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'solo open failed' });
  }
});

router.post('/agent/solo/:kind/:id/rotate', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const appId = deps().profile.appId;
    const r = await resolveSolo(req.params.kind, req.params.id);
    if (!r) return res.status(404).json({ detail: 'unknown agent or engine' });
    await withKeyLock(`solo:${userId}:${r.kind}:${req.params.id}`, async () => {
    const cur = await activeSolo(userId, appId, r.kind, req.params.id);
    if (cur && (await hasActiveRun(cur.id))) { res.status(409).json({ detail: 'run_active' }); return; }
    // 记忆:只有 Agent 私聊有 Tangu 记忆。强制采候选在后台跑(Historian 自带 90s 预算与并发上限),采完再 Dream 整固;
    // 本地 Historian 不跳过 archived,先归档不影响它;客户端拿到新会话即可继续,采集状态经 memory 字段告知。
    let memory: 'queued' | 'skipped' | 'none' = 'none';
    if (cur && r.kind === 'agent' && r.memSlug) {
      const started = forceHistorianForSession(cur.id, userId, r.memSlug);
      memory = started ? 'queued' : 'skipped';
      if (started) void started.then((ran) => { if (ran) startMemoryDream(userId, r.memSlug!); }).catch(() => {});
    }
    if (cur) await query(`UPDATE chat_sessions SET archived = ?, updated_at = ${getNowSql()} WHERE id = ?`, [true, cur.id]);
    res.json({ session: await createSolo(userId, appId, r), memory });
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'solo rotate failed' });
  }
});

export default router;
