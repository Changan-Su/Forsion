/**
 * 「其他可选技能」(共享 / 本机其他来源 / 云端)的勾选只在「自选」下生效。
 * 此前「自动」下勾一下就把当前全部技能固化成一份清单 = 悄悄换成了「自选」:之后新装的技能不再自动加入,
 * 用户却以为自己还在「自动」(反馈 6a239e58 的 xyra 就是这样被冻住的)。要单独调整,先显式切到「自选」。
 * 返回 null = 这次勾选不生效。
 */
export function nextExtraSelection(selectedIds: string[] | null | undefined, id: string, enabled: boolean): string[] | null {
  if (!selectedIds?.length) return null
  return enabled ? [...new Set([...selectedIds, id])] : selectedIds.filter((entry) => entry !== id)
}
