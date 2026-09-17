/**
 * 会话激活的 Normal Agent 人格解析(从 agentLoop.runLoop 抽出,以便对**云端 worker 路径**做单测)。
 *
 * 解析顺序:本地 FS(`getAgent`)→ 命中即用;未命中且有 `brain.agents`(云端 worker:本地 agents 目录为空)
 * → 从云端 tangu_agent_files 读 config.toml+SOUL.md 组装人格。把 def 里「会话未显式覆盖」的字段并入
 * agentConfig(就地修改,会话值优先),返回记忆/日志作用域 slug。无 agentSlug / 两路都未命中 / 出错 → 默认。
 */
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { agentCapOf, builtinAgentDef, resolveActiveSlug, resolveMemorySlug, upgradeAriosoPersona, type NormalAgentDef } from '../agents/agentRegistry.js';

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
      // 内置预设兜底(与 cloudAgentStore 列表的虚拟条目同源):web Picker 选的预设不落库,
      // 云端 tangu_agent_files 里没有它 → 用内置定义注入人格。仅云端形态(有 agentsBrain)兜底,
      // 本地删过的 agent 保持今天的降级行为。
      if (!def) def = builtinAgentDef(String(agentConfig.agentSlug));
    }
    if (def) {
      // 云端 Brain 直接读存储,绕过 cloudAgentStore;原装人格升级必须与列表展示同源。
      def = upgradeAriosoPersona(def);
      activeAgentSlug = resolveActiveSlug(agentConfig.agentSlug);
      memScopeSlug = resolveMemorySlug(def);
      if (!agentConfig.systemPrompt && def.systemPrompt) agentConfig.systemPrompt = def.systemPrompt;
      if (!agentConfig.soul && def.soul) agentConfig.soul = def.soul;
      if (!agentConfig.libraryOrder && def.libraryOrder?.length) agentConfig.libraryOrder = def.libraryOrder;
      // Agent 级轮数下限:低于下限视为误设(一个写了 3 的 agent 每回合两次工具调用就被迫收尾,09-13 用户导出实证),
      // 忽略并回落默认,告警点名文件与值,让人能在设置里看见并改掉。会话级 /loop 不套下限(那是显式意图)。
      if (agentConfig.maxIterations == null) {
        const cap = agentCapOf(def); // 低于下限 → null + 告警(同一函数也服务 groupChat / automation)
        if (cap != null) agentConfig.maxIterations = cap;
      }
      if (!agentConfig.thinkingLevel && def.thinkingLevel) agentConfig.thinkingLevel = def.thinkingLevel;
      if (!agentConfig.approvalMode && def.approvalMode) agentConfig.approvalMode = def.approvalMode;
      if ((!agentConfig.enabledToolIds || !agentConfig.enabledToolIds.length) && def.tools.length) {
        agentConfig.enabledToolIds = def.tools;
      }
      const legacyEmptySkills = Array.isArray(agentConfig.enabledSkillIds) && !agentConfig.enabledSkillIds.length && agentConfig.skillsConfigured !== true;
      if ((agentConfig.enabledSkillIds == null || legacyEmptySkills) && def.enabledSkillIds) {
        agentConfig.enabledSkillIds = def.enabledSkillIds;
        agentConfig.skillsConfigured = true;
      }
      if (agentConfig.enabledMcpServers == null && def.enabledMcpServers) agentConfig.enabledMcpServers = def.enabledMcpServers;
      if (agentConfig.activityAccess == null && def.activityAccess) agentConfig.activityAccess = true;
      if (agentConfig.toolsMode == null && def.toolsMode) {
        agentConfig.toolsMode = def.toolsMode;
        agentConfig.toolsList = def.toolsList || [];
      }
      // 压缩旋钮:会话级显式值优先,否则 Agent config.toml 的 [compaction] 表(run 级层,压过 config.json)。
      if (agentConfig.compaction == null && def.compaction) agentConfig.compaction = def.compaction;
    }
  } catch {
    /* 加载失败不阻断 run */
  }
  return { activeAgentSlug, memScopeSlug };
}
