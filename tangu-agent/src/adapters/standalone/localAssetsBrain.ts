/**
 * 本地技能 overlay(仅 standalone/TUI 组装,见 assemble.buildBrain):
 * 包住任意 AssetsBrain,把磁盘技能(包内置 skills/ + ~/.tangu/skills/)叠加进
 * getSkill / listSkills——`local:` 前缀 id 走磁盘,其余原样委托内层(云端)。
 * skillLoadout / use_skill / routes/assets 全经 deps().brain.assets,零改动即生效。
 */
import type { AssetsBrain } from '../../seams/cloudBrain.js';
import { getLocalSkill, listLocalSkills, LOCAL_SKILL_PREFIX } from '../../skills/localSkills.js';

export function createLocalAssets(inner: AssetsBrain): AssetsBrain {
  return {
    ...inner,
    getSkill: async (id: string) => {
      if (id.startsWith(LOCAL_SKILL_PREFIX)) return getLocalSkill(id);
      return inner.getSkill(id);
    },
    listSkills: async (filter) => {
      const [local, cloud] = await Promise.all([
        listLocalSkills().catch(() => []),
        inner.listSkills ? inner.listSkills(filter).catch(() => []) : Promise.resolve([]),
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
