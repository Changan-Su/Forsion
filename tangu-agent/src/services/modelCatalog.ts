/**
 * 模型目录(单源):云端托管(按应用过滤)+ 本机直连 / 订阅 provider,合并去重。
 *
 * 原先整段逻辑长在 GET /agent/models 里,TUI 的 /model 另起炉灶只调 listGlobalModels(看不到 `codex/*` 这类
 * 直连 / 订阅模型,也不按应用过滤),通道干脆没有 /model。现在路由、TUI、通道、session_settings 工具共用这里。
 * 路由独有的部分(users/me 探针区分 empty / error、contextWindowCap、modelOverridesWritable)仍留在路由。
 */
import { deps } from '../seams/runtime.js';
import type { AppProfile } from '../seams/appProfile.js';
import { effectiveContextWindowInfo, type CtxWindowSource } from './contextBudget.js';
import { clampThinkingLevel, modelSupportsVision, resolveModelCapability, supportedThinkingLevels, type ModelCapability, type ThinkingLevel } from '../llm/modelCapabilities.js';

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  source: 'forsion' | 'direct';
  modelType: 'llm' | 'image_gen' | 'asr';
  contextWindow: number;
  contextWindowSource: CtxWindowSource;
  maxContextWindow?: number;
  supportsVision: boolean;
  thinkingLevels?: ThinkingLevel[];
  groupId?: string | null;
  groupName?: string | null;
  groupSortOrder?: number;
  sortOrder?: number;
  tags?: Array<{ text: string; color: string }>;
  multiplier?: number | null;
}

export interface ModelCatalog {
  models: CatalogModel[];
  directProviders: any[];
  defaultModelId: string | null;
  backgroundModelId: string | null;
  imageModelId: string | null;
  visionModelId: string | null;
  /** 云端托管面:ok / error(拉取抛错)。「可达但为空」的判定要 users/me 探针,由路由补。 */
  forsion: { status: 'ok' | 'empty' | 'error'; detail: string | null };
}

/**
 * 托管模型的 supportsVision 标注 → 传给黑名单表的 override。**只有显式 false 算标注**:
 * `supports_vision` 列默认 TRUE,拿 TRUE 当「admin 说了能看」会把硬编码黑名单整片架空。
 * 与真正决定要不要走辅助识图的 mainModelSupportsVision(visionService)同一口径。
 */
export const visionOverrideOf = (v: unknown): false | undefined => (v === false ? false : undefined);

// ⚠️ baseUrl 必须带上:能力表大半规则按 host 键(xai/dashscope/moonshot…),丢了它会退到
// provider/model 兜底,标灰方向两头都能错(评审实证:grok off 不该亮/qwen off 不该灰)。
const thinkLv = (provider: string | undefined, modelId: string, baseUrl?: string): ThinkingLevel[] =>
  supportedThinkingLevels(resolveModelCapability({ provider, modelId, baseUrl }));

/** 列出 profile 可用的全部模型(字段口径见 routes/models.ts 头注)。云端出错不抛,记进 forsion.status。 */
export async function listModelCatalog(profile: AppProfile): Promise<ModelCatalog> {
  const models: CatalogModel[] = [];
  let forsion: ModelCatalog['forsion'] = { status: 'ok', detail: null };
  let cloud: any[] = [];
  let defaultModelId: string | null = null;
  let backgroundModelId: string | null = null;
  let imageModelId: string | null = null;
  let visionModelId: string | null = null;
  try {
    // 优先按应用过滤(admin 的 project_model_configs);brain 未实现该可选方法 → 回退全局列表。
    const listForProject = deps().brain.models.listModelsForProject;
    if (listForProject) {
      const r = await listForProject(profile.appId);
      cloud = r?.models || [];
      defaultModelId = r?.defaultModelId ?? null;
      backgroundModelId = r?.backgroundModelId ?? null;
      imageModelId = r?.imageModelId ?? null;
      visionModelId = r?.visionModelId ?? null;
    } else {
      cloud = (await deps().brain.models.listGlobalModels()) || [];
    }
  } catch (e: any) {
    forsion = { status: 'error', detail: e?.message || String(e) };
    cloud = [];
  }
  for (const m of cloud) {
    if (!m?.id) continue;
    // 已知类型(生图/语音识别)透传,未知归 llm。旧版只透传 image_gen,把 asr 静默拍成 llm。
    const mType = m.modelType === 'image_gen' || m.modelType === 'asr' ? m.modelType : 'llm';
    const win = effectiveContextWindowInfo(m.id, m);
    // 思考档能力表按上游模型名匹配(目录导入的 id 是 pr-<hash>);与 agentLoop 里 clamp 用的 `apiModelId || modelId` 同口径。
    models.push({ id: m.id, name: m.name || m.id, provider: m.provider || 'forsion', source: 'forsion', modelType: mType, groupId: m.groupId, groupName: m.groupName, groupSortOrder: m.groupSortOrder, sortOrder: m.sortOrder, tags: m.tags, multiplier: m.multiplier, contextWindow: win.tokens, contextWindowSource: win.source, maxContextWindow: win.max, supportsVision: modelSupportsVision(m.id, visionOverrideOf(m.supportsVision)), ...(mType === 'llm' ? { thinkingLevels: thinkLv(m.provider, m.apiModelId || m.id, m.defaultBaseUrl ?? m.default_base_url ?? undefined) } : {}) });
  }

  // 直连模型暴露为 `<providerId>/<模型>`:裸模型名与云端托管同名时曾被下方去重吞掉 —— 前缀化后永不相撞;
  // 旧会话存的裸 id 仍由 registry 形式 2(modelIds 精确命中)照常解析。name 保留裸名供展示。
  const directProviders = deps().brain.models.listDirectProviders?.() ?? [];
  for (const p of directProviders) {
    const noVision = new Set(p.noVisionModelIds ?? []);
    for (const mid of p.modelIds ?? []) {
      const id = `${p.providerId}/${mid}`;
      const win = effectiveContextWindowInfo(id);
      models.push({ id, name: mid, provider: p.providerId, source: 'direct', modelType: 'llm', contextWindow: win.tokens, contextWindowSource: win.source, maxContextWindow: win.max, supportsVision: modelSupportsVision(mid, noVision.has(mid) ? false : undefined), thinkingLevels: thinkLv(p.providerId, mid, p.baseUrl) });
    }
    for (const mid of p.imageModelIds ?? []) {
      models.push({ id: `${p.providerId}/${mid}`, name: mid, provider: p.providerId, source: 'direct', modelType: 'image_gen', contextWindow: 0, contextWindowSource: 'default', supportsVision: false });
    }
  }

  // 选择器按 id 选用 → 按 id 去重兜底(direct 已前缀化,正常不会撞)。
  const seen = new Set<string>();
  const unique = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  return {
    models: unique,
    directProviders,
    defaultModelId: defaultModelId || profile.defaultModelId || null,
    backgroundModelId,
    imageModelId,
    visionModelId,
    forsion,
  };
}

/** 能拿来聊天的模型(排除生图 / 语音识别)。命令面的 /model 列表只列这些。 */
export const chatModels = (models: CatalogModel[]): CatalogModel[] => models.filter((m) => m.modelType === 'llm');

export type ModelMatch =
  | { kind: 'hit'; model: CatalogModel }
  | { kind: 'ambiguous'; candidates: CatalogModel[] }
  | { kind: 'none' };

const norm = (s: string): string => s.toLowerCase().replace(/[\s_]+/g, '-');

/**
 * 用户 / 模型随手写的模型名 → 目录里的一条。依次:原样 id 精确(区分大小写,含 `<provider>:<model>` 写法)→
 * 归一后 id 精确 → name 精确 → 唯一子串命中(id 或 name)。归一后 id / name 精确或子串命中多条 → ambiguous
 * (调用方列候选,绝不猜);零命中 → none。
 * 只有**原样** id 唯一(目录按原始 id 去重):归一(小写、空格 / 下划线折成连字符)之后云端的 `Qwen/Qwen3-235B` 与直连的
 * `qwen/qwen3-235b` 是同一个串,旧口径 find 取目录第一项 = 静默切到另一家(09-25 #6)。name 同理不唯一:两个直连 provider
 * 都叫「gpt-5」时 /model 与 update_session_settings 会静默切 provider(Codex 09-25 P2)。
 * 归一让「opus 5.5」「claude_opus」都能命中。
 */
export function resolveModelQuery(query: string, models: CatalogModel[]): ModelMatch {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { kind: 'none' };
  // `vendor:model` 当 `vendor/model` 再试一次;原样那次在前 —— ollama 的 `qwen3.5:4b` 本身就是 id,不能被改写吞掉。
  const variants = (q: string): string[] => [...new Set([q, q.replace(/^([\w.-]+):(?!\/)/, '$1/')])];
  for (const q of variants(trimmed)) {
    const exact = models.find((m) => m.id === q);
    if (exact) return { kind: 'hit', model: exact };
  }
  const qs = variants(norm(trimmed));
  for (const q of qs) {
    const byId = models.filter((m) => norm(m.id) === q);
    if (byId.length === 1) return { kind: 'hit', model: byId[0] };
    if (byId.length > 1) return { kind: 'ambiguous', candidates: byId };
  }
  for (const q of qs) {
    const byName = models.filter((m) => norm(m.name) === q);
    if (byName.length === 1) return { kind: 'hit', model: byName[0] };
    if (byName.length > 1) return { kind: 'ambiguous', candidates: byName };
  }
  const q = qs[qs.length - 1];
  const partial = models.filter((m) => norm(m.id).includes(q) || norm(m.name).includes(q));
  if (partial.length === 1) return { kind: 'hit', model: partial[0] };
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial };
  return { kind: 'none' };
}

/**
 * 目录里的 thinkingLevels(该模型真支持的档)→ 请求档实际会落到哪一档。复用能力表的 clampThinkingLevel
 * (先往下、再往上、都没有落 off),命令面据此如实说「你要 max,这个模型按 high 跑」。
 * 目录没给档位表(生图 / 老后端)→ 原样返回,不瞎猜。
 */
export function effectiveThinkingOn(level: ThinkingLevel, supported: ThinkingLevel[] | undefined): ThinkingLevel {
  if (!supported?.length) return level;
  const levels = Object.fromEntries(supported.map((l) => [l, 1])) as unknown as ModelCapability['levels'];
  return clampThinkingLevel({ levels } as ModelCapability, level);
}
