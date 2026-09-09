import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { getAgent, isValidSlug, resolveMemorySlug } from '../agents/agentRegistry.js';
import { getMemoryDream, configureMemoryDream, startMemoryDream, cancelMemoryDream } from '../services/memoryDream.js';

const router = Router();
const base = '/agent/agents/:slug/memory/dream';
router.use(base, authMiddleware, async (req: AuthRequest, res, next) => {
  try {
    if (!deps().profile.capabilities.hostExec) return res.status(404).json({ detail: 'Local Agent memory maintenance is unavailable on this backend' });
    const slug = String(req.params.slug || '');
    if (!isValidSlug(slug)) return res.status(400).json({ detail: 'Invalid Agent slug' });
    const agent = await getAgent(slug);
    if (!agent) return res.status(404).json({ detail: 'Agent not found' });
    res.locals.memorySlug = resolveMemorySlug(agent);
    next();
  } catch (e: any) { res.status(500).json({ detail: e?.message || 'Cannot resolve Agent memory' }); }
});
router.get(base, (_req, res) => {
  try { res.json(getMemoryDream(res.locals.memorySlug)); }
  catch (e: any) { res.status(500).json({ detail: e?.message || 'Cannot read memory maintenance state' }); }
});
router.put(base, (req, res) => {
  try { configureMemoryDream(res.locals.memorySlug, req.body || {}); res.json(getMemoryDream(res.locals.memorySlug)); }
  catch (e: any) { res.status(400).json({ detail: e?.message || 'Cannot update memory maintenance settings' }); }
});
router.post(base, (req: AuthRequest, res) => {
  try { res.status(202).json({ status: startMemoryDream(req.user!.userId, res.locals.memorySlug) }); }
  catch (e: any) { res.status(500).json({ detail: e?.message || 'Cannot start memory maintenance' }); }
});
router.delete(base, (_req, res) => {
  try { res.json({ status: cancelMemoryDream(res.locals.memorySlug) }); }
  catch (e: any) { res.status(500).json({ detail: e?.message || 'Cannot cancel memory maintenance' }); }
});
export default router;
