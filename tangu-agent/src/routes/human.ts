import { Router, type Response, type RequestHandler } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { HumanError, isHumanFile, readHuman, writeHuman, type HumanScope } from '../agents/humanStore.js';
import { mirrorLegacyHuman } from '../agents/humanFolder.js';
import { humanProjectScope } from '../services/humanContext.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../services/agentFileSync.js';

const router = Router();
function fail(res: Response, e: any) {
  const code = e?.code || 'HUMAN_FAILED';
  res.status(code === 'HUMAN_CONFLICT' ? 409 : code === 'HUMAN_VERSION_REQUIRED' ? 428 : code === 'HUMAN_NOT_FOUND' ? 404 : 400)
    .json({ error: code, detail: e?.message || 'Collaboration request failed.' });
}
async function scopeOf(req: AuthRequest, res: Response): Promise<HumanScope | null> {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ error: 'HUMAN_LOCAL_ONLY', detail: 'Collaboration documents require a local engine.' }); return null; }
  // Keep the same persistent-configuration boundary as the other Agent management APIs.
  if (parseRemoteOrigin(req.headers)) { res.status(403).json({ error: 'HUMAN_REMOTE_DENIED', detail: 'Open collaboration settings on the host computer.' }); return null; }
  if (req.params.slug) return { kind: 'agent', slug: String(req.params.slug) };
  if (req.params.file !== undefined) {
    if (!isHumanFile(req.params.file)) throw new HumanError('HUMAN_NOT_FOUND', 'Unknown file in the human folder.');
    return { kind: 'human', file: req.params.file };
  }
  const sessionId = req.method === 'GET' ? req.query.sessionId : req.body?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) throw new HumanError('HUMAN_SESSION_REQUIRED', 'sessionId is required.');
  const scope = await humanProjectScope(req.user!.userId, sessionId);
  if (!scope) throw new HumanError('HUMAN_NO_PROJECT', 'This session has no local project.');
  return scope;
}
const getHuman: RequestHandler = async (req: AuthRequest, res) => {
    try { const scope = await scopeOf(req, res); if (scope) res.json(await readHuman(scope)); } catch (e) { fail(res, e); }
};
// 改了 human/MEMORY.md:旧位置 USER.md(旧版设备、降级回去的还读它)当场镜像一遍。镜像失败不影响这次保存,下次同步 / 启动再补。
const mirrorAfter = async (scope: HumanScope) => {
  if (scope.kind !== 'human' || scope.file !== 'MEMORY.md') return;
  try { await mirrorLegacyHuman(); } catch (e) { console.warn('[human mirror]', e instanceof Error ? e.message : e); }
};
const putHuman: RequestHandler = async (req: AuthRequest, res) => {
    try {
      const scope = await scopeOf(req, res); if (!scope) return;
      const result = await writeHuman(scope, { ...req.body, undoId: undefined }, 'user');
      await mirrorAfter(scope);
      // 不带 slug 是空操作;HUMAN.md 跟着归属 agent 的定义文件一起同步。
      if (scope.kind === 'agent' && result.change) scheduleAgentFilesSync(req.user!.userId, scope.slug);
      res.json(result);
    } catch (e) { fail(res, e); }
};
const undoHuman: RequestHandler = async (req: AuthRequest, res) => {
    try {
      const scope = await scopeOf(req, res); if (!scope) return;
      if (typeof req.body?.changeId !== 'string' || !req.body.changeId) throw new HumanError('HUMAN_CHANGE_REQUIRED', 'changeId is required.');
      const result = await writeHuman(scope, { expectedVersion: req.body.expectedVersion, undoId: req.body.changeId }, 'user');
      await mirrorAfter(scope);
      if (scope.kind === 'agent' && result.change) scheduleAgentFilesSync(req.user!.userId, scope.slug);
      res.json(result);
    } catch (e) { fail(res, e); }
};
// Keep paths explicit so the remote-access route allowlist can audit every endpoint.
router.get('/agent/agents/:slug/human', authMiddleware, getHuman);
router.put('/agent/agents/:slug/human', authMiddleware, putHuman);
router.post('/agent/agents/:slug/human/undo', authMiddleware, undoHuman);
router.get('/agent/project-context/human', authMiddleware, getHuman);
router.put('/agent/project-context/human', authMiddleware, putHuman);
router.post('/agent/project-context/human/undo', authMiddleware, undoHuman);
// human/ 文件夹(HUMAN.md 共识、AGENT.md、SOUL.md、MEMORY.md)
router.get('/agent/human/:file', authMiddleware, getHuman);
router.put('/agent/human/:file', authMiddleware, putHuman);
router.post('/agent/human/:file/undo', authMiddleware, undoHuman);
export default router;
