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
 * direct 部分仅 standalone 的 multiBrain 实现(listDirectProviders 可选方法),云端自动跳过。
 * 诊断:httpBrain.listGlobalModels 对错误降级 [](TUI 依赖此行为),这里用 users/me 探针
 * 区分「云端可达但 admin 没配模型(empty)」与「云端不可达/未授权/未部署 brain-api(error)」。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { modelContextWindow } from '../services/contextBudget.js';

const router = Router();

router.get('/agent/models', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const profile = deps().profile;
    // contextWindow 供客户端「上下文占比」进度条用(per-model 覆盖 ?? 全局默认)。
    const models: Array<{ id: string; name: string; provider: string; source: 'forsion' | 'direct'; contextWindow: number }> = [];

    let forsion: { status: 'ok' | 'empty' | 'error'; detail: string | null } = { status: 'ok', detail: null };
    let cloud: any[] = [];
    let projectDefaultModelId: string | null = null;
    try {
      // 优先按应用过滤(admin 的 project_model_configs);brain 未实现该可选方法 → 回退全局列表。
      const listForProject = deps().brain.models.listModelsForProject;
      if (listForProject) {
        const r = await listForProject(profile.appId);
        cloud = r?.models || [];
        projectDefaultModelId = r?.defaultModelId ?? null;
      } else {
        cloud = (await deps().brain.models.listGlobalModels()) || [];
      }
    } catch (e: any) {
      forsion = { status: 'error', detail: e?.message || String(e) };
      cloud = [];
    }
    for (const m of cloud) {
      if (!m?.id) continue;
      models.push({ id: m.id, name: m.name || m.id, provider: m.provider || 'forsion', source: 'forsion', contextWindow: modelContextWindow(m.id, m) });
    }
    if (forsion.status === 'ok' && cloud.length === 0) {
      // 列表为空:探针确认大脑是否可达(httpBrain 把网络/404 都吞成 [],此处补真相)。
      try {
        const u = await deps().brain.users.getUserById(req.user!.userId);
        forsion = u
          ? { status: 'empty', detail: '云端可达,但模型列表为空——检查 Forsion admin 的模型配置(需 enabled)' }
          : { status: 'error', detail: '云端鉴权失败或 brain-api 未部署(/api/brain/* 404)——检查 token 与 Forsion server 版本' };
      } catch (e: any) {
        forsion = { status: 'error', detail: `云端不可达:${e?.message || e}` };
      }
    }

    const directProviders = deps().brain.models.listDirectProviders?.() ?? [];
    for (const p of directProviders) {
      for (const mid of p.modelIds ?? []) {
        models.push({ id: mid, name: mid, provider: p.providerId, source: 'direct', contextWindow: modelContextWindow(mid) });
      }
    }

    // 默认模型:admin 的 project 默认 > profile 静态默认。
    res.json({ models, directProviders, defaultModelId: projectDefaultModelId || profile.defaultModelId || null, forsion });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list models failed' });
  }
});

export default router;
