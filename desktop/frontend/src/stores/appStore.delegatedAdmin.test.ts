/**
 * 委托管理员(Unit 网页的那一种来路,window.tangu.delegatedAdmin):
 *   · connect 只拉 Agent 管理要的三份目录(模型 / 技能 / Agent),会话、项目、外部引擎、后台 Agent 配置、团队一条都不发;
 *     探针换成白名单内的 agents-meta;
 *   · 同一种提示合并成一条(「只能在本机进行」不管从哪条请求来都并成一条);
 *   · 角色键不在 → 与改版前一样照发会话等(负对照,证明上面那条不是假绿)。
 * 跑:cd desktop && npx vitest run frontend/src/stores/appStore.delegatedAdmin.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { useApp } = await import('./appStore')
await import('../tangu/store/standalone')
const { useNotifications } = await import('./notificationStore')
const { localOnlyMessage } = await import('../services/localOnly')
const initial = useApp.getState()

const hits: string[] = []
function arm(delegated: boolean): void {
  const tangu: Record<string, unknown> = {
    unitPage: true,
    remoteCaller: true,
    getConfig: async () => ({ mode: 'external', backendUrl: 'http://unit.test/engine', token: 'tunnel', modelId: '' }),
    authStatus: async () => null,
    ...(delegated ? { delegatedAdmin: { name: 'Alex' } } : {}),
  }
  ;(globalThis as any).window = { tangu, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true, location: { search: '' } }
  useApp.setState({ ...initial, tr: (k: string) => k }, true)
}

beforeEach(() => {
  hits.length = 0
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(String(url)).pathname.replace(/^\/engine/, '')
    hits.push(path)
    const body = path === '/health' ? { ok: true, sandbox: 'none' }
      : path === '/agent/agents' ? { agents: [], approvalCap: 'auto-edit' }
      : path === '/agent/agents-meta' ? { defaultSlug: 'xyra', order: [] }
      : path === '/agent/models' ? { models: [], directProviders: [] }
      : path === '/agent/skills' ? { skills: [] }
      : path === '/agent/sessions' ? { sessions: [] }
      : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as any).window })

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }
const WHITELISTED = new Set(['/health', '/agent/agents-meta', '/agent/agents', '/agent/models', '/agent/skills'])

describe('委托管理员 · connect', () => {
  it('只发白名单内的目录请求;探针走 agents-meta;连上即可(不选会话)', async () => {
    arm(true)
    const s = useApp.getState()
    await s.connect({ backendUrl: 'http://unit.test/engine', token: 'tunnel', modelId: '' } as any)
    await settle()
    expect(useApp.getState().connState).toBe('ok')
    expect(hits.filter((p) => !WHITELISTED.has(p))).toEqual([])
    expect(hits).toContain('/agent/agents')
    expect(hits).toContain('/agent/models')
    expect(hits).not.toContain('/agent/special/config')
    // 关设置等调用点的刷新同样不发
    await useApp.getState().refreshSpecialEnabled(useApp.getState().cfg)
    await useApp.getState().refreshTeams()
    expect(await useApp.getState().refreshSessions(useApp.getState().cfg)).toEqual([])
    await settle()
    expect(hits.filter((p) => !WHITELISTED.has(p))).toEqual([])
  })
  it('负对照:没有角色键时照旧拉会话 / 后台 Agent 配置 / 团队', async () => {
    arm(false)
    await useApp.getState().connect({ backendUrl: 'http://unit.test/engine', token: 'tunnel', modelId: '' } as any)
    await settle()
    expect(hits).toContain('/agent/sessions')
    expect(hits).toContain('/agent/special/config')
  })
})

describe('委托管理员 · 提示合并', () => {
  it('「只能在本机进行」不论前缀都并成一条(计数叠加);别的来路照旧一条一条', () => {
    arm(true)
    useNotifications.setState({ items: [], queue: [] } as any)
    const msg = localOnlyMessage()
    useApp.getState().toast(msg, true)
    useApp.getState().toast(`app.sessionListLoadFail: ${msg}`, true)
    useApp.getState().toast(msg, true)
    const st = useNotifications.getState()
    const all = [...st.items, ...st.queue].filter((n) => n.text === msg)
    expect(all).toHaveLength(1)
    expect(all[0].count).toBe(3)
    arm(false)
    useNotifications.setState({ items: [], queue: [] } as any)
    useApp.getState().toast(msg, true)
    useApp.getState().toast(msg, true)
    const plain = useNotifications.getState()
    expect([...plain.items, ...plain.queue].filter((n) => n.text === msg).length).toBe(2)
  })
})
