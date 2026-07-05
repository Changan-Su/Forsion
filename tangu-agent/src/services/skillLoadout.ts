/**
 * 启用技能的装载（渐进式披露，对齐客户端 use_skill 机制；从 agentLoop 原样抽出）：
 *   ① system prompt 只放「名称 + 描述（触发契约）」目录——绝不全量注入 SKILL.md。
 *      大体量技能（pptx/docx 各 10 万+字）若每轮全量注入，单次调用就 10 万+ tokens，
 *      正是云端 token 暴涨的根因。
 *   ② 全文物化到 <appId>/.agent/skills/<id>/SKILL.md（云空间规范 + run_python 可读）。
 *   ③ 模型按需用 use_skill 工具加载某技能完整说明，只在相关时付费、且只付一次。
 */
import { deps } from '../seams/runtime.js';
import { materializeSkill } from '../tools/fileWorkspace.js';

const getSkill = (id: string) => deps().brain.assets.getSkill(id);

// 小体量技能(行为指令)直接内联进 prompt（始终生效）；大体量技能(参考文档，如 pptx/docx
// 各 10 万+字)只放目录、经 use_skill 按需加载——避免每轮全量注入导致 token 暴涨。
const INLINE_SKILL_MAX_CHARS = 8000;

export interface SkillLoadout {
  enabledSkillIds: string[];
  /** 进 system prompt 的技能段（0-2 段：Skill Instructions / Available Skills，构建文本与原内联逐字节一致）。 */
  sections: string[];
  /**
   * 本轮 /skill 点名的技能（指针，**不内联正文进 system**）：调用方据此在「尾部 user 消息」拼
   * 「先 use_skill」强指令,正文由 use_skill 按需取回、落对话尾部。参考 Hermes 的「指针+按需加载」——
   * 每条 /skill 都不改 system 前缀字节,前缀缓存照常命中(对比旧做法:正文进 system,/skill 轮整段前缀 miss)。
   */
  requested: Array<{ id: string; name: string; description: string }>;
}

export async function loadSkillLoadout(
  userId: string,
  appId: string,
  agentConfig: any,
): Promise<SkillLoadout> {
  // 显式技能集须为「非空数组」才算数:空数组([])按「未配置」处理,避免某轮 agentConfig 漏带或传空
  // 列表时把整段技能从 system prompt 抹掉(表现为「装完技能后本轮 agent 不知道有哪些 skills,刷新才好」)。
  const explicit = Array.isArray(agentConfig.enabledSkillIds) && agentConfig.enabledSkillIds.length > 0;
  let enabledSkillIds: string[] = explicit ? agentConfig.enabledSkillIds : [];
  let inlineSkills: Array<{ name: string; body: string }> = [];
  let deferredSkills: Array<{ id: string; name: string; description: string }> = [];
  // 未显式配置 + 非云端沙箱 → 默认列出全部本地技能(按需 use_skill 目录)。
  // 用 `!== 'sandbox'`(而非 `=== 'host'`):execMode 偶发缺失/未回填时仍兜底列出,
  // 不让单轮配置不完整就清空技能段;真·云端会话(execMode==='sandbox')仍走云端技能、不在此列本地。
  if (!explicit && agentConfig.execMode !== 'sandbox') {
    // 本机会话未显式配置技能 → 默认启用「全部本地技能」,但只列进按需 use_skill 目录:
    // 不内联、不逐个拉全文,零 prompt 膨胀;调不调用全看 agent(use_skill 读盘按需加载)。
    try {
      const all = (await (deps().brain.assets.listSkills?.() ?? Promise.resolve([]))) as any[];
      const local = all.filter((s) => String(s?.id || '').startsWith('local:'));
      enabledSkillIds = local.map((s) => s.id);
      deferredSkills = local.map((s) => ({
        id: s.id,
        name: s.name,
        description: String(s.description || '').trim(),
      }));
    } catch {
      enabledSkillIds = [];
    }
  } else if (enabledSkillIds.length) {
    const skills = (
      await Promise.all(enabledSkillIds.map((id: string) => getSkill(id).catch(() => null)))
    ).filter(Boolean) as any[];
    for (const s of skills) {
      const body = String(s.content || '').trim();
      if (body && body.length <= INLINE_SKILL_MAX_CHARS) {
        inlineSkills.push({ name: s.name, body });
      } else if (body) {
        deferredSkills.push({ id: s.id, name: s.name, description: String(s.description || '').trim() });
      } else if (String(s.description || '').trim()) {
        // 无正文、仅描述：当作小指令内联
        inlineSkills.push({ name: s.name, body: String(s.description).trim() });
      }
      if (s.content) void materializeSkill(userId, appId, s.id, s.content).catch(() => {});
    }
  }

  // 本轮用户经 /skill 显式点选的技能(per-message,与持久 enabledSkillIds 正交):
  // 加性——并入可用集(准许 use_skill),**绝不收窄目录**(修复「点选一个技能,其它都不识别」);
  // 但**不内联正文进 system**(参考 Hermes:指针+按需加载)——正文由 use_skill 取回、落对话尾部,
  // 强指令由调用方拼到尾部 user 消息,这样 /skill 轮不改 system 前缀字节,前缀缓存照常命中。
  const requestedIds: string[] = Array.isArray(agentConfig.requestedSkillIds) ? agentConfig.requestedSkillIds : [];
  const requested: Array<{ id: string; name: string; description: string }> = [];
  if (requestedIds.length) {
    const skills = (
      await Promise.all(requestedIds.map((id: string) => getSkill(id).catch(() => null)))
    ).filter(Boolean) as any[];
    for (const s of skills) {
      if (!enabledSkillIds.includes(s.id)) enabledSkillIds = [...enabledSkillIds, s.id]; // 准许 use_skill 访问
      // 已由尾部「指定技能」强指令点名,从普通目录/内联摘掉避免重复列出。
      deferredSkills = deferredSkills.filter((d) => d.id !== s.id);
      inlineSkills = inlineSkills.filter((i) => i.name !== s.name);
      requested.push({ id: s.id, name: s.name, description: String(s.description || '').trim() });
      if (s.content) void materializeSkill(userId, appId, s.id, s.content).catch(() => {});
    }
  }

  const sections: string[] = [];
  if (inlineSkills.length) {
    sections.push(
      '## Skill Instructions\n\n' +
        inlineSkills.map((s) => `### ${s.name}\n${s.body}`).join('\n\n---\n\n'),
    );
  }
  if (deferredSkills.length) {
    const lines = deferredSkills
      .map((s) => `- ${s.name} (id: \`${s.id}\`)${s.description ? ` — ${s.description}` : ''}`)
      .join('\n');
    sections.push(
      '## Available Skills (load on demand)\n' +
        'The following skills are large and not expanded here. When a task matches a skill, **first call the `use_skill` tool (passing its id) to obtain the full instructions, then act**; ' +
        'do not assume its details. No need to call it for unrelated simple questions.\n\n' +
        lines,
    );
  }
  return { enabledSkillIds, sections, requested };
}
