import { Router, type Response, type RequestHandler } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { HumanError, isHumanFile, readHuman, writeHuman, type HumanScope } from '../agents/humanStore.js';
import { mirrorLegacyHuman } from '../agents/humanFolder.js';
import { humanProjectScope } from '../services/humanContext.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../services/agentFileSync.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { defaultCalendarFile, ensureHumanFolder, humanDir, tanguHome } from '../core/tanguHome.js';
import { atomicSyncWrite, readSyncBytes } from '../services/agentSyncPaths.js';
import { withMemoryDirectoryLock } from '../services/memoryRepository.js';
import { serializeDb, type DbFile } from '../services/amadeusDb.js';

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
// 默认日历 human/CALENDAR.db(10-21 用户:「新的默认 Calendar 文件应该是 human 文件夹里面用户的 calendar」):日历视图直接读写这份。
// version = 文件内容哈希;写入按它比对交换,和 human/ 同步、旧位置镜像拿同一把 human/ 目录锁。旧位置那份(默认笔记库的 Calendar.db)写完当场镜像一遍。
const CALENDAR = 'CALENDAR.db';
const MAX_CALENDAR_BYTES = 8 * 1024 * 1024;
const calVersion = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const isDbFile = (d: any): d is DbFile => !!d && typeof d === 'object' && typeof d.version === 'number' && typeof d.name === 'string'
  && Array.isArray(d.columns) && Array.isArray(d.rows) && d.source === undefined;
function calendarLocal(req: AuthRequest, res: Response): boolean {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ error: 'HUMAN_LOCAL_ONLY', detail: 'The calendar in the human folder requires a local engine.' }); return false; }
  if (parseRemoteOrigin(req.headers)) { res.status(403).json({ error: 'HUMAN_REMOTE_DENIED', detail: 'Open the calendar on the host computer.' }); return false; }
  return true;
}
router.get('/agent/human/CALENDAR.db', authMiddleware, (req: AuthRequest, res) => {
  if (!calendarLocal(req, res)) return;
  try {
    ensureHumanFolder();
    const bytes = readSyncBytes(tanguHome(), join(humanDir(), CALENDAR));
    // legacy = 旧位置镜像的那份(绝对路径):日历视图据此不再把库里那份当成另一本日历重复显示
    res.json(bytes ? { status: 'ok', data: JSON.parse(bytes.toString('utf8')), version: calVersion(bytes), legacy: defaultCalendarFile() }
      : { status: 'missing', legacy: defaultCalendarFile() });
  } catch (e: any) { res.status(e instanceof SyntaxError ? 422 : 500).json({ error: e instanceof SyntaxError ? 'HUMAN_CALENDAR_CORRUPT' : 'HUMAN_FAILED', detail: e?.message || 'Read failed.' }); }
});
router.put('/agent/human/CALENDAR.db', authMiddleware, async (req: AuthRequest, res) => {
  if (!calendarLocal(req, res)) return;
  const { data, version } = req.body ?? {};
  if (!isDbFile(data) || (version !== null && typeof version !== 'string')) return res.status(400).json({ error: 'HUMAN_BAD_CALENDAR', detail: 'data must be a database file and version a string or null.' });
  const text = serializeDb(data);
  if (Buffer.byteLength(text) > MAX_CALENDAR_BYTES) return res.status(413).json({ error: 'HUMAN_CALENDAR_TOO_LARGE', detail: 'The calendar is too large.' });
  try {
    ensureHumanFolder();
    const next = withMemoryDirectoryLock(humanDir(), () => {
      const file = join(humanDir(), CALENDAR);
      const cur = readSyncBytes(tanguHome(), file);
      if ((cur ? calVersion(cur) : null) !== version) return null;
      atomicSyncWrite(tanguHome(), file, text);
      return calVersion(text);
    });
    if (!next) return res.status(409).json({ error: 'HUMAN_CONFLICT', detail: 'The calendar changed since it was read.' });
    try { await mirrorLegacyHuman(); } catch (e) { console.warn('[human mirror]', e instanceof Error ? e.message : e); }
    res.json({ ok: true, version: next });
  } catch (e: any) { res.status(500).json({ error: 'HUMAN_FAILED', detail: e?.message || 'Write failed.' }); }
});
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
