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
}

export async function loadSkillLoadout(
  userId: string,
  appId: string,
  agentConfig: any,
): Promise<SkillLoadout> {
  const explicit = Array.isArray(agentConfig.enabledSkillIds);
  let enabledSkillIds: string[] = explicit ? agentConfig.enabledSkillIds : [];
  let inlineSkills: Array<{ name: string; body: string }> = [];
  let deferredSkills: Array<{ id: string; name: string; description: string }> = [];
  if (!explicit && agentConfig.execMode === 'host') {
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
      '## Available Skills (按需加载)\n' +
        '以下技能体量较大，未展开。当任务匹配某技能时，**先调用 `use_skill` 工具（传其 id）拿到完整说明书再执行**，' +
        '不要凭空假设其细节。无关的简单问题不必调用。\n\n' +
        lines,
    );
  }
  return { enabledSkillIds, sections };
}
