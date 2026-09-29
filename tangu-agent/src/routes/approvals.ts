/**
 * host-exec 审批的 HTTP 兑现端点(桌面端审批卡;handler 自带 authMiddleware)。
 * TUI 同进程直调 resolveApproval;桌面端经 SSE 收 approval_request 事件后,POST 到这里兑现。
 * 审批登记表是进程内的(approvals.ts),与 loop 同进程——fleet 模式下本路由按 session 亲和
 * 代理到对应 worker(见 fleetDispatch)。
 *
 *   POST /agent/runs/:runId/approvals/:approvalId { action: 'approve'|'approve_always'|'reject', argsOverride? }
 *     → 200 { ok: true } | 400 非法 action | 404 run 不存在/非本人 | 410 该审批已不在等待(过期/重复/已被 TUI 处理)
 *       或不属于 URL 里这条 run(与「不在等待」同一回包,不泄露存在性)
 *
 * 安全边界:approval_request 事件只在 execMode==='host' 产生(gateToolCall 守卫 + profile.hostExec
 * 能力闸门),云端形态下 pending 恒空 → 本路由只会回 410,无新攻击面。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { getRunForUser } from '../services/runStore.js';
import { resolveApproval, approvalLocalOnly, customRules, APPROVAL_LOCAL_ONLY_BODY, type ApprovalAction, type CustomApprovalRules } from '../services/approvals.js';
import { saveSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';
import { resolveInquiry } from '../services/inquiries.js';
import { parseDeskShotBody, resolveDeskShot } from '../services/deskCapture.js';
import { resolveUiAction } from '../services/uiAck.js';
import { normalizeClientResult, normalizeUiValues, sanitizeText } from './runs.js';
import { parseRemoteOrigin, remoteArgsOverrideRejected, remoteArgsOverrideBody, taintRunRemote, type RemoteInfo } from '../services/remoteOrigin.js';
import { listPrompts, onPromptChange, promptsRev, sessionAttention, sweepTerminal, type AnswerBy, type PendingPrompt } from '../services/pendingPromptIndex.js';
import { resolveClientAction } from '../services/clientAck.js';

const router = Router();

const ACTIONS: ApprovalAction[] = ['approve', 'approve_always', 'reject'];

// ── custom 档规则的读写(H2:此前只能手写 config.json)。────────────────────────────────
//   GET  /agent/approval-rules → { base, allow[], ask[], deny[] }
//   PUT  /agent/approval-rules { base?, allow?, ask?, deny? } → 200 { ok, rules } | 400 非法
// 门控与 providers.ts 写 API key 那条同级(authMiddleware + saveSection);敏感度不高于它。
// 提权面:规则落在 ~/.tangu/config.json —— 工作区外,agent 写它要过越界升级;web_fetch 打不到
// 本机端点(urlSafety 挡 localhost/私网/回环,且 DNS 解析后再验)。**MCP/插件自带的网络能力
// 不过这道闸**,那是既有事实,不因本路由而变。
//
// ⚠️ **必须 host-only**(照 commands.ts 的既有守卫):本 router 挂在 `userRouter` 上,而云端
// microserver 是照单挂 userRouter 的 —— 不挡的话,任何已登录的云端用户都能读写一个**进程级全局**
// 配置文件(两个 handler 都不含 per-user 作用域),而 `customRules()` 在云端仍被 mcp__* 工具的
// 审批判定消费(gateToolCall 对 mcp__ 不早退)→ 用户 A 的规则会改变用户 B 的判定。
// `core/config.ts` 头注也写明这份配置「仅 standalone/TUI/desktop 使用」。
const localOnly = (): boolean => !!deps().profile.capabilities.hostExec;
const BASES = ['readonly', 'auto-edit', 'full-auto'] as const;

/**
 * 规则列表清洗:逐条 String+trim,丢空串。与引擎侧 strList 同语义。
 * `undefined` = 未提供 → 保持原样(PUT 允许部分更新);**非数组一律报错**,不静默当空 ——
 * 客户端一处 JSON 序列化把字段变成 null,就会把安全相关的 deny 名单悄悄清空落盘。
 * 清空必须是**显式传空数组**才成立。
 */
function ruleList(v: unknown, cur: string[]): string[] | null {
  if (v === undefined) return cur;
  if (!Array.isArray(v)) return null; // → 400
  // 200 条 × 单条 500 字符封顶:规则是人手写的,而 customRules() 每次工具调用都全文读+解析
  return v.map((x) => String(x).trim().slice(0, 500)).filter(Boolean).slice(0, 200);
}

router.get('/agent/approval-rules', authMiddleware, async (_req, res) => {
  try {
    if (!localOnly()) return res.status(404).json({ detail: 'not available in this deployment' });
    res.json(customRules());
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read approval rules failed' });
  }
});

router.put('/agent/approval-rules', authMiddleware, async (req, res) => {
  try {
    if (!localOnly()) return res.status(404).json({ detail: 'not available in this deployment' });
    const b = req.body || {};
    const cur = customRules();
    if (b.base !== undefined && !BASES.includes(String(b.base) as any)) {
      return res.status(400).json({ detail: `base must be one of ${BASES.join(' | ')}` });
    }
    const allow = ruleList(b.allow, cur.allow);
    const ask = ruleList(b.ask, cur.ask);
    const deny = ruleList(b.deny, cur.deny);
    if (!allow || !ask || !deny) {
      return res.status(400).json({ detail: 'allow / ask / deny must be arrays of strings (omit a field to keep it)' });
    }
    const next: CustomApprovalRules = {
      base: (b.base === undefined ? cur.base : String(b.base)) as CustomApprovalRules['base'],
      allow, ask, deny,
    };
    saveSection('approval', next);
    // customRules() 每次现读 config.json → 保存后**下一次工具调用**即生效,不必重启引擎
    res.json({ ok: true, rules: next });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'save approval rules failed' });
  }
});

// ── 待批索引(P1 · K3,services/pendingPromptIndex.ts)──────────────────────────────────────────
// 两条都 host-only(同 approval-rules:云端 worker 没有进程内审批,也不该暴露跨用户的进程级视图)。

/** 兑现请求从哪来:无 x-forsion-remote = 本机;有 = 来路(不在契约内 → 'remote'),K1 验过的调用方才带设备。 */
function answerByOf(remote: RemoteInfo | undefined): AnswerBy {
  if (!remote) return { via: 'local' };
  return {
    via: remote.via ?? 'remote',
    ...(remote.callerUnit ? { callerUnit: remote.callerUnit, ...(remote.callerName ? { callerName: remote.callerName } : {}) } : {}),
  };
}

//   GET /agent/approvals/pending[?rev=<rev>] → { rev, unchanged: true } | { rev, sessions: SessionAttention[] }
// 远端可读(会话列表「等你处理」点):**只给计数** —— 不给审批 id / preview / 参数 / 工具名;卡片内容照旧来自 run 事件流。
router.get('/agent/approvals/pending', authMiddleware, async (req, res) => {
  try {
    if (!localOnly()) return res.status(404).json({ detail: 'not available in this deployment' });
    await sweepTerminal();
    const rev = promptsRev();
    if (typeof req.query.rev === 'string' && req.query.rev === rev) return res.json({ rev, unchanged: true });
    // 逐字段重建(不透传 sessionAttention 的对象):响应形状由这里钉死,明天索引加字段也不会顺手外泄。
    const sessions = sessionAttention().map((a) => ({
      sessionId: a.sessionId, approvals: a.approvals, inquiries: a.inquiries, localOnly: a.localOnly, oldestAt: a.oldestAt, remote: a.remote,
    }));
    res.json({ rev, sessions });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'pending approvals failed' });
  }
});

/** 流里的条目:不含 preview / 参数(通知不展示命令 —— 锁屏可见,截断的命令会误导批准)。createdAt 转 ISO。 */
function wireOf(p: PendingPrompt): Record<string, unknown> {
  return {
    id: p.id, kind: p.kind, runId: p.runId, sessionId: p.sessionId, sessionTitle: p.sessionTitle, tool: p.tool,
    localOnly: p.localOnly, remote: p.remote, createdAt: new Date(p.createdAt).toISOString(),
  };
}

//   GET /agent/approvals/stream → text/event-stream
// 本机专用(桌面主进程订阅远程 run 的待批弹系统通知):unitWeb 允许清单之外的第二道 —— 带 x-forsion-remote 一律 403。
// 帧:snapshot {rev, items} → added {rev, item} / removed {rev, id, sessionId, outcome, by?};15s 一次 `: hb`。
router.get('/agent/approvals/stream', authMiddleware, async (req, res) => {
  if (!localOnly()) return res.status(404).json({ detail: 'not available in this deployment' });
  if (parseRemoteOrigin(req.headers)) return res.status(403).json({ code: 'LOCAL_ONLY', detail: 'This feed is only available on the computer running the engine.' });
  // 先清理再订阅:之后「订阅 + 写快照」在同一段同步代码里,中间不可能插进变更(不需要缓冲 / 去重)。
  try { await sweepTerminal(); } catch { /* 清理失败不挡订阅 */ }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  let ended = false;
  const safeWrite = (s: string): void => {
    if (ended || res.writableEnded) return;
    try { res.write(s); (res as any).flush?.(); } catch { /* socket closed */ }
  };
  const unsub = onPromptChange((c) => {
    safeWrite(`data: ${JSON.stringify(c.type === 'added' ? { type: 'added', rev: c.rev, item: wireOf(c.item) } : c)}\n\n`);
  });
  const heartbeat = setInterval(() => safeWrite(': hb\n\n'), 15_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  req.on('close', () => {
    ended = true;
    unsub();
    clearInterval(heartbeat);
  });
  safeWrite(': open\n\n');
  safeWrite(`data: ${JSON.stringify({ type: 'snapshot', rev: promptsRev(), items: listPrompts().map(wireOf) })}\n\n`);
});

router.post('/agent/runs/:runId/approvals/:approvalId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const action = req.body?.action as ApprovalAction;
    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ detail: `action must be one of ${ACTIONS.join('/')}` });
    }
    const run = await getRunForUser(req.params.runId, userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    // 契约 C9:远端(x-forsion-remote)答审批 —— 批准 / 拒绝照收(D1),但「总允许」按单次批准算(记下来 = 远端改了本机会话的
    // 审批面,本机 run 随后也吃它;与 run 本身带不带远程污点无关,看的是**答复**从哪来),改参数一律 400。
    if (remoteArgsOverrideRejected(req.headers, req.body)) return res.status(400).json(remoteArgsOverrideBody);
    const remote = parseRemoteOrigin(req.headers);
    const remoteAnswer = !!remote;
    const effective: ApprovalAction = remoteAnswer && action === 'approve_always' ? 'approve' : action;
    // P1 · K3(方案 §6.3):受保护路径(凭据 / ~/.forsion 配置)的审批只在执行设备本机批准 —— 远端的批准(含降级后的总允许)
    // 一律 403,条目照旧在等;拒绝照收。不在等 / 不属于这条 run(null)落到下面的 410,不在这里泄露存在性。
    if (remoteAnswer && effective !== 'reject' && approvalLocalOnly(req.params.approvalId, req.params.runId) === true) {
      return res.status(403).json(APPROVAL_LOCAL_ONLY_BODY);
    }

    const raw = req.body?.argsOverride;
    // 只收普通对象(typeof [] 也是 'object');改写后的参数由 gateToolCall 重新过闸,这里不做语义判定。
    const argsOverride = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
    // 必须带上 URL 的 runId:getRunForUser 只证明这条 run 是调用者的,审批条目属于哪条 run 由登记表比对。
    const ok = resolveApproval(req.params.approvalId, { action: effective, argsOverride }, req.params.runId, answerByOf(remote));
    if (!ok) return res.status(410).json({ detail: 'approval is no longer pending' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'approval failed' });
  }
});

// 询问(ask_user / exit_plan_mode)兑现端点;机制同审批(登记表在 services/inquiries.ts)。
//   POST /agent/runs/:runId/inquiries/:inquiryId { answer: string }
//     → 200 | 400 缺 answer | 404 run 不存在/非本人 | 410 该询问已不在等待
router.post('/agent/runs/:runId/inquiries/:inquiryId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    // 客户端原生动作(phone_* 等)的 claim / commit / result 也借这条路(同样的网关理由,见下方 ui_ 分支注释)。
    // 契约 tangu-agent/docs/phone-control.md §3.2:404 = run 不属于调用者;**其余一切**(未知 phase、digest / nonce 不符、
    // 已兑现、已中止、已超时)一律 410,不区分原因 —— 原生见 410 即终局、绝不执行。登记表在 services/clientAck.ts。
    // ⚠️ 必须排在 ui_ 分支与 answer 必填判定之前:这些电文没有 answer 字段,晚一步就被 400 吃掉。
    if (req.params.inquiryId.startsWith('cc_')) {
      const run0 = await getRunForUser(req.params.runId, userId);
      if (!run0) return res.status(404).json({ detail: 'Run not found' });
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const { runId, inquiryId } = req.params;
      const out =
        b.phase === 'claim' ? resolveClientAction(runId, inquiryId, { phase: 'claim', digest: b.digest, claimant: b.claimant })
        : b.phase === 'commit' ? resolveClientAction(runId, inquiryId, { phase: 'commit', nonce: b.nonce })
        : b.phase === 'result' ? resolveClientAction(runId, inquiryId, { phase: 'result', nonce: b.nonce, result: normalizeClientResult(b) })
        : null;
      if (!out) return res.status(410).json({ detail: 'client action is no longer pending' });
      return res.json({ ok: true, ...out });
    }
    // 界面动作回执(set_ui_setting / run_ui_command)搭这条路进来 —— **只借路由,不借电文**。
    // 为什么不自开一条:云端网关(server/microserver/agent-core/fleetDispatch.ts)只代理
    // runs / abort / approvals / inquiries 四条,新路由在 web 与移动端根本到不了 worker。
    // 为什么不复用 inquiry 电文:老客户端收到未知 kind 的 inquiry_request 会渲染一张用户可见的
    // 提问卡,且 requestInquiry 没有超时会把 run 挂死。所以出向是独立的 `ui_cmd` 事件,
    // 只有回程借这条路由,靠 ackId 前缀分流(登记表在 services/uiAck.ts)。
    if (req.params.inquiryId.startsWith('ui_')) {
      const run0 = await getRunForUser(req.params.runId, userId);
      if (!run0) return res.status(404).json({ detail: 'Run not found' });
      const b = req.body || {};
      // settings = 渲染端在 setter 落地后读的全份设置值,会进后续 list_ui_commands 的模型上下文 → 同 run 起步的消毒上限。
      const settings = normalizeUiValues(b.settings);
      const okUi = resolveUiAction(req.params.runId, req.params.inquiryId, {
        ok: b.ok === true,
        ...(typeof b.error === 'string' ? { error: sanitizeText(b.error, 500) } : {}),
        ...(typeof b.state === 'string' ? { state: sanitizeText(b.state, 200) } : {}),
        ...(settings ? { settings } : {}),
      });
      if (!okUi) return res.status(410).json({ detail: 'ui action is no longer pending' });
      // 回执里的 error / state / settings 是远端给的自由文本,会进后续模型上下文 → 与询问、截屏、steer 同理染色(09-27 终审 P2)。
      // 正常使用不受影响:界面动作只由发起这条 run 的渲染层执行并回执(G2),设备页不会替本机 run 回执。
      const remoteUi = parseRemoteOrigin(req.headers);
      if (remoteUi) taintRunRemote(req.params.runId, remoteUi);
      return res.json({ ok: true });
    }
    // 契约 C9:询问没有「总允许」与改参数的概念;远端夹带 argsOverride 同样 400(与审批一个口径,免得哪天兑现侧开始认它)。
    if (remoteArgsOverrideRejected(req.headers, req.body)) return res.status(400).json(remoteArgsOverrideBody);
    const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';
    if (!answer) return res.status(400).json({ detail: 'answer required' });
    const run = await getRunForUser(req.params.runId, userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    const remote = parseRemoteOrigin(req.headers);
    const ok = resolveInquiry(req.params.inquiryId, answer.slice(0, 4000), req.params.runId, answerByOf(remote));
    if (!ok) return res.status(410).json({ detail: 'inquiry is no longer pending' });
    // 远端的答案(最长 4000 字自由文本)从这一刻起就在驱动这条 run —— 与远端 steer 同理染色(P0 第三轮 E8,评审 F#1):
    // 之后的审批按远程钳、保护路径写入硬拒。只在兑现成功后登记;与 resolveInquiry 同一同步段,run 的续跑(微任务)必在其后。
    if (remote) taintRunRemote(req.params.runId, remote);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inquiry failed' });
  }
});

// Agent Desk 截屏(desk_screenshot)兑现端点;机制同上(登记表在 services/deskCapture.ts)。
//   POST /agent/runs/:runId/captures/:shotId { dataUrl?: string, mode?: 'card'|'open', companion?: string, error?: string }
//     → 200 | 404 run 不存在/非本人 | 410 该请求已不在等待(超时/重复/多窗口第二个到达者)
// dataUrl 会被回灌进模型上下文 → 只认 png/jpeg 的 data URL,其余一律按失败兑现。
router.post('/agent/runs/:runId/captures/:shotId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const run = await getRunForUser(req.params.runId, req.user!.userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    const ok = resolveDeskShot(req.params.runId, req.params.shotId, parseDeskShotBody(req.body));
    if (!ok) return res.status(410).json({ detail: 'capture is no longer pending' });
    // 远端回的截图进了模型上下文(图里的文字同样能驱动 run)→ 同询问、steer 一样染色(P0 第三轮 E8)。
    const remote = parseRemoteOrigin(req.headers);
    if (remote) taintRunRemote(req.params.runId, remote);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'capture failed' });
  }
});

export default router;
