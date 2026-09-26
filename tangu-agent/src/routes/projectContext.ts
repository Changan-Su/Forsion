/**
 * 项目上下文路由(桌面「PROJECT 详情」;handler 自带 authMiddleware):
 *   GET  /agent/project-context?sessionId=      → ProjectContext(指令文件 / 项目技能 / 计划 / 默认项 / git)
 *   POST /agent/project-context/init            { sessionId }                              → 建 .tangu/ + 骨架
 *   PUT  /agent/project-context/doc             { sessionId, content, expectedMtimeMs? }   → 写指令文件(409 = 别处改过)
 *   GET  /agent/project-context/settings?sessionId=|cwd= → { settings }(桌面建会话前的轻量预取;cwd 形态给没有会话可借的项目)
 *   PUT  /agent/project-context/settings        { sessionId, settings }                    → 用户侧项目默认项
 *   POST /agent/project-context/skills          { sessionId, slug, name, description, content } → 建项目技能
 *   POST   /agent/project-context/icon          { sessionId, data, mimeType }             → 导入图标图片进 .tangu/,返回 { settings }
 *   GET    /agent/project-context/icon?sessionId=|cwd=                                    → 图标图片二进制(settings.icon 是 emoji / 空 → 404)
 *   DELETE /agent/project-context/icon?sessionId=                                         → 移除图标(emoji 或图片),返回 { settings }
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
  saveProjectIcon, writeProjectDoc, writeProjectSettings,
} from '../services/projectContext.js';

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
    res.json(await projectContext(cwd));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'project context failed' });
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
    const { data, mimeType } = req.body || {};
    if (typeof data !== 'string' || typeof mimeType !== 'string') return res.status(400).json({ detail: 'data and mimeType are required' });
    res.json({ settings: await saveProjectIcon(cwd, data, mimeType) });
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

export default router;
