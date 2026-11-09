/**
 * 新装机播种的 USER.md / human/MEMORY.md 空模板(agentRegistry.seedUserMdOnce 写 USER.md,ensureHumanFolder 复制进 human/MEMORY.md)。
 * 单独一份是为了让桌面渲染层(首启引导「关于你」)也能认它,而不必把 agentSyncRules 的合并代码一起打进前端。
 * 纯常量 + 纯函数,不碰磁盘。agentSyncRules 原样再导出,引擎侧的引用不变。
 */
const userMdTemplate = (lead: string): string =>
  '# User Profile (USER.md)\n\n' +
  `> Every Agent reads this profile. ${lead}\n\n` +
  '## Name / What to call you\n\n' +
  '## Preferences\n- \n\n' +
  '## Level / Background\n\n' +
  '## Long-term needs / Goals\n';
export const USER_MD_TEMPLATE = userMdTemplate('Record long-term information about yourself here.');
/** 以前发出去的空模板:同步 / 镜像的第一次见面和提示词都要认得,不然旧装机那份空模板会被当成真资料合并、注入。 */
export const LEGACY_USER_MD_TEMPLATES: readonly string[] = [userMdTemplate('Record long-term information about yourself here; Agents may also add to it based on conversations.')];

/** 是不是没人动过的空模板(任一版本)。换行统一成 \n、去首尾空白后整份相等才算;和引擎 tanguHome.isUserMdTemplate 同一口径。 */
export function isUserMdTemplateText(s: string): boolean {
  const t = s.replace(/\r\n/g, '\n').trim();
  return [USER_MD_TEMPLATE, ...LEGACY_USER_MD_TEMPLATES].some((tpl) => tpl.trim() === t);
}
