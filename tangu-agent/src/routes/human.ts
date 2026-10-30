import { Router, type Response, type RequestHandler } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { HumanError, isHumanFile, readHuman, writeHuman, type HumanScope } from '../agents/humanStore.js';
import { mirrorLegacyHuman } from '../agents/humanFolder.js';
import { mutatePortrait, portraitEntries, PORTRAIT_SHORT_VERSION, readPortrait } from '../agents/humanPortrait.js';
import { getAgent, isValidSlug, resolveMemorySlug } from '../agents/agentRegistry.js';
import { humanProjectScope } from '../services/humanContext.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../services/agentFileSync.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { agentsDir, defaultCalendarFile, ensureHumanFolder, humanDir, tanguHome } from '../core/tanguHome.js';
import { atomicSyncWrite, readSyncBytes } from '../services/agentSyncPaths.js';
import { createMemoryRepository, normalizeMemoryFact, withMemoryDirectoryLock } from '../services/memoryRepository.js';
import { serializeDb, type DbFile } from '../services/amadeusDb.js';

const router = Router();
function fail(res: Response, e: any) {
  const code = e?.code || 'HUMAN_FAILED';
  res.status(code === 'HUMAN_CONFLICT' || code === 'MEMORY_VERSION_CONFLICT' ? 409 : code === 'HUMAN_VERSION_REQUIRED' ? 428 : code === 'HUMAN_NOT_FOUND' || code === 'PORTRAIT_NOT_FOUND' ? 404 : 400)
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
// 画像条目(human/SOUL.md,10-29):对话里回执行读状态 / 撤销用。和 human/ 其余接口同一个边界:只在本机、拒远端。
// 写入按人的身份记(actor user,来源 user);删掉的条目记墓碑,后台整理不再写回。
function humanLocal(req: AuthRequest, res: Response): boolean {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ error: 'HUMAN_LOCAL_ONLY', detail: 'The human folder requires a local engine.' }); return false; }
  if (parseRemoteOrigin(req.headers)) { res.status(403).json({ error: 'HUMAN_REMOTE_DENIED', detail: 'Manage this on the host computer.' }); return false; }
  return true;
}
const portraitBody = (doc: { version: string; content: string }) => ({ version: doc.version.slice(0, PORTRAIT_SHORT_VERSION), entries: portraitEntries(doc.content) });
router.get('/agent/human/SOUL.md/entries', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { res.json(await readPortrait()); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/entries', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const { action, id, fact, expectedVersion } = req.body ?? {};
    if (action !== 'add' && action !== 'forget') throw new HumanError('HUMAN_INVALID_ACTION', 'action must be add or forget.');
    if (typeof expectedVersion !== 'string' || !expectedVersion) throw new HumanError('HUMAN_VERSION_REQUIRED', 'Read the portrait entries and supply expectedVersion.');
    if (action === 'forget' && (typeof id !== 'string' || !id)) throw new HumanError('PORTRAIT_INVALID', 'id is required.');
    if (action === 'add' && (typeof fact !== 'string' || !fact.trim() || fact.length > 4000)) throw new HumanError('PORTRAIT_INVALID', 'fact must be a non-empty sentence.');
    const r = await mutatePortrait({ action, id, fact, expectedVersion, actor: 'user', source: { kind: 'user' } });
    res.json({ ...portraitBody(r.document), ...(r.entry ? { entry: r.entry } : {}) });
  } catch (e) { fail(res, e); }
});
// 「让所有 Agent 都照做」:把某个 Agent 实际生效记忆里的一条原文挪进 human/AGENT.md 末尾(人点的那一下就是「人开口」,10-20 定稿)。
// 先写 AGENT.md,写成了再从记忆里忘掉原条目(带版本);忘不掉 → 撤回 AGENT.md 那一笔,回 409。
router.post('/agent/agents/:slug/memory/promote', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const slug = String(req.params.slug);
    const def = isValidSlug(slug) ? await getAgent(slug) : null;
    if (!def) throw new HumanError('HUMAN_NOT_FOUND', 'Agent not found.');
    const memorySlug = resolveMemorySlug(def);
    if (!isValidSlug(memorySlug)) throw new HumanError('HUMAN_NOT_FOUND', 'Invalid memory scope.');
    const { id, expectedVersion } = req.body ?? {};
    if (typeof expectedVersion !== 'string' || !expectedVersion) throw new HumanError('HUMAN_VERSION_REQUIRED', 'Read the memory and supply expectedVersion.');
    if (typeof id !== 'string' || !id) throw new HumanError('PORTRAIT_INVALID', 'id is required.');
    const repo = createMemoryRepository(join(agentsDir(), memorySlug));
    const memory = repo.snapshot();
    const entry = memory.version === expectedVersion ? memory.entries.find((e) => e.id === id) : undefined;
    if (!entry) throw new HumanError('HUMAN_CONFLICT', 'The memory changed since it was read; the entry was not moved.');
    const text = entry.content.trim().replace(/^[-*+]\s+/, '');
    const scope: HumanScope = { kind: 'human', file: 'AGENT.md' };
    const doc = await readHuman(scope);
    const lines = doc.content.replace(/\s+$/, '').split('\n');
    const has = lines.some((l) => normalizeMemoryFact(l) === normalizeMemoryFact(text));
    const lastIsItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines.at(-1) ?? '');
    const body = lines.join('\n');
    const next = has ? doc.content : `${body ? `${body}${lastIsItem ? '\n' : '\n\n'}` : ''}- ${text}\n`;
    const source = { kind: 'promote' as const, agent: slug };
    const written = has ? { document: doc, change: null } : await writeHuman(scope, { content: next, expectedVersion: doc.version, summary: text.slice(0, 240), evidence: '' }, 'user', source);
    let after;
    try { after = repo.mutate({ action: 'forget', id, expectedVersion, source: { kind: 'manual' } }); }
    catch (e) {
      // 落盘后才抛的:原条目其实已经不在了,撤回 AGENT.md 那一笔就两边都没有 —— 先重读;读不了也不撤
      const now = (() => { try { return repo.snapshot(); } catch { return null; } })();
      if (now && !now.entries.some((x) => x.id === id)) { scheduleAgentFilesSync(req.user!.userId, slug); return res.json({ agentMd: { version: written.document.version }, memoryVersion: now.version }); }
      if (written.change && now) { try { await writeHuman(scope, { expectedVersion: written.document.version, undoId: written.change.id }, 'user', source); } catch { /* 撤不回:AGENT.md 里多了这一句,记忆那条也还在,人看得到两处 */ } }
      throw new HumanError('HUMAN_CONFLICT', `The memory changed while moving the entry; nothing was moved. (${e instanceof Error ? e.message : String(e)})`);
    }
    scheduleAgentFilesSync(req.user!.userId, slug); // 记忆少了一条:和记忆视图一样排一次后台同步(没开云同步的是空操作)
    res.json({ agentMd: { version: written.document.version }, memoryVersion: after.version });
  } catch (e) { fail(res, e); }
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
