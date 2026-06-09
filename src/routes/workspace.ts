/**
 * 把客户端（chat / 本地 loop 模式）会话的本地 workspace 文件上传到 Penzor 云空间，
 * 落在与云端 agent 相同的规范位置：<appId>/workspace/<sessionId>/...
 * handler 自带 authMiddleware。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import {
  writeFileRaw, listWorkspaceMetas, readWorkspaceFileRaw, deleteWorkspaceFile,
} from '../tools/fileWorkspace.js';

const router = Router();

// 列出某会话云端工作区文件（供 AI Studio 云模式 workspace 视图）。
router.get('/agent/workspace/list', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sessionId = String(req.query.sessionId || '');
    const appId = String(req.query.appId || 'ai-studio');
    if (!sessionId) return res.status(400).json({ detail: 'sessionId is required' });
    const files = await listWorkspaceMetas(userId, appId, sessionId);
    res.json({ files });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list failed' });
  }
});

// 读取某会话云端工作区文件内容（base64）。
router.get('/agent/workspace/read', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sessionId = String(req.query.sessionId || '');
    const appId = String(req.query.appId || 'ai-studio');
    const p = String(req.query.path || '');
    if (!sessionId || !p) return res.status(400).json({ detail: 'sessionId and path are required' });
    const f = await readWorkspaceFileRaw(userId, appId, sessionId, p);
    if (!f) return res.status(404).json({ detail: 'file not found' });
    res.json({ path: p, mimeType: f.mimeType, content: f.content.toString('base64'), encoding: 'base64', size: f.content.length });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read failed' });
  }
});

// 删除某会话云端工作区文件。
router.post('/agent/workspace/delete', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { sessionId, appId, path: p } = req.body || {};
    if (!sessionId || !p) return res.status(400).json({ detail: 'sessionId and path are required' });
    const ok = await deleteWorkspaceFile(userId, typeof appId === 'string' && appId ? appId : 'ai-studio', sessionId, p);
    res.json({ ok });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete failed' });
  }
});

router.post('/agent/workspace/upload', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { sessionId, appId, files } = req.body || {};
    if (!sessionId || !Array.isArray(files)) {
      return res.status(400).json({ detail: 'sessionId and files[] are required' });
    }
    const app = typeof appId === 'string' && appId ? appId : 'ai-studio';
    let saved = 0;
    const errors: string[] = [];
    for (const f of files) {
      if (!f || typeof f.path !== 'string') continue;
      try {
        const buf =
          f.encoding === 'base64'
            ? Buffer.from(String(f.content || ''), 'base64')
            : Buffer.from(String(f.content || ''), 'utf-8');
        await writeFileRaw(userId, app, sessionId, f.path, buf, f.mimeType);
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

export default router;
