/**
 * 后台进程给界面看(2026-10-25,桌面摘要栏「后台」卡):run_background 起的进程原来只有 Agent 自己的工具看得见。
 *   GET  /agent/processes                                  本人各会话的进程(不带输出;url = 识别出的本机地址,只在跑着时给)
 *   GET  /agent/sessions/:id/processes/:pid/output?tail=N   一条进程的输出尾巴(剥色码,缺省 64 KB)
 *   POST /agent/sessions/:id/processes/:pid/kill            用户自己点停止:直接停整棵进程树,**不走审批**
 *                                                           (审批拦的是 Agent 的 kill_process,这里是人点的)
 * 进程按会话登记,一律按会话归属过滤;hostExec 关(云端 worker)没有后台进程,列表恒空。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { query } from '../core/db.js';
import { deps } from '../seams/runtime.js';
import { getProcess, killProcess, lastLine, listAllProcesses, stripAnsi, type BackgroundProcess } from '../tools/processRegistry.js';

const router = Router();
const TAIL_DEFAULT = 64_000;

export interface ProcessView {
  id: string;
  sessionId: string;
  command: string;
  status: BackgroundProcess['status'];
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  origin: BackgroundProcess['origin'];
  url: string | null;
  last: string;
}

const view = (p: BackgroundProcess): ProcessView => ({
  id: p.id, sessionId: p.sessionId, command: p.command, status: p.status, exitCode: p.exitCode,
  startedAt: p.startedAt, endedAt: p.endedAt, origin: p.origin,
  url: p.status === 'running' ? p.url ?? null : null,
  last: lastLine(p.output),
});

async function ownedSessions(ids: string[], userId: string): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await query<any[]>(
    `SELECT id FROM chat_sessions WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [userId, ...ids],
  );
  return new Set(rows.map((r) => r.id));
}

const hostExec = (): boolean => !!deps().profile.capabilities.hostExec;

router.get('/agent/processes', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!hostExec()) return res.json({ processes: [] });
    const all = listAllProcesses();
    const mine = await ownedSessions([...new Set(all.map((p) => p.sessionId))], req.user!.userId);
    res.json({ processes: all.filter((p) => mine.has(p.sessionId)).sort((a, b) => a.startedAt - b.startedAt).map(view) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list processes failed' });
  }
});

/** 会话是本人的、进程属于这个会话 → 进程;否则已回 404。 */
async function ownProcess(req: AuthRequest, res: any): Promise<BackgroundProcess | null> {
  const p = hostExec() ? getProcess(req.params.id, req.params.pid) : null;
  if (!p || !(await ownedSessions([req.params.id], req.user!.userId)).has(req.params.id)) {
    res.status(404).json({ detail: 'Process not found' });
    return null;
  }
  return p;
}

router.get('/agent/sessions/:id/processes/:pid/output', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const p = await ownProcess(req, res);
    if (!p) return;
    const tail = Math.min(Math.max(1, Number(req.query.tail) || TAIL_DEFAULT), 200_000);
    const out = p.output.length > tail ? p.output.slice(-tail) : p.output;
    res.json({ ...view(p), output: stripAnsi(out), truncated: p.truncated || p.output.length > tail });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read output failed' });
  }
});

router.post('/agent/sessions/:id/processes/:pid/kill', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const p = await ownProcess(req, res);
    if (!p) return;
    killProcess(req.params.id, req.params.pid);
    res.json(view(p));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'kill failed' });
  }
});

export default router;
