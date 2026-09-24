/**
 * Tangu for Chrome 扩展:给桌面设置页的状态 + 连接码。连接码等于配对凭据,只走带鉴权的引擎接口。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { connectCode, extensionStatus, extensionToken } from '../services/browserExtension.js';

const router = Router();

router.get('/agent/browser-extension', authMiddleware, (_req: AuthRequest, res) => {
  res.json({ ...extensionStatus(), code: connectCode() });
});

/** 换一枚连接码:旧的配对立刻失效(已连着的扩展会被断开,要用户重新粘贴)。 */
router.post('/agent/browser-extension/reset-code', authMiddleware, (_req: AuthRequest, res) => {
  extensionToken(true);
  res.json({ ...extensionStatus(), code: connectCode() });
});

export default router;
