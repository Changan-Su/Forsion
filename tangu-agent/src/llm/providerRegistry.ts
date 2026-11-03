/**
 * 直连 provider 注册表 —— 接缝② `brain.llm` 的本地路由表。
 *
 * standalone 从 config/env 构建一组直连 provider(OpenAI / Ollama / 任意 OpenAI 兼容端点)。
 * `resolve(modelId)` 命中本地 provider → 返回带 DIRECT_MARK 的 ResolvedModel(走 openaiCompat);
 * 未命中 → 返回 null(交回 Forsion 托管面 httpBrain)。
 *
 * modelId 约定(二选一即命中):
 *   1. `<providerId>/<apiModelId>`  例:`ollama/llama3`、`openai/gpt-4o`
 *   2. 精确等于某 provider 的 modelIds 之一(provider 显式声明的模型白名单)
 */
import type { ResolvedModel } from '../core/types.js';
import { makeDirectModel } from './openaiCompat.js';

/** 直连推理协议。'openai' = OpenAI 兼容 /chat/completions(默认);其余为订阅登录的专用端点。 */
export type DirectProviderProtocol = 'openai' | 'anthropic-messages' | 'openai-responses' | 'grok-build';

export interface DirectProvider {
  providerId: string; // 'openai' / 'ollama' / 'anthropic-compat' …(也用作 modelId 前缀)
  baseUrl: string; // OpenAI 兼容端点根(含 /v1,如 http://localhost:11434/v1);openaiCompat 会拼 /chat/completions
  apiKey?: string; // 直连厂商的用户自有 key;Ollama 等本地端点可省
  modelIds?: string[]; // 可选:该 provider 的 LLM 模型白名单(支持不带前缀直接用)
  imageModelIds?: string[]; // 可选:该 provider 的生图模型白名单(generate_image 用;OpenAI 兼容 /images/generations)
  ttsModelIds?: string[]; // 可选:该 provider 的语音合成模型白名单(朗读用;OpenAI 兼容 /audio/speech)
  // 可选:该 provider 里**没有**多模态视觉的模型(黑名单;默认认为都能看图,见 modelSupportsVision)。
  // 命中的模型遇到图片会自动转交「辅助模型 · 图像识别」槽先转文字。
  noVisionModelIds?: string[];
  protocol?: DirectProviderProtocol; // 缺省 'openai';订阅登录据此切到原生端点
  accountId?: string; // Codex 订阅:chatgpt-account-id 头取值
  /** 模型 → Fast 档说明。Codex 订阅来自 /models 目录(见 fetchProviderCatalog);官方 OpenAI / Anthropic 由 OFFICIAL_FAST 按模型名派生。
   *  不在表里的模型开了 Fast 也不发。 */
  fastTiers?: Record<string, string>;
  /** 官方 OpenAI 的 Ultrafast 档(service_tier "ultrafast",只认 Responses):模型 → 「{倍数}x price」。由 OFFICIAL_ULTRAFAST 派生。 */
  ultrafastTiers?: Record<string, string>;
  /** 由订阅登录(provider-auth.json)派生:apiKey 是会过期的 access_token,调用前要续期(multiBrain)。显式配置的同名 provider 不带它。 */
  oauth?: boolean;
}

export interface ProviderRegistry {
  resolve(modelId: string): ResolvedModel | null;
  list(): DirectProvider[];
  has(modelId: string): boolean;
  /** 订阅登录的凭证续期 / 换号后换进来(token 与 account id 成对);之后 resolve 与直接读 p.apiKey 的路径(图像 / 语音)都拿到新值。
   *  换了账号时 Fast 目录跟着换成新账号盘上那份(没有就清空):旧账号的目录套在新账号上,会对它不支持的模型发 priority。 */
  setCreds(providerId: string, apiKey: string, accountId?: string, fastTiers?: Record<string, string>): void;
}

/**
 * 官方 API(BYOK)的 Fast 档:模型 → 「{倍数}x price」(界面 fastTierText 解析)。11-03 按两家文档 + 真 key 探针核实:
 * - api.openai.com:请求带 service_tier "fast"(旧值 priority 同效),chat / responses 都认;价表没列的模型 200 照常、回 default(静默不生效)。
 * - api.anthropic.com:请求带 speed "fast";不支持的模型 400。Opus 5 / 4.8 是研究预览(未开通的组织 fast 限额为 0 → 429),只放 Opus 5.5。
 * 倍数 = Fast 单价 ÷ 标准单价(两家价目页)。
 */
const OFFICIAL_FAST: Record<string, Array<[RegExp, string]>> = {
  'api.openai.com': [
    [/^gpt-5\.5$/, '2.5'],
    [/^gpt-5-mini$/, '1.8'],
    [/^(gpt-4\.1(-mini)?|o3)$/, '1.75'],
    [/^gpt-4o$/, '1.7'],
    [/^gpt-4o-mini$/, '1.67'],
    [/^(gpt-6(\.1)?-(astra|sol|luna|terra)|gpt-5\.6-(sol|terra|luna)|gpt-5\.4(-mini)?|gpt-5\.[12]|gpt-5|gpt-5\.3-codex)$/, '2'],
  ],
  'api.anthropic.com': [[/^claude-opus-5-5$/, '2']],
};
/** OpenAI Ultrafast(11-03 真 key 实测):只有 Responses 认 service_tier "ultrafast",chat/completions 与不支持的模型都 400 Invalid service_tier。 */
const OFFICIAL_ULTRAFAST: Record<string, Array<[RegExp, string]>> = {
  'api.openai.com': [[/^(gpt-6-astra|gpt-6\.1-sol)$/, '6']],
};

function officialFastTiers(p: DirectProvider, table: Record<string, Array<[RegExp, string]>>): Record<string, string> | undefined {
  let host = '';
  try { host = new URL(p.baseUrl).hostname.toLowerCase(); } catch { return undefined; } // 全等比对:api.openai.com.evil.tld 不算官方
  const rules = table[host];
  if (!rules || p.oauth || (host === 'api.anthropic.com' && p.protocol !== 'anthropic-messages')) return undefined;
  const out: Record<string, string> = {};
  for (const mid of p.modelIds ?? []) {
    const bare = mid.replace(/-\d{4}-?\d{2}-?\d{2}$/, ''); // 带日期的快照同族同价
    const hit = rules.find(([re]) => re.test(bare));
    if (hit) out[mid] = `${hit[1]}x price`;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createProviderRegistry(providers: DirectProvider[]): ProviderRegistry {
  const byId = new Map<string, DirectProvider>();
  for (const p of providers) {
    if (!p?.providerId || !p?.baseUrl) continue;
    const fastTiers = p.fastTiers ?? officialFastTiers(p, OFFICIAL_FAST);
    const ultrafastTiers = officialFastTiers(p, OFFICIAL_ULTRAFAST);
    byId.set(p.providerId, { ...p, baseUrl: p.baseUrl.replace(/\/+$/, ''), ...(fastTiers ? { fastTiers } : {}), ...(ultrafastTiers ? { ultrafastTiers } : {}) });
  }

  function resolve(modelId: string): ResolvedModel | null {
    if (!modelId) return null;
    // 形式 1:<providerId>/<apiModelId>
    const slash = modelId.indexOf('/');
    if (slash > 0) {
      const prefix = modelId.slice(0, slash);
      const rest = modelId.slice(slash + 1);
      const p = byId.get(prefix);
      if (p && rest) {
        return { model: makeDirectModel(modelId, p.providerId, { protocol: p.protocol, accountId: p.accountId }), apiKey: p.apiKey || '', baseUrl: p.baseUrl, apiModelId: rest };
      }
    }
    // 形式 2:精确命中某 provider 的 modelIds
    for (const p of byId.values()) {
      if (p.modelIds?.includes(modelId)) {
        return { model: makeDirectModel(modelId, p.providerId, { protocol: p.protocol, accountId: p.accountId }), apiKey: p.apiKey || '', baseUrl: p.baseUrl, apiModelId: modelId };
      }
    }
    return null;
  }

  return {
    resolve,
    list: () => Array.from(byId.values()),
    has: (modelId: string) => resolve(modelId) !== null,
    setCreds: (providerId: string, apiKey: string, accountId?: string, fastTiers?: Record<string, string>) => {
      const p = byId.get(providerId);
      if (!p) return;
      if (p.accountId !== accountId) p.fastTiers = fastTiers;
      p.apiKey = apiKey;
      p.accountId = accountId;
    },
  };
}
