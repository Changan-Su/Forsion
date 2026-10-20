// @vitest-environment happy-dom
// 蓬洲云额度满时的提醒(notificationWiring B 段):要真 window,单放一个文件。
import { describe, expect, it, vi } from 'vitest'

vi.mock('./notificationStore', () => ({ notifyApp: vi.fn() }))
vi.mock('../amadeus/store/mdMarkStore', () => ({
  useMdMarkStore: { getState: () => ({ marks: [], load: async () => {} }), subscribe: () => () => {} },
}))

describe('蓬洲云额度满的提醒', () => {
  it('刚满那一轮提醒一次(警告、人话),之后每轮不再刷;额度回来再满再提醒;混着别的错照旧报错', async () => {
    let cb: (s: unknown) => void = () => {}
    ;(window as any).remoteSync = { onStatus: (f: (s: unknown) => void) => { cb = f; return () => {} } }
    const { useApp } = await import('./appStore')
    const { notifyApp } = await import('./notificationStore')
    const { installNotificationWiring } = await import('./notificationWiring')
    useApp.setState({ tr: (k: string) => k } as any)
    installNotificationWiring()
    const round = (errors: string[]): void => {
      cb({ running: true })
      cb({ running: false, lastReport: { ok: !errors.length, errors, conflicts: 0, pendingDeletions: 0, pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0 } })
    }
    const Q = 'push 项目/a.md: penzor PUT 413: {"code":"QUOTA","detail":"quota exceeded"}'
    const calls = () => (notifyApp as any).mock.calls.map((c: any[]) => [c[0].level, c[0].text])
    round([Q, Q]); round([Q])
    expect(calls()).toEqual([['warning', 'ntf.remoteSyncQuota']])
    round([]); round([Q])
    expect(calls()).toEqual([['warning', 'ntf.remoteSyncQuota'], ['warning', 'ntf.remoteSyncQuota']])
    round([Q, 'pull b.md: ECONNRESET'])
    expect(calls().at(-1)).toEqual(['error', 'ntf.remoteSyncFail'])
    // 文件名里带 quota / 413 的别的错误照旧报错,不被当成额度满藏起来
    round(['push quota.md: EACCES: permission denied'])
    expect(calls().at(-1)).toEqual(['error', 'ntf.remoteSyncFail'])
    round(['pull logs/413.md: penzor GET 401: unauthorized'])
    expect((notifyApp as any).mock.calls.length).toBe(5)
  })
})
