/**
 * Channel workspace bootstrap timing:
 * polling mounts before appStore finishes connecting, so the non-ok -> ok edge must
 * trigger the first refresh immediately instead of waiting for the 15s interval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listChannels = vi.fn()
vi.mock('../services/backendService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/backendService')>()),
  listChannels: (...args: unknown[]) => listChannels(...args),
}))

const { useApp } = await import('./appStore')
const { useChannels } = await import('./channelsStore')
const initialApp = useApp.getState()
const initialChannels = useChannels.getState()

describe('channelsStore polling lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listChannels.mockReset()
    listChannels.mockResolvedValue({
      available: true,
      channels: [{ kind: 'wechat', enabled: true, workspace: '/tmp/Tangu/webot' }],
    })
    ;(globalThis as any).window = {
      tangu: { backendStatus: vi.fn(async () => ({ state: 'starting' })) },
      setInterval,
      clearInterval,
    }
    useChannels.getState().stopPolling()
    useChannels.setState({ ...initialChannels, channels: [], available: false, loaded: false }, true)
    useApp.setState({
      ...initialApp,
      connState: 'idle',
      channelWorkspaces: [],
      tr: (key: string) => key,
    }, true)
  })

  afterEach(() => {
    useChannels.getState().stopPolling()
    vi.useRealTimers()
    delete (globalThis as any).window
  })

  it('refreshes immediately when the backend becomes connected', async () => {
    useChannels.getState().startPolling()
    expect(listChannels).not.toHaveBeenCalled()

    useApp.setState({ connState: 'ok' })
    await vi.waitFor(() => expect(listChannels).toHaveBeenCalledTimes(1))

    expect(useApp.getState().channelWorkspaces).toEqual([
      expect.objectContaining({ key: '/tmp/Tangu/webot', kind: 'channel', channel: 'wechat' }),
    ])
  })

  it('removes the connection subscription when polling stops', async () => {
    useChannels.getState().startPolling()
    useChannels.getState().stopPolling()

    useApp.setState({ connState: 'ok' })
    await vi.advanceTimersByTimeAsync(20_000)

    expect(listChannels).not.toHaveBeenCalled()
  })
})
