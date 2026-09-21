/**
 * 上下文压缩的用户可配旋钮(借 pi 的 settings.compaction + Codex 的 compact_prompt)。
 *
 * 三层取值,前者压过后者:run 级 `agentConfig.compaction`(会话 / Agent 文件夹 config.toml 的
 * `[compaction]` 表,由 agentActivation 并入)→ `~/.tangu/config.json` 的 `compaction` 段 → 缺省值。
 * 每层都经同一把 normalize:非法值按字段各自丢弃(不是整层作废),数值钳在安全区间。
 *
 * 字段:
 *   enabled          false = 不做 LLM 摘要压缩(满载仍走机械折叠兜底,溢出照报错)
 *   reserveTokens    触发线 = 窗口 − max(reserveTokens, 5% 窗口);缺省 16384(pi 同值)
 *   thresholdPercent 上下文占到窗口的这个百分比就自动压缩(与客户端进度环同一分母);缺省 95 = 与「窗口 − 预留」
 *                    等价(行为不变)。1M 窗口的模型按预留算要 950k 才压,每轮重读几十万 token —— 调到 20–35 即可
 *                    在 200–350k 处压。只会把触发线往下拉(见 contextBudget.compactionThreshold)。
 *   keepRecentTokens 压缩后原样保留的最近上下文(按 token 走,不按条数);缺省 20000(pi 同值)
 *   summaryMaxTokens 摘要输出上限;缺省 6144(原 1200 对长任务不够写 Next steps),另受 reserve/2 封顶
 *   thinking         摘要调用的思考档:'off'(缺省,与改前 wire 一致)| 某档 | 'inherit'(跟随本 run)
 *   model            摘要用另一个(更便宜的)模型;缺省 = 本 run 模型
 *   instructions     追加到摘要指令末尾的「Additional focus」(持久;/compact <focus> 是一次性的同款)
 *   prompt           整体替换内置摘要指令(Codex compact_prompt);增量压缩的 PRESERVE/UPDATE 附注照加
 */
import { getRawSection, updateSection } from '../core/config.js';
import type { ThinkingLevel } from '../core/types.js';

const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  thresholdPercent: number;
  keepRecentTokens: number;
  summaryMaxTokens: number;
  thinking: ThinkingLevel | 'inherit';
  model?: string;
  instructions?: string;
  prompt?: string;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16_384,
  thresholdPercent: 95,
  keepRecentTokens: 20_000,
  summaryMaxTokens: 6_144,
  thinking: 'off',
};

const LIMITS = {
  reserveTokens: [2_048, 200_000],
  thresholdPercent: [10, 95],
  keepRecentTokens: [0, 500_000],
  summaryMaxTokens: [512, 32_000],
} as const;

const MAX_TEXT = 4_000; // instructions / prompt 单字段上限:它们进每次摘要请求,不该无界

/** 一层原始值 → 只含合法字段的部分设置(非法字段丢弃,不抛)。导出仅为测试。 */
export function normalizeCompactionLayer(raw: unknown): Partial<CompactionSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<CompactionSettings> = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  for (const key of ['reserveTokens', 'thresholdPercent', 'keepRecentTokens', 'summaryMaxTokens'] as const) {
    const n = Number(r[key]);
    const [lo, hi] = LIMITS[key];
    if (Number.isFinite(n)) out[key] = Math.min(hi, Math.max(lo, Math.floor(n)));
  }
  if (r.thinking === 'inherit' || THINKING.includes(r.thinking as ThinkingLevel)) out.thinking = r.thinking as CompactionSettings['thinking'];
  for (const key of ['model', 'instructions', 'prompt'] as const) {
    const s = typeof r[key] === 'string' ? (r[key] as string).trim() : '';
    if (s) out[key] = s.slice(0, key === 'model' ? 200 : MAX_TEXT);
  }
  return out;
}

/** 合并多层(前者优先)。 */
export function resolveCompactionSettings(...layers: unknown[]): CompactionSettings {
  const merged: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };
  for (const layer of [...layers].reverse()) Object.assign(merged, normalizeCompactionLayer(layer));
  return merged;
}

/** 单测:只在内存里读写(同 modelOverrides),绝不碰真家目录的 config.json。 */
let memory: Record<string, unknown> | null = null;
export function resetGlobalCompactionForTest(seed?: Record<string, unknown>): void {
  memory = seed ? { ...seed } : {};
}

/** config.json 的 `compaction` 段(缺失 / 坏 JSON → 空层)。standalone / TUI / desktop 形态才有该文件;
 *  云端 worker 没有,天然落缺省。 */
export function globalCompactionLayer(): unknown {
  if (memory) return memory;
  try { return getRawSection('compaction'); } catch { return undefined; }
}

/**
 * 改 config.json 的 `compaction` 段(设置页的写口;锁内读改写,段里手写的其它键原样保留)。
 * patch 逐键:null = 删掉交还缺省;其余经同一把 normalize(数值钳进安全区间),不认识 / 类型不对的键 → 抛错不写。
 * 返回写后归一化的全局层。
 */
export function updateGlobalCompaction(patch: Record<string, unknown>): Partial<CompactionSettings> {
  const apply = (raw: unknown): Record<string, unknown> => {
    const next: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) { delete next[key]; continue; }
      const norm = normalizeCompactionLayer({ [key]: value }) as Record<string, unknown>;
      if (!(key in norm)) throw new Error(`invalid compaction.${key}`);
      next[key] = norm[key];
    }
    return next;
  };
  if (memory) return normalizeCompactionLayer((memory = apply(memory)));
  return normalizeCompactionLayer(updateSection('compaction', apply));
}

/** run 级(agentConfig.compaction)> config.json > 缺省。 */
export function compactionSettingsFor(runLayer: unknown): CompactionSettings {
  return resolveCompactionSettings(runLayer, globalCompactionLayer());
}
