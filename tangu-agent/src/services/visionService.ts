/**
 * 图像识别(辅助视觉模型)——把图片交给一个多模态模型,换回一段文字描述。
 *
 * 两个消费方,共用这一条实现:
 *   1. agentLoop 的自动降级:主模型没有原生视觉能力时,view_image / desk_screenshot 等工具
 *      产出的图不再直接回灌上下文(发过去只会被 provider 拒),先在这里转成文字再进对话。
 *   2. `POST /agent/vision/describe`:非聊天场景(插件、自动化、外部调用)要认张图,不必为此
 *      起一个 agent run。
 *
 * 用的模型 = 「辅助模型 · 图像识别」槽(visionModelId),与主模型解耦。槽为空 → 抛错,调用方
 * 自行降级(agentLoop 会退回原来的「直接塞图」行为,不因为没配槽就丢内容)。
 */
import { deps } from '../seams/runtime.js';
import { getRawSection } from '../core/config.js';
import { modelSupportsVision } from '../llm/modelCapabilities.js';
import { toImageParts } from './imageAttachments.js';
import type { ChatMessage } from '../core/types.js';

const DESCRIBE_SYSTEM_PROMPT =
  'You are an image-understanding assistant. Describe the given image(s) so that another AI, which cannot see them, can act on your description alone. ' +
  'Transcribe every piece of visible text verbatim (including code, error messages, numbers and labels). ' +
  'Describe layout, UI structure, charts and any state that carries meaning. ' +
  'Be factual and complete; never guess at content you cannot see, and add no commentary or pleasantries.';

const DESCRIBE_MAX_TOKENS = 1500;
const MAX_IMAGES_PER_CALL = 8;

/**
 * app 级模型目录的 60s 快照:一次调用同时喂两个问题——「图像识别槽配了谁」和「哪些模型被
 * 标注成没有视觉」。与 resolveBackgroundModelId 同款缓存(loop 每轮都会问,不能每轮拉一次)。
 *
 * ⚠️**按 appId 分桶**:云端一个进程服务多 app,`deps().profile` 只是**基线**(agent-core 是
 * ai-studio),真正该问的是本 run 的 app(agentLoop 里的 `appId`)。用一个全局桶会让 B app 的
 * run 读到 A app 的槽(2026-07-27 Codex 评审)。
 */
type Slots = { at: number; visionId: string; noVision: Set<string> };
const slotCache = new Map<string, Slots>();
async function loadSlots(appId?: string): Promise<Slots> {
  const key = (appId || deps().profile.appId || '').trim();
  const now = Date.now();
  const hit = slotCache.get(key);
  if (hit && now - hit.at <= 60_000) return hit;
  let visionId = '';
  const noVision = new Set<string>();
  try {
    const list = deps().brain.models.listModelsForProject;
    if (list) {
      const r = await list(key);
      visionId = String(r?.visionModelId || '');
      for (const m of r?.models || []) {
        if (m?.id && m.supportsVision === false) noVision.add(String(m.id));
      }
    }
  } catch { /* 云端不可达 → 视作未标注(全默认有视觉),不因此拦下图片 */ }
  const fresh: Slots = { at: now, visionId, noVision };
  slotCache.set(key, fresh);
  return fresh;
}

/** 单测用:清掉 60s 快照(各用例换一套 brain 桩)。 */
export function __resetVisionSlotCacheForTests(): void {
  slotCache.clear();
}

/**
 * 辅助视觉模型解析:run 显式 > 本地 `~/.tangu/config.json` 的 `models.vision`(桌面设置/引导写)
 * > admin 的 app 级「图像识别」槽 > 空(空 = 功能关闭,调用方降级)。
 */
export async function resolveVisionModelId(explicit?: string, appId?: string): Promise<string> {
  const e = (explicit || '').trim();
  if (e) return e;
  const local = String((getRawSection('models') as any)?.vision || '').trim();
  if (local) return local;
  return (await loadSlots(appId)).visionId;
}

/**
 * 主模型能不能直接看图。判定源(优先级从高到低):
 *   1. admin 在托管模型上标注的 supportsVision=false
 *   2. 直连 provider 声明的 noVisionModelIds(`<providerId>/<model>` 与裸名都认)
 *   3. 硬编码黑名单(modelSupportsVision)
 * 三处都没说话 → 有视觉(黑名单制,见 modelCapabilities 里的理由)。
 */
export async function mainModelSupportsVision(modelId: string, appId?: string): Promise<boolean> {
  const id = (modelId || '').trim();
  if (!id) return true;
  const { noVision } = await loadSlots(appId);
  if (noVision.has(id)) return false;
  // 直连黑名单按 provider 归属判:`a/gemma3` 只吃 provider a 的名单,不吃 b 的(否则同名模型互相误伤)。
  const slash = id.indexOf('/');
  const prefix = slash > 0 ? id.slice(0, slash) : '';
  const bare = slash > 0 ? id.slice(slash + 1) : id;
  for (const p of deps().brain.models.listDirectProviders?.() ?? []) {
    if (prefix && p.providerId !== prefix) continue;
    if (p.noVisionModelIds?.includes(id) || p.noVisionModelIds?.includes(bare)) return false;
  }
  return modelSupportsVision(id);
}

export interface DescribeImagesOpts {
  /** 辅助视觉模型 id(必填;空 → 抛错)。 */
  modelId: string;
  /** 计费主体(额度预检 / 扣费 / 用量记录都挂在他头上)。 */
  userId: string;
  /** 附加指令(如「只提取表格里的数字」);缺省走通用转录。 */
  prompt?: string;
  /** 记账归因(api_usage_logs.project_source)。 */
  appId?: string;
  signal?: AbortSignal;
}

/** 额度预检的输入量估算:base64 长度当 token 数会离谱高估,按「每张图一个常数」更接近真实。 */
const EST_TOKENS_PER_IMAGE = 1500;

/**
 * 一次调用识别一组图(最多 MAX_IMAGES_PER_CALL 张),返回一段文字。任何失败都抛(调用方决定降级策略)。
 *
 * ⚠️**超量抛错而不是截断**:截断 + 调用方拿描述替换整批图 = 多出来的图既没文字也没原图,
 * 静默数据空洞。抛出去 agentLoop 会退回直接送图,一张不丢(2026-07-27 Codex 评审)。
 *
 * 计费与 agentLoop 同款三步(预检 → 扣费 → 记用量):这条路不经 agent loop,漏了就是**免费 LLM**。
 */
export async function describeImages(
  images: Array<{ url: string }>,
  opts: DescribeImagesOpts,
): Promise<string> {
  const modelId = (opts.modelId || '').trim();
  if (!modelId) throw new Error('未配置图像识别模型(辅助模型 · 图像识别)');
  const imgs = images.filter((i) => i?.url);
  if (!imgs.length) throw new Error('没有可识别的图片');
  if (imgs.length > MAX_IMAGES_PER_CALL) {
    throw new Error(`一次最多识别 ${MAX_IMAGES_PER_CALL} 张图(收到 ${imgs.length} 张)`);
  }

  const billing = deps().billing;
  const user = (await deps().brain.users.getUserById(opts.userId).catch(() => null))
    ?? { id: opts.userId, username: 'local' };
  const estCost = await billing.calculateCost(modelId, EST_TOKENS_PER_IMAGE * imgs.length, DESCRIBE_MAX_TOKENS);
  const pre = await billing.canConsumeTokenPoints(user.id, estCost);
  if (!pre.ok) throw new Error('token_quota_exceeded');

  const { model, apiKey, baseUrl, apiModelId } = await deps().brain.llm.resolveModelAndKey(modelId);
  const payload = await deps().brain.llm.buildProviderPayload({
    model,
    apiModelId,
    messages: [
      { role: 'system', content: DESCRIBE_SYSTEM_PROMPT },
      { role: 'user', content: toImageParts(opts.prompt || 'Describe the image(s).', imgs) },
    ] as ChatMessage[],
    projectSource: '', // 不叠项目层提示词(纯工具调用)
    usageSource: opts.appId, // 记账归进应用桶
    temperature: 0.2,
    maxTokens: DESCRIBE_MAX_TOKENS,
    stream: true,
  } as any);
  const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, signal: opts.signal });

  const usage = res?.usage || ({} as any);
  const cached = usage.cached_tokens || 0;
  const cost = await billing.calculateCost(modelId, usage.prompt_tokens || 0, usage.completion_tokens || 0, undefined, cached);
  await billing.consumeTokenPoints(user.id, cost).catch(() => {});
  await (billing.logApiUsage as any)(
    user.username, modelId, model.name, model.provider,
    usage.prompt_tokens || 0, usage.completion_tokens || 0, true, undefined, opts.appId, cost, cached,
  ).catch(() => {});

  const text = String(res?.content || '').trim();
  if (!text) throw new Error('图像识别模型未返回内容');
  return text;
}
