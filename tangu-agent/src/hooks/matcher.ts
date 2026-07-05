/**
 * Matcher DSL（端口 codex-rs/hooks common.rs）：
 *   空 / "*"                 → 全匹配
 *   纯 [A-Za-z0-9_|]         → 精确匹配，支持 `A|B` 或（避免 `Edit` 当正则误伤 `CodeEditor`）
 *   其它                     → 正则（如 `mcp__.*`）
 * UserPromptSubmit / Stop 恒运行（忽略 matcher，见 runner.ts）。
 */
const PURE = /^[A-Za-z0-9_|]+$/;

/** 校验 matcher 模式；返回错误信息或 null（合法）。 */
export function validateMatcherPattern(pattern: string): string | null {
  const p = (pattern ?? '').trim();
  if (!p || p === '*') return null;
  if (PURE.test(p)) return null;
  try {
    // eslint-disable-next-line no-new
    new RegExp(p);
    return null;
  } catch (e: any) {
    return e?.message || 'invalid regex';
  }
}

/** matcher 是否匹配 target（工具名 / source / agent_type）。空/`*` 恒真；非法正则视为不匹配。 */
export function matcherMatches(matcher: string | undefined, target: string): boolean {
  const m = (matcher ?? '').trim();
  if (!m || m === '*') return true;
  if (PURE.test(m)) return m.split('|').some((p) => p === target);
  try {
    return new RegExp(m).test(target);
  } catch {
    return false;
  }
}
