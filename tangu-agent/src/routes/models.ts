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
    // modelType 区分大语言模型 / 生图模型 / 语音识别(后端已分类;桌面模型设置据此分区,generate_image 据此选模型,语音输入据此筛 ASR)。
    const models: Array<{ id: string; name: string; provider: string; source: 'forsion' | 'direct'; modelType: 'llm' | 'image_gen' | 'asr'; contextWindow: number }> = [];

    let forsion: { status: 'ok' | 'empty' | 'error'; detail: string | null } = { status: 'ok', detail: null };
    let cloud: any[] = [];
    let projectDefaultModelId: string | null = null;
    let projectBackgroundModelId: string | null = null;
    let projectImageModelId: string | null = null;
    try {
      // 优先按应用过滤(admin 的 project_model_configs);brain 未实现该可选方法 → 回退全局列表。
      const listForProject = deps().brain.models.listModelsForProject;
      if (listForProject) {
        const r = await listForProject(profile.appId);
        cloud = r?.models || [];
        projectDefaultModelId = r?.defaultModelId ?? null;
        projectBackgroundModelId = r?.backgroundModelId ?? null;
        projectImageModelId = r?.imageModelId ?? null;
      } else {
        cloud = (await deps().brain.models.listGlobalModels()) || [];
      }
    } catch (e: any) {
      forsion = { status: 'error', detail: e?.message || String(e) };
      cloud = [];
    }
    for (const m of cloud) {
      if (!m?.id) continue;
      // 已知类型(生图/语音识别)透传,未知归 llm。旧版只透传 image_gen,把 asr 静默拍成 llm → 桌面把语音识别模型误当聊天模型(见 AsrModelChoice/ChatView 的 modelType 分流)。
      models.push({ id: m.id, name: m.name || m.id, provider: m.provider || 'forsion', source: 'forsion', modelType: m.modelType === 'image_gen' || m.modelType === 'asr' ? m.modelType : 'llm', contextWindow: modelContextWindow(m.id, m) });
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

    // 直连模型暴露为 `<providerId>/<模型>`(registry 形式 1,本就是自由填约定):裸模型名与云端托管
    // 模型同名(如订阅 codex 的 gpt-5.5 vs Forsion 托管 gpt-5.5)时曾被下方去重吞掉 —— 用户加了
    // provider 却"看不到自己的模型"。前缀化后 id 永不与云端相撞,选谁走谁也不再有歧义;
    // 旧会话存的裸 id 仍由 registry 形式 2(modelIds 精确命中)照常解析。name 保留裸名供展示。
    const directProviders = deps().brain.models.listDirectProviders?.() ?? [];
    for (const p of directProviders) {
      for (const mid of p.modelIds ?? []) {
        models.push({ id: `${p.providerId}/${mid}`, name: mid, provider: p.providerId, source: 'direct', modelType: 'llm', contextWindow: modelContextWindow(mid) });
      }
      for (const mid of p.imageModelIds ?? []) {
        models.push({ id: `${p.providerId}/${mid}`, name: mid, provider: p.providerId, source: 'direct', modelType: 'image_gen', contextWindow: 0 });
      }
    }

    // 选择器按 id 选用(value={m.id})→ 按 id 去重兜底(direct 已前缀化,正常不会撞)。
    const seenId = new Set<string>();
    const uniqueModels = models.filter((m) => (seenId.has(m.id) ? false : (seenId.add(m.id), true)));

    // 默认模型:admin 的 project 默认 > profile 静态默认。后台/生图槽供客户端「未显式设置即跟随」。
    res.json({
      models: uniqueModels,
      directProviders,
      defaultModelId: projectDefaultModelId || profile.defaultModelId || null,
      backgroundModelId: projectBackgroundModelId,
      imageModelId: projectImageModelId,
      forsion,
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list models failed' });
  }
});

export default router;
