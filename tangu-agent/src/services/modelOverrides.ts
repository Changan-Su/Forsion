/**
 * 用户侧的 per-model 覆盖(config.json `modelOverrides` 段)—— 对标 pi 的 `modelOverrides` /
 * Codex 的 `model_context_window`:托管模型的窗口由 admin 填、直连模型没人填,用户在本机都能改。
 *
 *   { "modelOverrides": { "<modelId>": { "contextWindow": 272000 } } }
 *
 * key = 引擎里用的模型 id(托管=目录 id 如 `pr-…`;直连=`<providerId>/<model>`),与 /agent/models 下发的一致。
 * 段名不叫 `models`:那段已被桌面的辅助模型槽(models.background / vision / visionMode)占用。
 * 读取每次走 config.json(几 KB 的同步读;调用点是 run 开头与模型列表,不值得加缓存);
 * 写入经 saveSection(config.json 唯一写入口,坏 JSON 拒写)。env `TANGU_MODEL_CONTEXT_WINDOWS` 仍压过本段(运维逃生口)。
 * ponytail: 目前只有 contextWindow 一个字段,清窗口=删条目;加 maxTokens / 思考档映射时改成按字段合并。
 */
import { getRawSection, saveSection } from '../core/config.js';

export interface ModelOverride { contextWindow?: number }

/** 与 contextBudget 同一下限:比 4k 小的不像窗口(多半是把 K 当 token 填了)。 */
export const MIN_OVERRIDE_TOKENS = 4_000;

/** 单测:只在内存里读写,绝不碰真家目录(否则跑一次测试就读到开发机自己的 config.json)。 */
let memory: Record<string, ModelOverride> | null = null;

function sanitize(raw: unknown): Record<string, ModelOverride> {
  const out: Record<string, ModelOverride> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, any>)) {
    const win = Number(v?.contextWindow);
    if (Number.isFinite(win) && win >= MIN_OVERRIDE_TOKENS) out[id] = { contextWindow: Math.floor(win) };
  }
  return out;
}

/** 当前全部覆盖(脏条目已滤掉)。 */
export function modelOverrides(): Record<string, ModelOverride> {
  return sanitize(memory ?? getRawSection('modelOverrides'));
}

/** 设 / 清某模型的上下文窗口(tokens;null = 清除,交还自动识别)。返回写后的整段。 */
export function setModelContextWindow(modelId: string, tokens: number | null): Record<string, ModelOverride> {
  const id = String(modelId || '').trim();
  if (!id) throw new Error('modelId required');
  const next = { ...modelOverrides() };
  if (tokens == null) delete next[id];
  else {
    if (!Number.isFinite(tokens) || tokens < MIN_OVERRIDE_TOKENS) throw new Error(`contextWindow is in tokens: minimum ${MIN_OVERRIDE_TOKENS} (for 272K enter 272000)`);
    next[id] = { ...next[id], contextWindow: Math.floor(tokens) };
  }
  if (memory) memory = next;
  else saveSection('modelOverrides', next);
  return next;
}

export function resetModelOverridesForTest(seed?: Record<string, ModelOverride>): void {
  memory = seed ? { ...seed } : {};
}
