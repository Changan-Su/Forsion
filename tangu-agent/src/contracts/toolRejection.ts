/**
 * 用户拒绝了一次工具调用时,引擎回给模型的那句话(模型面,落库的也是这句)。
 * 引擎三处写它(approvals 的回落文案 / 托盘挂起后被拒 / 外部引擎的工具桥),桌面的过程行认它 ——
 * 折叠头把「你自己拒绝的」写成「已拒绝 N」,不当成失败挂红叉。重开对话后只剩这句话,所以认句子,不认审批卡状态。
 * 改措辞只改这里,两边跟着变(改了会改模型读到的字节,AI 行为改动照规矩过 live 台架)。
 * 规则 / hook / 无人值守 / 中止等各自带 rejectReason 的拒绝不在这里:那些不是「你拒绝的」,照旧算失败。
 */

/** 用户在审批卡 / 通道里点了拒绝(决定体不带 rejectReason)。 */
export const USER_REJECT_REASON =
  'The user rejected this tool call, so it was NOT run. Do not retry the same call; ask the user how to proceed or continue with other work.'
/** 托盘挂起的调用被用户拒绝(agentLoop 兑现挂起调用那条路的回落;旧文案,模型读到的字节保持不变)。 */
export const PARKED_USER_REJECT_REASON = '用户拒绝了该操作。'
/** 外部引擎经工具桥(engines/toolServer)调用、被用户拒绝。 */
export const BRIDGE_USER_REJECT_REASON = 'The user denied this tool call.'

const USER_REJECT_TEXTS: ReadonlySet<string> = new Set([USER_REJECT_REASON, PARKED_USER_REJECT_REASON, BRIDGE_USER_REJECT_REASON])

/** 这条工具结果是不是「用户拒绝了」那句(整句全等;前后空白不计)。 */
export function isUserRejectedToolResult(raw: string | undefined): boolean {
  return !!raw && USER_REJECT_TEXTS.has(raw.trim())
}
