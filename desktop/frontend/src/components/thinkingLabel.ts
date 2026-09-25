/**
 * 思考档位的**显示名**单源(评审 U-28a):模型药丸、Agent 档案、团队成员调档、项目设置、
 * 设置页 Agent 编辑、群聊临时成员 —— 所有下拉与摘要都走这里,不再有渲染原始值 `medium` 的下拉,
 * 也不再有 'Max' 这类只在一处的特例。词条在 i18n.generated.ts 的 `input.thinkingShort.*`(七档齐全)。
 */
import type { ThinkingLevel } from '../types'

/** 档位的短名键(「标准 / 极简 / 浅 / 中 / 深 / 极深 / 拉满」)。 */
export const thinkingShortKey = (lv: ThinkingLevel): string => `input.thinkingShort.${lv}`

/** 档位的短名(已翻译)。 */
export function thinkingLabel(lv: ThinkingLevel, t: (key: string) => string): string {
  return t(thinkingShortKey(lv))
}
