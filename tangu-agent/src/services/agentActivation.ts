/**
 * 会话激活的 Normal Agent 人格解析(从 agentLoop.runLoop 抽出,以便对**云端 worker 路径**做单测)。
 *
 * 解析顺序:本地 FS(`getAgent`)→ 命中即用;未命中且有 `brain.agents`(云端 worker:本地 agents 目录为空)
 * → 从云端 tangu_agent_files 读 config.toml+SOUL.md 组装人格。把 def 里「会话未显式覆盖」的字段并入
 * agentConfig(就地修改,会话值优先),返回记忆/日志作用域 slug。无 agentSlug / 两路都未命中 / 出错 → 默认。
 */
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { resolveActiveSlug, resolveMemorySlug, type NormalAgentDef } from '../agents/agentRegistry.js';

export interface AgentActivation {
  /** 人格 slug(start_discussion 分身、prompt section、Library 取用据此)。 */
  activeAgentSlug: string;
  /** 记忆/日志作用域 slug(shareDefaultMemory → DEFAULT,否则该 agent 自己)。 */
  memScopeSlug: string;
}

export interface AgentsBrainLike {
  getAgent(userId: string, slug: string): Promise<NormalAgentDef | null>;
}

/**
 * 解析并就地并入人格字段。`localGet`=本地 FS 读(standalone/TUI/desktop),`agentsBrain`=云端兜底(worker)。
 * 依赖注入便于测试:云端 worker 用「localGet 恒 null + agentsBrain 命中」复现。
 */
export async function applyAgentActivation(
  agentConfig: any,
  userId: string,
  localGet: (slug: string) => Promise<NormalAgentDef | null>,
  agentsBrain?: AgentsBrainLike | null,
): Promise<AgentActivation> {
  let activeAgentSlug = DEFAULT_AGENT_SLUG;
  let memScopeSlug = DEFAULT_AGENT_SLUG;
  if (!agentConfig || !agentConfig.agentSlug) return { activeAgentSlug, memScopeSlug };
  try {
    let def = await localGet(String(agentConfig.agentSlug));
    // 云端运行水合:worker 的 ~/.tangu/agents 是空的 → 从云端读人格。软失败 → null,回落默认行为。
    if (!def && agentsBrain) {
      def = await agentsBrain.getAgent(userId, String(agentConfig.agentSlug)).catch(() => null);
    }
    if (def) {
      activeAgentSlug = resolveActiveSlug(agentConfig.agentSlug);
      memScopeSlug = resolveMemorySlug(def);
      if (!agentConfig.systemPrompt && def.systemPrompt) agentConfig.systemPrompt = def.systemPrompt;
      if (!agentConfig.soul && def.soul) agentConfig.soul = def.soul;
      if (!agentConfig.libraryOrder && def.libraryOrder?.length) agentConfig.libraryOrder = def.libraryOrder;
      if (agentConfig.maxIterations == null && def.maxIterations != null) agentConfig.maxIterations = def.maxIterations;
      if (!agentConfig.thinkingLevel && def.thinkingLevel) agentConfig.thinkingLevel = def.thinkingLevel;
      if (!agentConfig.approvalMode && def.approvalMode) agentConfig.approvalMode = def.approvalMode;
      if ((!agentConfig.enabledToolIds || !agentConfig.enabledToolIds.length) && def.tools.length) {
        agentConfig.enabledToolIds = def.tools;
      }
      if (agentConfig.activityAccess == null && def.activityAccess) agentConfig.activityAccess = true;
      if (agentConfig.toolsMode == null && def.toolsMode) {
        agentConfig.toolsMode = def.toolsMode;
        agentConfig.toolsList = def.toolsList || [];
      }
    }
  } catch {
    /* 加载失败不阻断 run */
  }
  return { activeAgentSlug, memScopeSlug };
}
