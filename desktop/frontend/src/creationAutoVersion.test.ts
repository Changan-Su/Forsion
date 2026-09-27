// @vitest-environment happy-dom
/**
 * 造物里的项目在任何 Space 跑完一轮都存一版:只认托管根的直接子目录、只认「跑着 → 停了」那一沿、
 * writable=false(没 git / 用户自己的仓)不写;web / 移动端(没有 git IPC)整个不装。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCreationAutoVersion, isCreationDir } from './creationAutoVersion'
import { useApp } from './stores/appStore'

const ROOT = '/Users/me/Forsion/Project'
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => { delete (window as any).tangu })

describe('isCreationDir', () => {
  it('托管根的直接子目录才算;根本身、更深的子目录、别处都不算;斜杠规整', () => {
    expect(isCreationDir(`${ROOT}/game`, ROOT)).toBe(true)
    expect(isCreationDir(`${ROOT}/game/`, `${ROOT}/`)).toBe(true)
    expect(isCreationDir('C:\\Users\\me\\Forsion\\Project\\game', 'C:/Users/me/Forsion/Project')).toBe(true)
    expect(isCreationDir(ROOT, ROOT)).toBe(false)
    expect(isCreationDir(`${ROOT}/game/src`, ROOT)).toBe(false)
    expect(isCreationDir('/Users/me/Notes/Sessions', ROOT)).toBe(false)
    expect(isCreationDir('', ROOT)).toBe(false)
  })
})

describe('installCreationAutoVersion', () => {
  it('作品会话一轮跑完存一版(标题取最后一条用户消息);非作品 / 仍在跑 / 不可写都不存', async () => {
    const commit = vi.fn(async () => ({ id: 'x' }))
    const status = vi.fn(async (root: string) => ({ available: true, state: 'owned', dirty: true, writable: !root.endsWith('/readonly') }))
    ;(window as any).tangu = { codeStudioGitCommit: commit, codeStudioGitStatus: status, codeProjectsRoot: async () => ROOT }
    useApp.setState({
      sessions: [
        { id: 'a', project_path: `${ROOT}/game` },
        { id: 'b', project_path: '/Users/me/Notes/Sessions' },
        { id: 'c', project_path: `${ROOT}/readonly` },
      ],
      configBySession: {},
      messagesBySession: { a: [{ id: 'u1', role: 'user', content: '加一个暂停按钮\n细节…' }] },
      runningBySession: { a: 'r1', b: 'r2', c: 'r3' },
    } as never)
    const off = installCreationAutoVersion()
    await tick()
    useApp.setState({ runningBySession: { b: 'r2', c: 'r3' } } as never) // a 停了
    useApp.setState({ runningBySession: { c: 'r3' } } as never)          // b 停了(不是作品)
    useApp.setState({ runningBySession: {} } as never)                   // c 停了(不可写)
    await tick(); await tick()
    off?.()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith(`${ROOT}/game`, expect.objectContaining({ name: '加一个暂停按钮', auto: true }))
    expect(status).toHaveBeenCalledWith(`${ROOT}/readonly`)
  })

  it('同一作品里两个会话并跑:先停的那个不存(另一个还在写),最后一个停下才存;路径大小写不同也算同一个', async () => {
    const commit = vi.fn(async () => ({ id: 'x' }))
    const status = vi.fn(async () => ({ available: true, state: 'owned', dirty: true, writable: true }))
    ;(window as any).tangu = { codeStudioGitCommit: commit, codeStudioGitStatus: status, codeProjectsRoot: async () => ROOT }
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
    ;(window as any).tangu = { codeStudioGitCommit: commit, codeStudioGitStatus: status, codeProjectsRoot: async () => ROOT }
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
