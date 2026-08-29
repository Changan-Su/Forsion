/** 侧栏目标宽的纯几何 —— 单独成文件以便单测(dockviewStore 拖 dockview/DOM,测试里进不去;同 sessionOpenPlan 先例)。 */

/** 黄金分割默认:中间 0.618,两侧每侧 0.382/2 = 0.191(= 1 - 0.618 平分)。 */
export const SIDE_FRACTION = 0.191
/** 可拖宽侧栏的下限(比钉宽档的 min 更松,允许用户拖窄)。 */
export const RESIZABLE_MIN = 220

export interface SideWidthInput {
  /** 该侧是否「可自由拖宽 + 记住宽度」(SpaceDefinition.resizableSides)。 */
  free: boolean
  /** 记住的宽度;null = 该 Space 该侧还没被拖过。 */
  saved: number | null
  /** 「首次无记录」时的默认宽 = 黄金分割 × 本系数(SpaceDefinition.sideDefaultScale,缺省 1)。 */
  scale?: number
}

/** 某侧栏的目标宽:
 *  - 非 free → 钉黄金分割(钳 min~max);
 *  - free 且有记忆 → 用记忆(故拖宽持久,不被重钉回黄金分割);
 *  - free 且无记忆 → 黄金分割 × scale。**scale 缺省 1 = 与普通 Space 同宽**
 *    (曾硬编码 ×1.2:那本是 Coding 对话栏的宽默认,2.7.0 给 Amadeus 开 free 后被顺带继承 → 左栏莫名宽 20%)。 */
export function computeSideWidth(containerWidth: number, loc: 'left' | 'right', o: SideWidthInput): number {
  const min = loc === 'left' ? 220 : 240
  const max = loc === 'left' ? 280 : 300
  const golden = Math.round(Math.min(max, Math.max(min, containerWidth * SIDE_FRACTION)))
  if (!o.free) return golden
  const target = typeof o.saved === 'number' ? o.saved : Math.round(golden * (o.scale ?? 1))
  const hardMax = Math.max(RESIZABLE_MIN, Math.min(680, Math.round(containerWidth * 0.6)))
  return Math.min(hardMax, Math.max(RESIZABLE_MIN, target))
}

/** 底部面板高度下限(= shouldRecordSideWidth 的 measured<120 门槛,两者必须一致:
 *  低于它的高度一律当「收起补间的中间值」,不记忆)。 */
export const BOTTOM_MIN_HEIGHT = 120

/** 底部面板目标高。底部**恒 free**(不进 pinSides 的黄金分割钉宽体系,那套是横向的):
 *  只有一条规则 —— 记得住、拖得动。无记忆时取容器高的 32%(≈ VS Code 面板起手高),钳 [120, 60%]。 */
export function computeBottomHeight(containerHeight: number, saved: number | null): number {
  const max = Math.max(BOTTOM_MIN_HEIGHT, Math.round(containerHeight * 0.6))
  const target = typeof saved === 'number' ? saved : Math.round(containerHeight * 0.32)
  return Math.min(max, Math.max(BOTTOM_MIN_HEIGHT, target))
}
