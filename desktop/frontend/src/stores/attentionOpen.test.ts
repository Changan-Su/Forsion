// @vitest-environment happy-dom
/**
 * 「打开那条等你处理的会话」(P1 · K3):系统通知点击(approval:open)与收件箱审批提醒信的「打开会话」共用。
 *   空 id → false;未知 id → 先刷会话列表,刷完仍找不到 → false 且不开空会话;刷出来了 → 打开;已归档的也认;
 *   主页 / 收件箱 Space 没有聊天主区 → 先切回 Tangu Space;别的 Space 不动。
 * 负对照(实跑见红,记在 K3 交付报告):去掉 home/inbox → tangu 的切换 → 「主页 / 收件箱」两条红;去掉刷新 → 「刷出来了」红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  space: 'tangu' as string,
  setActiveSpace: vi.fn(),
  openSession: vi.fn(),
  sessions: [] as Array<{ id: string }>,
  archived: [] as Array<{ id: string }>,
  refresh: vi.fn(),
}))
vi.mock('@lcl/engine', () => ({
  setActiveSpace: (id: string) => state.setActiveSpace(id),
  useSpaceStore: { getState: () => ({ activeSpaceId: state.space }) },
}))
vi.mock('../sessionNav', () => ({ openSession: (sid: string) => state.openSession(sid) }))
vi.mock('./appStore', () => ({
  useApp: { getState: () => ({ sessions: state.sessions, archivedSessions: state.archived, cfg: { token: 't' }, refreshSessions: state.refresh }) },
}))

import { openSessionFromApproval } from './attentionOpen'

beforeEach(() => {
  state.space = 'tangu'
  state.sessions = [{ id: 's-known' }]
  state.archived = [{ id: 's-archived' }]
  state.setActiveSpace.mockReset()
  state.openSession.mockReset()
  state.refresh.mockReset()
  state.refresh.mockImplementation(async () => [])
})

describe('openSessionFromApproval', () => {
  it('空 id → false,什么都不做', async () => {
    expect(await openSessionFromApproval('')).toBe(false)
    expect(state.refresh).not.toHaveBeenCalled()
    expect(state.openSession).not.toHaveBeenCalled()
  })

  it('已知会话(含已归档)→ 直接打开,不刷列表', async () => {
    expect(await openSessionFromApproval('s-known')).toBe(true)
    expect(await openSessionFromApproval('s-archived')).toBe(true)
    expect(state.refresh).not.toHaveBeenCalled()
    expect(state.openSession.mock.calls).toEqual([['s-known'], ['s-archived']])
  })

  it('未知 id → 先刷一次会话列表;刷完仍找不到 → false,不开一个「加载失败」的空会话', async () => {
    expect(await openSessionFromApproval('s-elsewhere')).toBe(false)
    expect(state.refresh).toHaveBeenCalledTimes(1)
    expect(state.refresh).toHaveBeenCalledWith({ token: 't' })
    expect(state.openSession).not.toHaveBeenCalled()
    expect(state.setActiveSpace).not.toHaveBeenCalled()
  })

  it('未知 id,刷出来了(通知比列表新)→ 打开', async () => {
    state.refresh.mockImplementation(async () => { state.sessions = [...state.sessions, { id: 's-new' }]; return state.sessions })
    expect(await openSessionFromApproval('s-new')).toBe(true)
    expect(state.openSession).toHaveBeenCalledWith('s-new')
  })

  it('刷新抛错(离线)→ 按找不到处理,不抛', async () => {
    state.refresh.mockImplementation(async () => { throw new Error('offline') })
    expect(await openSessionFromApproval('s-elsewhere')).toBe(false)
    expect(state.openSession).not.toHaveBeenCalled()
  })

  it.each(['home', 'inbox'])('当前在 %s Space(没有聊天主区)→ 先切回 tangu 再打开', async (space) => {
    state.space = space
    expect(await openSessionFromApproval('s-known')).toBe(true)
    expect(state.setActiveSpace).toHaveBeenCalledWith('tangu')
    expect(state.openSession).toHaveBeenCalledWith('s-known')
  })

  it('别的 Space(如笔记库)→ 不切,交给 openSession 自己', async () => {
    state.space = 'amadeus'
    expect(await openSessionFromApproval('s-known')).toBe(true)
    expect(state.setActiveSpace).not.toHaveBeenCalled()
  })
})
