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
import { modelContextWindow } from '../services/contextBudget.js';
import { modelSupportsVision, resolveModelCapability, supportedThinkingLevels, type ThinkingLevel } from '../llm/modelCapabilities.js';

const router = Router();

/**
 * 托管模型的 supportsVision 标注 → 传给黑名单表的 override。**只有显式 false 算标注**:
 * `supports_vision` 列默认 TRUE,拿 TRUE 当「admin 说了能看」会把硬编码黑名单整片架空。
 * 与真正决定要不要走辅助识图的 mainModelSupportsVision(visionService)同一口径。
 */
export const visionOverrideOf = (v: unknown): false | undefined => (v === false ? false : undefined);

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
    // contextWindow 供客户端「上下文占比」进度条用(per-model 覆盖 ?? 全局默认)。
    // modelType 区分大语言模型 / 生图模型 / 语音识别(后端已分类;桌面模型设置据此分区,generate_image 据此选模型,语音输入据此筛 ASR)。
    // supportsVision:能不能直接「看」图。黑名单制(见 modelSupportsVision)——后端/provider 显式
    // 标了就听标注,没标就默认能看。客户端据此提示「本模型没有多模态,已启用图像识别辅助模型」。
    // ⚠️ 只有 `false` 算标注:托管模型的 supports_vision 列默认就是 TRUE(建模型时没人会去取消勾选),
    // 拿它当「admin 说了能看」会把硬编码黑名单整片架空 —— 真正决定要不要走辅助识图的
    // mainModelSupportsVision 本来就只认 false(visionService),这里跟它对齐,否则会出现
    // 「界面说这模型能看图、引擎其实在走辅助模型」的两套口径(GLM-5.3 这类纯文本模型上必现)。
    // thinkingLevels:该模型真正支持的思考档(能力表 supportedThinkingLevels;H6 思考档可见)。
    // 客户端据此把不支持的档位标灰——此前 /think 菜单全档可选,选了不支持的静默降档零提示。
    // ⚠️ baseUrl 必须带上:能力表大半规则按 host 键(xai/dashscope/moonshot…),丢了它会退到
    // provider/model 兜底,标灰方向两头都能错(评审实证:grok off 不该亮/qwen off 不该灰)。
    const thinkLv = (provider: string | undefined, modelId: string, baseUrl?: string): ThinkingLevel[] =>
      supportedThinkingLevels(resolveModelCapability({ provider, modelId, baseUrl }));
    const models: Array<{ id: string; name: string; provider: string; source: 'forsion' | 'direct'; modelType: 'llm' | 'image_gen' | 'asr'; contextWindow: number; supportsVision: boolean; thinkingLevels?: ThinkingLevel[] }> = [];

    let forsion: { status: 'ok' | 'empty' | 'error'; detail: string | null } = { status: 'ok', detail: null };
    let cloud: any[] = [];
    let projectDefaultModelId: string | null = null;
    let projectBackgroundModelId: string | null = null;
    let projectImageModelId: string | null = null;
    let projectVisionModelId: string | null = null;
    try {
      // 优先按应用过滤(admin 的 project_model_configs);brain 未实现该可选方法 → 回退全局列表。
      const listForProject = deps().brain.models.listModelsForProject;
      if (listForProject) {
        const r = await listForProject(profile.appId);
        cloud = r?.models || [];
        projectDefaultModelId = r?.defaultModelId ?? null;
        projectBackgroundModelId = r?.backgroundModelId ?? null;
        projectImageModelId = r?.imageModelId ?? null;
        projectVisionModelId = r?.visionModelId ?? null;
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
      const mType = m.modelType === 'image_gen' || m.modelType === 'asr' ? m.modelType : 'llm';
      models.push({ id: m.id, name: m.name || m.id, provider: m.provider || 'forsion', source: 'forsion', modelType: mType, contextWindow: modelContextWindow(m.id, m), supportsVision: modelSupportsVision(m.id, visionOverrideOf(m.supportsVision)), ...(mType === 'llm' ? { thinkingLevels: thinkLv(m.provider, m.id, m.defaultBaseUrl ?? m.default_base_url ?? undefined) } : {}) });
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
      const noVision = new Set(p.noVisionModelIds ?? []);
      for (const mid of p.modelIds ?? []) {
        models.push({ id: `${p.providerId}/${mid}`, name: mid, provider: p.providerId, source: 'direct', modelType: 'llm', contextWindow: modelContextWindow(mid), supportsVision: modelSupportsVision(mid, noVision.has(mid) ? false : undefined), thinkingLevels: thinkLv(p.providerId, mid, p.baseUrl) });
      }
      for (const mid of p.imageModelIds ?? []) {
        models.push({ id: `${p.providerId}/${mid}`, name: mid, provider: p.providerId, source: 'direct', modelType: 'image_gen', contextWindow: 0, supportsVision: false });
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
      visionModelId: projectVisionModelId,
      forsion,
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list models failed' });
  }
});

export default router;
