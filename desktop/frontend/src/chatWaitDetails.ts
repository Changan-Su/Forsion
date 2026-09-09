/**
 * Agent 消息尾部的模型等待诊断详情（发送上下文 / 等待首帧 / 已等待时间）。
 *
 * 这是跨 desktop / web / mobile 的纯渲染偏好，不进后端配置，也不跨设备同步。
 * 缺省严格为关：只有用户在「设置 → 高级 → 测试性功能」显式开启后才显示。
 */
import { useSyncExternalStore } from 'react'

export const CHAT_WAIT_DETAILS_KEY = 'forsion_chat_wait_details'
export const CHAT_WAIT_DETAILS_EVENT = 'forsion:chat-wait-details'

export function isChatWaitDetailsEnabled(): boolean {
  try { return localStorage.getItem(CHAT_WAIT_DETAILS_KEY) === '1' } catch { return false }
}

export function setChatWaitDetailsEnabled(enabled: boolean): void {
  try { localStorage.setItem(CHAT_WAIT_DETAILS_KEY, enabled ? '1' : '0') } catch { /* private mode */ }
  try { window.dispatchEvent(new Event(CHAT_WAIT_DETAILS_EVENT)) } catch { /* non-browser test/runtime */ }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (event: StorageEvent): void => {
    if (event.key === CHAT_WAIT_DETAILS_KEY) listener()
  }
  window.addEventListener(CHAT_WAIT_DETAILS_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHAT_WAIT_DETAILS_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useChatWaitDetailsEnabled(): boolean {
  return useSyncExternalStore(subscribe, isChatWaitDetailsEnabled, () => false)
}
