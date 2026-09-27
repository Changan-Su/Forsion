// @vitest-environment happy-dom
/**
 * 造物里的项目在任何 Space 跑完一轮都存一版:是不是造物问宿主(products:isCreation)、只认「跑着 → 停了」那一沿、
 * 宿主说不自动存(auto=false:没 git / 用户自己的仓 / 外部造物还没开版本历史)就不存;web / 移动端(没有这组 IPC)整个不装。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCreationAutoVersion } from './creationAutoVersion'
import { useApp } from './stores/appStore'

const ROOT = '/Users/me/Forsion/Project'
const tick = () => new Promise((r) => setTimeout(r, 0))
/** 造物 = 托管根下的这几个 + 一个原地加入的外部文件夹(宿主判;这里按表模拟)。 */
const CREATIONS = new Set([`${ROOT}/game`, `${ROOT}/readonly`, `${ROOT}/Game/`, '/Users/me/code/site', '/Users/me/code/fresh'])
const isCreation = vi.fn(async (dir: string) => CREATIONS.has(dir))

afterEach(() => { delete (window as any).tangu; isCreation.mockClear() })

describe('installCreationAutoVersion', () => {
  it('作品会话一轮跑完存一版(标题取最后一条用户消息);非作品 / 仍在跑 / 不可写都不存', async () => {
    const commit = vi.fn(async (_root: string, _input: unknown) => ({ id: 'x' }))
    const status = vi.fn(async (root: string) => ({
      available: true, state: root.endsWith('/fresh') ? 'none' : 'owned', dirty: true, writable: !root.endsWith('/readonly'),
      // 外部造物还没开版本历史:可写(手动保存第一个版本)但不自动存;/site 是开过的(我方仓)
      ...(root.startsWith('/Users/me/code/') ? { auto: root.endsWith('/site') } : {}),
    }))
    ;(window as any).tangu = { codeStudioGitCommit: commit, codeStudioGitStatus: status, productsIsCreation: isCreation }
    useApp.setState({
      sessions: [
        { id: 'a', project_path: `${ROOT}/game` },
        { id: 'b', project_path: '/Users/me/Notes/Sessions' },
        { id: 'c', project_path: `${ROOT}/readonly` },
        { id: 'd', project_path: '/Users/me/code/site' },
        { id: 'e', project_path: '/Users/me/code/fresh' },
      ],
      configBySession: {},
      messagesBySession: { a: [{ id: 'u1', role: 'user', content: '加一个暂停按钮\n细节…' }] },
      runningBySession: { a: 'r1', b: 'r2', c: 'r3', d: 'r4', e: 'r5' },
    } as never)
    const off = installCreationAutoVersion()
    await tick()
    useApp.setState({ runningBySession: { b: 'r2', c: 'r3', d: 'r4', e: 'r5' } } as never) // a 停了
    useApp.setState({ runningBySession: { c: 'r3', d: 'r4', e: 'r5' } } as never)          // b 停了(不是作品)
    useApp.setState({ runningBySession: { d: 'r4', e: 'r5' } } as never)                   // c 停了(不可写,没 auto → 按 writable)
    useApp.setState({ runningBySession: { e: 'r5' } } as never)                            // d 停了(外部造物,开过版本历史)
    useApp.setState({ runningBySession: {} } as never)                                     // e 停了(外部造物,还没开 → 不自动建仓)
    await tick(); await tick(); await tick()
    off?.()
    expect(commit.mock.calls.map((c) => c[0])).toEqual([`${ROOT}/game`, '/Users/me/code/site'])
    expect(commit).toHaveBeenCalledWith(`${ROOT}/game`, expect.objectContaining({ name: '加一个暂停按钮', auto: true }))
    expect(status).toHaveBeenCalledWith(`${ROOT}/readonly`)
    expect(status).toHaveBeenCalledWith('/Users/me/code/fresh')
    expect(status).not.toHaveBeenCalledWith('/Users/me/Notes/Sessions') // 不是造物:连状态都不问
  })

  it('同一作品里两个会话并跑:先停的那个不存(另一个还在写),最后一个停下才存;路径大小写不同也算同一个', async () => {
    const commit = vi.fn(async () => ({ id: 'x' }))
    const status = vi.fn(async () => ({ available: true, state: 'owned', dirty: true, writable: true }))
    ;(window as any).tangu = { codeStudioGitCommit: commit, codeStudioGitStatus: status, productsIsCreation: isCreation }
    useApp.setState({
      sessions: [{ id: 'a', project_path: `${ROOT}/game` }, { id: 'b', project_path: `${ROOT}/Game/` }],
      configBySession: {}, messagesBySession: {}, runningBySession: { a: 'r1', b: 'r2' },
    } as never)
    const off = installCreationAutoVersion()
    await tick()
    useApp.setState({ runningBySession: { b: 'r2' } } as never) // a 停了,b 还在写同一个文件夹
    await tick(); await tick()
    expect(commit).not.toHaveBeenCalled()
    useApp.setState({ runningBySession: {} } as never)          // b 也停了
    await tick(); await tick()
    off?.()
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('查状态那一下里同一作品又跑起来一个 run → 这次不存', async () => {
    const commit = vi.fn(async () => ({ id: 'x' }))
    const status = vi.fn(async () => {
      useApp.setState({ runningBySession: { b: 'r9' } } as never) // 查状态的同时,b 在同一个作品里开跑
      return { available: true, state: 'owned', dirty: true, writable: true }
    })
    ;(window as any).tangu = { codeStudioGitCommit: commit, codeStudioGitStatus: status, productsIsCreation: isCreation }
    useApp.setState({
      sessions: [{ id: 'a', project_path: `${ROOT}/game` }, { id: 'b', project_path: `${ROOT}/game` }],
      configBySession: {}, messagesBySession: {}, runningBySession: { a: 'r1' },
    } as never)
    const off = installCreationAutoVersion()
    await tick()
    useApp.setState({ runningBySession: {} } as never)
    await tick(); await tick()
    off?.()
    expect(status).toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('没有 git IPC(web / 移动端)→ 整个不装', () => {
    ;(window as any).tangu = {}
    const before = useApp.getState()
    installCreationAutoVersion()
    expect(useApp.getState()).toBe(before)
  })
})
