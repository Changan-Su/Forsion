/** 从其他 AI 导入(11-03):只许本机,和 /agent/human 同一道边界。逻辑在 services/externalImport。 */
import { Router, type Response } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { applyPlan, ignoreCurrent, ImportError, planView, scanSummary, startPlan, undoImport } from '../services/externalImport/index.js';

const router = Router();
function local(req: AuthRequest, res: Response): boolean {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ error: 'IMPORT_LOCAL_ONLY', detail: 'Importing needs a local engine.' }); return false; }
  if (parseRemoteOrigin(req.headers)) { res.status(403).json({ error: 'IMPORT_REMOTE_DENIED', detail: 'Import on the host computer.' }); return false; }
  return true;
}
function fail(res: Response, e: any) {
  const code = e?.code || 'IMPORT_FAILED';
  const status = code === 'IMPORT_NOT_FOUND' ? 404 : code === 'IMPORT_PLAN_GONE' || code === 'HUMAN_CONFLICT' || code === 'MEMORY_VERSION_CONFLICT' ? 409 : e instanceof ImportError ? 400 : 500;
  res.status(status).json({ error: code, detail: e?.message || 'Import failed.' });
}
const handle = (fn: (req: AuthRequest) => unknown) => async (req: AuthRequest, res: Response) => {
  if (!local(req, res)) return;
  try { res.json((await fn(req)) ?? { ok: true }); } catch (e) { fail(res, e); }
};

router.get('/agent/import/scan', authMiddleware, handle(() => scanSummary()));
router.get('/agent/import/plan', authMiddleware, handle(() => planView()));
router.post('/agent/import/plan', authMiddleware, handle((req) => startPlan(req.user!.userId, req.body ?? {})));
router.post('/agent/import/apply', authMiddleware, handle((req) => applyPlan(req.body ?? {})));
router.post('/agent/import/undo', authMiddleware, handle((req) => undoImport(String(req.body?.id ?? ''))));
router.post('/agent/import/ignore', authMiddleware, handle(() => { ignoreCurrent(); }));
export default router;
