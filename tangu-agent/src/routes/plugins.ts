/**
 * 统一插件:列表 / 启用 / 设置(全局或按 agent 作用域)/ image-list 文件。handler 自带 authMiddleware。
 * 仅本地形态(hostExec)暴露;云端 404。设置面板由前端据 schema 通用渲染。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { listPluginMetas, getPluginMeta, pluginsNeedingRestart } from '../plugins/registry.js';
import {
  isPluginEnabledSync, setPluginEnabled, getScopeSettings, setScopeSettings,
  listPluginFiles, readPluginFile, writePluginFile, deletePluginFile, parseScope,
} from '../plugins/settingsStore.js';
import { resolveReplySegment, splitMessage } from '../services/replySegment.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: '插件仅在本地（桌面/TUI）可用' });
    return false;
  }
  return true;
}

function pluginView(m: ReturnType<typeof listPluginMetas>[number]) {
  return {
    id: m.id, name: m.name, nameEn: m.nameEn, description: m.description, descriptionEn: m.descriptionEn,
    scopes: m.scopes || ['global'], settings: m.settings || null, source: m.source || 'builtin',
    enabled: isPluginEnabledSync(m.id), needsRestart: pluginsNeedingRestart.has(m.id),
  };
}

router.get('/agent/plugins', authMiddleware, (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  res.json({ plugins: listPluginMetas().map(pluginView) });
});

// 通道无关的分段结果。Web 等非微信客户端可批量把已持久化回复按 reply-segment 的
// 全局⊕agent 设置还原成气泡，而不复制核心拆分算法或绕过插件启用态。
router.post('/agent/reply-segments', authMiddleware, (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const texts = Array.isArray(req.body?.texts)
      ? req.body.texts.filter((x: any) => typeof x === 'string').slice(0, 200)
      : [];
    const agentSlug = typeof req.body?.agentSlug === 'string' && req.body.agentSlug
      ? req.body.agentSlug
      : undefined;
    const cfg = resolveReplySegment(agentSlug);
    res.json({
      enabled: cfg.enabled,
      segments: texts.map((text: string) => cfg.enabled ? splitMessage(text) : [text]),
    });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'segment failed' }); }
});

// 运行期重扫:市场装新插件后无需重启即出现在列表并可启用。返回新激活的 id 与是否仍需重启(贡献路由的插件)。
router.post('/agent/plugins/rescan', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const { activateNewPlugins } = await import('../plugins/bootstrap.js'); // 动态 import 避免 index↔bootstrap 早期环引用
    const { addedIds, needsRestart } = await activateNewPlugins();
    res.json({ ok: true, addedIds, needsRestart, plugins: listPluginMetas().map(pluginView) });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'rescan failed' }); }
});

router.put('/agent/plugins/:id/enabled', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!getPluginMeta(req.params.id)) return res.status(404).json({ detail: 'plugin not found' });
    await setPluginEnabled(req.params.id, !!(req.body || {}).enabled);
    res.json({ ok: true, enabled: isPluginEnabledSync(req.params.id) });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'update failed' }); }
});

router.get('/agent/plugins/:id/settings', authMiddleware, (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!getPluginMeta(req.params.id)) return res.status(404).json({ detail: 'plugin not found' });
    res.json({ values: getScopeSettings(req.params.id, parseScope(req.query.scope as string)) });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'read failed' }); }
});

router.put('/agent/plugins/:id/settings', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!getPluginMeta(req.params.id)) return res.status(404).json({ detail: 'plugin not found' });
    const values = await setScopeSettings(req.params.id, parseScope(req.query.scope as string), (req.body || {}).patch || {});
    res.json({ ok: true, values });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'write failed' }); }
});

router.get('/agent/plugins/:id/files', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const scope = parseScope(req.query.scope as string);
    const list = await listPluginFiles(req.params.id, scope);
    const files = await Promise.all(list.map(async (f) => {
      const blob = f.size <= 256 * 1024 ? await readPluginFile(req.params.id, scope, f.name).catch(() => null) : null;
      return { ...f, dataBase64: blob ? blob.buffer.toString('base64') : undefined };
    }));
    res.json({ files });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'list failed' }); }
});

router.post('/agent/plugins/:id/files', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (!b.name || !b.dataBase64) return res.status(400).json({ detail: 'name 与 dataBase64 必填' });
    const buf = Buffer.from(String(b.dataBase64).replace(/^data:[^,]*,/, ''), 'base64');
    const name = await writePluginFile(req.params.id, parseScope(req.query.scope as string), String(b.name), buf);
    res.json({ ok: true, name });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'upload failed' }); }
});

router.delete('/agent/plugins/:id/files', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    await deletePluginFile(req.params.id, parseScope(req.query.scope as string), String(req.query.name || ''));
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'delete failed' }); }
});

export default router;
