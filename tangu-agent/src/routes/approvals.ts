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
import { resolveApproval, type ApprovalAction } from '../services/approvals.js';
import { resolveInquiry } from '../services/inquiries.js';
import { resolveDeskShot } from '../services/deskCapture.js';

const router = Router();

const ACTIONS: ApprovalAction[] = ['approve', 'approve_always', 'reject'];

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
