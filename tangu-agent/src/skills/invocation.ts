/**
 * 技能的两个「装载闸」字段(由 localSkills.toRecord 从 SKILL.md / 所在目录算出,挂在技能记录上)。单独成一个小模块:
 * skillLoadout / use_skill 只要这两个判断,不必为此把整个 localSkills(扫盘、播种)拉进来 —— 测试里 mock 掉 localSkills 时也不受牵连。
 */

/** frontmatter `disable-model-invocation: true`(Claude Code 同义):只在用户这一轮亲手点名(/skill)时装载,不进模型看到的技能目录。 */
export const userInvokedOnly = (skill: unknown): boolean =>
  (skill as { disableModelInvocation?: unknown } | null)?.disableModelInvocation === true;

/** 技能文件夹里的 `.forsion-adapt.md` 只对「从商店来源装进用户 / Agent 技能目录」的技能(文件夹名 `src-<8 位来源 id>-…`)算数:
 *  那是安装流程写的。项目目录、插件包里自带的同名文件不认 —— 否则仓库里随手放一份就能冒充 Forsion 的适配说明。 */
export const acceptsAdaptNote = (skill: unknown): boolean =>
  (skill as { adaptNote?: unknown } | null)?.adaptNote === true;
