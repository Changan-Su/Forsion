/**
 * 项目上下文路由(桌面「PROJECT 详情」;handler 自带 authMiddleware):
 *   GET  /agent/project-context?sessionId=      → ProjectContext(指令文件 / 项目技能 / 计划 / 默认项 / git)
 *   POST /agent/project-context/init            { sessionId }                              → 建 .tangu/ + 骨架
 *   DELETE /agent/project-context/memory        { sessionId, id, expectedVersion }         → 删一条项目记忆,返回 { memory }(GET 的 context 里带 memory;远端来源不给)
 *   POST /agent/project-context/memory/candidate { sessionId, id, action: adopt|dismiss }  → 对一条待确认的后台候选点头或丢弃,返回 { memory }(远端来源不给)
 *   POST /agent/project-context/memory/restore   { sessionId, id }                          → 把写满压缩时合并 / 去掉的一句原句记回去,返回 { memory }
 *   PUT  /agent/project-context/doc             { sessionId, content, expectedMtimeMs? }   → 写指令文件(409 = 别处改过)
 *   GET  /agent/project-context/settings?sessionId=|cwd= → { settings }(桌面建会话前的轻量预取;cwd 形态给没有会话可借的项目)
 *   PUT  /agent/project-context/settings        { sessionId, settings }                    → 用户侧项目默认项
 *   POST /agent/project-context/skills          { sessionId, slug, name, description, content } → 建项目技能
 *   POST   /agent/project-context/icon          { sessionId, data } | { sessionId, emoji } → 导入图片进 .tangu/ 或设 emoji,返回 { settings }
 *          (图标只经这组端点改;PUT settings 保留 icon 现值)
 *   GET    /agent/project-context/icon?sessionId=|cwd=                                    → 图标图片二进制(settings.icon 是 emoji / 空 → 404)
 *   DELETE /agent/project-context/icon?sessionId=                                         → 移除图标(emoji 或图片),返回 { settings }
 *   POST   /agent/project-context/git/{init,trust,commit,branch,push,pull}  { sessionId, message?, name?, trust? } → 写动作 + 新的 context
 *          (push / pull 的远端有凭据提供方认领时带凭据,见 services/gitCredentials.ts;pull = fetch + 只快进)
 *   GET    /agent/project-context/git/hosting?sessionId=              → { forsionGit: { webUrl, name } | null }(这里能不能「发布到 Forsion Git」)
 *   POST   /agent/project-context/git/publish  { sessionId, name, trust? } → 没有远端的仓库:origin 设到 Forsion Git 并推送(services/forsionGitPublish.ts)
 *   POST   /agent/project-context/git/{pending,message}                { sessionId, trust? } → 待提交清单 / 生成的提交信息(只读)
 *          → 用户点的 git 动作(services/gitActions.ts);失败回 400 { detail, error: <code>, info },桌面按 error 出文案。
 *          trust=true = 用户在面板上点了「信任并继续」(仓库自带会执行程序的配置,见 services/gitTrust.ts)
 *   GET|PUT /agent/git-settings                                                          → 「设置 → Git」(config.json 的 git 段)
 *
 * 只对本地引擎开放(hostExec):云端 microserver 没有用户磁盘。**cwd 不从客户端收**:请求按 sessionId 绑定,只认本人会话行上的
 * project_path(桌面项目分组键)—— 能写的只有用户已经在里面工作的目录,`hostExec` 说明的是引擎形态,不是路径授权(codex 评审)。
 */
import { Router, type Response } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';
import {
  canonicalProjectPath, createProjectSkill, deleteProjectIcon, initProjectWorkspace, projectContext, readProjectIcon, readProjectSettings,
  saveProjectIcon, setProjectIconEmoji, writeProjectDoc, writeProjectSettings,
} from '../services/projectContext.js';
import { forgetProjectMemory, projectMemoryView, resolveProjectCandidate, restoreCompactedFact } from '../services/projectMemory.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { GitActionError, generateCommitMessage, gitCommit, gitCreateBranch, gitInit, gitPending, gitPull, gitPush, gitTrustRepo, serialized } from '../services/gitActions.js';
import { DEFAULT_GIT_SETTINGS, gitSettings, updateGitSettings } from '../services/gitSettings.js';
import { forsionPublishInfo, publishToForsionGit } from '../services/forsionGitPublish.js';

const router = Router();

/** 会话 → canonical 项目目录;不是本人 / 不是项目会话 / 目录没了 → 已回复错误,返回 null。 */
async function projectDirOf(req: AuthRequest, res: Response, sessionId: unknown): Promise<string | null> {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ detail: 'Project context is only available on a local engine' }); return null; }
  if (typeof sessionId !== 'string' || !sessionId) { res.status(400).json({ detail: 'sessionId is required' }); return null; }
  const rows = await query<any[]>('SELECT user_id, project_path FROM chat_sessions WHERE id = ? LIMIT 1', [sessionId]);
  const s = rows[0];
  if (!s || s.user_id !== req.user!.userId) { res.status(404).json({ detail: 'Session not found' }); return null; }
  if (!s.project_path) { res.status(400).json({ detail: 'This session does not belong to a local project' }); return null; }
  try {
    return await canonicalProjectPath(String(s.project_path));
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'invalid project path' });
    return null;
  }
}

const fail = (res: Response, e: any, fallback: string): void => { res.status(400).json({ detail: e?.message || fallback }); };
/** 项目记忆的失败:404 = 那一条已经不在了,409 = 别处刚改过(都让界面重载);error 是机器码(桌面 request() 从它取 code)。 */
const memoryFail = (res: Response, e: any, fallback: string): void => {
  res.status(e?.code === 'MEMORY_NOT_FOUND' ? 404 : e?.code === 'MEMORY_VERSION_CONFLICT' || e?.code === 'MEMORY_BUSY' ? 409 : 400).json({ detail: e?.message || fallback, code: e?.code, error: e?.code });
};

/** 只读端点的目录解析:`?sessionId=` 照常绑定;也接 `?cwd=` —— 项目会话全删光再添加回来时没有会话可借,
 *  而这里读的只是用户家目录里自己的记录(图标图片也只在那份记录指向它时才出),不碰别的项目内容。 */
async function readableDirOf(req: AuthRequest, res: Response): Promise<string | null> {
  if (typeof req.query.cwd === 'string' && req.query.cwd && !req.query.sessionId) {
    if (!deps().profile.capabilities.hostExec) { res.status(404).json({ detail: 'Project context is only available on a local engine' }); return null; }
    try { return await canonicalProjectPath(req.query.cwd); } catch (e: any) { res.status(400).json({ detail: e?.message || 'invalid project path' }); return null; }
  }
  return projectDirOf(req, res, req.query.sessionId);
}

router.get('/agent/project-context', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.query.sessionId);
    if (!cwd) return;
    // 项目记忆(10-04):同协作说明的口径,远端设备来的请求不给看、也不给改(见下面的 DELETE)。
    const memory = parseRemoteOrigin(req.headers) ? undefined : await projectMemoryView(cwd).catch(() => undefined);
    res.json({ ...(await projectContext(cwd)), ...(memory ? { memory } : {}) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'project context failed' });
  }
});

// 用户删一条项目记忆(项目详情 › 设置)。只在主机上:与协作说明、agent 管理面同一条「持久配置只在本机改」的边界。
router.delete('/agent/project-context/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (parseRemoteOrigin(req.headers)) return res.status(403).json({ detail: 'Open the project on the host computer to edit its memory.' });
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const { id, expectedVersion } = req.body || {};
    if (typeof id !== 'string' || !id || typeof expectedVersion !== 'string' || !expectedVersion) return res.status(400).json({ detail: 'id and expectedVersion are required' });
    res.json({ memory: await forgetProjectMemory(cwd, id, expectedVersion) });
  } catch (e: any) {
    memoryFail(res, e, 'forget project memory failed');
  }
});

// 用户对一条待确认的后台候选(过不了形状闸、没有直接记的那些)点「采纳 / 丢弃」。同样只在主机上。
router.post('/agent/project-context/memory/candidate', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (parseRemoteOrigin(req.headers)) return res.status(403).json({ detail: 'Open the project on the host computer to edit its memory.' });
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const { id, action } = req.body || {};
    if (typeof id !== 'string' || !id || (action !== 'adopt' && action !== 'dismiss')) return res.status(400).json({ detail: 'id and action ("adopt" or "dismiss") are required' });
    res.json({ memory: await resolveProjectCandidate(cwd, id, action === 'adopt') });
  } catch (e: any) {
    memoryFail(res, e, 'project memory candidate action failed');
  }
});

// 用户把写满压缩时被合并 / 去掉的一句原句「恢复」(项目详情 › 设置)。同样只在主机上;放不下 → 400 + MEMORY_FULL(界面提示先删几条)。
router.post('/agent/project-context/memory/restore', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (parseRemoteOrigin(req.headers)) return res.status(403).json({ detail: 'Open the project on the host computer to edit its memory.' });
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const { id } = req.body || {};
    if (typeof id !== 'string' || !id) return res.status(400).json({ detail: 'id is required' });
    res.json({ memory: await restoreCompactedFact(cwd, id) });
  } catch (e: any) {
    memoryFail(res, e, 'restore project memory failed');
  }
});

router.post('/agent/project-context/init', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const result = await initProjectWorkspace(cwd);
    res.json({ ...result, context: await projectContext(cwd) });
  } catch (e: any) {
    fail(res, e, 'project init failed');
  }
});

router.put('/agent/project-context/doc', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const expected = req.body?.expectedMtimeMs;
    const result = await writeProjectDoc(cwd, req.body?.content, typeof expected === 'number' ? expected : null);
    if (result.conflict) return res.status(409).json({ detail: 'The instruction file changed elsewhere', path: result.path, mtimeMs: result.mtimeMs });
    res.json(result);
  } catch (e: any) {
    fail(res, e, 'write instruction file failed');
  }
});

/** 轻量读:桌面建会话前预取项目默认项用(全量 context 会跑 git,预取不值得)。 */
router.get('/agent/project-context/settings', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await readableDirOf(req, res);
    if (!cwd) return;
    res.json({ settings: await readProjectSettings(cwd) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read project settings failed' });
  }
});

router.put('/agent/project-context/settings', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    res.json({ settings: await writeProjectSettings(cwd, req.body?.settings) });
  } catch (e: any) {
    fail(res, e, 'write project settings failed');
  }
});

router.post('/agent/project-context/skills', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    res.json({ skill: await createProjectSkill(cwd, req.body || {}) });
  } catch (e: any) {
    fail(res, e, 'create project skill failed');
  }
});

router.post('/agent/project-context/icon', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const { data, emoji } = req.body || {};
    if (typeof data === 'string') return res.json({ settings: await saveProjectIcon(cwd, data) });
    if (typeof emoji === 'string') return res.json({ settings: await setProjectIconEmoji(cwd, emoji) });
    res.status(400).json({ detail: 'data or emoji is required' });
  } catch (e: any) {
    fail(res, e, 'save project icon failed');
  }
});

router.get('/agent/project-context/icon', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await readableDirOf(req, res);
    if (!cwd) return;
    const icon = await readProjectIcon(cwd);
    if (!icon) return res.status(404).json({ detail: 'no icon image' });
    res.setHeader('Content-Type', icon.mimeType);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(icon.data);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read project icon failed' });
  }
});

router.delete('/agent/project-context/icon', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.query.sessionId);
    if (!cwd) return;
    res.json({ settings: await deleteProjectIcon(cwd) });
  } catch (e: any) {
    fail(res, e, 'remove project icon failed');
  }
});

// ── Git 动作(PROJECT 详情「Git」页;用户点了才做)───────────────────────────

/** 带 code 的失败 → 400 { error: code }(桌面 request() 从 error 取机器码本地化,info 是 git 原文 / 文件名);其余 → 500。 */
function gitFail(res: Response, e: any, fallback: string): void {
  if (e instanceof GitActionError) { res.status(400).json({ detail: e.message, error: e.code, info: e.detail }); return; }
  res.status(500).json({ detail: e?.message || fallback });
}

/** 写动作:同一目录排队;做完连同新的项目上下文一起回,面板一次刷新。上下文在队列里读(不混进下一个动作的状态);
 *  读失败回 context:null —— 动作已经做完,不许报成失败(用户会重试 → 重复提交 / 再跑一遍钩子),桌面见 null 自己重读。 */
function gitWrite(label: string, action: (cwd: string, body: any) => Promise<object>) {
  return async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const cwd = await projectDirOf(req, res, req.body?.sessionId);
      if (!cwd) return;
      res.json(await serialized(cwd, async () => {
        const result = await action(cwd, req.body || {});
        return { ...result, context: await projectContext(cwd).catch(() => null) };
      }));
    } catch (e: any) {
      gitFail(res, e, `git ${label} failed`);
    }
  };
}
const trusted = (body: any): boolean => body?.trust === true;
// 路径一律写字面量:desktop/scripts/gen-engine-routes.mjs 静态抽出全部路由给远程访问分类表,模板串抽不出来
router.post('/agent/project-context/git/init', authMiddleware, gitWrite('init', (cwd) => gitInit(cwd)));
router.post('/agent/project-context/git/trust', authMiddleware, gitWrite('trust', (cwd) => gitTrustRepo(cwd)));
// 面板提交必须带上它刚给用户看过的清单指纹:没有清单 = 用户没过目,不许提交
router.post('/agent/project-context/git/commit', authMiddleware, gitWrite('commit', async (cwd, body) => {
  if (typeof body.expect !== 'string' || !body.expect) throw new GitActionError('changes_changed', 'Review the list of changes before committing');
  return { commit: await gitCommit(cwd, body.message, trusted(body), body.expect) };
}));
router.post('/agent/project-context/git/branch', authMiddleware, gitWrite('branch', (cwd, body) => gitCreateBranch(cwd, body.name, trusted(body))));
router.post('/agent/project-context/git/push', authMiddleware, gitWrite('push', (cwd, body) => gitPush(cwd, trusted(body))));
router.post('/agent/project-context/git/pull', authMiddleware, gitWrite('pull', async (cwd, body) => ({ pull: await gitPull(cwd, trusted(body)) })));

router.post('/agent/project-context/git/publish', authMiddleware, gitWrite('publish', async (cwd, body) => ({ publish: await publishToForsionGit(cwd, body.name, trusted(body)) })));

/** 这里能不能「发布到 Forsion Git」(登录了 Forsion、云端有 Forsion Git 且发凭据)。只读站点信息,不取凭据;读不到就是 null。 */
router.get('/agent/project-context/git/hosting', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.query.sessionId);
    if (!cwd) return;
    res.json({ forsionGit: await forsionPublishInfo(cwd).catch(() => null) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'git hosting lookup failed' });
  }
});

/** 待提交清单(提交框完整列出;有已暂存的只列已暂存的)。只读,不排队。 */
router.post('/agent/project-context/git/pending', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    res.json(await gitPending(cwd, trusted(req.body)));
  } catch (e: any) {
    gitFail(res, e, 'list pending changes failed');
  }
});

/** 用会话自己的模型写一条提交信息(只读,不排队;计费在 generateCommitMessage 里)。 */
router.post('/agent/project-context/git/message', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const cwd = await projectDirOf(req, res, req.body?.sessionId);
    if (!cwd) return;
    const rows = await query<any[]>('SELECT model_id, app_id FROM chat_sessions WHERE id = ? LIMIT 1', [req.body.sessionId]);
    const message = await generateCommitMessage(cwd, { userId: req.user!.userId, modelId: rows[0]?.model_id ?? null, appId: rows[0]?.app_id || 'tangu', trust: trusted(req.body) });
    res.json({ message });
  } catch (e: any) {
    gitFail(res, e, 'generate commit message failed');
  }
});

/** 「设置 → Git」的读写口。写的是本进程的 config.json → 云端 worker(hostExec=false)不开放,同 /agent/compaction。 */
router.get('/agent/git-settings', authMiddleware, (_req, res) => {
  res.json({ settings: gitSettings(), defaults: DEFAULT_GIT_SETTINGS, writable: deps().profile.capabilities.hostExec });
});
router.put('/agent/git-settings', authMiddleware, (req, res) => {
  if (!deps().profile.capabilities.hostExec) return res.status(404).json({ detail: 'Git settings are only available on a local engine' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) return res.status(400).json({ detail: 'git settings fields required' });
  try {
    res.json({ settings: updateGitSettings(body) });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'invalid git settings' });
  }
});

export default router;
