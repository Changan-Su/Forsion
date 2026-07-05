/**
 * 记忆 / 日志(桌面记忆面板;handler 自带 authMiddleware)。
 * MemoryBrain 接缝只有「读 + 追加」——编辑/整理在云端账户中心做,这里不扩接缝。
 *   GET  /agent/memory                → { content, updatedAt }
 *   POST /agent/memory { text, dedup? } → AppendMemoryResult
 *   GET  /agent/log?date=YYYY-MM-DD   → { date, content, updatedAt }
 *   POST /agent/log { text }          → { date, time }
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { syncNow, getSyncStatus } from '../services/memorySyncService.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { getAgent, resolveMemorySlug } from '../agents/agentRegistry.js';

const router = Router();

router.get('/agent/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json(await deps().brain.memory.getMemory(req.user!.userId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'get memory failed' });
  }
});

router.post('/agent/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ detail: 'text is required' });
    const append = () => deps().brain.memory.appendMemoryEntry(req.user!.userId, text, { dedup: req.body?.dedup !== false });
    // slug 指定(面板按当前 agent 追加)→ 在该 agent 记忆作用域内写(共用默认则落默认);否则按默认 agent。
    const slug = req.body?.slug ? String(req.body.slug) : '';
    if (slug) {
      const def = await getAgent(slug).catch(() => null);
      res.json(await runWithAgentSlug(def ? resolveMemorySlug(def) : slug, append));
    } else {
      res.json(await append());
    }
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'append memory failed' });
  }
});

router.get('/agent/log', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : undefined;
    res.json(await deps().brain.memory.getLog(req.user!.userId, date));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'get log failed' });
  }
});

router.post('/agent/log', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ detail: 'text is required' });
    res.json(await deps().brain.memory.appendLogEntry(req.user!.userId, text));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'append log failed' });
  }
});

// ── 本地 ↔ Forsion Brain 同步(手动「立即同步」/ 桌面端按开关定时调用)──
router.post('/agent/sync', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json(await syncNow(req.user!.userId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'sync failed' });
  }
});

router.get('/agent/sync/status', authMiddleware, (_req: AuthRequest, res) => {
  res.json(getSyncStatus());
});

export default router;
