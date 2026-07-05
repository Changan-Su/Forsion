/**
 * agent-core 用户路由（handler 自带 authMiddleware）：
 *   POST /agent/runs                 起一个 run（异步），返回 {runId, assistantMessageId, userMessageId}
 *   GET  /agent/runs/:id/events      SSE：先回放 agent_run_events(seq>fromSeq) 再订阅 live（可恢复）
 *   GET  /agent/runs?session_id=     列出该 session 的在飞/最近 run（刷新恢复用）
 *   POST /agent/runs/:id/abort       中止
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { resolveProfile } from '../seams/appProfile.js';
import { createRun, getRunForUser, listActiveRunsBySession, listEventsFrom } from '../services/runStore.js';
import { enqueueRun, abortRun, enqueueSteer } from '../services/agentLoop.js';
import { subscribe, type AgentEvent } from '../services/eventBus.js';

const router = Router();

// 起一个 run
router.post('/agent/runs', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { session_id, model_id, app_id, message, attachments, agent_config } = req.body || {};
    // 接缝①(G1):app_id 经请求流入(缺省=本进程装配的 profile);未知 app_id 拒绝。
    const profile = resolveProfile(app_id);
    if (!profile) {
      return res.status(400).json({ detail: `unknown app_id: ${app_id}` });
    }
    const modelId = model_id || profile.defaultModelId || '';
    if (!session_id || !modelId) {
      return res.status(400).json({ detail: 'session_id and model_id are required' });
    }
    // 入站硬帽(防 2026-06-10 的巨型粘贴事故;窗口相对的细闸门在 agentLoop):
    // 400k 字符 ≈ 远超任何正常输入,直接 400,别让它进队列/落库。
    const MAX_INPUT_CHARS = Number(process.env.TANGU_MAX_INPUT_CHARS) || 400_000;
    if (typeof message === 'string' && message.length > MAX_INPUT_CHARS) {
      return res.status(400).json({
        detail: `消息过长(${message.length.toLocaleString()} 字符,上限 ${MAX_INPUT_CHARS.toLocaleString()})。请把大段材料保存为文件后让 agent 用工具读取。`,
      });
    }

    // session 可能尚未从客户端同步到服务端（AI Studio 客户端建 session、懒同步）。
    // 存在且属他人 → 拒绝；不存在 → 自动建一条（agent 端自给自足，避免新会话首条消息 404）。
    const owner = await deps().state.getSessionOwner(session_id);
    if (owner && owner !== userId) {
      return res.status(404).json({ detail: 'Session not found' });
    }
    if (!owner) {
      const title =
        typeof message === 'string' && message.trim() ? message.trim().slice(0, 60) : 'New Chat';
      await deps().state.autoCreateSession({ id: session_id, userId, appId: profile.appId, title, modelId });
    }

    // user 消息不在此落库，改由 runLoop 在 run 真正开始时插入（见 agentLoop），
    // 以保证排队 run 的消息时间戳排在上一个 run 的 assistant 之后、会话顺序正确。
    const userMessageId = uuidv4();

    const runId = uuidv4();
    const assistantMessageId = uuidv4();
    await createRun({
      id: runId,
      sessionId: session_id,
      userId,
      appId: profile.appId,
      modelId,
      assistantMessageId,
      input: { message, userMessageId, attachments: attachments || [], agentConfig: agent_config || {} },
    });

    enqueueRun(session_id, runId); // 同会话已有在飞 run 则排队，否则立刻起；均不 await

    res.json({ runId, assistantMessageId, userMessageId });
  } catch (err: any) {
    console.error('[agent-core] POST /agent/runs error:', err);
    res.status(500).json({ detail: err?.message || 'Failed to start run' });
  }
});

// 列出 session 的在飞/最近 run
router.get('/agent/runs', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sessionId = req.query.session_id as string;
    if (!sessionId) return res.status(400).json({ detail: 'session_id is required' });
    const runs = await listActiveRunsBySession(sessionId, userId);
    res.json({ runs });
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || 'Failed to list runs' });
  }
});

// SSE 事件流（回放 + live）
router.get('/agent/runs/:id/events', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  const runId = req.params.id;
  const fromSeq = parseInt((req.query.fromSeq as string) || '0', 10) || 0;

  const run = await getRunForUser(runId, userId);
  if (!run) return res.status(404).json({ detail: 'Run not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': open\n\n');

  let lastSent = fromSeq;
  let ended = false;
  let unsub: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // 客户端断开：仅解绑订阅，不杀 run（先于任何 await 注册，避免 replay 期间断开导致监听泄漏）
  req.on('close', () => {
    if (!ended) {
      ended = true;
      unsub();
    }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  });

  const safeWrite = (s: string) => {
    if (ended || res.writableEnded) return;
    try {
      res.write(s);
      // 部署在压缩/反代之后时,小事件可能滞留在 gzip 缓冲直到下次写入(群聊结束的 ended/总结提问尤甚:
      // 其后是长时间 await 用户回答,无后续写入触发 flush)。compression 中间件会挂 res.flush;无则 undefined → 安全空操作。
      (res as any).flush?.();
    } catch { /* socket closed */ }
  };
  const endStream = () => {
    if (ended) return;
    ended = true;
    unsub();
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    try { res.end(); } catch { /* ignore */ }
  };

  // 心跳：每 15s 发一行 SSE 注释，撑住长工具执行/思考期间的连接，
  // 既防代理掐死空闲连接，又给客户端「服务端还活着」的活跃信号（重置其 inactivity 看门狗）。
  heartbeat = setInterval(() => safeWrite(': hb\n\n'), 15_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  const writeEvent = (ev: AgentEvent) => {
    if (ended || ev.seq <= lastSent) return; // seq 去重
    lastSent = ev.seq;
    safeWrite(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === 'done' || ev.type === 'error') endStream();
  };

  // 先订阅 live（缓冲），再回放 DB，避免回放与 live 之间漏事件
  let caughtUp = false;
  const buffer: AgentEvent[] = [];
  unsub = subscribe(runId, (ev) => {
    if (!caughtUp) buffer.push(ev);
    else writeEvent(ev);
  });

  try {
    const past = await listEventsFrom(runId, fromSeq);
    for (const ev of past) writeEvent(ev);
  } catch (err) {
    console.error('[agent-core] replay error:', err);
  }
  caughtUp = true;
  for (const ev of buffer) writeEvent(ev);

  // 用「最新」状态判断终态（避免连接建立瞬间的 stale 快照）；若终态但未发过 done/error，补发一条，
  // 保证客户端 onDone/onError 一定触发（已完成 run 的恢复场景）。
  if (!ended) {
    const fresh = await getRunForUser(runId, userId).catch(() => run);
    const st = fresh?.status || run.status;
    if (['done', 'failed', 'aborted'].includes(st)) {
      const result = typeof fresh?.result === 'string' ? safeParse(fresh.result) : fresh?.result;
      if (st === 'done') {
        writeEvent({ seq: lastSent + 1, type: 'done', payload: { content: result?.content ?? '' } });
      } else {
        writeEvent({ seq: lastSent + 1, type: 'error', payload: { error: fresh?.error || st, aborted: st === 'aborted' } });
      }
      endStream();
    }
  }
});

function safeParse(s: any): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// 中止
router.post('/agent/runs/:id/abort', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const run = await getRunForUser(req.params.id, userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    abortRun(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || 'Failed to abort run' });
  }
});

// 运行时转向(steer)：把消息注入仍在跑的 run，下一迭代边界生效；run 已结束/仅排队 → 409，前端回退起新 run。
router.post('/agent/runs/:id/steer', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { message, attachments } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ detail: 'message is required' });
    }
    const MAX_INPUT_CHARS = Number(process.env.TANGU_MAX_INPUT_CHARS) || 400_000;
    if (message.length > MAX_INPUT_CHARS) {
      return res.status(400).json({ detail: `消息过长(${message.length.toLocaleString()} 字符,上限 ${MAX_INPUT_CHARS.toLocaleString()})。` });
    }
    const run = await getRunForUser(req.params.id, userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    const userMessageId = uuidv4();
    const ok = enqueueSteer(req.params.id, {
      id: userMessageId,
      content: message,
      attachments: Array.isArray(attachments) ? attachments : [],
    });
    if (!ok) return res.status(409).json({ detail: 'run not active', reason: 'not_active' });
    res.json({ ok: true, userMessageId });
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || 'Failed to steer run' });
  }
});

export default router;
