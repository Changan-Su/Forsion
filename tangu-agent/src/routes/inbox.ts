/**
 * 收件箱(Inbox Space)HTTP API。handler 自带 authMiddleware;本地特性(hostExec=false 一律 404)。
 *   GET    /agent/inbox?filter=all|unread|archived|scheduled&limit=&offset=   消息列表
 *   GET    /agent/inbox/unread-count                                          未读数 + 最新已投递消息 id
 *   PATCH  /agent/inbox/:id { read?, archived? }                              标已读/未读、归档/取消
 *   POST   /agent/inbox/read-all                                              全部已读(不动未投递定时消息)
 *   DELETE /agent/inbox/:id                                                   软删(定时消息「取消」同此)
 *   POST   /agent/inbox/pull                                                  手动拉服务端广播
 *
 * 时间纪律:写入/比较一律 JS 生成的 UTC 'YYYY-MM-DD HH:MM:SS' 串(不用 SQL CURRENT_TIMESTAMP 比较——
 * 外部 PG 的它是服务器本地墙钟);响应统一过 ts() 归一(PG host 回 Date、SQLite 回字符串)。
 * 到期投递无定时器:deliver_at IS NULL OR deliver_at <= now 即「已投递」。DELETE=软删,理由见 migrate.ts。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';
import { pullBroadcastsOnce } from '../services/inboxPull.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: '收件箱仅在本地(桌面/TUI)可用' });
    return false;
  }
  return true;
}

const nowUtc = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');
/** 响应时间归一:UTC、无时区后缀(前端按 +'Z' 解析)。广播行的微秒原文也截到秒,展示层不需要微秒。 */
const ts = (v: any): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v).slice(0, 19);

const COLS = 'id, title, body, sender_kind, sender_id, origin_broadcast_id, deliver_at, read_at, archived_at, created_at';

function serialize(r: any) {
  return {
    id: r.id,
    title: r.title,
    body: r.body ?? '',
    sender_kind: r.sender_kind,
    sender_id: r.sender_id,
    origin_broadcast_id: r.origin_broadcast_id ?? null,
    deliver_at: ts(r.deliver_at),
    read_at: ts(r.read_at),
    archived_at: ts(r.archived_at),
    created_at: ts(r.created_at),
  };
}

router.get('/agent/inbox', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const filter = String(req.query.filter || 'all');
    const limit = Math.floor(Math.min(Math.max(1, Number(req.query.limit) || 50), 200));
    const offset = Math.floor(Math.max(0, Number(req.query.offset) || 0));
    const now = nowUtc();
    let where: string;
    let order: string;
    let params: any[];
    if (filter === 'archived') {
      where = `user_id = ? AND deleted_at IS NULL AND archived_at IS NOT NULL`;
      order = `archived_at DESC, id DESC`;
      params = [userId];
    } else if (filter === 'scheduled') {
      where = `user_id = ? AND deleted_at IS NULL AND deliver_at > ?`;
      order = `deliver_at ASC, id ASC`;
      params = [userId, now];
    } else {
      // all / unread(非法值按 all)
      where = `user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND (deliver_at IS NULL OR deliver_at <= ?)`;
      if (filter === 'unread') where += ` AND read_at IS NULL`;
      order = `created_at DESC, id DESC`;
      params = [userId, now];
    }
    const rows = await query<any[]>(
      `SELECT ${COLS} FROM inbox_messages WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ messages: (rows || []).map(serialize) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inbox list failed' });
  }
});

router.get('/agent/inbox/unread-count', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const now = nowUtc();
    const visible = `user_id = ? AND deleted_at IS NULL AND archived_at IS NULL AND (deliver_at IS NULL OR deliver_at <= ?)`;
    const cntRows = await query<any[]>(
      `SELECT COUNT(*) AS n FROM inbox_messages WHERE ${visible} AND read_at IS NULL`,
      [userId, now],
    );
    // latestId 含已读:read-all 之后前端仍能靠它感知新消息到达。
    const latestRows = await query<any[]>(
      `SELECT id FROM inbox_messages WHERE ${visible} ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, now],
    );
    res.json({ count: Number(cntRows?.[0]?.n) || 0, latestId: latestRows?.[0]?.id || null });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'unread-count failed' });
  }
});

router.patch('/agent/inbox/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const read = req.body?.read;
    const archived = req.body?.archived;
    if (typeof read !== 'boolean' && typeof archived !== 'boolean') {
      return res.status(400).json({ detail: 'read 或 archived 至少一项' });
    }
    const exist = await query<any[]>(
      `SELECT id FROM inbox_messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, userId],
    );
    if (!exist?.length) return res.status(404).json({ detail: 'message not found' });
    const sets: string[] = [];
    const params: any[] = [];
    if (typeof read === 'boolean') {
      sets.push(`read_at = ?`);
      params.push(read ? nowUtc() : null);
    }
    if (typeof archived === 'boolean') {
      sets.push(`archived_at = ?`);
      params.push(archived ? nowUtc() : null);
    }
    await query(`UPDATE inbox_messages SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...params, req.params.id, userId]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inbox patch failed' });
  }
});

router.post('/agent/inbox/read-all', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const now = nowUtc();
    await query(
      `UPDATE inbox_messages SET read_at = ?
       WHERE user_id = ? AND deleted_at IS NULL AND archived_at IS NULL
         AND read_at IS NULL AND (deliver_at IS NULL OR deliver_at <= ?)`,
      [now, userId, now],
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read-all failed' });
  }
});

router.delete('/agent/inbox/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const userId = req.user!.userId;
    const exist = await query<any[]>(
      `SELECT id FROM inbox_messages WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, userId],
    );
    if (!exist?.length) return res.status(404).json({ detail: 'message not found' });
    await query(`UPDATE inbox_messages SET deleted_at = ? WHERE id = ? AND user_id = ?`, [nowUtc(), req.params.id, userId]);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inbox delete failed' });
  }
});

router.post('/agent/inbox/pull', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!deps().brain.inbox) return res.json({ pulled: false, added: 0, detail: '未配置云端连接' });
    const { added } = await pullBroadcastsOnce(req.user!.userId);
    res.json({ pulled: true, added });
  } catch (e: any) {
    // 手动按钮的失败给 200+detail(前端 toast),不用 5xx 炸前端。
    res.json({ pulled: false, added: 0, detail: e?.message || 'pull failed' });
  }
});

export default router;
