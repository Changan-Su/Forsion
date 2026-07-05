/**
 * 每-run 累计成本硬上限(2026-06-10 「77 万 token 烧百万点」事故的持久护栏)。
 *
 * contextBudget 的入站闸门只挡**单条**入站消息;本模块挡**多轮累计**——run 内逐轮累加
 * calculateCost 得到的扣费点数,越过上限即让 run 以 run_cost_exceeded 失败,防止失控的
 * 工具循环(或重试风暴)把用户额度烧穿。纯函数,便于单测,不依赖 deps。
 *
 * TANGU_MAX_RUN_COST(点):默认 20000(远高于事故的 ~3853,但能截住 10× 级失控);设 0(或负)关闭。
 */
const DEFAULT_MAX_RUN_COST = 20_000;

/** 读取每-run 成本上限(点);返回 <=0 表示关闭。环境变量 TANGU_MAX_RUN_COST 可调。 */
export function runCostCeiling(): number {
  const v = Number(process.env.TANGU_MAX_RUN_COST);
  if (!Number.isFinite(v)) return DEFAULT_MAX_RUN_COST;
  return v < 0 ? 0 : Math.floor(v);
}

/** 累计成本是否越过上限(ceiling<=0 表示关闭 → 恒 false)。 */
export function isOverRunCost(costTotal: number, ceiling: number): boolean {
  return ceiling > 0 && costTotal > ceiling;
}
