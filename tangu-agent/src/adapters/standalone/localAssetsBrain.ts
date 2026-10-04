/**
 * 本地技能 overlay(仅 standalone/TUI 组装,见 assemble.buildBrain):
 * 包住任意 AssetsBrain,把磁盘技能(包内置 skills/ + ~/.tangu/skills/)叠加进
 * getSkill / listSkills——`local:` 前缀 id 走磁盘,其余原样委托内层(云端;见 CLOUD_SKILLS_ENABLED)。
 * skillLoadout / use_skill / routes/assets 全经 deps().brain.assets,零改动即生效。
 */
import type { AssetsBrain } from '../../seams/cloudBrain.js';
import { getLocalSkill, listLocalSkills, LOCAL_SKILL_PREFIX } from '../../skills/localSkills.js';

/**
 * 云端技能库(Forsion /api/brain/skills)暂时停用(2026-10-04 用户定:上古产物,当前没用)。
 * 关着时技能只有磁盘上的 `local:`:云端的不列、不取、不发布;清单里残留的云端 id 取不到,自然从目录里消失。
 * 恢复 = 改回 true,并同步改 desktop `GlobalSkillsLibrary.tsx` 的同名开关(「云端副本」筛选项 + 「发布正文副本」按钮)。
 * 删除本人云端副本(deleteUserSkill)不拦:关着时面板列不出来,留着只为日后清理。
 */
export const CLOUD_SKILLS_ENABLED: boolean = false;

export function createLocalAssets(inner: AssetsBrain, cloudSkills: boolean = CLOUD_SKILLS_ENABLED): AssetsBrain {
  return {
    ...inner,
    ...(cloudSkills ? {} : { upsertUserSkill: undefined }), // /agent/skills/upload 据此回 501
    getSkill: async (id: string) => {
      if (id.startsWith(LOCAL_SKILL_PREFIX)) return getLocalSkill(id);
      return cloudSkills ? inner.getSkill(id) : null;
    },
    listSkills: async (filter) => {
      const [local, cloud] = await Promise.all([
        listLocalSkills().catch(() => []),
        cloudSkills && inner.listSkills ? inner.listSkills(filter).catch(() => []) : Promise.resolve([]),
      ]);
      // 本地在前(桌面技能面板置顶);id 冲突理论上不可能(local: 前缀),仍按 id 去重保险。
      // source 来自 localSkills(local/claude/codex 来源徽标),缺省兜底 'local'。
      const byId = new Map<string, any>();
      for (const s of local) byId.set(s.id, { source: 'local', ...s });
      for (const s of cloud as any[]) if (!byId.has(s.id)) byId.set(s.id, s);
      return [...byId.values()];
    },
  };
}
