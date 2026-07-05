/**
 * WeChat Remote 路由：Desktop 设置页扫码绑定 iLink bot。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { wechatRemote } from '../services/wechatRemote.js';

const router = Router();

function approvalMode(v: any): 'readonly' | 'auto-edit' | 'full-auto' | undefined {
  return v === 'readonly' || v === 'auto-edit' || v === 'full-auto' ? v : undefined;
}

router.post('/agent/wechat/login/start', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const body = req.body || {};
    const out = await wechatRemote.loginStart({
      userId: req.user!.userId,
      sessionId: typeof body.session_id === 'string' && body.session_id ? body.session_id : undefined,
      modelId: typeof body.model_id === 'string' && body.model_id ? body.model_id : undefined,
      approvalMode: approvalMode(body.approval_mode),
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat login start failed' });
  }
});

router.get('/agent/wechat/login/status', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const loginId = String(req.query.loginId || '');
    if (!loginId) return res.status(400).json({ detail: 'loginId is required' });
    res.json(await wechatRemote.loginStatus(req.user!.userId, loginId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat login status failed' });
  }
});

router.get('/agent/wechat/status', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json(await wechatRemote.status(req.user!.userId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat status failed' });
  }
});

router.post('/agent/wechat/disconnect', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const accountId = String(req.body?.account_id || '');
    if (!accountId) return res.status(400).json({ detail: 'account_id is required' });
    res.json(await wechatRemote.disconnect(req.user!.userId, accountId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat disconnect failed' });
  }
});

// 「微信远程」Project(~/Tangu/webot)下的会话列表(供主界面选择正在连接的 session)。
router.get('/agent/wechat/sessions', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json({ sessions: await wechatRemote.listProjectSessions(req.user!.userId) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat sessions failed' });
  }
});

// 切换「正在连接的 session」。
router.post('/agent/wechat/connect', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const sessionId = String(req.body?.session_id || '');
    if (!sessionId) return res.status(400).json({ detail: 'session_id is required' });
    res.json(await wechatRemote.setConnectedSession(req.user!.userId, sessionId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat connect failed' });
  }
});

// 设置某微信会话使用的 Normal Agent。
router.post('/agent/wechat/session-agent', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const sessionId = String(req.body?.session_id || '');
    const agentSlug = String(req.body?.agent_slug || '');
    if (!sessionId || !agentSlug) return res.status(400).json({ detail: 'session_id 与 agent_slug 必填' });
    res.json(await wechatRemote.setSessionAgent(req.user!.userId, sessionId, agentSlug));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'set session agent failed' });
  }
});

// 在微信 Project 下新建会话(可选立即切为正在连接)。
router.post('/agent/wechat/sessions/new', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const title = typeof req.body?.title === 'string' && req.body.title ? req.body.title : undefined;
    const modelId = typeof req.body?.model_id === 'string' && req.body.model_id ? req.body.model_id : undefined;
    const id = await wechatRemote.createWebotSession(req.user!.userId, modelId, title);
    if (req.body?.connect !== false) await wechatRemote.setConnectedSession(req.user!.userId, id);
    res.json({ sessionId: id });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'wechat session create failed' });
  }
});

export default router;
