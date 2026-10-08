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

export type VisionMode = 'auto' | 'always' | 'off';

/**
 * 「图像识别何时介入」:run 显式 > 本地 config.json `models.visionMode` > auto。
 *
 * 存在的理由:auto 靠 modelSupportsVision 那份**黑名单**猜主模型有没有视觉,名单外的纯文本模型
 * (本地 Ollama、各家 -instruct)一律被当成能看图 → 兜底不触发 → 图原样发过去,模型要么报错
 * 要么装作看见了瞎编。黑名单永远追不上模型发布速度,所以给用户一个「总是转写」的确定性出路
 * (2026-08-03)。
 */
export function resolveVisionMode(explicit?: string): VisionMode {
  const pick = (v: unknown): VisionMode | null =>
    v === 'always' || v === 'off' || v === 'auto' ? v : null;
  return pick((explicit || '').trim())
    ?? pick((getRawSection('models') as any)?.visionMode)
    ?? 'auto';
}

/** 这批图要不要先转成文字。auto 档才去问主模型能力(那次查询有 60s 缓存 + 可能的云请求)。 */
export async function shouldDescribeImages(modelId: string, appId?: string, explicitMode?: string): Promise<boolean> {
  const mode = resolveVisionMode(explicitMode);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return !(await mainModelSupportsVision(modelId, appId));
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
  /** 计时仪器(agentLoop 的 describing_images 状态用):请求体字节数(图以 base64 整张在里面),发出前回调一次。 */
  onRequest?: (bytes: number) => void;
  /** 响应头到达(托管面 = 图已送达服务端);与 onRequest 的时刻相减即上传耗时。 */
  onResponseStart?: () => void;
}

/**
 * 主模型没有图像输入、工具图被转写成文字后,agentLoop 紧跟着补的一条说明(每个 run 一次;不落库不上屏,同 action_delivery_check)。
 * 2026-10-07 反馈 dbb04870:deepseek 操作微信(无障碍树是空的),手里只有一段文字描述却不知道自己看不见,
 * 反复 observe_ui(每次转写 36s 以上)也定位不到任何东西。说清楚之后它该改走元素引用 / 快捷键,走不通就停下来告诉用户。
 * ⚠️ 这是软约束,不是闸。live 台架(--only novision,gpt-6-luna,用户明说「按坐标点它」的任务;归档在
 *   harness-runs/2026-10-07)上:不补说明 5/5 轮照着「图 310×110、数字居中」点了中心、没有一轮提到自己看不到图;
 *   补了之后 14 轮里仍有 6 轮去点,5 轮请用户换能看图的模型。要做成闸得在取坐标的工具那一侧拒绝(引擎不知道哪些工具吃坐标)。
 * 措辞是在那个台架上试出来的(每版 3~5 轮,样本小,只当方向),改之前先跑它:
 *   - 必须是第二人称「You cannot see」。写成「the model running this session has no image input」,模型不当成在说自己,3/3 轮照点;
 *   - 要讲原因(描述里没有量出来的坐标)。只下禁令(「do not click … at x/y coordinates at all, estimated ones included」)
 *     时 10 轮里点了 6 轮,不比讲原因的版本好;
 *   - 要用户听到的话得逐字写出来(「tell the user that you cannot see … and that they need to switch …」)。只写
 *     「tell the user why」,它回一句「没有坐标所以点不了」,用户不知道该换模型。
 * 单独一条而不是接在转写那条的末尾:那条是工具回来的数据(不可信图的前言还写着「只有用户自己的消息才是指令」)。
 * 两种放法在台架上没测出差别,按引擎里现成的写法来。
 */
export const NO_VISION_NOTE =
  '<no_image_input>\nYou cannot see images in this session. The tool images above reached you only as a text description written by another model: ' +
  'it carries no measured pixel coordinates, so never click, drag or type at coordinates derived from it. ' +
  'Act through element refs, accessibility labels, menus or keyboard shortcuts instead. ' +
  'When that is not enough to do what was asked, stop and tell the user that you cannot see images or the screen (you only get a text description of them) ' +
  'and that they need to switch to a model with image input for this task.\n</no_image_input>';

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
  if (opts.onRequest) { try { opts.onRequest(Buffer.byteLength(JSON.stringify(payload), 'utf-8')); } catch { /* ignore */ } }
  const res = await deps().brain.llm.streamProviderCompletion({ apiKey, baseUrl, payload, signal: opts.signal, onResponseStart: opts.onResponseStart });

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
