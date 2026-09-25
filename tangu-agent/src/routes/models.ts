/**
 * 模型目录(桌面/客户端模型选择器;handler 自带 authMiddleware)。
 *   GET /agent/models →
 *     {
 *       models: [{ id, name, provider, source: 'forsion'|'direct' }],   // 可直接选用的模型
 *       directProviders: [{ providerId, modelIds? }],                   // 直连 provider(支持 <providerId>/<model> 自由填)
 *       defaultModelId,
 *       forsion: { status: 'ok'|'empty'|'error', detail }               // 云端托管面诊断(空列表不再静默)
 *     }
 * forsion 部分经 deps().brain.models(microserver 进程内直连 / standalone 走 brain-api);
 * 优先 listModelsForProject(profile.appId) 遵守 admin「应用模型配置」,旧 brain 回退 listGlobalModels。
 * profile 按查询参数 `app_id` 解析(与 run 的 resolveProfile 同源),缺省才回退本进程基线。
 * direct 部分仅 standalone 的 multiBrain 实现(listDirectProviders 可选方法),云端自动跳过。
 * 诊断:httpBrain.listGlobalModels 对错误降级 [](TUI 依赖此行为),这里用 users/me 探针
 * 区分「云端可达但 admin 没配模型(empty)」与「云端不可达/未授权/未部署 brain-api(error)」。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { CONTEXT_WINDOW_TOKENS } from '../services/contextBudget.js';
import { MIN_OVERRIDE_TOKENS, setModelContextWindow } from '../services/modelOverrides.js';
import { listModelCatalog } from '../services/modelCatalog.js';

const router = Router();

// 旧导入点(测试 / 外部)不断:口径搬进 services/modelCatalog.ts。
export { visionOverrideOf } from '../services/modelCatalog.js';

router.get('/agent/models', authMiddleware, async (req: AuthRequest, res) => {
  try {
    // 本请求所属 app 的 profile(照 /agent/tools 先例;app_id / appId 两种写法都收)。
    // ⚠️ 不能用 deps().profile:云端一个 worker 服务多 app,那只是**基线**(TANGU_APP_ID,缺省
    // 'ai-studio')。用它会让 Tangu Web 的模型列表/五槽默认全按 ai-studio 的「应用模型配置」解析,
    // 而 run 的用量按 run.app_id='tangu' 记账 —— 就是「用量显示 Tangu、模型配置却走 AI Studio」。
    // 显式传了却解析不出(未知/被 admin 禁用)→ 400,照 /agent/runs 先例。这里**不能**静默回退基线:
    // 那正是本次要修的失败模式(客户端拼错 app_id 就又悄悄拿到 ai-studio 的列表)。不传才回退。
    // 不传也要走 profileStore(resolve(null) = 基线的**生效** profile),否则 admin 的 DB 覆盖与
    // enabled:false 在这条路径上全被绕过 —— 会出现「显式传 app 被 400、省略参数反而读得到」。
    // 末尾 ?? deps().profile 只兜「基线自身被禁用」这一种极端,保住老客户端不硬失败。
    const appIdQ = String(req.query.app_id || req.query.appId || '') || null;
    const store = deps().profileStore;
    const profile = appIdQ ? store.resolve(appIdQ) : (store.resolve(null) ?? deps().profile);
    if (!profile) return res.status(400).json({ detail: `unknown app_id: ${appIdQ}` });
    // 字段口径(contextWindow / modelType / supportsVision / thinkingLevels …)见 services/modelCatalog.ts。
    const cat = await listModelCatalog(profile);
    let forsion = cat.forsion;
    if (forsion.status === 'ok' && !cat.models.some((m) => m.source === 'forsion')) {
      // 云端列表为空:探针确认大脑是否可达(httpBrain 把网络/404 都吞成 [],此处补真相)。
      try {
        const u = await deps().brain.users.getUserById(req.user!.userId);
        forsion = u
          ? { status: 'empty', detail: '云端可达,但模型列表为空——检查 Forsion admin 的模型配置(需 enabled)' }
          : { status: 'error', detail: '云端鉴权失败或 brain-api 未部署(/api/brain/* 404)——检查 token 与 Forsion server 版本' };
      } catch (e: any) {
        forsion = { status: 'error', detail: `云端不可达:${e?.message || e}` };
      }
    }
    // 默认模型:admin 的 project 默认 > profile 静态默认。后台/生图槽供客户端「未显式设置即跟随」。
    res.json({
      models: cat.models,
      directProviders: cat.directProviders,
      defaultModelId: cat.defaultModelId,
      backgroundModelId: cat.backgroundModelId,
      imageModelId: cat.imageModelId,
      visionModelId: cat.visionModelId,
      contextWindowCap: CONTEXT_WINDOW_TOKENS, // 缺省上限:模型菜单「默认」档显示 min(maxContextWindow, 它)
      // PUT /agent/models/overrides 在本进程能不能写(与它同一道 hostExec 门):桌面连外部 / 云端 worker 时为 false,
      // 模型菜单据此不露「上下文上限」—— 靠前端猜宿主(backendStatus)会在 external 模式下露出一个必然 404 的开关。
      modelOverridesWritable: deps().profile.capabilities.hostExec,
      forsion,
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list models failed' });
  }
});

/**
 * 用户本机的 per-model 覆盖(config.json modelOverrides 段;pi 的 modelOverrides 同义):
 *   PUT /agent/models/overrides { modelId, contextWindow: number | null } → { overrides }
 * contextWindow 按 token(≥4000),null / 空 = 清除交还自动识别。改动对下一次 run 与下一次 GET /agent/models 生效。
 * ⚠️ 写的是本进程的 config.json → 云端 worker(hostExec=false)一律 404,与 providers/websearch 同门:
 *    那里一个进程服务所有用户,放行等于让 A 改掉 B 的预算(容器重启前一直有效)。
 */
export function applyModelOverride(body: any, hostExec: boolean): { code: number; body: any } {
  if (!hostExec) return { code: 404, body: { detail: 'Model overrides are only available on a local engine (desktop / TUI)' } };
  const modelId = String(body?.modelId ?? '').trim();
  if (!modelId || modelId.length > 200) return { code: 400, body: { detail: 'modelId required' } };
  const raw = body?.contextWindow;
  const tokens = raw == null || raw === '' ? null : Number(raw);
  if (tokens !== null && !(Number.isFinite(tokens) && tokens >= MIN_OVERRIDE_TOKENS)) {
    return { code: 400, body: { detail: `contextWindow is in tokens: minimum ${MIN_OVERRIDE_TOKENS} (for 272K enter 272000); send null to clear` } };
  }
  return { code: 200, body: { overrides: setModelContextWindow(modelId, tokens) } };
}

router.put('/agent/models/overrides', authMiddleware, async (req, res) => {
  try {
    const r = applyModelOverride(req.body, deps().profile.capabilities.hostExec);
    res.status(r.code).json(r.body);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'save model override failed' });
  }
});

export default router;
