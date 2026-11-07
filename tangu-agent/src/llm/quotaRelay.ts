/**
 * 额度用完接力(借鉴 yetone/magpie,方案页 docs/ToBeImproved/借鉴magpie方案_2026-10-28/relay.html,选 A +「换之前先问我」开关)。
 *
 * 只认 retry.ts 判成「额度用完」(QUOTA_EXHAUSTED)的那一组;秒级限流照旧退避,凭证失效照旧续期,都不换模型。
 * 只接**一个**后备模型(config.json models.quotaFallback),后备自己也用完就停下报错,不往下找。缺省不设 = 今天的行为。
 * 换回:不粘在后备上。下一轮先试原模型;重置时间没到的直接用后备,省一次必败的请求(这张表只在进程内存)。
 */
import { getRawSection } from '../core/config.js';

export interface RelaySettings { fallback: string | null; ask: boolean }

export function relaySettings(): RelaySettings {
  const m = getRawSection('models') || {};
  const fallback = typeof m.quotaFallback === 'string' && m.quotaFallback.trim() ? m.quotaFallback.trim() : null;
  return { fallback, ask: m.quotaFallbackAsk === true };
}

/** 额度用完时没报重置时间:按一小时算(Codex 订阅的窗口是 5 小时,按最短的猜,宁可多试一次原模型)。 */
const UNKNOWN_RESET_MS = 60 * 60_000;
const exhausted = new Map<string, number>();

/** 上游报错里的重置时刻(ms);openaiResponses / openaiCompat 解析 resets_at / resets_in_seconds 时挂在 LlmError 上。 */
export const quotaResetAt = (err: unknown): number | undefined => {
  const v = Number((err as any)?.resetsAt);
  return v > 0 ? v : undefined;
};

export function noteQuotaExhausted(modelId: string, resetsAt?: number): number {
  const until = resetsAt && resetsAt > Date.now() ? resetsAt : Date.now() + UNKNOWN_RESET_MS;
  exhausted.set(modelId, until);
  return until;
}

/** 这个模型还在额度用完的窗口里 → 返回重置时刻;过了就忘掉它。 */
export function quotaExhaustedUntil(modelId: string): number | null {
  const until = exhausted.get(modelId);
  if (!until) return null;
  if (until <= Date.now()) { exhausted.delete(modelId); return null; }
  return until;
}

/** 测试用:清掉进程内的「已用完」表。 */
export const __resetQuotaRelay = (): void => exhausted.clear();

/** 「换之前先问我」开着时这一轮停下的报错尾巴:界面认它画「等重置 / 改用 X」两颗按钮。 */
export const QUOTA_ASK_MARK = 'quota_fallback_ask';
export const quotaAskSuffix = (fallback: string) => ` [${QUOTA_ASK_MARK}:${fallback}]`;
