/**
 * 正文里的生成式 AI(评审 G3-07):`POST /agent/inline` —— 编辑器选区改写 / 续写 / 自定义指令的一次性补全,
 * 也是插件 `ctx.tangu.complete` 的落点(收编此前插件直连 `/agent/runs` 的做法)。
 * SSE:delta* → done | error(同旁聊 /aside)。不落库、无工具、不排 run 的队;客户端断开即中止上游请求。
 * 单独成文件(sessions.ts 被多个在途分支改着),在 index.ts 的注册处一行接入。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { resolveProfile } from '../seams/appProfile.js';
import { completeInline, normalizeInlineInput } from '../services/inlineAi.js';
import { normalizeClientTag } from './runs.js';

const router = Router();

/** 每用户在飞上限:编辑器一次一问,这道闸挡的是绕过客户端的并发刷(额度预检在请求前,并发时都能过预检)。 */
const INLINE_MAX_IN_FLIGHT = 3;
const inFlight = new Map<string, number>();

router.post('/agent/inline', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const input = normalizeInlineInput(req.body);
  if (!input) return res.status(400).json({ detail: 'invalid inline request: unknown action, or missing selection / instruction' });
  const modelId = (typeof req.body?.model_id === 'string' && req.body.model_id) || resolveProfile(typeof req.body?.app_id === 'string' ? req.body.app_id : undefined)?.defaultModelId || '';
  if (!modelId) return res.status(400).json({ detail: 'model_id required' });
  const n = inFlight.get(userId) || 0;
  if (n >= INLINE_MAX_IN_FLIGHT) return res.status(429).json({ detail: 'Too many inline requests in flight' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');
  const ac = new AbortController();
  // res 的 close 才是「连接没了」;req 的 close 在读完请求体时就会触发。
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const write = (event: object): void => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    (res as any).flush?.();
  };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 15_000);
  inFlight.set(userId, n + 1);
  try {
    const answer = await completeInline({
      userId, modelId, appId: (typeof req.body?.app_id === 'string' && req.body.app_id) || 'tangu', client: normalizeClientTag(req.body?.client),
      input, signal: ac.signal, onToken: (text) => write({ type: 'delta', text }),
    });
    write({ type: 'done', ...answer, modelId });
  } catch (e: any) {
    if (!ac.signal.aborted) write({ type: 'error', error: e?.message || 'inline completion failed' });
  } finally {
    clearInterval(heartbeat);
    const left = (inFlight.get(userId) || 1) - 1;
    if (left > 0) inFlight.set(userId, left); else inFlight.delete(userId);
    res.end();
  }
});

export default router;
