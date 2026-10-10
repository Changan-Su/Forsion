/**
 * 对话里的可视化卡多少(对标 ChatGPT 设置「Layout and visuals」,2026-10-09)。
 * auto=由模型按关系 / 流程 / 数据形状自行判断;less=只在用户明确要图时画;off=撤下 sketch 工具与提示段。
 * 本地偏好(localStorage),随每次 run 的 ui_settings 快照上送 —— 引擎侧 tangu-agent/src/tools/builtin/sketch.ts
 * 的 visualsPrefOf 按同一枚举开关;模型经 set_ui_setting 改的也落在这里(agentCommands UI_SETTINGS.visuals)。
 * 下一次 run 才生效(快照按 run 送),已画出的卡不受影响。
 */
export type VisualsPref = 'auto' | 'less' | 'off'
export const VISUALS_KEY = 'forsion_tangu_visuals'
export const VISUALS_VALUES: readonly VisualsPref[] = ['auto', 'less', 'off']

export function getVisualsPref(): VisualsPref {
  try {
    const v = localStorage.getItem(VISUALS_KEY)
    return v === 'less' || v === 'off' ? v : 'auto'
  } catch { return 'auto' }
}

/** 唯一写口(设置页与 set_ui_setting 共用)。auto 是缺省,存成「没存」,老键值不留。 */
export function setVisualsPref(v: VisualsPref): void {
  try {
    if (v === 'auto') localStorage.removeItem(VISUALS_KEY)
    else localStorage.setItem(VISUALS_KEY, v)
  } catch { /* 隐私模式 / 配额:偏好丢了也不该影响对话 */ }
}
