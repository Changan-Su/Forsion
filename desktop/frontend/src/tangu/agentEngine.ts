/**
 * Agent 的「由谁来跑」(11-14,DSH 融合底层第 2 步)在界面上的那一半:名册 / 选择器的行尾小标、配置页的 Harness 卡、
 * 输入框在跑不了的地方写明原因、引擎报错的中英文。引擎那一半在 tangu-agent(agentRegistry 的 engine 字段、agentLoop 的分流)。
 *
 * 能不能在这台设备上跑,按本机引擎清单判(appStore.engines,来自 homeTarget 的 GET /agent/engines):
 *   - 清单里有这个引擎、不是「未安装」→ ready(需登录也算:DSH 自己会把原因说出来);
 *   - 清单里有、但「未安装」→ not-installed(给「怎么安装」,去设置 › 本机 Agent CLI 看那行安装命令);
 *   - 清单里没有 → elsewhere:手机、网页、连着别的设备时清单是空的,外部引擎只在装了它的那台电脑上跑;
 *   - 定义里的引擎本版本不认识 → unsupported。
 */
import { registerMessages } from '../i18n'
import { agentEngineLabel, isKnownAgentEngine, parseAgentEngineError, AGENT_ENGINE_IDS } from '../../../../tangu-agent/src/contracts/agentEngine'

export { agentEngineLabel, AGENT_ENGINE_IDS }

registerMessages({
  'agentEngine.harness': { zh: 'Harness', en: 'Harness' },
  'agentEngine.runsOn': { zh: '运行在', en: 'Runs on' },
  'agentEngine.harnessHint': { zh: '人设、记忆、技能都留在 Forsion，换来换去都在，旧对话照常能看。换到 {name} 后，新一轮从头开始，不带之前的上文；换回 Tangu，它会接着读这场对话。', en: 'Persona, memory and skills stay in Forsion whichever harness you pick, and earlier chats stay readable. After switching to {name}, the next turn starts fresh without the earlier context; Tangu reads the whole chat when you switch back.' },
  'agentEngine.handoff': { zh: '每一轮把这个 Agent 的人设、协作说明、记忆、技能、勾选的 MCP 和 Forsion 的工具交给 {name}，记忆和日志记在它名下。Forsion 的工具照它的审批档来问，卡片画在 Forsion 里；读写文件、跑命令用 {name} 自带的。', en: "Each turn, this agent's persona, collaboration notes, memory, skills, chosen MCP servers and Forsion tools are handed to {name}, and its memory and logs stay under this agent. Forsion tools follow its approval mode and show their cards in Forsion; {name} reads and writes files and runs commands with its own tools." },
  'agentEngine.handoffLimits': { zh: '还交不过去的：浏览器、电脑和手机控制，定时和自动化，团队和 @。', en: 'Not handed over yet: browser, computer and phone control, schedules and automations, teams and @ mentions.' },
  'agentEngine.notInstalled': { zh: '未安装', en: 'Not installed' },
  'agentEngine.notInstalledHint': { zh: '这台电脑上没检测到 {name}。装好后就能用，安装命令在设置 › 本机 Agent CLI。', en: '{name} was not found on this computer. Install it to use this agent; the install command is in Settings › Local agent CLIs.' },
  'agentEngine.howToInstall': { zh: '怎么安装', en: 'How to install' },
  'agentEngine.elsewhereHint': { zh: '这个 Agent 由 {name} 运行，只能在装了 {name} 的电脑上对话。', en: 'This agent runs on {name}, so you can only chat with it on the computer where {name} is installed.' },
  'agentEngine.unsupportedHint': { zh: '这个 Agent 设成了由「{name}」运行，当前版本的 Forsion 跑不了它。', en: 'This agent is set to run on "{name}", which this version of Forsion cannot run.' },
  'agentEngine.selfManaged': { zh: '由 {name} 自己管', en: 'Managed by {name}' },
  'agentEngine.modelHint': { zh: '{name} 自己的模型；对话里另选的优先。', en: '{name} models. A model picked in the chat takes priority.' },
  'agentEngine.engineDefault': { zh: '跟随 {name} 的默认', en: '{name} default' },
  // 输入框禁用时的占位句(发不出去时写明为什么)
  'agentEngine.composerElsewhere': { zh: '只能在电脑上用：这个 Agent 由 {name} 运行', en: 'Computer only: this agent runs on {name}' },
  'agentEngine.composerNotInstalled': { zh: '{name} 没装在这台电脑上，安装命令在设置 › 本机 Agent CLI', en: '{name} is not installed on this computer. See Settings › Local agent CLIs' },
  'agentEngine.composerUnsupported': { zh: '这个 Agent 由「{name}」运行，当前版本跑不了', en: 'This agent runs on "{name}", which this version cannot run' },
  // 引擎发回的错误码(contracts/agentEngine.ts),EditorialMessage.humanizeRunError 用
  'chat.err.agentEngine.remote': { zh: '这个 Agent 由 {name} 运行，只能在装了它的那台电脑上用。回到那台电脑上接着聊', en: 'This agent runs on {name} and only works on the computer where it is installed. Continue this chat there' },
  'chat.err.agentEngine.not_installed': { zh: '这台电脑上没装 {name}，这个 Agent 跑不起来。安装命令在设置 › 本机 Agent CLI', en: '{name} is not installed on this computer, so this agent cannot run. See Settings › Local agent CLIs for the install command' },
  'chat.err.agentEngine.unsupported': { zh: '这个 Agent 设成了由「{name}」运行，当前版本的 Forsion 跑不了它', en: 'This agent is set to run on "{name}", which this version of Forsion cannot run' },
  'chat.err.agentEngine.chat_preset': { zh: '这个 Agent 由 {name} 运行，仅聊天模式的对话里用不了', en: 'This agent runs on {name}, which is not available in chat-only conversations' },
  'chat.err.agentEngine.elsewhere': { zh: '这个 Agent 由 {name} 运行，暂时只能在它自己的对话里用；团队、讨论、委派、自动化和通道还用不了它', en: 'This agent runs on {name}. For now it only works in its own chats; teams, discussions, delegation, automations and channels cannot use it yet' },
})

export type AgentEngineState = 'ready' | 'not-installed' | 'elsewhere' | 'unsupported'

type EngineRow = { id: string; status?: 'available' | 'needs-signin' | 'not-installed' }

/** 这个 Agent 由谁来跑:'' = Tangu。 */
export function agentEngineOf(def: { engine?: string } | null | undefined): string {
  return typeof def?.engine === 'string' ? def.engine.trim() : ''
}

/** 名册里有 Agent 形态的引擎(今天只有 DSH):新对话选择器的「外部引擎」分组、左栏的引擎行不再单列它。 */
export function isRosterEngine(engineId: string): boolean {
  return AGENT_ENGINE_IDS.includes(engineId)
}

/** 这台设备上能不能跑这个引擎(见文件头)。engine 为空(Tangu)恒 ready。 */
export function agentEngineState(engine: string, engines: readonly EngineRow[]): AgentEngineState {
  if (!engine) return 'ready'
  if (!isKnownAgentEngine(engine)) return 'unsupported'
  const row = engines.find((e) => e.id === engine)
  if (!row) return 'elsewhere'
  return row.status === 'not-installed' ? 'not-installed' : 'ready'
}

/** 输入框禁用时写什么(ready → null)。 */
export function agentEnginePlaceholder(engine: string, state: AgentEngineState, t: (k: string, v?: Record<string, unknown>) => string): string | null {
  const name = agentEngineLabel(engine)
  if (state === 'elsewhere') return t('agentEngine.composerElsewhere', { name })
  if (state === 'not-installed') return t('agentEngine.composerNotInstalled', { name })
  if (state === 'unsupported') return t('agentEngine.composerUnsupported', { name })
  return null
}

/** 引擎报回来的 agent_engine_* 错误 → 一句人话(认不出回 null)。 */
export function agentEngineErrorText(raw: string | undefined, t: (k: string, v?: Record<string, unknown>) => string): string | null {
  const hit = parseAgentEngineError(raw)
  return hit ? t(`chat.err.agentEngine.${hit.code}`, { name: agentEngineLabel(hit.engine) }) : null
}
