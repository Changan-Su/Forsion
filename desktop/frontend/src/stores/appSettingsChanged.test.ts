/**
 * app_settings_changed(agent 经 update_app_settings 改了本机 config.json):桌面缓存着那份配置 ——
 * 不重读,界面与朗读开关是旧值,下一次 run 还把旧的识图模型透传过去、盖住 agent 刚写的值。
 * 事件存库、重新订阅会回放,所以载荷不落地:落到本地的只能是主进程此刻读出来的配置;
 * 连接信息(backendUrl / token)和不归这份设置管的生图模型不许被这次重读改掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunEvent } from '../types'
import { useApp } from './appStore'

const g = globalThis as any
const initial = useApp.getState()
const flush = () => new Promise((r) => setTimeout(r, 0))
const emit = (payload: Record<string, unknown>) =>
  useApp.getState().reduceEvent('s1', 'r1', { current: 'a1' }, { seq: 1, type: 'app_settings_changed', payload } as AgentRunEvent)
const LOCAL_CFG = { backendUrl: 'http://engine', token: 'tok', modelId: 'old-default', imageModelId: 'img', visionModelId: 'old-vision', visionMode: 'auto' as const }

beforeEach(() => {
  useApp.setState(initial, true)
  useApp.setState({
    cfg: LOCAL_CFG,
    desktopConfig: { ttsModelId: '', ttsVoice: 'alloy', backgroundModelId: 'old-bg' } as never,
    defaultWsDir: '/old/ws',
    runningBySession: { s1: 'r1' }, // reduceEvent 按 runningBySession 认领事件,不种就整条静默丢弃
  })
})
afterEach(() => { delete g.window })

describe('app_settings_changed', () => {
  it('重读主进程配置:界面缓存、默认工作目录、随 run 透传的默认 / 识图模型换成盘上的值;连接信息不动', async () => {
    const disk = {
      backendUrl: 'http://OTHER', token: 'OTHER', imageModelId: 'OTHER-img', modelId: 'new-default', visionModelId: 'new-vision', visionMode: 'always',
      ttsModelId: 'p/tts', ttsVoice: 'nova', backgroundModelId: 'new-bg', defaultWorkspaceDir: '/new/ws', homeDir: '/home/u',
    }
    g.window = { tangu: { getConfig: vi.fn(async () => disk) } }
    // 载荷故意和盘上不一样(= 回放出来的旧事件):落地的必须是盘上的值
    emit({ section: 'tts', fields: ['voice'], source: 'agent', voice: 'STALE' })
    await flush()
    const s = useApp.getState()
    expect(g.window.tangu.getConfig).toHaveBeenCalledTimes(1)
    expect(s.desktopConfig).toEqual(disk)
    expect(s.defaultWsDir).toBe('/new/ws')
    expect(s.homeDir).toBe('/home/u')
    expect(s.cfg).toEqual({ ...LOCAL_CFG, modelId: 'new-default', visionModelId: 'new-vision', visionMode: 'always' })
  })

  it('连改两次、先发的读取后到:以最后发起的那次为准(旧值不许盖回新值)', async () => {
    let releaseOld!: () => void
    const older = { modelId: 'older', visionModelId: 'older-v', visionMode: 'auto', ttsVoice: 'older', defaultWorkspaceDir: '/older' }
    const newer = { modelId: 'newer', visionModelId: 'newer-v', visionMode: 'off', ttsVoice: 'newer', defaultWorkspaceDir: '/newer' }
    const getConfig = vi.fn()
      .mockImplementationOnce(() => new Promise((res) => { releaseOld = () => res(older) }))
      .mockImplementationOnce(async () => newer)
    g.window = { tangu: { getConfig } }
    emit({ section: 'tts', fields: ['voice'] })
    emit({ section: 'tts', fields: ['voice'] })
    await flush()
    expect(useApp.getState().cfg.modelId).toBe('newer')
    releaseOld()
    await flush()
    const s = useApp.getState()
    expect(s.cfg).toEqual({ ...LOCAL_CFG, modelId: 'newer', visionModelId: 'newer-v', visionMode: 'off' })
    expect(s.desktopConfig).toEqual(newer)
    expect(s.defaultWsDir).toBe('/newer')
  })

  it('读不到(web / 手机没有这份配置,或主进程报错):保留本地,不抛', async () => {
    g.window = {} // 没有 window.tangu
    emit({ section: 'tts', fields: ['voice'] })
    g.window = { tangu: { getConfig: vi.fn(async () => { throw new Error('ipc down') }) } }
    emit({ section: 'tts', fields: ['voice'] })
    await flush()
    expect(g.window.tangu.getConfig).toHaveBeenCalledTimes(1)
    expect(useApp.getState().cfg).toEqual(LOCAL_CFG)
    expect(useApp.getState().desktopConfig).toEqual({ ttsModelId: '', ttsVoice: 'alloy', backgroundModelId: 'old-bg' })
    expect(useApp.getState().defaultWsDir).toBe('/old/ws')
  })
})
