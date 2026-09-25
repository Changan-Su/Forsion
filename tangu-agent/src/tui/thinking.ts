/** TUI 的思考档小工具:Shift+Tab 循环、/think 参数解析。纯函数,单测见 tui.commands.test.ts。 */
import { THINKING_LEVELS, normalizeThinkingLevel, type ThinkingLevel } from '../llm/modelCapabilities.js';

/**
 * Shift+Tab 的下一档(PI 口径):只在当前模型支持的档里转,转到头回到第一档。
 * 目录没给档位表(模型不在目录 / 老后端)→ 按全部 7 档转。
 * 当前档本身不被支持(比如换模型后)→ 跳到它之后第一个被支持的档,没有就回到第一档。
 */
export function nextThinkingLevel(current: ThinkingLevel, supported: readonly ThinkingLevel[] | undefined): ThinkingLevel {
  const order = supported?.length ? THINKING_LEVELS.filter((l) => supported.includes(l)) : [...THINKING_LEVELS];
  if (!order.length) return current;
  const at = order.indexOf(current);
  if (at >= 0) return order[(at + 1) % order.length];
  const rank = THINKING_LEVELS.indexOf(current);
  return order.find((l) => THINKING_LEVELS.indexOf(l) > rank) ?? order[0];
}

/**
 * /think 的参数 → 档位;认不得返回 null。别名同引擎归一(none → off、ultra → max …):
 * 两个不同兜底值归一出同一档 = 认得这个写法,否则 normalizeThinkingLevel 会静默落到兜底档。
 */
export function parseThinkingArg(raw: string): ThinkingLevel | null {
  const s = raw.trim();
  if (!s) return null;
  const a = normalizeThinkingLevel(s, 'off');
  return a === normalizeThinkingLevel(s, 'max') ? a : null;
}
