/**
 * 后台 LLM 调用的用量台账(报告 A5 / 跨车道契约 C-5)。
 *
 * 背景:压缩摘要 / Historian 判官 / self_brainstorm 分身 / delegate 子代理 / Muse 判官都发真请求、
 * 烧真 token,却一条 `usage` 事件都不发 —— Muse 的预算和用户可见的「本 run 花了多少」因此都有洞
 * (60 天里仅 Muse 一侧就有 11 次不计量的 LLM 摘要 ≈1.65M token)。这里是这些调用**唯一**的上报口,
 * 形状与主循环的 usage 事件对齐,只多一个 `phase`。
 *
 * ⚠ 消费端契约:主循环的 usage 事件**不带** `phase`;带 `phase` 的不是主对话的上下文用量,
 *   不能拿去刷上下文进度条(`prompt`)或当作 run 累计量(故本事件刻意不发 `total`/`costTotal`)。
 *   这道闸在三处消费端落实:desktop `appStore.reduceEvent` 的 case 'usage'、TUI `src/tui/app.tsx`、
 *   以及 `/agent/sessions/:id/usage` 的 `pickMainLoopUsage`。新增消费端照抄这三处之一。
 * ⚠ 只发事件,不调 consumeTokenPoints/logApiUsage:托管路由已按 usageSource 记过账,重复调=双扣。
 */
import { deps } from '../seams/runtime.js';
import { publish } from './eventBus.js';
import { currentRunId } from '../seams/runContext.js';

/** 后台阶段名(C-5 固定枚举;主循环调用不带 phase)。 */
export type UsagePhase = 'compaction' | 'historian' | 'brainstorm' | 'muse-judge' | 'delegate';

export interface BackgroundUsageInput {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** provider 未上报缓存命中量时应为 undefined(不是 0)—— cacheReported 据此区分「0 命中」与「没报」。 */
  cached_tokens?: number;
  reasoning_tokens?: number;
}

/**
 * 发一条带 phase 的 usage 事件。runId 缺省取当前 run 上下文(ALS);仍拿不到就静默跳过
 * (Dream / 云端 historian 这类没有 run 的后台任务没有落点,不为它们编一个 run)。
 * 绝不抛、绝不阻断调用方 —— 记账失败不该让压缩/判官/子代理失败。
 */
export async function publishBackgroundUsage(
  phase: UsagePhase,
  modelId: string,
  usage: BackgroundUsageInput | undefined,
  opts?: { runId?: string; model?: any; iteration?: number },
): Promise<void> {
  try {
    const runId = opts?.runId || currentRunId();
    if (!runId) return;
    const prompt = Number(usage?.prompt_tokens) || 0;
    const completion = Number(usage?.completion_tokens) || 0;
    const reported = usage?.cached_tokens;
    const cached = Number(reported) || 0;
    let cost = 0;
    try {
      cost = (await deps().billing.calculateCost(modelId, prompt, completion, opts?.model, cached)) || 0;
    } catch { /* 计价失败按 0 上报,事件本身不能丢 */ }
    await publish(runId, 'usage', {
      phase,
      prompt,
      completion,
      cached,
      cacheReported: reported !== undefined && reported !== null,
      // 与主循环同一判别:`!== undefined` 而非真值 ——「上游报了 0」和「上游没报」是两件事,
      // 真值判断会把两者并成「没报」,A3 的推理分账据此就分不开(Codex 评审三轮 #8)。
      // reasoning 与 reasoningTokens 同时发:前者是既有消费端的键,后者是本轮 usage 契约的键。
      ...(usage?.reasoning_tokens !== undefined
        ? { reasoning: Number(usage.reasoning_tokens) || 0, reasoningTokens: Number(usage.reasoning_tokens) || 0 }
        : {}),
      cost,
      ...(opts?.iteration != null ? { iteration: opts.iteration } : {}),
    });
  } catch { /* 台账绝不阻断后台任务 */ }
}
