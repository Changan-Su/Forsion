/**
 * Agent 的「由谁来跑」(11-14,DSH 融合底层第 2 步):Agent 定义里的 `engine`,缺席 = Tangu 自己的循环。
 * 引擎与桌面共用的这一小块(纯数据,不碰 fs):哪些外部引擎能当名册里 Agent 的 harness、给人看的名字、引擎报错的码。
 *
 * 在名册里有了 Agent 形态的引擎(今天只有 DSH),新对话选择器的「外部引擎」分组和左栏的引擎行就不再单列它 ——
 * 它出现在 Agent 那边(自带的那个叫 DSH)。老的引擎会话 / 引擎私聊照旧能打开、能接着聊。
 */

/** 名册里能「由谁来跑」的外部引擎。Claude Code / Codex 排在 DSH 之后,还不在这里。 */
export const AGENT_ENGINE_IDS: readonly string[] = ['dsh']

export function isKnownAgentEngine(engine: string): boolean {
  return AGENT_ENGINE_IDS.includes(engine)
}

/** 行尾小标和报错里给人看的引擎名(短名,不进 i18n:产品名)。不认识的引擎原样显示 id。 */
export function agentEngineLabel(engine: string): string {
  return engine === 'dsh' ? 'DSH' : engine
}

/**
 * 跑在外部引擎上的 Agent 的对话没跑起来时,引擎发的错误码(error 字段 = `<码>:<引擎 id>`,后面可能跟英文说明)。
 *   remote        —— 从远程设备(手机 / 网页 / 别的电脑)发来的:外部引擎只在装了它的那台电脑上跑
 *   not_installed —— 这台电脑上没装
 *   unsupported   —— 定义里的引擎本版本不认识(新版本写的)
 *   chat_preset   —— 仅聊天模式的对话里不交给外部引擎
 *   elsewhere     —— 走进了还没接的路(团队、讨论、委派、自动化、通道),不替它答
 */
export const AGENT_ENGINE_ERROR_CODES = ['remote', 'not_installed', 'unsupported', 'chat_preset', 'elsewhere'] as const
export type AgentEngineErrorCode = (typeof AGENT_ENGINE_ERROR_CODES)[number]

/** 从一条运行错误里认出上面的码;不是就回 null。 */
export function parseAgentEngineError(raw: string | undefined): { code: AgentEngineErrorCode; engine: string } | null {
  const m = /agent_engine_(remote|not_installed|unsupported|chat_preset|elsewhere):([a-z0-9][a-z0-9._-]{0,63})/i.exec(raw || '')
  return m ? { code: m[1].toLowerCase() as AgentEngineErrorCode, engine: m[2] } : null
}

/**
 * 交给外部引擎的 Computer Use 没跑(这一轮的模型看不见图,或说不清看不看得见,2026-11-16):回给模型的英文原话。
 * 工具桥(engines/toolServer.ts)写它、卡片(ToolGroup)认它 —— 那一行按界面语言写原因,模型收到的照旧是这句英文。
 * 改措辞只改这里,两边跟着变;落库的也是这句,重开对话照样认得。
 */
export function computerUseUnavailableText(why: 'no-image-input' | 'unknown'): string {
  const cause = why === 'no-image-input'
    ? 'because the model you are running on has no image input'
    : 'because Forsion could not confirm that the model you are running on can see images'
  return `${CU_UNAVAILABLE_HEAD} ${cause}, so this call was not run. `
    + 'This is not a missing plugin or permission, and enabling anything will not help. '
    + 'When the user asks for it, do not just report that the tool failed: tell them plainly that computer control needs a model that can see images, and that they can pick one for this agent.'
}
const CU_UNAVAILABLE_HEAD = 'Computer control (looking at the screen, clicking and typing in desktop apps) is unavailable'
/** 从一条工具结果里认出上面那句;不是就回 null。 */
export function parseComputerUseUnavailable(raw: string | undefined): 'no-image-input' | 'unknown' | null {
  const text = raw || ''
  if (!text.startsWith(CU_UNAVAILABLE_HEAD)) return null
  return text.startsWith(`${CU_UNAVAILABLE_HEAD} because the model you are running on has no image input`) ? 'no-image-input' : 'unknown'
}
