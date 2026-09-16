/**
 * 独立团队(Agent 轨道的持久团队实体)—— host-only,镜像 routes/agents.ts 的形状(云端 404,不做半可用)。
 *   GET    /agent/teams                     → { teams }
 *   GET    /agent/teams/:slug               → { team }
 *   POST   /agent/teams                     → { team }   members(≥2)必填;name 可省(缺省 = 成员名相连);slug 唯一化(撞了递增后缀),更新走 PATCH
 *   PATCH  /agent/teams/:slug               → { team }   逐字段合并
 *   DELETE /agent/teams/:slug               → { ok }     只删定义与 Library;历史会话留着(teamSlug 指向已删团队 = 归档口径由客户端定)
 *   GET/PUT /agent/teams-meta               → { order }
 *   POST   /agent/teams/:slug/session/open  → { session, created }  该团队的活动会话,没有就建(§6.1 形状,与 solo/open 同形)
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { mkdirSync } from 'node:fs';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { query, getDbType } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { isValidSlug, slugify, getAgent } from '../agents/agentRegistry.js';
import { listTeams, getTeam, saveTeam, deleteTeam, readTeamsMeta, writeTeamsMeta, type TeamDef } from '../agents/teamRegistry.js';
import { SESSION_COLS, rowToSession } from './sessions.js';
import { withKeyLock } from '../core/keyLock.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: '团队仅在本地(桌面/TUI)可用' });
    return false;
  }
  return true;
}

router.get('/agent/teams', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try { res.json({ teams: await listTeams() }); } catch (e: any) { res.status(500).json({ detail: e?.message || 'list teams failed' }); }
});

router.get('/agent/teams-meta', authMiddleware, (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  res.json(readTeamsMeta());
});
router.put('/agent/teams-meta', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try { res.json(await writeTeamsMeta({ order: Array.isArray(req.body?.order) ? req.body.order : undefined })); }
  catch (e: any) { res.status(400).json({ detail: e?.message || 'write meta failed' }); }
});

router.get('/agent/teams/:slug', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  const team = await getTeam(req.params.slug);
  if (!team) return res.status(404).json({ detail: 'team not found' });
  res.json({ team });
});

/** 成员必须都能由本地 registry 解析(云端定义 / 已删 agent 存进去 = 首条消息就 group_needs_2_agents)。返回第一个解析不到的 slug。 */
async function unresolvedMember(members: unknown): Promise<string | null> {
  if (!Array.isArray(members)) return null;
  for (const m of members) {
    const slug = String((m as any)?.slug || '').trim();
    if (!slug) continue;
    if (!isValidSlug(slug) || !(await getAgent(slug))) return slug;
  }
  return null;
}

/** 团队名缺省 = 成员名相连(用户 09-16:名称不必填,给个按 Agent 名生成的缺省;将来若从项目里建团队再 `+ 项目`)。 */
export async function defaultTeamName(members: Array<{ slug?: string }>, project?: string): Promise<string> {
  const names: string[] = [];
  for (const m of members) {
    const slug = String(m?.slug || '').trim();
    if (!slug) continue;
    const def = await getAgent(slug).catch(() => null);
    names.push(def?.name || slug);
  }
  const base = names.join(' & ');
  return (project ? `${base} @ ${project}` : base).slice(0, 100);
}

router.post('/agent/teams', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (!Array.isArray(b.members)) return res.status(400).json({ detail: 'members 必填' });
    const missing = await unresolvedMember(b.members);
    if (missing) return res.status(400).json({ detail: `member not found locally: ${missing}` });
    const name = String(b.name || '').trim() || await defaultTeamName(b.members, typeof b.project === 'string' ? b.project.trim() : '');
    if (!name) return res.status(400).json({ detail: 'members 必填' });
    // slug 唯一化 + 落盘串行:两个同名 POST 不会选中同一个 slug 互相覆盖(creview 09-16 P1)。
    const team = await withKeyLock('team:create', async () => {
      // 中文 / emoji 名 slugify 后为空 → 落到固定基名再加序号(slugify 自己的空回落是 'agent',是 agent 语义,团队不借)。
      const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
      let slug = typeof b.slug === 'string' && isValidSlug(b.slug) ? b.slug : (ascii ? slugify(name) : 'team');
      if (await getTeam(slug)) {
        const base = slug.slice(0, 60);
        let n = 2;
        while (await getTeam(`${base}-${n}`)) n++;
        slug = `${base}-${n}`;
      }
      return saveTeam({ slug, name, description: b.description, lead: b.lead, avatar: b.avatar, members: b.members, doc: b.doc });
    });
    res.json({ team });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'create team failed' });
  }
});

router.patch('/agent/teams/:slug', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const existing = await getTeam(req.params.slug);
    if (!existing) return res.status(404).json({ detail: 'team not found' });
    const b = req.body || {};
    const missing = await unresolvedMember(b.members);
    if (missing) return res.status(400).json({ detail: `member not found locally: ${missing}` });
    const team = await saveTeam({
      slug: existing.slug, name: b.name != null && String(b.name).trim() ? String(b.name) : existing.name,
      description: b.description, lead: b.lead, avatar: b.avatar,
      members: Array.isArray(b.members) ? b.members : undefined, doc: b.doc != null ? String(b.doc) : undefined,
    });
    res.json({ team });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'update team failed' });
  }
});

router.delete('/agent/teams/:slug', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  const team = await getTeam(req.params.slug);
  if (!team) return res.status(404).json({ detail: 'team not found' });
  try {
    const userId = req.user!.userId;
    const appId = deps().profile.appId;
    const pred = teamSlugPredicate('s');
    // 有活动 run 的团队不能删(fs.rm 掉正在用的 cwd = run 在已删目录上失败或写出残留);409 让前端提示先停掉。
    const active = await query<any[]>(
      `SELECT 1 FROM agent_runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = ? AND s.app_id = ? AND r.status IN ('queued','running') AND ${pred} LIMIT 1`,
      [userId, appId, team.slug],
    );
    if (active.length) return res.status(409).json({ detail: 'run_active' });
    const ok = await deleteTeam(team.slug);
    if (!ok) return res.status(500).json({ detail: 'delete failed (files still in use?)' });
    // 历史会话保留但归档(只读口径):它们的 cwd 已经没了,再发消息只会在不存在的目录上失败。
    await query(`UPDATE chat_sessions SET archived = ? WHERE user_id = ? AND app_id = ? AND kind = 'user' AND ${teamSlugPredicate('chat_sessions')}`, [true, userId, appId, team.slug]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete team failed' });
  }
});

function teamSlugPredicate(alias: string): string {
  const col = `${alias}.agent_config`;
  return getDbType() === 'sqlite'
    ? `(${col} IS NOT NULL AND json_valid(${col}) AND json_type(${col}) = 'object' AND json_extract(${col}, '$.teamSlug') = ?)`
    : `(${col} IS NOT NULL AND jsonb_typeof(${col}) = 'object' AND (${col} ->> 'teamSlug') = ?)`;
}

/** 独立团队会话形状(方案 §6.1):projectless + teamSlug(轨道身份,锁)+ 成员表(可变)+ cwd = 团队 Library。没有运行模式与轮数字段。 */
export function teamSessionConfig(team: TeamDef): Record<string, unknown> {
  return { teamSlug: team.slug, groupChat: true, groupAgents: team.members.map((m) => m.slug), execMode: 'host', cwd: team.libraryDir, preset: null };
}

async function activeTeamSession(userId: string, appId: string, slug: string): Promise<any | null> {
  const pred = teamSlugPredicate('chat_sessions');
  const rows = await query<any[]>(
    `SELECT ${SESSION_COLS} FROM chat_sessions WHERE user_id = ? AND app_id = ? AND archived = ? AND kind = 'user' AND ${pred} ORDER BY updated_at DESC LIMIT 1`,
    [userId, appId, false, slug],
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

router.post('/agent/teams/:slug/session/open', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const team = await getTeam(req.params.slug);
    if (!team) return res.status(404).json({ detail: 'team not found' });
    const userId = req.user!.userId;
    const appId = deps().profile.appId;
    const out = await withKeyLock(`team:session:${userId}:${team.slug}`, async () => {
      const cur = await activeTeamSession(userId, appId, team.slug);
      if (cur) return { session: cur, created: false };
      try { mkdirSync(team.libraryDir, { recursive: true }); } catch { /* ignore */ }
      const id = uuidv4();
      await query(
        `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, emoji, project_path, project_name, projectless, agent_config)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, userId, appId, team.name.slice(0, 200), deps().profile.defaultModelId || null, null, null, null, true, JSON.stringify(teamSessionConfig(team))],
      );
      const rows = await query<any[]>(`SELECT ${SESSION_COLS} FROM chat_sessions WHERE id = ?`, [id]);
      return { session: rowToSession(rows[0]), created: true };
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'team session open failed' });
  }
});

export default router;
