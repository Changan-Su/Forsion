/**
 * 接缝:BillingServices —— 计费/配额/用量(B 类,SaaS 专有)。
 * microserver 接 Forsion 的 tokenQuota/creditPricing/usage;standalone 用 noopBilling(allow-all / cost 0)。
 */
import type { QuotaResult, AgentModel } from '../core/types.js';

export interface BillingServices {
  canConsumeTokenPoints(userId: string, amount: number): Promise<QuotaResult>;
  consumeTokenPoints(userId: string, amount: number): Promise<QuotaResult>;
  /** 签名对齐 creditPricingService.calculateCost(modelId, tokensInput, tokensOutput, model?, cachedTokens?)。
   *  cachedTokens=prompt 缓存命中量,命中部分按 provider 折扣价计费;省略与旧行为一致。 */
  calculateCost(
    modelId: string,
    tokensInput: number,
    tokensOutput: number,
    model?: AgentModel,
    cachedTokens?: number,
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
  ): Promise<void>;
}
