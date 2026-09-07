/**
 * chat / work 模式(客户端侧,方案 D5 / D7 / D8 / D36,D9 已替换为「空白会话锁」):
 * ① newSessionPreset 是新会话模式的唯一判定源(项目会话恒 work / 无根恒 chat / 侧栏模式 / 按端默认);
 * ② 新建 chat 会话恒 projectless + sandbox、不带 workspaceProject、不带外部引擎/计划/群聊残值(applyPreset 唯一物化点),
 *    初始配置随 POST 原子落库(老引擎回空 → 补 PUT);
 * ③ 思考档按 preset 分槽(chat 缺省 off,chat 里调高不污染 work);④ 端判定每次现算;
 * ⑤ 三条建会话路(空态 send / createInWorkspace / newSession)同一条默认规则;⑥ 列表 agent_config 预填。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CLOUD_PROJECT, ROOTLESS_WORKSPACE_KEY, type WorkspaceDescriptor } from '../types'
import { useApp, newSessionPreset, stickyDefaults, applyPreset, type AppState } from './appStore'
import { effectiveSessionMode, sessionsInMode, workspacesInMode } from '../views/sessionMode'
import { currentPlatform } from '../services/agentRunService'
import { usePageStore } from '../amadeus/store/pageStore'

const createSessionMock = vi.hoisted(() => vi.fn())
const putSessionConfigMock = vi.hoisted(() => vi.fn())
const listSessionsMock = vi.hoisted(() => vi.fn())
const startRunMock = vi.hoisted(() => vi.fn())
vi.mock('../services/backendService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createSession: (...a: unknown[]) => createSessionMock(...a),
  putSessionConfig: (...a: unknown[]) => putSessionConfigMock(...a),
  listSessions: (...a: unknown[]) => listSessionsMock(...a),
  updateSession: () => Promise.resolve({}),
}))
vi.mock('../services/agentRunService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  startRun: (...a: unknown[]) => startRunMock(...a),
}))

const rootless: WorkspaceDescriptor = { key: ROOTLESS_WORKSPACE_KEY, name: '不在项目中工作', kind: 'rootless', path: null, system: true }
const cloudWs: WorkspaceDescriptor = { key: 'cloud:Tangu', name: 'Tangu', kind: 'cloud', path: null, project: 'Tangu' }
const localWs: WorkspaceDescriptor = { key: '/proj', name: 'proj', kind: 'local', path: '/proj' }

describe('newSessionPreset(唯一判定源)', () => {
  it('项目会话恒 work,显式选择也压不过(chat 按定义不带 Project)', () => {
    expect(newSessionPreset('chat', cloudWs, 'web')).toBeUndefined()
    expect(newSessionPreset('chat', localWs, 'desktop')).toBeUndefined()
  })
  it('无根工作区恒 chat(它就是 Chat 的项目,Work 模式里它的 + 建的也是 chat);未选工作区听侧栏模式', () => {
    expect(newSessionPreset('chat', null, 'desktop')).toBe('chat')
    expect(newSessionPreset('work', rootless, 'web')).toBe('chat')
    expect(newSessionPreset('work', null, 'mobile')).toBeUndefined()
  })
  it('未选工作区且没手选模式 → 按端默认(desktop→work,web/mobile→chat)', () => {
    expect(newSessionPreset(null, rootless, 'desktop')).toBe('chat')
    expect(newSessionPreset(null, null, 'desktop')).toBeUndefined()
    expect(newSessionPreset(null, null, 'web')).toBe('chat')
    expect(newSessionPreset(null, null, 'mobile')).toBe('chat')
  })
})

describe('侧栏 Chat/Work 模式:端默认解析 + 列表过滤(views/sessionMode.ts)', () => {
  it('effectiveSessionMode:手选优先;没选按端默认', () => {
    expect(effectiveSessionMode(null, 'desktop')).toBe('work')
    expect(effectiveSessionMode(null, 'web')).toBe('chat')
    expect(effectiveSessionMode(null, 'mobile')).toBe('chat')
    expect(effectiveSessionMode('chat', 'desktop')).toBe('chat')
    expect(effectiveSessionMode('work', 'mobile')).toBe('work')
  })
  it('chat 模式只看无根会话与无根组(不分侧);work 模式全部(含无根);叠加桌面左栏的本地/云端侧过滤时无根恒在', () => {
    const list = [{ id: 'a', projectless: true, project_path: null }, { id: 'b', projectless: false, project_path: '/p' }, { id: 'c', project_path: null }]
    const localSide = (x: { project_path?: string | null }) => !!x.project_path
    expect(sessionsInMode(list, 'chat').map((x) => x.id)).toEqual(['a'])
    expect(sessionsInMode(list, 'chat', localSide).map((x) => x.id)).toEqual(['a']) // chat 不分侧
    expect(sessionsInMode(list, 'work')).toBe(list)
    expect(sessionsInMode(list, 'work', localSide).map((x) => x.id)).toEqual(['a', 'b']) // 本地侧 + 无根恒在
    expect(workspacesInMode([cloudWs, localWs, rootless], 'chat')).toEqual([rootless])
    expect(workspacesInMode([cloudWs, localWs, rootless], 'work')).toHaveLength(3)
    expect(workspacesInMode([cloudWs, localWs, rootless], 'work', (w) => w.kind === 'local')).toEqual([localWs, rootless])
  })
})

describe('applyPreset(唯一物化点,creview F1/F6)', () => {
  it('chat:强制 sandbox/无 cwd,剥掉外部引擎/计划/群聊残值;work 原样', () => {
    const draft = { execMode: 'host', cwd: '/x', engineId: 'codex', engineModelId: 'm', planMode: true, groupChat: true, thinkingLevel: 'high' } as never
    expect(applyPreset(draft, 'chat')).toMatchObject({ preset: 'chat', execMode: 'sandbox', thinkingLevel: 'high' })
    for (const k of ['cwd', 'engineId', 'engineModelId', 'planMode', 'groupChat']) expect((applyPreset(draft, 'chat') as Record<string, unknown>)[k]).toBeUndefined()
    expect(applyPreset(draft, undefined)).toBe(draft)
  })
})

describe('stickyDefaults 思考档分槽(D36)', () => {
  it('chat 缺省 off,且 dc 为 null(web/mobile)时也是 off', () => {
    expect(stickyDefaults(null, false, 'chat').thinkingLevel).toBe('off')
    expect(stickyDefaults({ lastThinkingLevel: 'high' } as never, false, 'chat').thinkingLevel).toBe('off')
  })
  it('chat 槽与 work 槽互不污染', () => {
    const dc = { lastThinkingLevel: 'high', lastChatThinkingLevel: 'low' } as never
    expect(stickyDefaults(dc, false, 'chat').thinkingLevel).toBe('low')
    expect(stickyDefaults(dc, false).thinkingLevel).toBe('high')
    expect(stickyDefaults({ lastChatThinkingLevel: 'high' } as never, false).thinkingLevel).toBeUndefined() // work 不读 chat 槽
  })
})

describe('currentPlatform 每次现算', () => {
  const g = globalThis as { window?: unknown }
  afterEach(() => { delete g.window })
  it('node 无 window → desktop;cloudWeb → web;mobile → mobile', () => {
    expect(currentPlatform()).toBe('desktop')
    g.window = { tangu: { cloudWeb: true } }
    expect(currentPlatform()).toBe('web')
    g.window = { tangu: { mobile: true } }
    expect(currentPlatform()).toBe('mobile')
  })
})

const initial = useApp.getState()
let oldServer = false // 老引擎:POST 忽略 agent_config,回来的行里是 null
const created = (id: string, init: { model_id?: string; projectless?: boolean; agent_config?: unknown }) =>
  ({ id, title: 'New Chat', model_id: init?.model_id ?? null, created_at: '', updated_at: '', projectless: !!init?.projectless, agent_config: oldServer ? null : (init?.agent_config ?? null) })
const createdInit = (): Record<string, unknown> => createSessionMock.mock.calls[0][1]
const createdCfg = (): Record<string, unknown> => createdInit().agent_config as Record<string, unknown>

describe('新建 chat 会话:恒 projectless + sandbox,初始配置随 POST 原子落库', () => {
  const g = globalThis as { window?: unknown }
  beforeEach(() => {
    useApp.setState(initial, true)
    useApp.setState({
      tr: ((k: string) => k) as AppState['tr'],
      activeId: null,
      desktopMode: 'external', // web 云壳:引擎在云端,无 host FS
      modelsResp: { models: [], defaultModelId: 'backend-default' } as unknown as AppState['modelsResp'],
    })
    oldServer = false
    createSessionMock.mockReset()
    putSessionConfigMock.mockReset()
    listSessionsMock.mockReset()
    startRunMock.mockReset()
    usePageStore.setState({ vaultRoot: null })
    createSessionMock.mockImplementation((_cfg: unknown, init: { model_id?: string; projectless?: boolean; agent_config?: unknown }) => Promise.resolve(created('s-new', init)))
    putSessionConfigMock.mockResolvedValue({})
    startRunMock.mockRejectedValue(new Error('stop here')) // 建会话之后就够断言了
  })
  afterEach(() => { delete g.window })

  it('send():web 端未选工作区 → 按端默认 chat → projectless、sandbox、无 Project、preset=chat 随 POST 落库;暂存选择被消费;引擎回显配置则不补 PUT', async () => {
    g.window = { tangu: { cloudWeb: true } }
    await useApp.getState().send('你好', [])
    expect(createSessionMock).toHaveBeenCalledTimes(1)
    const init = createdInit()
    expect(init).toMatchObject({ projectless: true })
    expect(init).not.toHaveProperty('project_name')
    expect(init).not.toHaveProperty('project_path')
    expect(createdCfg()).toMatchObject({ execMode: 'sandbox', preset: 'chat', thinkingLevel: 'off' })
    expect(createdCfg()).not.toHaveProperty('workspaceProject')
    const cfg = startRunMock.mock.calls[0]?.[1].agentConfig
    expect(cfg).toMatchObject({ execMode: 'sandbox', preset: 'chat', thinkingLevel: 'off' })
    expect(useApp.getState().sessionMode).toBeNull() // 模式是持久状态,建会话不消费它(null = 端默认)
    expect(putSessionConfigMock).not.toHaveBeenCalled()
  })

  it('老引擎(POST 忽略 agent_config)→ 回来的 agent_config 为空 → 补一次 PUT,内容同 init', async () => {
    oldServer = true
    g.window = { tangu: { cloudWeb: true } }
    await useApp.getState().send('你好', [])
    expect(putSessionConfigMock).toHaveBeenCalledTimes(1)
    expect(putSessionConfigMock.mock.calls[0][2]).toEqual(createdCfg())
    expect(putSessionConfigMock.mock.calls[0][2]).toMatchObject({ preset: 'chat', execMode: 'sandbox' })
  })

  it('send():桌面端未选工作区默认 work(落默认 Tangu Project);空态显式选 chat 则强制无根 sandbox', async () => {
    useApp.setState({ desktopMode: 'managed', defaultWsDir: '/default' })
    await useApp.getState().send('你好', [])
    expect(createdInit()).toMatchObject({ project_path: '/default' })
    expect(createdCfg()).not.toHaveProperty('preset')
    expect(startRunMock.mock.calls[0]?.[1].agentConfig).not.toHaveProperty('preset')

    createSessionMock.mockClear(); startRunMock.mockClear()
    useApp.setState({ activeId: null, sessionMode: 'chat' })
    await useApp.getState().send('随便聊聊', [])
    expect(createdInit()).toMatchObject({ projectless: true })
    expect(createdInit()).not.toHaveProperty('project_path')
    expect(startRunMock.mock.calls[0]?.[1].agentConfig).toMatchObject({ execMode: 'sandbox', preset: 'chat' })
    expect(startRunMock.mock.calls[0]?.[1].agentConfig.cwd).toBeUndefined()
  })

  it('creview F1:草稿残留的外部引擎/计划/host 审批在 chat 下被剥掉(否则 chat 走 ACP 直打真实磁盘)', async () => {
    useApp.setState({
      desktopMode: 'managed', defaultWsDir: '/default', sessionMode: 'chat',
      newChatCfg: { engineId: 'codex', engineModelId: 'gpt', planMode: true, groupChat: true, execMode: 'host', approvalMode: 'full-auto' } as never,
    })
    await useApp.getState().send('你好', [])
    const cfg = createdCfg()
    expect(cfg).toMatchObject({ preset: 'chat', execMode: 'sandbox' })
    for (const k of ['engineId', 'engineModelId', 'planMode', 'groupChat', 'cwd']) expect(cfg[k]).toBeUndefined()
    expect(startRunMock.mock.calls[0]?.[1].agentConfig.engineId).toBeUndefined()
  })

  it('send():项目工作区里选了 chat 也不生效(项目会话恒 work)', async () => {
    useApp.setState({ newChatWs: cloudWs, sessionMode: 'chat' })
    await useApp.getState().send('你好', [])
    expect(createdInit()).toMatchObject({ project_name: 'Tangu' })
    expect(createdCfg()).toMatchObject({ workspaceProject: 'Tangu' })
    expect(createdCfg()).not.toHaveProperty('preset')
  })

  it('createInWorkspace(无根)→ chat 会话:projectless + sandbox + preset 随 POST;云项目 → work', async () => {
    await useApp.getState().createInWorkspace(rootless)
    expect(createdInit()).toMatchObject({ projectless: true })
    expect(createdCfg()).toMatchObject({ execMode: 'sandbox', preset: 'chat', thinkingLevel: 'off' })
    expect(createdCfg()).not.toHaveProperty('workspaceProject')
    expect(putSessionConfigMock).not.toHaveBeenCalled()

    createSessionMock.mockClear()
    await useApp.getState().createInWorkspace(cloudWs)
    expect(createdInit()).toMatchObject({ project_name: 'Tangu' })
    expect(createdCfg()).toMatchObject({ workspaceProject: 'Tangu' })
    expect(createdCfg()).not.toHaveProperty('preset')
  })

  it('newSession()(/new、侧栏按钮)三种落点:web 默认 → 无根 chat;web 显式 work → 默认云项目(与 send 同落点);桌面 → 默认工作区', async () => {
    g.window = { tangu: { cloudWeb: true } }
    await useApp.getState().newSession()
    expect(createdInit()).toMatchObject({ projectless: true })
    expect(createdCfg()).toMatchObject({ execMode: 'sandbox', preset: 'chat' })

    createSessionMock.mockClear()
    useApp.setState({ activeId: null, sessionMode: 'work' })
    await useApp.getState().newSession()
    expect(createdInit()).toMatchObject({ project_name: DEFAULT_CLOUD_PROJECT })
    expect(createdCfg()).toMatchObject({ execMode: 'sandbox', workspaceProject: DEFAULT_CLOUD_PROJECT })
    expect(createdCfg()).not.toHaveProperty('preset')

    delete g.window; createSessionMock.mockClear()
    useApp.setState({ desktopMode: 'managed', defaultWsDir: '/default', activeId: null })
    await useApp.getState().newSession()
    expect(createdInit()).toMatchObject({ project_path: '/default' })
    expect(createdCfg()).not.toHaveProperty('preset')
  })

  it('setSessionMode:持久(localStorage);选 chat 清空工作区选择(chat 无项目);选 work 从无根退回端默认;切模式丢草稿思考档', () => {
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage ??= {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) },
    }
    useApp.setState({ newChatWs: cloudWs, newChatCfg: { thinkingLevel: 'high', approvalMode: 'auto-edit' } as never })
    useApp.getState().setSessionMode('chat')
    expect(useApp.getState().sessionMode).toBe('chat')
    expect(useApp.getState().newChatWs).toBeNull()
    expect(useApp.getState().newChatCfg).not.toHaveProperty('thinkingLevel')
    expect(useApp.getState().newChatCfg).toMatchObject({ approvalMode: 'auto-edit' })
    expect(newSessionPreset(useApp.getState().sessionMode, useApp.getState().newChatWs, 'desktop')).toBe('chat')
    expect(localStorage.getItem('forsion_tangu_session_mode')).toBe('chat')
    useApp.setState({ newChatWs: rootless })
    useApp.getState().setSessionMode('work')
    expect(useApp.getState().newChatWs).toBeNull()
    expect(localStorage.getItem('forsion_tangu_session_mode')).toBe('work')
  })

  it('setSessionEngine:chat 会话不委托外部引擎(空操作,不 PUT);work 会话照旧', () => {
    useApp.setState({ configBySession: { c1: { preset: 'chat' }, w1: {} } })
    useApp.getState().setSessionEngine('codex', 'c1')
    expect(useApp.getState().configBySession.c1).toEqual({ preset: 'chat' })
    expect(putSessionConfigMock).not.toHaveBeenCalled()
    useApp.getState().setSessionEngine('codex', 'w1')
    expect(useApp.getState().configBySession.w1).toMatchObject({ engineId: 'codex' })
  })

  it('refreshSessions:列表自带的 agent_config 预填本地缺席的会话(重载后 chat 立刻按 chat 渲染),本地已有的不覆盖', async () => {
    listSessionsMock.mockImplementation((_c: unknown, archived: boolean) => Promise.resolve(archived ? [] : [
      { id: 'p1', title: 't', model_id: null, archived: false, emoji: null, agent_config: { preset: 'chat', execMode: 'sandbox' }, created_at: '', updated_at: '' },
      { id: 'p2', title: 't', model_id: null, archived: false, emoji: null, agent_config: { preset: 'chat' }, created_at: '', updated_at: '' },
    ]))
    useApp.setState({ configBySession: { p2: { thinkingLevel: 'high' } } })
    await useApp.getState().refreshSessions(useApp.getState().cfg)
    expect(useApp.getState().configBySession.p1).toEqual({ preset: 'chat', execMode: 'sandbox' })
    expect(useApp.getState().configBySession.p2).toEqual({ thinkingLevel: 'high' }) // local-wins
  })

  it('chat 会话里调思考档只写 chat 槽;work 会话只写 work 槽', () => {
    g.window = { tangu: {} } // rememberDefaults 会经 window.tangu?.setConfig 落盘(可选链,桌面壳缺席即跳过)
    useApp.setState({ desktopConfig: {} as never, configBySession: { c1: { preset: 'chat' }, w1: {} }, activeId: 'c1' })
    useApp.getState().setSessionThinking('high', 'c1')
    expect(useApp.getState().desktopConfig).toMatchObject({ lastChatThinkingLevel: 'high' })
    expect(useApp.getState().desktopConfig).not.toHaveProperty('lastThinkingLevel')
    useApp.getState().setSessionThinking('low', 'w1')
    expect(useApp.getState().desktopConfig).toMatchObject({ lastChatThinkingLevel: 'high', lastThinkingLevel: 'low' })
  })
})
