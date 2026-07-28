/**
 * 图像识别端点 —— 非聊天场景「认张图」的快捷通道(插件 / 自动化 / 外部集成)。
 *
 *   POST /agent/vision/describe  { images: string[] | image: string, prompt? }
 *                              → { text, modelId }
 *
 * 与走一个 agent run 的区别:不建会话、不进上下文、不跑工具循环——一次 LLM 往返拿文字就走。
 * 用「辅助模型 · 图像识别」槽;槽为空 → 400(而不是悄悄拿主模型顶上,主模型可能正是那个看不了图的)。
 *
 * ⚠️两条闸别拆(2026-07-27 Codex 评审):
 *   · **模型由服务端槽决定,不收客户端的 modelId** —— 否则任何登录用户都能点名最贵的模型跑,
 *     还绕过 admin 的 app 模型白名单。
 *   · **入参有体积上限** —— 这条路不经 agent loop 的入站闸,data URL 可以很大。
 *     计费在 describeImages 内(预检 → 扣费 → 记用量),不是免费通道。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { describeImages, resolveVisionModelId } from '../services/visionService.js';

const router = Router();

/** 单图与整批上限(base64 后的字符数)。贴近 provider 的单图 5-10MB 与 hostExec 的 view_image 口径。 */
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
const MAX_TOTAL_CHARS = 20 * 1024 * 1024;
const MAX_PROMPT_CHARS = 4000;

router.post('/agent/vision/describe', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const body = req.body || {};
    const raw: unknown = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
    const urls = (raw as unknown[]).map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
    if (!urls.length) return res.status(400).json({ detail: '缺少 images(data URL 或图片 URL)' });

    let total = 0;
    for (const u of urls) {
      if (u.length > MAX_IMAGE_CHARS) return res.status(413).json({ detail: `单张图片超过 ${MAX_IMAGE_CHARS / 1048576}MB` });
      total += u.length;
    }
    if (total > MAX_TOTAL_CHARS) return res.status(413).json({ detail: `图片总量超过 ${MAX_TOTAL_CHARS / 1048576}MB` });

    const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, MAX_PROMPT_CHARS) : undefined;
    const appId = deps().profile.appId;
    const modelId = await resolveVisionModelId('', appId); // 只认服务端槽,不收 body.modelId
    if (!modelId) return res.status(400).json({ detail: '未配置图像识别模型(设置 → 模型 → 辅助模型)' });

    const text = await describeImages(urls.map((url) => ({ url })), {
      modelId,
      userId: req.user!.userId,
      prompt,
      appId,
    });
    res.json({ text, modelId });
  } catch (e: any) {
    const msg = e?.message || 'describe failed';
    if (msg === 'token_quota_exceeded') return res.status(402).json({ detail: 'token_quota_exceeded' });
    res.status(500).json({ detail: msg });
  }
});

export default router;
