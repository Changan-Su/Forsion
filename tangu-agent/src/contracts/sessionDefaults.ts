/**
 * 新会话的起步配置(纯函数):审批 / 思考档的缺省与记忆、chat 预设的物化、笔记库并入可写根。
 * 界面热更新 3c 从 Tangu 的 store 半身(desktop tanguSlice.ts)原样挪来,宿主(文档任务、图像工作室、插件聊天、ctx.tangu 探针)
 * 与 Tangu 同引这一份,不再经 appStore 转出口。只依赖同目录的 clientTypes。
 */
import type { AgentConfig, StoredDesktopConfig } from './clientTypes.js'

/** 审批档缺省(全端统一「替我批准」);新会话没有记忆时的起步值。 */
export const DEFAULT_APPROVAL = 'auto-edit' as const
/** 思考档缺省(全端、两种模式统一「中」,09-19 用户拍板):与引擎的会话缺省(agentLoop `|| 'medium'`)、内置 Agent 预设同值。
 *  从前 chat 缺省 off(方案 D36 为首字延迟定的);现在 chat 也起步于中,想要更快的人在药丸上调低即可,调过的值按槽记住。 */
export const DEFAULT_THINKING = 'medium' as const
/** 新会话的起步档位 = 上次用的那套(没记忆过就用全端默认「替我批准」+ 不指定思考档)。
 *  只吐 AgentConfig 的键,好让调用方直接展开进 init;模型不在此(走 cfg.modelId 老路)。
 *  **云沙箱会话不带审批档**:引擎那边 approvalMode 缺席才等于 full-auto,写死 auto-edit 会让
 *  云会话的 MCP 调用开始逐个弹审批(gateToolCall 对 mcp__ 工具非 host 也过闸)。 */
export function stickyDefaults(dc: StoredDesktopConfig | null, host: boolean, preset?: AgentConfig['preset']): Pick<AgentConfig, 'approvalMode' | 'thinkingLevel' | 'ultra'> {
  const out: Pick<AgentConfig, 'approvalMode' | 'thinkingLevel' | 'ultra'> = {}
  if (host) out.approvalMode = dc?.lastApprovalMode || DEFAULT_APPROVAL
  // 思考档按 preset **分槽**(D36):chat 只读 chat 槽、缺省 DEFAULT_THINKING(dc 为 null 的 web/mobile 同);work 沿用 lastThinkingLevel,
  // 没记过就不指定 —— 交给 Agent 自己的档位,再回落引擎的会话缺省(都是中)。
  if (preset === 'chat') out.thinkingLevel = dc?.lastChatThinkingLevel || DEFAULT_THINKING
  else if (dc?.lastThinkingLevel) out.thinkingLevel = dc.lastThinkingLevel
  // Ultra 只延续到本机 work 会话(delegate 只在本机引擎有;云端 / chat 会话带上它药丸也显示不出来),且只跟 max 同在。
  if (host && preset !== 'chat' && dc?.lastUltra && out.thinkingLevel === 'max') out.ultra = true
  return out
}

/** 模式感知的配置物化(**唯一一处**,四个建会话/空态点都走它,放在 `...newChatCfg` 之后):chat 会话恒 sandbox、无 cwd,
 *  不带自选 Agent/外部引擎/计划/群聊——Chat 固定使用创建时的当前默认 Agent；草稿残留的 engineId 会让
 *  「chat」跑 ACP 外部 CLI 直打真实磁盘(creview 09-07 F1/E1);
 *  草稿里 work 下改出的 execMode:'host' 也压不过它(F6)。work 原样返回。 */
export function applyPreset(cfg: AgentConfig, preset: 'chat' | undefined): AgentConfig {
  if (preset !== 'chat') return cfg
  return { ...cfg, preset: 'chat', execMode: 'sandbox', cwd: undefined, agentSlug: undefined, engineId: undefined, engineModelId: undefined, planMode: undefined, groupChat: undefined, groupAgents: undefined, ultra: undefined }
}

/** 活动 Amadeus Vault 是 Forsion 的系统工作区:本机会话默认把它并入额外可写根。
 *  cwd 仍是相对路径基准;同根/重复项不再列,并保留用户手工添加根的顺序。 */
export function withAmadeusWorkspace(config: AgentConfig, vaultRoot: string | null | undefined): AgentConfig {
  if (config.execMode !== 'host' || !vaultRoot || vaultRoot === config.cwd) return config
  const roots = config.extraRoots || []
  if (roots.includes(vaultRoot)) return config
  return { ...config, extraRoots: [...roots, vaultRoot] }
}
