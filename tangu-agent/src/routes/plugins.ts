/**
 * 统一插件:列表 / 启用 / 设置(全局或按 agent 作用域)/ image-list 文件。handler 自带 authMiddleware。
 * 仅本地形态(hostExec)暴露;云端 404。设置面板由前端据 schema 通用渲染。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { listPluginMetas, getPluginMeta, pluginsNeedingRestart } from '../plugins/registry.js';
import type { PluginStatus } from '../plugins/bootstrap.js';
import {
  isPluginEnabledSync, getScopeSettings, setScopeSettings,
  listPluginFiles, readPluginFile, writePluginFile, deletePluginFile, parseScope, clearPluginData,
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

function pluginView(m: ReturnType<typeof listPluginMetas>[number], st: PluginStatus) {
  return {
    id: m.id, name: m.name, nameEn: m.nameEn, description: m.description, descriptionEn: m.descriptionEn,
    iconUrl: m.iconUrl,
    scopes: m.scopes || ['global'], settings: m.settings || null, source: m.source || 'builtin',
    enabled: isPluginEnabledSync(m.id), needsRestart: pluginsNeedingRestart.has(m.id),
    // 生命周期运行态(老桌面忽略未知字段):active=此刻在跑;version 仅 folder 插件;requiresPlugins=声明的前置;
    // waitingFor 仅「已启用但前置没齐而休眠」时给;lastError=上次激活抛错;settling=上一次启停超时还在后台收尾。
    active: st.active,
    ...(st.version ? { version: st.version } : {}),
    ...(st.requiresPlugins ? { requiresPlugins: st.requiresPlugins } : {}),
    ...(st.waitingFor ? { waitingFor: st.waitingFor } : {}),
    ...(st.lastError ? { lastError: st.lastError } : {}),
    ...(st.settling ? { settling: true } : {}),
  };
}

/** 生命周期函数住 bootstrap:动态 import 避免 index↔bootstrap 早期环引用(bootstrap 顶层的 sdk 在求值期就读 createTanguModule)。 */
const lifecycle = () => import('../plugins/bootstrap.js');

async function pluginViews() {
  const { pluginStatus } = await lifecycle();
  return listPluginMetas().map((m) => pluginView(m, pluginStatus(m.id)));
}

router.get('/agent/plugins/external-tools',authMiddleware,async(req:AuthRequest,res)=>{
  if(!ensureLocal(res))return;if(req.headers['x-forsion-remote'])return res.status(403).json({detail:'Local Desktop MCP only'});
  const {pluginExternalTools}=await import('../plugins/externalTools.js');
  res.json({tools:pluginExternalTools(req.user!.userId).map(t=>t.definition.function)});
});
router.post('/agent/plugins/external-tools/call',authMiddleware,async(req:AuthRequest,res)=>{
  if(!ensureLocal(res))return;if(req.headers['x-forsion-remote'])return res.status(403).json({detail:'Local Desktop MCP only'});
  const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),90000);res.on('close',()=>ac.abort());
  try{const {callPluginExternalTool}=await import('../plugins/externalTools.js');const result=await callPluginExternalTool(req.user!.userId,String(req.body?.name||''),req.body?.arguments||{},ac.signal);res.json(result);}
  catch(e:any){if(!res.headersSent)res.status(400).json({detail:e.message});}finally{clearTimeout(timer);}
});

router.get('/agent/plugins', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ plugins: await pluginViews() });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'list failed' }); }
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

// 运行期重扫 = 与磁盘同步:新装的即时出现并可启用、换了代码的原地热升级、目录没了的注销,都不用重启。
// needsRestart:换了代码但破不了模块缓存(CommonJS / node_modules / 引到包外等,见 loader cannotHotSwap;老实例照跑)。
router.post('/agent/plugins/rescan', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const { rescanPlugins } = await lifecycle();
    const { addedIds, reloadedIds, removedIds, needsRestart } = await rescanPlugins();
    res.json({ ok: true, addedIds, reloadedIds, removedIds, needsRestart, plugins: await pluginViews() });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'rescan failed' }); }
});

// npm 一条命令装引擎插件(仅本地形态)。要求显式 confirm:true —— 装前风险确认由桌面 UI 弹框负责,
// 路由不做交互。只接受 npm: 源(本地路径/.tgz 通道限 CLI,缩注入面)。装后内联重扫即时生效(含覆盖安装的热升级)。
router.post('/agent/plugins/install', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (b.confirm !== true) return res.status(400).json({ detail: '需显式 confirm:true(装前请在 UI 确认插件以完整系统权限运行的风险)' });
    const raw = String(b.spec || '').trim();
    if (!raw.startsWith('npm:')) return res.status(400).json({ detail: '路由仅支持 npm: 源(本地目录/.tgz 走 CLI)' });
    const { parseInstallSpec, installPlugin } = await import('../plugins/npmInstall.js');
    const r = await installPlugin(parseInstallSpec(raw), raw, { preferMirror: !!b.preferMirror, force: !!b.force });
    const { rescanPlugins } = await lifecycle();
    const { addedIds, reloadedIds, removedIds, needsRestart } = await rescanPlugins();
    res.json({ ok: true, id: r.id, version: r.version, addedIds, reloadedIds, removedIds, needsRestart, plugins: await pluginViews() });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'install failed' }); }
});

// 读某插件的安装来源(.tangu-source.json):桌面显示「来自 npm:xxx@ver」与更新检查。
router.get('/agent/plugins/:id/source', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const { readInstalledSource } = await import('../plugins/npmInstall.js');
    res.json({ source: readInstalledSource(req.params.id) });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'read failed' }); }
});

// 卸载:现场停用(依赖者先休眠 → deactivate → 撤工具/路由)+ 注销 meta + 清全局/每-agent 设置与 blob,不用重启。
// 插件文件夹由桌面端删,删完再 rescan;删之前的重扫不会把它复活。
// 故意不查 meta 是否存在 —— 也用于清理「加载失败插件」的孤儿设置。
router.delete('/agent/plugins/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const { removePluginLive } = await lifecycle();
    await removePluginLive(req.params.id); // 先注销:清完设置后 isPluginEnabledSync 不会落回 defaultEnabled=true
    await clearPluginData(req.params.id);
    res.json({ ok: true, restartRequired: false });
  } catch (e: any) { res.status(400).json({ detail: e?.message || 'uninstall failed' }); }
});

// 开关:落盘(同旧)后现场收敛 —— 启用即激活、停用即 deactivate,级联前置依赖它的插件。回带全量列表(级联会改别的插件的 active)。
router.put('/agent/plugins/:id/enabled', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!getPluginMeta(req.params.id)) return res.status(404).json({ detail: 'plugin not found' });
    const { setPluginEnabledLive, pluginStatus } = await lifecycle();
    await setPluginEnabledLive(req.params.id, !!(req.body || {}).enabled);
    res.json({ ok: true, enabled: isPluginEnabledSync(req.params.id), active: pluginStatus(req.params.id).active, plugins: await pluginViews() });
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
