/**
 * 远程活动 + 急停 + 解锁(设备能力 MCP 方案 P1 · K2 §3.5,方案 §6.5)。**本机专用**:桌面主进程带本机引擎令牌调。
 *   GET  /agent/remote/activity           ActivitySnapshot(在飞 run 分类 + 待批计数 + 非本机后台进程 + 锁状态)
 *   GET  /agent/remote/activity/events    SSE:连上立即一帧全量 snapshot,之后每次变更(去抖 200ms)再发全量;15s 一次 `: hb`
 *   POST /agent/remote/estop {source}     急停:上闩 → 中止全部非本机 run(reason:'remote_estop')→ 杀其后台进程 → 撤回远端批准的 Muse 条目
 *   POST /agent/remote/unlock             清闩:只在主进程已写好解锁(锁文件可读且 lock===null)时成立,否则 409
 * 四条都 deny-remote(unitWeb 允许清单之外的第二道:带 x-forsion-remote 一律 403);hostExec=false(云端 worker)一律 404。
 * estop 幂等、与锁状态无关、**恒上闩**。活动快照只列已 dispatch 的 run:排在本机 run 后面(sessionQueue)与刚起还没登记的非本机 run
 * 由 abortUnregisteredNonLocalRuns 按 run 行现分类一并中止 —— 只靠扼流点的话,用户先解锁它们就会在急停之后照跑(独立评审 P1)。
 */
import { Router } from 'express';
import { authMiddleware } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { abortRun, abortUnregisteredNonLocalRuns, waitForRunSettlement } from '../services/agentLoop.js';
import { activitySnapshot, notifyActivity, onActivityChange, type RunCategory } from '../services/remoteActivity.js';
import { clearRemoteLatch, latchRemoteLock, remoteLocked, remoteLockState } from '../services/remoteLock.js';
import { killProcessesWhere } from '../tools/processRegistry.js';
import { revertRemoteMuseEntries } from '../services/remoteCreated.js';

const router = Router();

const LOCAL_ONLY_BODY = { code: 'LOCAL_ONLY', detail: 'This is only available on the computer running the engine.' };
const SOURCES = new Set(['hotkey', 'tray', 'settings']);

export interface EstopReport {
  ok: true;
  aborted: Array<{ runId: string; sessionId: string; category: RunCategory }>;
  killedProcesses: number;
  revertedEntries: number;
  /** estop 之后 remoteLocked()(闩已上 → 恒 true)。 */
  locked: boolean;
}

/** hostExec 否 → 404;带远程来源头 → 403。两道都过了返回 true。 */
function localOnly(req: any, res: any): boolean {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ detail: 'not available in this deployment' }); return false; }
  if (parseRemoteOrigin(req.headers)) { res.status(403).json(LOCAL_ONLY_BODY); return false; }
  return true;
}

router.get('/agent/remote/activity', authMiddleware, (req, res) => {
  if (!localOnly(req, res)) return;
  res.json(activitySnapshot());
});

router.get('/agent/remote/activity/events', authMiddleware, (req, res) => {
  if (!localOnly(req, res)) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  let ended = false;
  const safeWrite = (s: string): void => {
    if (ended || res.writableEnded) return;
    try { res.write(s); (res as any).flush?.(); } catch { /* socket closed */ }
  };
  const frame = (): void => safeWrite(`data: ${JSON.stringify({ type: 'snapshot', ...activitySnapshot() })}\n\n`);
  const unsub = onActivityChange(frame);
  const heartbeat = setInterval(() => safeWrite(': hb\n\n'), 15_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  req.on('close', () => {
    ended = true;
    unsub();
    clearInterval(heartbeat);
  });
  safeWrite(': open\n\n');
  frame();
});

router.post('/agent/remote/estop', authMiddleware, async (req, res) => {
  if (!localOnly(req, res)) return;
  const source = typeof req.body?.source === 'string' && SOURCES.has(req.body.source) ? req.body.source : 'settings';
  // ① 无条件上闩(先于一切 await):此刻起新的非本机 run 在 dispatchRun 被拦 —— 哪怕主进程的锁文件还没写成
  latchRemoteLock();
  try {
    // ② 中止全部非本机 run(远程 / 通道 / 无人值守;本机交互 run 不动):
    //    a. 活动表里在飞的(已 dispatch,分类含中途染色)—— 同步先停;
    //    b. 活动表看不见的:排在同会话本机 run 后面的、刚起还没登记的(按 run 行现分类;排队中的直接终态化)。
    const registered = activitySnapshot().runs;
    const targets: EstopReport['aborted'] = registered.filter((r) => r.category !== 'local').map((r) => ({ runId: r.runId, sessionId: r.sessionId, category: r.category }));
    for (const r of targets) abortRun(r.runId, { reason: 'remote_estop' });
    targets.push(...await abortUnregisteredNonLocalRuns(new Set(registered.map((r) => r.runId)), 'remote_estop'));
    const ids = new Set(targets.map((r) => r.runId));
    // ③ 杀后台进程:非本机来源的全部 + 被中止 run 起的(本机起、后被染色的 run 起的进程 origin 仍是 local,靠 runId 命中)
    const killedProcesses = killProcessesWhere((p) => p.origin !== 'local' || (!!p.runId && ids.has(p.runId)));
    // ④ 撤回远端批准的 Muse 条目(还没跑的、以及带着它的周期刚被中止的:删掉、TODO 回 pending)
    let revertedEntries = 0;
    try { revertedEntries = await revertRemoteMuseEntries(ids); } catch (e: any) { console.warn('[remote] revert remote Muse entries failed:', e?.message || e); }
    // 等中止落定(不阻塞过久:3s 封顶,落不定的由各自的 finally 继续收尾)
    await Promise.all([...ids].map((id) => waitForRunSettlement(id, 3000).catch(() => false)));
    notifyActivity();
    console.log(`[remote] estop(${source}):中止 ${targets.length} 个非本机 run、结束 ${killedProcesses} 个后台进程、撤回 ${revertedEntries} 个远端批准的条目`);
    const report: EstopReport = { ok: true, aborted: targets, killedProcesses, revertedEntries, locked: remoteLocked() };
    res.json(report);
  } catch (e: any) {
    // 闩已上;这里只可能是快照 / 中止本身出错 —— 如实回 500,主进程会在引擎下次 ready 时补发
    res.status(500).json({ detail: e?.message || 'estop failed', locked: true });
  }
});

router.post('/agent/remote/unlock', authMiddleware, (req, res) => {
  if (!localOnly(req, res)) return;
  if (!clearRemoteLatch()) {
    return res.status(409).json({ code: 'REMOTE_UNLOCK_NOT_CONFIRMED', detail: 'Unlock has not been confirmed on this computer.', lock: remoteLockState() });
  }
  notifyActivity();
  res.json({ ok: true, locked: remoteLocked() });
});

export default router;
