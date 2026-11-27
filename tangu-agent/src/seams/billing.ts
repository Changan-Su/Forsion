/**
 * 接缝:BillingServices —— 计费/配额/用量(B 类,SaaS 专有)。
 * microserver 接 Forsion 的 tokenQuota/creditPricing/usage;standalone 用 noopBilling(allow-all / cost 0)。
 */
import type { QuotaResult, AgentModel } from '../core/types.js';

/** 缓存写入量(server #209 的 CacheWriteUsage):tokens = 写入总量,longTokens = 其中长档(Claude 1h / GPT-5.6+ 12h)。
 *  模型行没配写入单价时 server 照旧按输入价算,与不传一致。 */
export interface CacheWriteUsage { tokens: number; longTokens?: number }

/** StreamResult.usage → CacheWriteUsage;没有写入返回 undefined(调用方原样透传,老 server 忽略多出的参数)。
 *  与 server creditPricingService.cacheWriteOf 同口径。 */
export function cacheWriteOf(
  u: { cache_write_tokens?: number; cache_write_long_tokens?: number } | null | undefined,
): CacheWriteUsage | undefined {
  const tokens = Number(u?.cache_write_tokens) || 0;
  if (!(tokens > 0)) return undefined;
  return { tokens, longTokens: Number(u?.cache_write_long_tokens) || 0 };
}

/** calculateCost 的第六参:有写入量才带,没有就不加参数(调用形状与旧版一致,按位置比对的单测与老 server 都不受影响)。 */
export function cacheWriteArg(cw: CacheWriteUsage | undefined): [] | [CacheWriteUsage] {
  return cw ? [cw] : [];
}

/** logApiUsage 第 12 位(client)之后的尾巴:有写入量才补到第 16 位,没有就不加参数(调用形状与旧版一致)。 */
export function cacheWriteLogTail(cw: CacheWriteUsage | undefined): unknown[] {
  return cw ? [undefined, undefined, undefined, cw] : [];
}

export interface BillingServices {
  canConsumeTokenPoints(userId: string, amount: number): Promise<QuotaResult>;
  consumeTokenPoints(userId: string, amount: number): Promise<QuotaResult>;
  /** 签名对齐 creditPricingService.calculateCost(modelId, tokensInput, tokensOutput, model?, cachedTokens?, cacheWrite?)。
   *  cachedTokens=prompt 缓存命中量,命中部分按 provider 折扣价计费;cacheWrite=缓存写入量(模型配了写入单价才另算);
   *  两者省略与旧行为一致。 */
  calculateCost(
    modelId: string,
    tokensInput: number,
    tokensOutput: number,
    model?: AgentModel,
    cachedTokens?: number,
    cacheWrite?: CacheWriteUsage,
  ): Promise<number>;
  /** 签名对齐 usageService.logApiUsage(位置参数,与现状一致;末位 tokensCachedInput 可省略)。 */
  logApiUsage(
    username: string,
    modelId: string,
    modelName?: string,
    provider?: string,
    tokensInput?: number,
    tokensOutput?: number,
    success?: boolean,
    errorMessage?: string,
    projectSource?: string,
    pointsCost?: number,
    tokensCachedInput?: number,
    /** 客户端面标识(desktop/2.7.9),来自 run 的 input.client;in-process microserver 面用。 */
    client?: string,
    /** 13–15 位是 server 侧的 served / realtimeBilling / origin,引擎不传(给 undefined 占位)。 */
    served?: unknown,
    realtimeBilling?: unknown,
    origin?: unknown,
    /** 缓存写入量,后台「扣费详情」按它重算;server 签名末位(第 16 个位置参数)。 */
    cacheWrite?: CacheWriteUsage,
  ): Promise<void>;
}
