/** 回收站(services/trash):列出 / 恢复 / 彻底删除 / 清空。只在本机形态有。
 *  restorer='desktop' 的条目(Forsion 插件)由桌面主进程恢复(它知道笔记库在哪、恢复后要重扫插件),这里拒绝并说明。 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { emptyTrash, listTrash, purgeTrash, readTrash, TRASH_DAYS } from '../services/trash.js';
import { restoreAgent } from '../services/agentUninstall.js';
import { restoreSkill } from '../services/skillUninstall.js';
import { restoreEnginePlugin } from '../services/pluginUninstall.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (deps().profile.capabilities.hostExec) return true;
  res.status(404).json({ detail: 'Trash is only available on this computer' });
  return false;
}

router.get('/agent/trash', authMiddleware, async (_req, res) => {
  if (!ensureLocal(res)) return;
  try { res.json({ entries: await listTrash(), days: TRASH_DAYS }); }
  catch (e: any) { res.status(500).json({ detail: e?.message || 'list trash failed' }); }
});

router.post('/agent/trash/:id/restore', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const entry = await readTrash(req.params.id);
    if (!entry) return res.status(404).json({ detail: 'Not in the trash' });
    if (entry.restorer !== 'engine') return res.status(409).json({ detail: 'Restored by the desktop app', error: 'restorer_desktop' });
    if (entry.kind === 'agent') return res.json({ ok: true, ...(await restoreAgent(req.user!.userId, entry)) });
    if (entry.kind === 'skill') return res.json({ ok: true, ...(await restoreSkill(entry)) });
    if (entry.kind === 'plugin') return res.json({ ok: true, ...(await restoreEnginePlugin(entry)) });
    res.status(400).json({ detail: `cannot restore ${entry.kind}` });
  } catch (e: any) {
    if (e?.code === 'plugin_reinstalled') return res.status(409).json({ detail: e.message, error: e.code });
    res.status(500).json({ detail: e?.message || 'restore failed' });
  }
});

router.delete('/agent/trash/:id', authMiddleware, async (req, res) => {
  if (!ensureLocal(res)) return;
  try { res.json({ ok: await purgeTrash(req.params.id) }); }
  catch (e: any) { res.status(500).json({ detail: e?.message || 'delete failed' }); }
});

router.delete('/agent/trash', authMiddleware, async (_req, res) => {
  if (!ensureLocal(res)) return;
  try { res.json({ ok: true, removed: await emptyTrash() }); }
  catch (e: any) { res.status(500).json({ detail: e?.message || 'empty trash failed' }); }
});

export default router;
