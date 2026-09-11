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
import { enqueueRun, abortRun, enqueueSteer, expediteSteer, cancelSteer, waitForRunSettlement } from '../services/agentLoop.js';
import { subscribe, type AgentEvent } from '../services/eventBus.js';

const router = Router();

/**
 * 客户端面标识白名单(信任边界:值来自客户端,会进 admin 统计的 group-by 与展示)。
 * 锁死 `<平台>/<版本>` 形态且平台只认自家客户端(cli/tui 预留)——不只挡脏字符,还挡任意串:
 * 认证用户能造高基数标签污染无分页的统计分组(2026-08-03 Codex 评审)。不合法 → undefined。
 */
const CLIENT_TAG_RE = /^(desktop|web|mobile|cli|tui)\/[A-Za-z0-9._-]{1,32}$/;
export function normalizeClientTag(v: unknown): string | undefined {
  return typeof v === 'string' && CLIENT_TAG_RE.test(v) ? v : undefined;
}

/**
 * GUI 自报的可派发命令目录 + 设置快照(信任边界:值来自客户端,且**会进模型上下文**)。
 * 与 client tag 同一条链:白名单消毒后随 input 落 JSONB,不加列、不动 stateStore 接缝。
 *
 * 消毒不是洁癖 —— 目录是模型每轮可读的文本,不封顶就等于给了客户端一个无限长的提示词注入位。
 * 条目数、字段长度、参数 schema 体积全部封顶;超出即截断,不报错(老客户端多送字段不该起不了 run)。
 */
// ⚠️ 必须容得下渲染端真实的 id 形态:插件命令是 `amadeus:<pluginId>:<命令 id>` 三段拼的,
// 而插件 id 本身就能到 64 字符,且插件作者常在 id 里用 `.`。收窄成 64/无点会让**合法**的插件
// 命令在这里被静默丢掉 —— 目录里有、派发时说不存在(Codex 评审 2026-09-04 P2-13)。
const UI_CMD_ID_RE = /^[A-Za-z0-9:._-]{1,160}$/;
// 排除 __proto__:`out[k] = …` 对它是改原型链不是加键(客户端可控的键名进 Object 字面量,必须挡)。
const UI_KEY_RE = /^(?!__proto__$)[A-Za-z0-9_]{1,64}$/;

/**
 * 目录文本进模型上下文 = 提示词注入面(插件作者写的字符串,宿主只是搬运工)。
 * 截断挡不住指令,只挡得住体积。这里额外做两件事:剥掉换行与控制字符(含 bidi 覆写),
 * 让一条 description 无法伪造出新的段落/小节去冒充系统指令。
 */
export function sanitizeText(v: string, max: number): string {
  return v
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const MAX_UI_COMMANDS = 200;
const MAX_UI_DESC = 300;
const MAX_UI_PARAMS_CHARS = 2000;
const MAX_UI_SETTINGS = 40;
/** 目录**总**字节预算。⚠️ 只有逐项上限时,200 条 × (300 描述 + 2000 params + 300 state) ≈ 520KB,
 *  离通用工具结果上限还很远,足够把有用的上下文整片挤出去(Codex 评审 2026-09-04 P1-7 的量级那半)。
 *  超出即停止收录,并在末尾留一条 truncated 记号 —— 静默截断会让模型以为它看到的就是全部。 */
const MAX_UI_CATALOG_CHARS = 24_000;

export function normalizeUiCommands(v: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(v)) return undefined; // 字段缺席 = 老客户端 → 界面面工具整体不注册
  const out: Array<Record<string, unknown>> = [];
  let budget = MAX_UI_CATALOG_CHARS;
  for (const raw of v.slice(0, MAX_UI_COMMANDS)) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const description = typeof o.description === 'string' ? sanitizeText(o.description, MAX_UI_DESC) : '';
    if (!UI_CMD_ID_RE.test(id) || !description) continue;
    const entry: Record<string, unknown> = { id, description };
    if (o.params && typeof o.params === 'object' && !Array.isArray(o.params)) {
      try {
        if (JSON.stringify(o.params).length <= MAX_UI_PARAMS_CHARS) entry.params = o.params;
      } catch { /* 带环的对象:丢掉 params,保留命令本身 */ }
    }
    if (typeof o.state === 'string' && o.state) {
      const st = sanitizeText(o.state, MAX_UI_DESC);
      if (st) entry.state = st;
    }
    const cost = id.length + description.length + (entry.params ? JSON.stringify(entry.params).length : 0) + String(entry.state ?? '').length;
    if (cost > budget) {
      out.push({ id: '_truncated', description: `catalog truncated: ${v.length - out.length} more command(s) not listed` });
      break;
    }
    budget -= cost;
    out.push(entry);
  }
  return out;
}

/** 每项设置上送 `{value, allowed}`。
 *  ⚠️ **合法值必须由渲染端给**,引擎不许自己维护一份枚举:主题包与插件字体是可上盘的,
 *  三个内置设计语言的真实 id 也是 `genesis-glass|lovable|zhi`(不是 genesis|soft)。
 *  引擎侧硬编码提示 = 保证会漂,而漂了的表现是模型照着提示发一个必被拒的值(Codex 评审 P2-11)。 */
export function normalizeUiSettings(v: unknown): Record<string, { value: string; allowed?: string[] }> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, { value: string; allowed?: string[] }> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>).slice(0, MAX_UI_SETTINGS)) {
    if (!UI_KEY_RE.test(k) || !raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const value = typeof o.value === 'string' || typeof o.value === 'number' || typeof o.value === 'boolean'
      ? sanitizeText(String(o.value), MAX_UI_DESC) : '';
    const entry: { value: string; allowed?: string[] } = { value };
    if (Array.isArray(o.allowed)) {
      const allowed = o.allowed
        .filter((x): x is string => typeof x === 'string')
        .slice(0, 60)
        .map((x) => sanitizeText(x, 64))
        .filter(Boolean);
      if (allowed.length) entry.allowed = allowed;
    }
    out[k] = entry;
  }
  return out;
}

/** 界面动作回执里的设置新值(key → value):键/条数/长度与 normalizeUiSettings 同一套上限;值域不收(run 内不变)。 */
export function normalizeUiValues(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>).slice(0, MAX_UI_SETTINGS)) {
    if (!UI_KEY_RE.test(k) || typeof raw !== 'string') continue;
    out[k] = sanitizeText(raw, MAX_UI_DESC);
  }
  return Object.keys(out).length ? out : undefined;
}

// 起一个 run
router.post('/agent/runs', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { session_id, model_id, app_id, message, attachments, agent_config, client, ui_commands, ui_settings } = req.body || {};
    if (agent_config != null && (typeof agent_config !== 'object' || Array.isArray(agent_config))) {
      return res.status(400).json({ detail: 'agent_config must be an object' });
    }
    // 客户端面标识(desktop/2.7.4 等,统计维度,与 app_id 正交)。客户端自报,白名单校验后
    // 随 input 落库(不加列:input 本就是 JSONB,免动 stateStore 接缝);不合法静默丢弃。
    const clientTag = normalizeClientTag(client);
    const uiCommandsNorm = normalizeUiCommands(ui_commands);
    const uiSettingsNorm = normalizeUiSettings(ui_settings);
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
      input: {
        message, userMessageId, attachments: attachments || [], agentConfig: agent_config || {},
        ...(clientTag ? { client: clientTag } : {}),
        // 界面面能力握手:字段在场(哪怕空数组)= 渲染端够新,会处理 ui_cmd 事件。缺席 → 工具不注册。
        ...(uiCommandsNorm ? { uiCommands: uiCommandsNorm } : {}),
        ...(uiSettingsNorm ? { uiSettings: uiSettingsNorm } : {}),
      },
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
    const settled = await waitForRunSettlement(req.params.id);
    const fresh = await getRunForUser(req.params.id, userId);
    // success 只代表接受取消;settled + status 才代表已退出。字段向后兼容现有客户端/网关。
    res.json({ success: true, settled, status: fresh?.status || run.status });
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || 'Failed to abort run' });
  }
});

// 运行时转向(steer)：把消息注入仍在跑的 run，下一迭代边界生效；run 已结束/仅排队 → 409，前端回退起新 run。
router.post('/agent/runs/:id/steer', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { message, attachments } = req.body || {};
    // Reuse the steer route so existing desktop/web/mobile gateways pass it through.
    // A flush only wakes already queued input. It never cancels the task or resends text.
    if (req.body?.flush === true) {
      const run = await getRunForUser(req.params.id, userId);
      if (!run) return res.status(404).json({ detail: 'Run not found' });
      const ok = expediteSteer(req.params.id);
      return res.status(ok ? 200 : 409).json({ ok, reason: ok ? undefined : 'not_active' });
    }
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

// 撤回一条尚未注入的转向消息(前端「删除 / ↑撤回编辑」)。已注入或 run 已终结 → 404,
// 前端据此判断「来不及了」(消息已进对话或已被丢弃)。
router.delete('/agent/runs/:id/steer/:messageId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const run = await getRunForUser(req.params.id, req.user!.userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    const ok = cancelSteer(req.params.id, req.params.messageId);
    if (!ok) return res.status(404).json({ detail: 'steer message not queued', reason: 'not_queued' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ detail: err?.message || 'Failed to cancel steer' });
  }
});

export default router;
