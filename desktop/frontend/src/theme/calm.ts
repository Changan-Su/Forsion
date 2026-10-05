/**
 * 「呼吸感」三个外观开关(10-05 用户拍板;设置 → 外观逐项可开关。宽松正文与舒缓过渡缺省开;
 *   外围淡出缺省关 —— 同一晚用户看过实物后改的,要的人自己打开):
 *   dim     外围淡出 —— Ribbon 图标、未选中的标签、左栏文字、对话右侧卡片平时退后,指针或键盘焦点进来恢复
 *   reading 宽松正文 —— 笔记与对话正文的行距、段距放宽,笔记阅读宽度收窄;界面字号与控件大小不动
 *   motion  舒缓过渡 —— 切主视图的淡入、外围恢复慢一点
 * 与「聊天头像」同一套做法(views/chat2/chatAvatars.ts):纯本机渲染偏好,存 localStorage,不进后端、不跨设备;
 * 落在 <html data-calm-*="off">(没存过 = 取 DEFAULT_ON),同机别的窗口经 storage 事件跟上。样式全在 calm.css,组件不订阅。
 * themeStore 在模块顶层 import 本文件一次:每个窗口、三端都会加载,且先于首次渲染,所以不用进首屏脚本。
 * ⚠️ 这三个开关是用户的:插件与视图不读、不写这些键和属性,只消费 calm.css 里那几个 token(DESIGN §6「呼吸感」)。
 */
import './calm.css'

export type CalmKey = 'dim' | 'reading' | 'motion'
const KEYS: CalmKey[] = ['dim', 'reading', 'motion']
const PREFIX = 'forsion_calm_'
const attr = (k: CalmKey): string => `calm${k[0].toUpperCase()}${k.slice(1)}`

/** 没存过时的值。 */
const DEFAULT_ON: Record<CalmKey, boolean> = { dim: false, reading: true, motion: true }
/** 存过 = 以存的为准('0' 关,其余开);没存过 / 读不了 = 缺省值。 */
const read = (k: CalmKey): boolean => {
  try { const v = localStorage.getItem(PREFIX + k); return v === null ? DEFAULT_ON[k] : v !== '0' } catch { return DEFAULT_ON[k] }
}
// 本窗的当前值。存一份在内存里:写盘失败(隐私模式 / 配额满)时这次会话照样生效,开关显示的也是真的。
const state: Record<CalmKey, boolean> = { dim: read('dim'), reading: read('reading'), motion: read('motion') }

export const isCalmOn = (k: CalmKey): boolean => state[k]

function apply(): void {
  for (const k of KEYS) {
    if (state[k]) delete document.documentElement.dataset[attr(k)]
    else document.documentElement.dataset[attr(k)] = 'off'
  }
}

export function setCalmOn(k: CalmKey, on: boolean): void {
  state[k] = on
  try { localStorage.setItem(PREFIX + k, on ? '1' : '0') } catch { /* private mode */ }
  apply()
}

if (typeof document !== 'undefined') {
  apply()
  // 别的窗口改了(key 为 null = 那边 localStorage.clear()):以存储为准重读
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith(PREFIX)) return
    for (const k of KEYS) state[k] = read(k)
    apply()
  })
}
