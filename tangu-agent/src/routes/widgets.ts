/**
 * 小组件的只读接口(开工顺序第 3 步):仪表盘、卡片区、主页没有会话,按 id 读原件和记录。存储口径见 services/widgetStore.ts。
 * 唯一的写接口是 restore(已删占位卡上人点的「恢复」,撤销软删除);记录照旧只由 manage_widget 写(写入过审批)。
 * 只在本机(hostExec)、拒远端:原件和记录是这台电脑上的文件,和 human/ 那几条同一个边界。
 * ?project=<绝对路径> 才看项目级;不给就只看各 Agent 和用户级。
 * ⚠️读失败 ≠ 空:data.db 坏了,这张卡照样回,records 标 error;manifest 读不了的,找不到时把读不了的个数一并回。
 */
import { Router, type Response } from 'express';
import { isAbsolute } from 'node:path';
import { authMiddleware, type AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { scheduleAgentFilesSync } from '../services/agentFileSync.js';
import { listAllWidgets, locateWidgetAnywhere, readRecords, readWidgetContent, restoreWidgetAnywhere, WidgetError, type AnyWidgetInfo } from '../services/widgetStore.js';

const router = Router();

function widgetsLocal(req: AuthRequest, res: Response): boolean {
  if (!deps().profile.capabilities.hostExec) { res.status(404).json({ error: 'WIDGET_LOCAL_ONLY', detail: 'Widgets require a local engine.' }); return false; }
  if (parseRemoteOrigin(req.headers)) { res.status(403).json({ error: 'WIDGET_REMOTE_DENIED', detail: 'Open widgets on the host computer.' }); return false; }
  return true;
}
/** undefined = 没给;null = 给了但不是绝对路径(回 400)。 */
function projectOf(req: AuthRequest): string | undefined | null {
  const p = req.query.project;
  if (p === undefined || p === '') return undefined;
  return typeof p === 'string' && isAbsolute(p) && !p.includes('\0') ? p : null;
}
const summary = (w: AnyWidgetInfo) => {
  const m = w.manifest;
  return {
    id: m.id, rev: m.rev, name: m.name, title: m.title, entry: m.entry, scope: w.scope,
    ...(w.agentSlug ? { agentSlug: w.agentSlug } : {}), ...(m.deletedAt ? { deletedAt: m.deletedAt } : {}), updatedAt: m.updatedAt,
    ...(m.summary ? { summary: m.summary } : {}), ...(m.sizes?.length ? { sizes: m.sizes } : {}), ...(m.rail ? { rail: true } : {}),
  };
};
const failed = (res: Response, e: unknown) => res.status(500).json({ error: 'WIDGET_FAILED', detail: e instanceof Error ? e.message : String(e) });
/** 按 id 找的错误 → 状态码;GET 和 restore 同一张表。 */
function notLocated(res: Response, e: unknown) {
  if (!(e instanceof WidgetError)) return failed(res, e);
  if (e.code === 'INVALID_ID') return res.status(400).json({ error: 'WIDGET_BAD_ID', detail: e.message });
  if (e.code === 'TWO_COPIES') return res.status(409).json({ error: 'WIDGET_TWO_COPIES', detail: e.message });
  if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'WIDGET_NOT_FOUND', unreadable: e.unreadable ?? 0, detail: e.message });
  return failed(res, e);
}

router.get('/agent/widgets', authMiddleware, (req: AuthRequest, res) => {
  if (!widgetsLocal(req, res)) return;
  const projectDir = projectOf(req);
  if (projectDir === null) return res.status(400).json({ error: 'WIDGET_BAD_PROJECT', detail: 'project must be an absolute path.' });
  try {
    const { widgets, unreadable } = listAllWidgets({ projectDir });
    res.json({ widgets: widgets.map(summary), unreadable });
  } catch (e) { failed(res, e); }
});

router.get('/agent/widgets/:id', authMiddleware, (req: AuthRequest, res) => {
  if (!widgetsLocal(req, res)) return;
  const projectDir = projectOf(req);
  if (projectDir === null) return res.status(400).json({ error: 'WIDGET_BAD_PROJECT', detail: 'project must be an absolute path.' });
  let w: AnyWidgetInfo;
  try { w = locateWidgetAnywhere(String(req.params.id), { projectDir }); } catch (e) { return notLocated(res, e); }
  // 原件读不了就画不出来:整条报错;记录读不了只标在 records 上,卡照样画
  let content: string;
  try { content = readWidgetContent(w); } catch (e) { return res.status(422).json({ error: 'WIDGET_UNREADABLE', detail: e instanceof Error ? e.message : String(e) }); }
  let records: { status: 'ok'; rows: unknown[] } | { status: 'none' } | { status: 'error'; error: string };
  try { const r = readRecords(w); records = r.status === 'ok' ? { status: 'ok', rows: r.rows } : { status: 'none' }; }
  catch (e) { records = { status: 'error', error: e instanceof Error ? e.message : String(e) }; }
  res.json({ widget: { ...summary(w), content, records } });
});

// 撤销软删除:人在已删占位卡上点「恢复」。没删的原样回。Agent 级的排一次后台同步(和 human 路由一样;没开云同步是空操作)。
router.post('/agent/widgets/:id/restore', authMiddleware, async (req: AuthRequest, res) => {
  if (!widgetsLocal(req, res)) return;
  const projectDir = projectOf(req);
  if (projectDir === null) return res.status(400).json({ error: 'WIDGET_BAD_PROJECT', detail: 'project must be an absolute path.' });
  let w: AnyWidgetInfo;
  try { w = await restoreWidgetAnywhere(String(req.params.id), { projectDir }); } catch (e) { return notLocated(res, e); }
  if (w.scope === 'agent' && w.agentSlug) scheduleAgentFilesSync(req.user!.userId, w.agentSlug);
  res.json({ widget: summary(w) });
});

export default router;
