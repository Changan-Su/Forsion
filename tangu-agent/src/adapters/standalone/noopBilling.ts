/**
 * standalone 接缝:BillingServices no-op。独立模式不计费/不限额(allow-all、cost 0)。
 */
import type { BillingServices } from '../../seams/billing.js';

export function createNoopBilling(): BillingServices {
  return {
    canConsumeTokenPoints: async () => ({ ok: true }),
    consumeTokenPoints: async () => ({ ok: true }),
    calculateCost: async () => 0,
    logApiUsage: async () => { /* standalone 不记云端用量 */ },
  };
}
