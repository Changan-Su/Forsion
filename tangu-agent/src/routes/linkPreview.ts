/**
 * Chat 链接悬停卡的富卡数据(services/linkPreview.ts)。
 *
 *   GET /agent/link-preview?url=  → { preview: LinkPreview | null }
 *
 * 认不得 / 取不到一律 200 + null,不报错:渲染端照样出素卡。用的是本机绑定的凭据,远端(unitWeb)不放行。
 */
import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { linkPreview } from '../services/linkPreview.js';

const router = Router();

router.get('/agent/link-preview', authMiddleware, async (req: AuthRequest, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url || url.length > 2048) return res.status(400).json({ detail: 'url is required' });
  res.json({ preview: await linkPreview(req.user!.userId, url) });
});

export default router;
