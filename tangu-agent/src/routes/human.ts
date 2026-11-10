import { Router, type NextFunction, type Response, type RequestHandler } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { HumanError, isHumanFile, readHuman, writeHuman, type HumanScope } from '../agents/humanStore.js';
import { mirrorLegacyHuman } from '../agents/humanFolder.js';
import { dismissPortraitOverflow, mutatePortrait, portraitEntries, portraitEntryId, PORTRAIT_SHORT_VERSION, readPortrait, readPortraitOverflow } from '../agents/humanPortrait.js';
import { keepPortraitItem, movePortraitItem, readPortraitMove, startPortraitScan, undoPortraitMove } from '../agents/portraitMove.js';
import { getAgent, isValidSlug, resolveMemorySlug } from '../agents/agentRegistry.js';
import { humanProjectScope } from '../services/humanContext.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../services/agentFileSync.js';
import { ledger } from '../services/telemetryLedger.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { agentsDir, defaultCalendarFile, ensureHumanFolder, humanDir, tanguHome } from '../core/tanguHome.js';
import { atomicSyncWrite, readSyncBytes } from '../services/agentSyncPaths.js';
import { isSettingsDbShape, SETTINGS_MAX_BYTES } from '../contracts/agentSyncRules.js';
import { createMemoryRepository, MemoryRepositoryError, normalizeMemoryFact, withMemoryDirectoryLock, withMemoryDirectoryLockRetry } from '../services/memoryRepository.js';
import { serializeDb, type DbFile } from '../services/amadeusDb.js';
import { pinPortraitEntry, portraitOrganizeHistory, undoPortraitOrganize } from '../agents/portraitLayers.js';
import { agentOrganizeHistory, pinAgentEntry, readAgentLayers, undoAgentOrganize } from '../services/agentMemoryLayers.js';
import { lastOrganize, organizeAvailable, organizeRunning, runOrganize, type OrganizeTarget } from '../services/memoryOrganize.js';

const router = Router();
function fail(res: Response, e: any) {
  const code = e?.code || 'HUMAN_FAILED';
  res.status(code === 'HUMAN_CONFLICT' || code === 'MEMORY_VERSION_CONFLICT' ? 409 : code === 'HUMAN_VERSION_REQUIRED' ? 428 : code === 'HUMAN_NOT_FOUND' || code === 'PORTRAIT_NOT_FOUND' || code === 'MEMORY_NOT_FOUND' ? 404 : code === 'MEMORY_BUSY' ? 409 : 400)
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
// 随账号走的设置文件 human/Settings/<name>.db(11-10,第一份是日历设置 calendar.db):一行一项设置的 DbFile,和默认日历同一条同步通道。
// 桌面渲染层读写这一对,网页 / 手机走云端的同名接口(/api/agent/human/Settings/<name>.db)—— 两边报文同形,渲染层用同一套解析;
// 票据(version)对调用方是不透明的字符串,这里 = 文件字节的 sha256。内容当不透明的 DbFile,只校验形状。
// 和默认日历那一对同一个边界(只在本机、拒远端)、同一把 human/ 目录锁、原子写、按内容哈希比对交换。调用方靠 GET 的四种回答决定能不能写:
//   200 { status: 'ok', exists: true, data, version }        读到了
//   200 { status: 'missing', exists: false, version: null }  接口在、文件还没建:可以带 version: null 新建
//   422 { error: 'HUMAN_SETTINGS_CORRUPT', status: 'corrupt' } 文件解析不了 / 形状不对:不许覆盖(PUT 一律 409,不发票据),等同步把好的那份带下来
//   其余(400 名字不对 / 401 / 403 / 404 / 5xx)              不知道:不写
// 旧引擎没有这条路由,回的是 404(/agent/human/:file 那条还会回带 code 的 404):「文件还没建」从不走 404,
// HTTP 200 + status: 'missing' + exists: false 是旧引擎给不出的回答,调用方只认它是「确认没有」。
const SETTINGS_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.db$/;
type SettingsCurrent = { status: 'ok'; exists: true; data: DbFile; version: string } | { status: 'missing'; exists: false; version: null } | { status: 'corrupt' };
/** 盘上这份现在是哪种状态。解析不了 / 形状不对(契约 isSettingsDbShape,同步判「读不读得懂」用的是同一条)= corrupt。读盘失败照抛(= 不知道)。 */
function settingsCurrent(file: string): { current: SettingsCurrent; hash: string | null } {
  const bytes = readSyncBytes(tanguHome(), file);
  if (!bytes) return { current: { status: 'missing', exists: false, version: null }, hash: null };
  const hash = calVersion(bytes);
  let data: unknown;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { return { current: { status: 'corrupt' }, hash }; }
  return { current: isSettingsDbShape(data) ? { status: 'ok', exists: true, data: data as DbFile, version: hash } : { status: 'corrupt' }, hash };
}
/** 路径里的文件名 → 绝对路径。大小写敏感(和云端那条一样);名字不合规矩回 400。 */
function settingsFile(req: AuthRequest, res: Response, next: NextFunction): string | null {
  if (!req.path.startsWith('/agent/human/Settings/')) { next(); return null; } // express 缺省不分大小写:/agent/human/settings/… 不是这条路由
  const name = String(req.params.file ?? '');
  if (!SETTINGS_NAME.test(name)) { res.status(400).json({ error: 'HUMAN_BAD_SETTINGS_NAME', detail: 'Settings files are Settings/<name>.db with a lowercase name.' }); return null; }
  return join(humanDir(), 'Settings', name);
}
router.get('/agent/human/Settings/:file', authMiddleware, (req: AuthRequest, res, next) => {
  if (!humanLocal(req, res)) return;
  const file = settingsFile(req, res, next); if (!file) return;
  try {
    ensureHumanFolder();
    const { current } = settingsCurrent(file);
    if (current.status === 'corrupt') return void res.status(422).json({ error: 'HUMAN_SETTINGS_CORRUPT', detail: 'The settings file is not a valid database file; it was left untouched.', ...current });
    res.json(current);
  } catch (e: any) { res.status(500).json({ error: 'HUMAN_FAILED', detail: e?.message || 'Read failed.' }); }
});
router.put('/agent/human/Settings/:file', authMiddleware, async (req: AuthRequest, res, next) => {
  if (!humanLocal(req, res)) return;
  const file = settingsFile(req, res, next); if (!file) return;
  const { data, version } = req.body ?? {};
  // version:上次读到的那个;null = 期望文件还不存在(首次创建);不带 = 400
  if (!isSettingsDbShape(data) || (version !== null && typeof version !== 'string')) return void res.status(400).json({ error: 'HUMAN_BAD_SETTINGS', detail: 'data must be a database file and version a string or null.' });
  const text = serializeDb(data as DbFile);
  if (Buffer.byteLength(text) > SETTINGS_MAX_BYTES) return void res.status(413).json({ error: 'HUMAN_SETTINGS_TOO_LARGE', detail: `A settings file is limited to ${SETTINGS_MAX_BYTES / 1024} KB.`, limit: SETTINGS_MAX_BYTES });
  try {
    ensureHumanFolder();
    // 同步落盘(引擎的旧同步、桌面宿主的新同步)拿的是同一把锁:撞上了稍等重试,约 1 秒还拿不到回 503(调用方按「不知道」处理,稍后再来)
    const outcome = await withMemoryDirectoryLockRetry(humanDir(), (): { version: string } | { current: SettingsCurrent } => {
      const { current } = settingsCurrent(file);
      // 坏文件没有票据:带着它的哈希来也盖不掉。票据不对(别人刚改过 / 刚建了 / 已经没了):带回现在这份,调用方合进去再写
      if (current.status === 'corrupt' || current.version !== version) return { current };
      atomicSyncWrite(tanguHome(), file, text);
      return { version: calVersion(text) };
    });
    if ('current' in outcome) return void res.status(409).json({ error: 'HUMAN_CONFLICT', detail: 'The settings file changed since it was read.', ...outcome.current });
    res.json({ ok: true, version: outcome.version });
  } catch (e: any) {
    const busy = e instanceof MemoryRepositoryError && e.code === 'MEMORY_BUSY';
    res.status(busy ? 503 : 500).json({ error: busy ? 'HUMAN_BUSY' : 'HUMAN_FAILED', detail: e?.message || 'Write failed.' });
  }
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
// Dream 因为画像满了、退回各 Agent 记忆的条目(11-09):画像页提示一句、点开看是哪几条,「知道了」清掉。只在本机、拒远端。
router.get('/agent/human/SOUL.md/overflow', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { res.json({ items: await readPortraitOverflow() }); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/overflow/dismiss', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { dismissPortraitOverflow(); res.json({ items: [] }); } catch (e) { fail(res, e); }
});
// 搬家卡(10-30 第 2 步):人点了才扫、逐条点了才挪。同样只在本机、拒远端。
router.get('/agent/human/SOUL.md/move', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { res.json(await readPortraitMove(req.user!.userId)); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/move/scan', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { res.json(startPortraitScan(req.user!.userId)); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/move/items/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const decision = String(req.body?.decision);
    const act = { move: movePortraitItem, keep: keepPortraitItem, undo: undoPortraitMove }[decision];
    if (!act) throw new HumanError('HUMAN_INVALID_ACTION', 'decision must be move, keep or undo.');
    const view = await act(req.user!.userId, String(req.params.id));
    ledger.inc('daily_human', decision === 'move' ? 'moveMoved' : decision === 'keep' ? 'moveKept' : 'moveUndo');
    res.json(view);
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
      if (now && !now.entries.some((x) => x.id === id)) { ledger.inc('daily_human', 'promoteToAgentMd'); scheduleAgentFilesSync(req.user!.userId, slug); return res.json({ agentMd: { version: written.document.version }, memoryVersion: now.version }); }
      if (written.change && now) { try { await writeHuman(scope, { expectedVersion: written.document.version, undoId: written.change.id }, 'user', source); } catch { /* 撤不回:AGENT.md 里多了这一句,记忆那条也还在,人看得到两处 */ } }
      throw new HumanError('HUMAN_CONFLICT', `The memory changed while moving the entry; nothing was moved. (${e instanceof Error ? e.message : String(e)})`);
    }
    ledger.inc('daily_human', 'promoteToAgentMd');
    scheduleAgentFilesSync(req.user!.userId, slug); // 记忆少了一条:和记忆视图一样排一次后台同步(没开云同步的是空操作)
    res.json({ agentMd: { version: written.document.version }, memoryVersion: after.version });
  } catch (e) { fail(res, e); }
});
// ── 记忆分层(11-09 第二步):画像 / Agent 记忆的整理、整理记录(可整次撤销)、图钉。只在本机、拒远端 ──
const organizeView = async (target: OrganizeTarget, history: Array<{ id: string; at: number; moves: Array<{ to: string }>; undoneAt?: number; before?: unknown; after?: unknown }>) => ({
  available: await organizeAvailable(), running: organizeRunning(target), last: lastOrganize(target),
  history: history.map((r) => ({ id: r.id, at: r.at, moved: r.moves.filter((m) => m.to !== 'archive').length, archived: r.moves.filter((m) => m.to === 'archive').length, topics: [...new Set(r.moves.map((m) => m.to))], before: r.before, after: r.after, ...(r.undoneAt ? { undoneAt: r.undoneAt } : {}) })),
});
router.get('/agent/human/SOUL.md/organize', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { res.json(await organizeView({ kind: 'portrait' }, await portraitOrganizeHistory())); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/organize', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { res.json(await runOrganize({ kind: 'portrait' }, { userId: req.user!.userId, manual: true })); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/organize/:id/undo', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try { const r = await undoPortraitOrganize(String(req.params.id)); res.json({ id: r.id, undoneAt: r.undoneAt }); } catch (e) { fail(res, e); }
});
router.post('/agent/human/SOUL.md/pin', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    // 界面按原句指(画像页画的是文件本身,不另取条目列表);id 也认(和 /entries 的号同一个)
    const { id: given, fact, pinned, expectedVersion } = req.body ?? {};
    const id = typeof given === 'string' && given ? given : typeof fact === 'string' && fact.trim() ? portraitEntryId(fact) : '';
    if (!id || typeof pinned !== 'boolean') throw new HumanError('PORTRAIT_INVALID', 'id (or fact) and pinned are required.');
    if (typeof expectedVersion !== 'string' || !expectedVersion) throw new HumanError('HUMAN_VERSION_REQUIRED', 'Read the portrait and supply expectedVersion.');
    await pinPortraitEntry({ id, pinned, expectedVersion });
    res.json(await readHuman(PORTRAIT_HUMAN));
  } catch (e) { fail(res, e); }
});
const PORTRAIT_HUMAN: HumanScope = { kind: 'human', file: 'SOUL.md' };
/** 这个 Agent 实际读写的那份记忆(共用默认记忆的 Agent → 默认 Agent 的文件夹,和面板、写入端同一个口径)。 */
async function memoryBase(slug: string): Promise<{ memorySlug: string; base: string }> {
  const def = isValidSlug(slug) ? await getAgent(slug) : null;
  if (!def) throw new HumanError('HUMAN_NOT_FOUND', 'Agent not found.');
  const memorySlug = resolveMemorySlug(def);
  if (!isValidSlug(memorySlug)) throw new HumanError('HUMAN_NOT_FOUND', 'Invalid memory scope.');
  return { memorySlug, base: join(agentsDir(), memorySlug) };
}
router.get('/agent/agents/:slug/memory/layers', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const { memorySlug, base } = await memoryBase(String(req.params.slug));
    const l = readAgentLayers(base);
    res.json({
      version: l.version, residentChars: l.residentChars, limit: l.limit,
      resident: l.resident.map((r) => ({ id: r.entry.id, text: r.text, pinned: r.pinned, by: r.by, shadowed: r.shadowed })),
      topics: l.topics.map((t) => ({ key: t.key, title: t.title, about: t.about, path: t.path, entries: t.entries.map((e) => ({ id: e.entryId, text: e.text, by: e.by })) })),
      archive: l.archive ? { key: l.archive.key, title: l.archive.title, path: l.archive.path, entries: l.archive.entries.map((e) => ({ id: e.entryId, text: e.text, by: e.by })) } : null,
      organize: await organizeView({ kind: 'agent', slug: memorySlug }, agentOrganizeHistory(base)),
    });
  } catch (e) { fail(res, e); }
});
router.post('/agent/agents/:slug/memory/organize', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const { memorySlug } = await memoryBase(String(req.params.slug));
    res.json(await runOrganize({ kind: 'agent', slug: memorySlug }, { userId: req.user!.userId, manual: true }));
  } catch (e) { fail(res, e); }
});
router.post('/agent/agents/:slug/memory/organize/:id/undo', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const { base } = await memoryBase(String(req.params.slug));
    const r = undoAgentOrganize(base, String(req.params.id));
    scheduleAgentFilesSync(req.user!.userId, String(req.params.slug));
    res.json({ id: r.id, undoneAt: r.undoneAt, changed: r.undoChanged ?? [] });
  } catch (e) { fail(res, e); }
});
router.post('/agent/agents/:slug/memory/pin', authMiddleware, async (req: AuthRequest, res) => {
  if (!humanLocal(req, res)) return;
  try {
    const { id, pinned, expectedVersion } = req.body ?? {};
    if (typeof id !== 'string' || !id || typeof pinned !== 'boolean') throw new HumanError('PORTRAIT_INVALID', 'id and pinned are required.');
    const { base } = await memoryBase(String(req.params.slug));
    pinAgentEntry(base, { id, pinned, ...(typeof expectedVersion === 'string' && expectedVersion ? { expectedVersion } : {}) });
    scheduleAgentFilesSync(req.user!.userId, String(req.params.slug));
    res.json({ ok: true });
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
