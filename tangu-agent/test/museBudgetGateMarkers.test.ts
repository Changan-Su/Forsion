/**
 * live 台架的 Muse 预算闸读数:钉「muse.ts 打的闸日志」与「live-harness 的 BLOCK_MARKS」两边措辞对齐。
 * 起因:blocked() 原来只 grep `token 预算用尽`,而毛量闸打的是 `毛 prompt 预算用尽` —— 两串互不为子串,
 * 于是毛量闸挡住时台架把结果写成「420s 未起」,live 读数把「被预算挡住」误判成「周期起不来」。
 *
 * 为什么读源码文本而不是 import:scripts/live-harness.mjs 顶层就 spawn 引擎 / process.exit(dist 缺失),
 * import 一下就是把真台架跑起来(本仓也明令单测不许跑 live)。
 *
 * 双向都钉,少一向就还会退回「仪器自己坏了没人知道」:
 *   ① muse 那段里**每条**闸日志都有 marker 覆盖 —— 漏一道 = 误报回归(本轮起因);
 *   ② **每个** marker 都还能在 muse.ts 里逐字找到 —— 措辞改了而 marker 没跟 = 死 grep(和早先那个
 *      永远零命中的 `token 已计` 正则同类:台架照样"绿",只是什么都没在看)。
 *
 * 跑:cd Forsion-Genesis/tangu-agent && npx vitest run test/museBudgetGateMarkers.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MUSE = read('../src/services/muse.ts');
const HARNESS = read('../scripts/live-harness.mjs');

/**
 * muse.ts 的 `if (cfg.maxTokensPerWindow > 0) { … }` 那一段(两道 token 预算闸),到重启闸为止。
 * ponytail: 只覆盖这一段;重启闸(`本窗口预算用尽`)不算 token 预算,台架配 maxRestartsPerWindow=3
 * 也不可能在周期 2 之前触发 —— 台架那侧同理不收它。
 */
const budgetBlock = (): string => {
  const start = MUSE.indexOf('if (cfg.maxTokensPerWindow > 0) {');
  const end = MUSE.indexOf('if (restartsThisWindow >=', start + 1);
  expect(start, 'muse.ts 的 token 预算闸结构变了:锚点 `if (cfg.maxTokensPerWindow > 0) {` 没找到').toBeGreaterThanOrEqual(0);
  expect(end, 'muse.ts 的重启闸锚点 `if (restartsThisWindow >=` 没找到(或跑到了预算闸前面)').toBeGreaterThan(start);
  return MUSE.slice(start, end);
};

/** 闸日志的静态前缀:log(`毛 prompt 预算用尽(近 ${…}` → 取到第一个 ${ 为止。 */
const gatePhrases = (): string[] => [...budgetBlock().matchAll(/log\(`([^`$]+)/g)].map((m) => m[1]);

/** live-harness 里 blocked() 用的 marker 表(源码文本解析,理由见文件头)。 */
const blockMarks = (): string[] => {
  const m = HARNESS.match(/const BLOCK_MARKS = \[([^\]]+)\]/);
  expect(m, 'live-harness.mjs 里找不到 `const BLOCK_MARKS = [...]`(改了写法就同步改这里)').toBeTruthy();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

/** 某组 marker 能认出哪几条闸日志。 */
const covered = (marks: string[]): string[] => gatePhrases().filter((p) => marks.some((m) => p.includes(m)));

describe('live 台架 muse 预算闸 marker', () => {
  it('muse 的两道 token 预算闸,台架的 blocked() 都认得', () => {
    const phrases = gatePhrases();
    expect(phrases).toHaveLength(2); // 这段里再加一道闸 → 这里先红,而不是静默漏检
    expect(covered(blockMarks())).toEqual(phrases);
  });

  it('BLOCK_MARKS 里没有死 grep:每个 marker 都还能在 muse.ts 里逐字找到', () => {
    const marks = blockMarks();
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(MUSE.includes(m), `marker「${m}」在 muse.ts 里已经找不到了`).toBe(true);
  });

  it('负对照:只留旧的单个 marker,毛量闸那条就漏检(证明第二个 marker 不是装饰)', () => {
    const LEGACY = ['token 预算用尽'];
    expect(covered(LEGACY)).toHaveLength(1);          // 旧写法只盖住计费闸
    expect(covered(blockMarks())).toHaveLength(2);    // 现写法两道都盖住
    const gross = gatePhrases().find((p) => !p.includes(LEGACY[0]))!;
    expect(gross.includes(LEGACY[0])).toBe(false);    // 两串互不为子串,一句 grep 盖不住两道闸
  });
});
