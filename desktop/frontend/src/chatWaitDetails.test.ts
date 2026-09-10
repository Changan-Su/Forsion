// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_WAIT_DETAILS_EVENT,
  CHAT_WAIT_DETAILS_KEY,
  isChatWaitDetailsEnabled,
  setChatWaitDetailsEnabled,
} from './chatWaitDetails'

describe('chat wait details preference', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to off and only an explicit "1" enables the diagnostics', () => {
    expect(isChatWaitDetailsEnabled()).toBe(false)
    localStorage.setItem(CHAT_WAIT_DETAILS_KEY, '0')
    expect(isChatWaitDetailsEnabled()).toBe(false)
    localStorage.setItem(CHAT_WAIT_DETAILS_KEY, '1')
    expect(isChatWaitDetailsEnabled()).toBe(true)
  })

  it('persists changes and announces them to the mounted Chat View', () => {
    const listener = vi.fn()
    window.addEventListener(CHAT_WAIT_DETAILS_EVENT, listener)

    setChatWaitDetailsEnabled(true)
    expect(localStorage.getItem(CHAT_WAIT_DETAILS_KEY)).toBe('1')
    expect(isChatWaitDetailsEnabled()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)

    setChatWaitDetailsEnabled(false)
    expect(localStorage.getItem(CHAT_WAIT_DETAILS_KEY)).toBe('0')
    expect(isChatWaitDetailsEnabled()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)

    window.removeEventListener(CHAT_WAIT_DETAILS_EVENT, listener)
  })
})
