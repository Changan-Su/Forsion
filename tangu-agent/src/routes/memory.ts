/**
 * 记忆 / 日志(桌面记忆面板;handler 自带 authMiddleware)。
 * 旧读/追加入口保兼容；本地管理返回版本化快照，Agent 面板的编辑/恢复走 agents.ts。
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
import { getAgent, resolveMemorySlug, isValidSlug } from '../agents/agentRegistry.js';
import { MemoryRepositoryError } from '../services/memoryRepository.js';

const router = Router();

async function inRequestedMemoryScope<T>(req: AuthRequest, fn: () => Promise<T>): Promise<T> {
  const requested = req.body?.slug ?? req.query.slug;
  if (requested === undefined || requested === '') return fn();
  if (typeof requested !== 'string' || !isValidSlug(requested)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid agent slug.');
  if (!deps().profile.capabilities.hostExec) throw new MemoryRepositoryError('MEMORY_UNSUPPORTED', 'This memory backend does not support per-agent memory.');
  const def = await getAgent(requested);
  if (!def) throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'Agent not found.');
  const scope = resolveMemorySlug(def);
  if (!isValidSlug(scope)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid memory scope.');
  return runWithAgentSlug(scope, fn);
}
function statusFor(e: any): number {
  if (e?.code === 'MEMORY_NOT_FOUND') return 404;
  if (e?.code === 'MEMORY_VERSION_CONFLICT' || e?.code === 'MEMORY_BUSY') return 409;
  if (e?.code === 'MEMORY_UNSAFE_PATH' || e?.code === 'MEMORY_INVALID' || e?.code === 'MEMORY_UNSUPPORTED') return 400;
  return 500;
}

router.get('/agent/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json(await inRequestedMemoryScope(req, () => deps().brain.memory.getMemorySnapshot?.(req.user!.userId) ?? deps().brain.memory.getMemory(req.user!.userId)));
  } catch (e: any) {
    res.status(statusFor(e)).json({ detail: e?.message || 'get memory failed', code: e?.code });
  }
});

router.post('/agent/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ detail: 'text is required' });
    const append = () => deps().brain.memory.appendMemoryEntry(req.user!.userId, text, { dedup: req.body?.dedup !== false });
    res.json(await inRequestedMemoryScope(req, append));
  } catch (e: any) {
    res.status(statusFor(e)).json({ detail: e?.message || 'append memory failed', code: e?.code });
  }
});

router.get('/agent/log', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : undefined;
    res.json(await inRequestedMemoryScope(req, () => deps().brain.memory.getLog(req.user!.userId, date)));
  } catch (e: any) {
    res.status(statusFor(e)).json({ detail: e?.message || 'get log failed', code: e?.code });
  }
});

router.post('/agent/log', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ detail: 'text is required' });
    res.json(await inRequestedMemoryScope(req, () => deps().brain.memory.appendLogEntry(req.user!.userId, text)));
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

router.get('/agent/sync/status', authMiddleware, (req: AuthRequest, res) => {
  res.json(getSyncStatus(req.user!.userId));
});

export default router;
