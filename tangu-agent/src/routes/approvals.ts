/**
 * host-exec 审批的 HTTP 兑现端点(桌面端审批卡;handler 自带 authMiddleware)。
 * TUI 同进程直调 resolveApproval;桌面端经 SSE 收 approval_request 事件后,POST 到这里兑现。
 * 审批登记表是进程内的(approvals.ts),与 loop 同进程——fleet 模式下本路由按 session 亲和
 * 代理到对应 worker(见 fleetDispatch)。
 *
 *   POST /agent/runs/:runId/approvals/:approvalId { action: 'approve'|'approve_always'|'reject', argsOverride? }
 *     → 200 { ok: true } | 400 非法 action | 404 run 不存在/非本人 | 410 该审批已不在等待(过期/重复/已被 TUI 处理)
 *
 * 安全边界:approval_request 事件只在 execMode==='host' 产生(gateToolCall 守卫 + profile.hostExec
 * 能力闸门),云端形态下 pending 恒空 → 本路由只会回 410,无新攻击面。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { getRunForUser } from '../services/runStore.js';
import { resolveApproval, customRules, type ApprovalAction, type CustomApprovalRules } from '../services/approvals.js';
import { saveSection } from '../core/config.js';
import { deps } from '../seams/runtime.js';
import { resolveInquiry } from '../services/inquiries.js';
import { resolveDeskShot } from '../services/deskCapture.js';

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

router.post('/agent/runs/:runId/approvals/:approvalId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const action = req.body?.action as ApprovalAction;
    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ detail: `action must be one of ${ACTIONS.join('/')}` });
    }
    const run = await getRunForUser(req.params.runId, userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });

    const argsOverride =
      req.body?.argsOverride && typeof req.body.argsOverride === 'object' ? req.body.argsOverride : undefined;
    const ok = resolveApproval(req.params.approvalId, { action, argsOverride });
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
    const answer = typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';
    if (!answer) return res.status(400).json({ detail: 'answer required' });
    const run = await getRunForUser(req.params.runId, userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    const ok = resolveInquiry(req.params.inquiryId, answer.slice(0, 4000));
    if (!ok) return res.status(410).json({ detail: 'inquiry is no longer pending' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'inquiry failed' });
  }
});

// Agent Desk 截屏(desk_screenshot)兑现端点;机制同上(登记表在 services/deskCapture.ts)。
//   POST /agent/runs/:runId/captures/:shotId { dataUrl?: string, mode?: 'card'|'open', error?: string }
//     → 200 | 404 run 不存在/非本人 | 410 该请求已不在等待(超时/重复/多窗口第二个到达者)
// dataUrl 会被回灌进模型上下文 → 只认 png/jpeg 的 data URL,其余一律按失败兑现。
router.post('/agent/runs/:runId/captures/:shotId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const run = await getRunForUser(req.params.runId, req.user!.userId);
    if (!run) return res.status(404).json({ detail: 'Run not found' });
    const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl : '';
    const valid = /^data:image\/(png|jpeg);base64,/.test(dataUrl) && dataUrl.length <= 12_000_000;
    const ok = resolveDeskShot(
      req.params.shotId,
      valid
        ? { dataUrl, mode: req.body?.mode === 'card' ? 'card' : 'open' }
        : { error: String(req.body?.error || 'capture failed').slice(0, 200) },
    );
    if (!ok) return res.status(410).json({ detail: 'capture is no longer pending' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'capture failed' });
  }
});

export default router;
