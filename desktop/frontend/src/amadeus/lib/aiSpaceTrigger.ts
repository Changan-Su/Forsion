/** 「空行按空格唤起 AI」开关(评审 G3-07,拍板 #13:缺省关)。本机偏好,存 localStorage(不进桌面配置 / 不同步);
 *  编辑器按键路径上同步读,所以进程内缓存一份,设置页改了就地更新。读写一律 try:隐私模式 / 禁用存储时按「关」处理。 */
import { registerMessages } from '../../i18n'

// 设置 → 笔记 → 行为 里那一行的文案(跟着开关一起住在这里,不动中央词典)。
registerMessages({
  'settings.notes.aiSpaceLabel': { zh: '空行按空格唤起 AI', en: 'Press Space on an empty line for AI' },
  'settings.notes.aiSpaceHint': { zh: '在空的段落里按空格打开 AI 写作面板；输入法组字中的空格不受影响。仅本机生效', en: 'Space on an empty paragraph opens the AI writing panel. Spaces typed with an input method are not affected. This device only' },
})

const KEY = 'forsion.amadeus.aiSpaceTrigger'
let cached: boolean | null = null

export function aiSpaceTriggerEnabled(): boolean {
  if (cached === null) {
    try { cached = localStorage.getItem(KEY) === '1' } catch { cached = false }
  }
  return cached
}

export function setAiSpaceTriggerEnabled(on: boolean): void {
  cached = on
  try {
    if (on) localStorage.setItem(KEY, '1')
    else localStorage.removeItem(KEY)
  } catch { /* 存不住就只在本次会话生效 */ }
}
