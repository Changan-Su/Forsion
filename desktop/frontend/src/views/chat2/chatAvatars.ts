/**
 * 聊天消息头像(默认开;10-02 用户拍板:v2「内容去装饰」只落这一条开关)。
 * 关 = 助手头像留位不画(正文左缘不跳)+ 用户头像与名字条一起收。纯渲染偏好:localStorage,
 * 不进后端、不跨设备;同机别的窗口经 storage 事件跟上。落在 <html data-chat-avatars="off">,
 * 样式在 chat2.css 末尾 —— 消息组件不用订阅它,只需 import 本模块一次(EditorialMessage)。
 */
export const CHAT_AVATARS_KEY = 'forsion_chat_avatars'

/** 没存过 = 开;只有显式存 '0' 才关。 */
export function isChatAvatarsOn(): boolean {
  try { return localStorage.getItem(CHAT_AVATARS_KEY) !== '0' } catch { return true }
}

function apply(): void {
  if (isChatAvatarsOn()) delete document.documentElement.dataset.chatAvatars
  else document.documentElement.dataset.chatAvatars = 'off'
}

export function setChatAvatarsOn(on: boolean): void {
  try { localStorage.setItem(CHAT_AVATARS_KEY, on ? '1' : '0') } catch { /* private mode */ }
  apply()
}

if (typeof document !== 'undefined') {
  apply()
  window.addEventListener('storage', (e) => { if (e.key === CHAT_AVATARS_KEY) apply() })
}
