/**
 * 把客户端（chat / 本地 loop 模式）会话的本地 workspace 文件上传到 Penzor 云空间，
 * 落在与云端 agent 相同的规范位置：<appId>/workspace/<sessionId>/...
 * handler 自带 authMiddleware。
 */
import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { query } from '../core/db.js';
import {
  writeFileRaw, listWorkspaceMetas, readWorkspaceFileRaw, deleteWorkspaceFile,
  mimeForName, sanitizeProjectName, listProjects, ensureProject, DEFAULT_PROJECT_NAME,
  type WorkspaceMeta, type WsScope,
} from '../tools/fileWorkspace.js';
import { getSessionDir, markSessionDirty, type SessionKey } from '../sandbox/sessionSandbox.js';

const router = Router();

/** appId 缺省回退本进程 profile(microserver='ai-studio' 与旧硬编码等价;standalone='tangu')。 */
const defaultAppId = (v: unknown): string =>
  typeof v === 'string' && v ? v : deps().profile.appId;

/**
 * 解析请求的工作区 scope + appId：显式 project/appId 参数优先，否则查 session 行——
 * project_name 有值且非本地目录会话(project_path 空)即云端 Project 会话，文件落
 * <appId>/Cloud-Workspaces/Projects/<name>/(跨会话共享)；否则旧 per-session 工作区。
 * 服务端解析使旧客户端(只传 sessionId)对 Project 会话也拿到正确文件视图。
 */
async function resolveScope(
  userId: string,
  sessionId: string,
  explicitProject: unknown,
  explicitAppId: unknown,
): Promise<{ scope: WsScope; appId: string; key: SessionKey }> {
  let project = sanitizeProjectName(explicitProject);
  let appId = typeof explicitAppId === 'string' && explicitAppId ? explicitAppId : '';
  if (!project || !appId) {
    try {
      const rows = await query<any[]>(
        'SELECT user_id, app_id, project_name, project_path FROM chat_sessions WHERE id = ? LIMIT 1',
        [sessionId],
      );
      const s = rows[0];
      if (s && s.user_id === userId) {
        if (!project && !s.project_path) project = sanitizeProjectName(s.project_name);
        if (!appId && s.app_id) appId = String(s.app_id);
      }
    } catch { /* standalone 旧库缺列等 → 回退旧 per-session 行为 */ }
  }
  appId = appId || deps().profile.appId;
  const scope: WsScope = { sessionId, project };
  return { scope, appId, key: { userId, appId, sessionId, wsProject: project } };
}

// ── 本地会话目录回退(standalone):brain.storage 在 standalone 不可用(httpBrain 全抛),
//    而文件工具本就 local-first 写在会话沙箱目录——云存储不可用时改用同一目录,
//    桌面工作区面板才能与工具看到同一份文件。microserver 云存储可用,不走回退,行为不变。
//    注意 listWorkspaceMetas/readWorkspaceFileRaw/deleteWorkspaceFile 对错误内部吞掉
//    (返回 []/null/false),无法靠 .catch 判别——用一次性探测(缓存)决定走哪条路。──

let cloudStorageUp: boolean | null = null;
async function isCloudStorageUp(userId: string, appId: string): Promise<boolean> {
  if (cloudStorageUp !== null) return cloudStorageUp;
  try {
    await deps().brain.storage.listDirectory('ROOT', userId, appId);
    cloudStorageUp = true;
  } catch {
    cloudStorageUp = false;
  }
  return cloudStorageUp;
}

/** 解析会话内相对路径为本地绝对路径;越界(..)返回 null。 */
function safeJoin(baseDir: string, p: string): string | null {
  const abs = path.resolve(baseDir, './' + String(p || '').replace(/^\/+/, ''));
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return abs;
}

async function localList(key: SessionKey): Promise<WorkspaceMeta[]> {
  const dir = await getSessionDir(key);
  const out: WorkspaceMeta[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = path.join(dir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else {
        const st = await fs.stat(path.join(dir, r)).catch(() => null);
        if (st) out.push({ path: '/' + r, size: st.size, mimeType: mimeForName(e.name), updatedAt: st.mtimeMs });
      }
    }
  }
  await walk('');
  return out;
}

async function localRead(key: SessionKey, p: string): Promise<{ content: Buffer; mimeType: string } | null> {
  const dir = await getSessionDir(key);
  const abs = safeJoin(dir, p);
  if (!abs) return null;
  const content = await fs.readFile(abs).catch(() => null);
  if (!content) return null;
  return { content, mimeType: mimeForName(path.basename(abs)) };
}

// 列出某会话云端工作区文件（供 AI Studio 云模式 workspace 视图）。
router.get('/agent/workspace/list', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ detail: 'sessionId is required' });
    const r = await resolveScope(userId, sessionId, req.query.project, req.query.appId);
    const files = (await isCloudStorageUp(userId, r.appId))
      ? await listWorkspaceMetas(userId, r.appId, r.scope)
      : await localList(r.key);
    res.json({ files, project: r.scope.project || null });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list failed' });
  }
});

// 读取某会话云端工作区文件内容（base64）。
router.get('/agent/workspace/read', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sessionId = String(req.query.sessionId || '');
    const p = String(req.query.path || '');
    if (!sessionId || !p) return res.status(400).json({ detail: 'sessionId and path are required' });
    const r = await resolveScope(userId, sessionId, req.query.project, req.query.appId);
    const f = (await isCloudStorageUp(userId, r.appId))
      ? await readWorkspaceFileRaw(userId, r.appId, r.scope, p)
      : await localRead(r.key, p);
    if (!f) return res.status(404).json({ detail: 'file not found' });
    res.json({ path: p, mimeType: f.mimeType, content: f.content.toString('base64'), encoding: 'base64', size: f.content.length });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read failed' });
  }
});

// 下载某会话云端工作区文件（二进制流,浏览器 <a download> 直用）。
router.get('/agent/workspace/download', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sessionId = String(req.query.sessionId || '');
    const p = String(req.query.path || '');
    if (!sessionId || !p) return res.status(400).json({ detail: 'sessionId and path are required' });
    const r = await resolveScope(userId, sessionId, req.query.project, req.query.appId);
    const f = (await isCloudStorageUp(userId, r.appId))
      ? await readWorkspaceFileRaw(userId, r.appId, r.scope, p)
      : await localRead(r.key, p);
    if (!f) return res.status(404).json({ detail: 'file not found' });
    const filename = p.split('/').filter(Boolean).pop() || 'file';
    res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(f.content);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'download failed' });
  }
});

// 删除某会话云端工作区文件。
router.post('/agent/workspace/delete', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { sessionId, appId, path: p, project } = req.body || {};
    if (!sessionId || !p) return res.status(400).json({ detail: 'sessionId and path are required' });
    const r = await resolveScope(userId, String(sessionId), project, appId);
    let ok: boolean;
    if (await isCloudStorageUp(userId, r.appId)) {
      ok = await deleteWorkspaceFile(userId, r.appId, r.scope, p);
    } else {
      const dir = await getSessionDir(r.key);
      const abs = safeJoin(dir, p);
      ok = false;
      if (abs) {
        ok = await fs.unlink(abs).then(() => true).catch(() => false);
        if (ok) markSessionDirty(r.key);
      }
    }
    res.json({ ok });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete failed' });
  }
});

router.post('/agent/workspace/upload', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { sessionId, appId, files, project } = req.body || {};
    if (!sessionId || !Array.isArray(files)) {
      return res.status(400).json({ detail: 'sessionId and files[] are required' });
    }
    const r = await resolveScope(userId, String(sessionId), project, appId);
    let saved = 0;
    const errors: string[] = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string') continue;
      try {
        const buf =
          f.encoding === 'base64'
            ? Buffer.from(String(f.content || ''), 'base64')
            : Buffer.from(String(f.content || ''), 'utf-8');
        if (await isCloudStorageUp(userId, r.appId)) {
          await writeFileRaw(userId, r.appId, r.scope, f.path, buf, f.mimeType);
        } else {
          // standalone:云存储不可用 → 写本地会话目录(与文件工具同一目录)。
          const dir = await getSessionDir(r.key);
          const abs = safeJoin(dir, f.path);
          if (!abs) throw new Error('invalid path');
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, buf);
          markSessionDirty(r.key);
        }
        saved++;
      } catch (e: any) {
        errors.push(`${f.path}: ${e?.message || e}`);
      }
    }
    res.json({ success: true, saved, total: files.length, errors });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'upload failed' });
  }
});

// ── 云端 Project 管理:<appId>/Cloud-Workspaces/Projects/ 下的目录即项目,
//    在 Penzor 云空间(网页)以普通文件夹可见。默认项目 Tangu 恒在列表首位(目录懒创建——
//    首次写文件时 resolveDir 自动建链,列表阶段不落库)。──────────────────────────

router.get('/agent/projects', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const appId = defaultAppId(req.query.appId);
    const names = (await isCloudStorageUp(userId, appId)) ? await listProjects(userId, appId) : [];
    if (!names.includes(DEFAULT_PROJECT_NAME)) names.unshift(DEFAULT_PROJECT_NAME);
    res.json({ projects: names.map((name) => ({ name, isDefault: name === DEFAULT_PROJECT_NAME })) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list projects failed' });
  }
});

router.post('/agent/projects', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const name = sanitizeProjectName(req.body?.name);
    if (!name) return res.status(400).json({ detail: 'invalid project name' });
    const appId = defaultAppId(req.body?.appId);
    if (!(await isCloudStorageUp(userId, appId))) {
      return res.status(503).json({ detail: 'cloud storage unavailable' });
    }
    await ensureProject(userId, appId, name);
    res.json({ name });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'create project failed' });
  }
});

export default router;
