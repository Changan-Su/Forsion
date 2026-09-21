// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { StudioBrief } from './projectBrief'
import type { GitPanelStatus, GitRepoState, GitVersion } from '../../../../shared/products'
// 安装引导复用 onboarding.env.* 这一族文案,它们住在 generated 字典里(运行期由 main.tsx 注册)。
// 不 import 就只能断言键名本身 —— 那等于把「文案压根没注册」这类故障测成绿的。
import '../../i18n.generated'

const { state, appState, saveFile, flushEditors, unsavedEditors } = vi.hoisted(() => ({
  state: { activeProject: '/projects/a', projects: {} as Record<string, { brief: StudioBrief }>, updateProject: vi.fn() },
  // HistoryPanel 的「别在生成中动源码」闸门读的是这两个字段,给 `{}` 会当场炸在 sessions.some 上。
  // 可变是刻意的:有测试要把「这个项目正在跑一轮生成」摆进来,写死成空数组等于永远绕开那条闸门。
  appState: { sessions: [] as Array<{ id: string; project_path: string }>, runningBySession: {} as Record<string, boolean> },
  saveFile: vi.fn(),
  flushEditors: vi.fn(async () => true),
  unsavedEditors: vi.fn(() => false),
}))
vi.mock('./briefFile', () => ({ saveStudioBriefFile: saveFile }))
vi.mock('./editorSession', () => ({ flushStudioEditors: flushEditors, hasUnsavedStudioEditors: unsavedEditors }))
vi.mock('../../stores/appStore', () => ({ useApp: { getState: () => appState } }))
vi.mock('../../stores/codeStudioStore', () => ({ useCodeStudio: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }))
import { BriefPanel, HistoryPanel } from './StudioPanels'

const globals = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
globals.IS_REACT_ACT_ENVIRONMENT = true; globals.React = React
let host: HTMLDivElement
let root: Root
/** happy-dom 不保证有 window.confirm,所以直接换掉它(spyOn 在属性缺失时会直接抛)。 */
type ConfirmHost = { confirm?: (message?: string) => boolean }
let originalConfirm: ConfirmHost['confirm']
let confirmSpy: ReturnType<typeof vi.fn>
const answerConfirm = (answer: boolean) => {
  confirmSpy = vi.fn(() => answer)
  ;(window as unknown as ConfirmHost).confirm = confirmSpy
  return confirmSpy
}
const brief: StudioBrief = { idea: 'An offline notes app', audience: 'Students', constraints: 'No account', capabilities: [], locale: 'zh' }
const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  saveFile.mockReset(); state.updateProject.mockReset(); state.activeProject = '/projects/a'; state.projects = { '/projects/a': { brief: { ...brief } } }
  appState.sessions = []; appState.runningBySession = {}
  flushEditors.mockClear(); flushEditors.mockResolvedValue(true); unsavedEditors.mockClear(); unsavedEditors.mockReturnValue(false)
  // 安装引导会先 window.confirm 才动手装,默认放行;要测「用户点了取消」的用例自己改返回值。
  originalConfirm = (window as unknown as ConfirmHost).confirm
  answerConfirm(true)
  delete (globalThis as { tangu?: unknown }).tangu
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount() }); host.remove()
  ;(window as unknown as ConfirmHost).confirm = originalConfirm
  delete (globalThis as { tangu?: unknown }).tangu
})

/** 主进程那半由别的 agent 在写,这里只按 types.ts 的契约给桥打桩。 */
type Bridge = Partial<NonNullable<Window['tangu']>>
const bridge = (methods: Bridge): Bridge => {
  ;(globalThis as unknown as { tangu: Bridge }).tangu = methods
  return methods
}
const gitStatus = (patch: Partial<GitPanelStatus> & { state: GitRepoState }): GitPanelStatus => ({ available: true, dirty: false, writable: false, ...patch })
const version = (patch: Partial<GitVersion> & { id: string }): GitVersion => ({ name: patch.id, createdAt: Date.now() - 60_000, auto: false, files: 2, ...patch })
const mountHistory = async (props: Partial<Parameters<typeof HistoryPanel>[0]> = {}) => {
  const onRestored = vi.fn()
  await act(async () => { root.render(createElement(HistoryPanel, { root: '/projects/a', running: false, onRestored, ...props })) })
  return onRestored
}
const body = () => host.querySelector<HTMLElement>('.csu-panel-body')!
const text = () => body().textContent || ''
const click = async (element: Element | null | undefined) => { await act(async () => { (element as HTMLButtonElement).click() }) }
/** 受控 input 必须走原生 setter:直接赋 value 会绕过 React 的 value tracker,onChange 根本不触发。 */
const type = async (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('HistoryPanel 四态', () => {
  it('本机没装 git:给安装引导(命令 + 一键装 + 重新检测),不给任何版本控件', async () => {
    const envRun = vi.fn(async () => ({ exitCode: 0 }))
    const status = vi.fn(async () => gitStatus({ state: 'none', available: false }))
    const api = bridge({
      codeStudioGitStatus: status,
      codeStudioVersions: vi.fn(async () => []),
      codeStudioGitVersions: vi.fn(async () => []),
      envCheck: vi.fn(async () => [{ tool: 'node', found: true, version: '22', installId: null, installCommand: null },
        { tool: 'git', found: false, version: null, installId: 'git-brew', installCommand: 'brew install git' }]),
      envRun,
    })
    await mountHistory()
    expect(body().dataset.historyMode).toBe('install')
    expect(text()).toContain('编码工作室用 Git 记录项目版本')
    expect(host.querySelector('.csu-version-create')).toBeNull()
    // ⚠️面板只是被打开,**不许自己去探测环境**:通用探针会跑 `git --version`,没装命令行工具的 Mac 上那是
    //   /usr/bin/git 垫片,一跑就弹系统的「安装开发者工具」对话框。要等用户点「查看安装方式」。
    expect(api.envCheck).not.toHaveBeenCalled()
    expect(host.querySelector('.csu-git-cmd')).toBeNull()
    await click(host.querySelector('[data-action="git-show-install"]'))
    expect(api.envCheck).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.csu-git-cmd')?.textContent).toBe('brew install git')
    // 没装 git 时不去读提交列表 —— 那一定失败,只会把引导屏变成报错屏。
    expect(api.codeStudioGitVersions).not.toHaveBeenCalled()
    const [install, recheck] = [...host.querySelectorAll('.csu-git-actions button')]
    await click(install)
    // 在本机跑安装命令之前必须先问过用户,且问的就是将要执行的那条命令。
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(String(confirmSpy.mock.calls[0][0])).toContain('brew install git')
    expect(envRun).toHaveBeenCalledWith('git-brew')
    const afterInstall = status.mock.calls.length
    expect(afterInstall).toBeGreaterThan(1) // 装完自动复查宿主判定
    // exit 0 但复检仍没有 git(GUI PATH 没刷新)= 整屏一动不动 → 必须如实说一句。
    expect(host.querySelector('[role="status"]')?.textContent).toContain('仍未检测到 git')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await click(recheck)
    expect(status.mock.calls.length).toBeGreaterThan(afterInstall)
  })

  it('安装确认被取消时一条命令都不跑', async () => {
    const envRun = vi.fn(async () => ({ exitCode: 0 }))
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'none', available: false })),
      codeStudioVersions: vi.fn(async () => []),
      envCheck: vi.fn(async () => [{ tool: 'git', found: false, version: null, installId: 'git-brew', installCommand: 'brew install git' }]),
      envRun,
    })
    answerConfirm(false)
    await mountHistory()
    await click(host.querySelector('[data-action="git-show-install"]')) // 先让用户自己把安装方式点出来
    await click(host.querySelector('.csu-git-actions .csu-primary'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(envRun).not.toHaveBeenCalled()
  })

  it('可写的新项目:先说清会建 .git,没有改动时如实说「没有改动」而不是报错', async () => {
    const commit = vi.fn(async () => null)
    const versions = vi.fn(async () => [] as GitVersion[])
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'none', writable: true, dirty: true })),
      codeStudioGitVersions: versions,
      codeStudioGitCommit: commit,
      codeStudioGitRestore: vi.fn(),
      codeStudioVersions: vi.fn(async () => []),
    })
    await mountHistory()
    expect(body().dataset.historyMode).toBe('writable')
    expect(body().dataset.historyReason).toBe('studio.history.firstVersionNote')
    expect(text()).toContain('创建 Git 仓库')
    expect(text()).toContain('每轮 AI 改动结束后都会自动存一个版本')
    const loads = versions.mock.calls.length
    await type(host.querySelector<HTMLInputElement>('.csu-version-create input')!, '首页定稿')
    await click(host.querySelector('.csu-version-create .csu-primary'))
    expect(flushEditors).toHaveBeenCalledWith('/projects/a')
    // untitled 跟界面语言一起交给宿主:提交标题落盘即不可变,渲染期再翻译根本来不及。
    expect(commit).toHaveBeenCalledWith('/projects/a', { name: '首页定稿', auto: false, untitled: '未命名版本' })
    expect(host.querySelector('[role="status"]')?.textContent).toBe('与上一个版本相比没有改动。')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    // 没提交成任何东西就不该重新拉列表(拉了也只会闪一下空列表)。
    expect(versions.mock.calls.length).toBe(loads)
  })

  it('外来仓只读:说明理由,不给保存框也不给恢复按钮', async () => {
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'foreign' })),
      codeStudioGitVersions: vi.fn(async () => [version({ id: 'sha-1', name: 'Upstream commit' })]),
      codeStudioGitCommit: vi.fn(),
      codeStudioGitRestore: vi.fn(),
      codeStudioVersions: vi.fn(async () => []),
    })
    await mountHistory()
    expect(body().dataset.historyMode).toBe('readonly')
    expect(text()).toContain('它自己的 Git 仓库')
    expect(host.querySelector('.csu-version-create')).toBeNull()
    expect(host.querySelectorAll('.csu-version')).toHaveLength(1)
    expect(host.querySelector('.csu-version button')).toBeNull()
  })

  it('桥只有一半(能问状态、不能提交)时降级只读,而不是给一个按下去就炸的保存按钮', async () => {
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'none', writable: true })),
      codeStudioGitVersions: vi.fn(async () => []),
      codeStudioVersions: vi.fn(async () => []),
    })
    await mountHistory()
    expect(body().dataset.historyMode).toBe('readonly')
    // 降级不是「外来仓」那类业务理由,不该照搬 writable 那条 .git 提示 —— 但也不能一句解释都不给。
    expect(body().dataset.historyReason).toBe('studio.history.readonlyBridge')
    expect(text()).toContain('保存与恢复需要更新到新版本')
    expect(host.querySelector('.csu-version-create')).toBeNull()
  })

  it('宿主没有 git 桥(老版本 / web):整段不渲染,不误报「没装 git」,也不留一个纯空白面板', async () => {
    bridge({ codeStudioVersions: vi.fn(async () => []) })
    await mountHistory()
    expect(body().dataset.historyMode).toBe('unsupported')
    expect(host.querySelector('.csu-git-install')).toBeNull()
    expect(host.querySelector('.csu-version-create')).toBeNull()
    // 没有 git 桥又没有旧快照 = 整块面板一个字都没有,用户无从判断是「没有版本」还是「坏了」。
    expect(text()).toContain('这个仓库还没有提交')
  })
})

describe('HistoryPanel 恢复与旧快照', () => {
  it('恢复必须先确认,确认文案要讲清当前状态会先存成备份', async () => {
    const restore = vi.fn(async () => ({ backupId: 'sha-backup', restoreId: 'sha-restore' }))
    const versions = vi.fn(async () => [version({ id: 'sha-1', name: '首页定稿', auto: false }), version({ id: 'sha-2', name: 'AI 改动', auto: true })])
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'owned', writable: true })),
      codeStudioGitVersions: versions,
      codeStudioGitCommit: vi.fn(),
      codeStudioGitRestore: restore,
      codeStudioVersions: vi.fn(async () => []),
    })
    const onRestored = await mountHistory()
    expect(text()).toContain('自动') // 自动版本有独立标记
    expect(host.querySelector('.csu-version-auto')).not.toBeNull()
    await click(host.querySelector('[aria-label="恢复源码 首页定稿"]'))
    expect(restore).not.toHaveBeenCalled() // 一键直达恢复 = 不可接受
    const confirmBox = host.querySelector('.csu-restore-confirm')!
    expect(confirmBox.textContent).toContain('会先存成一个备份版本')
    const loads = versions.mock.calls.length
    await click(confirmBox.querySelector('.csu-primary'))
    // 备份 / 恢复提交的标题同样是落盘产物命名,必须带着当前语言的文案过桥。
    expect(restore).toHaveBeenCalledWith('/projects/a', 'sha-1', { backup: '恢复前的备份', restorePrefix: '恢复到:' })
    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('备份版本')
    expect(versions.mock.calls.length).toBeGreaterThan(loads)
  })

  it('生成中 / 有未保存改动时拒绝写动作,并说明要先处理什么', async () => {
    const commit = vi.fn(async () => version({ id: 'sha-9' }))
    unsavedEditors.mockReturnValue(true)
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'owned', writable: true })),
      codeStudioGitVersions: vi.fn(async () => []),
      codeStudioGitCommit: commit,
      codeStudioGitRestore: vi.fn(),
      codeStudioVersions: vi.fn(async () => []),
    })
    await mountHistory()
    await click(host.querySelector('.csu-version-create .csu-primary'))
    expect(commit).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('请先处理未保存的修改，并等待生成结束。')
  })

  it('这个项目正在跑一轮生成时,写动作全部禁用(不给点)', async () => {
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'owned', writable: true })),
      codeStudioGitVersions: vi.fn(async () => [version({ id: 'sha-1', name: '首页定稿' })]),
      codeStudioGitCommit: vi.fn(),
      codeStudioGitRestore: vi.fn(),
      codeStudioVersions: vi.fn(async () => []),
    })
    await mountHistory({ running: true })
    expect(host.querySelector<HTMLButtonElement>('.csu-version-create .csu-primary')!.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[aria-label="恢复源码 首页定稿"]')!.disabled).toBe(true)
  })

  it('闸门按项目收窄:本项目有会话在跑时拒绝提交并说明原因', async () => {
    const commit = vi.fn(async () => version({ id: 'sha-9' }))
    // running prop 为 false(面板自己不知道),真相在 app store 里 —— 闸门必须自己去查。
    appState.sessions = [{ id: 's1', project_path: '/projects/a' }, { id: 's2', project_path: '/projects/b' }]
    appState.runningBySession = { s1: true }
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'owned', writable: true })),
      codeStudioGitVersions: vi.fn(async () => []),
      codeStudioGitCommit: commit,
      codeStudioGitRestore: vi.fn(),
      codeStudioVersions: vi.fn(async () => []),
    })
    await mountHistory()
    await click(host.querySelector('.csu-version-create .csu-primary'))
    expect(commit).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('请先处理未保存的修改，并等待生成结束。')
    // 别的项目在跑与本项目无关:放开之后同一个按钮必须能提交。
    appState.runningBySession = { s2: true }
    await click(host.querySelector('.csu-version-create .csu-primary'))
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('启用 git 之前的旧快照始终可达(含没装 git 的机器),但不能再新增', async () => {
    const legacyRestore = vi.fn(async () => ({ restored: ['index.html'], deleted: [], conflicts: [], backupId: 'snap-0' }))
    bridge({
      codeStudioGitStatus: vi.fn(async () => gitStatus({ state: 'none', available: false })),
      codeStudioVersions: vi.fn(async () => [{ id: 'snap-1', name: '上线前快照', createdAt: Date.now() - 86_400_000, files: 7 }]),
      codeStudioRestore: legacyRestore,
      envCheck: vi.fn(async () => []),
    })
    const onRestored = await mountHistory()
    expect(body().dataset.historyMode).toBe('install')
    const legacy = host.querySelector('details.csu-legacy')!
    expect(legacy.textContent).toContain('上线前快照')
    expect(legacy.textContent).toContain('不再新增')
    expect(legacy.querySelector('input')).toBeNull()
    await click(legacy.querySelector('[aria-label="恢复源码 上线前快照"]'))
    await click(host.querySelector('.csu-restore-confirm .csu-primary'))
    expect(legacyRestore).toHaveBeenCalledWith('/projects/a', 'snap-1')
    expect(onRestored).toHaveBeenCalledTimes(1)
  })

  it('宿主报错时给出错误与重试,不静默停在空列表', async () => {
    const status = vi.fn(async () => { throw new Error('git exited 128') })
    bridge({ codeStudioGitStatus: status, codeStudioVersions: vi.fn(async () => []) })
    await mountHistory()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('git exited 128')
    await click(host.querySelector('[role="alert"] button'))
    expect(status.mock.calls.length).toBe(2)
  })
})

describe('BriefPanel save-before-prompt sequencing', () => {
  it('waits for a confirmed disk save, prevents same-frame duplicate submissions, then queues the saved snapshot once', async () => {
    const pending = deferred(); saveFile.mockReturnValue(pending.promise)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    const build = host.querySelector<HTMLButtonElement>('.csu-primary')!
    await act(async () => { build.click(); build.click() })
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(onPrompt).not.toHaveBeenCalled(); expect(state.updateProject).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('button,textarea')].every(item => (item as HTMLButtonElement).disabled)).toBe(true)
    await act(async () => { pending.resolve() })
    expect(state.updateProject).toHaveBeenCalledWith({ brief })
    expect(onPrompt).toHaveBeenCalledTimes(1)
    expect(onPrompt).toHaveBeenCalledWith(expect.stringContaining(brief.idea), false)
    expect(onPrompt.mock.calls[0][0]).toContain('请先阅读已保存的 FORSION_BRIEF.md')
    expect(onPrompt.mock.calls[0][0]).not.toContain('Working agreement')
    expect(saveFile.mock.invocationCallOrder[0]).toBeLessThan(state.updateProject.mock.invocationCallOrder[0])
    expect(state.updateProject.mock.invocationCallOrder[0]).toBeLessThan(onPrompt.mock.invocationCallOrder[0])
  })

  it('keeps the form and shows failure without changing project preferences or queuing a prompt, then allows retry', async () => {
    saveFile.mockRejectedValueOnce(new Error('Disk conflict')).mockResolvedValue(undefined)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    const build = host.querySelector<HTMLButtonElement>('.csu-primary')!
    await act(async () => { build.click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Disk conflict')
    expect(host.querySelector('textarea')?.value).toBe(brief.idea)
    expect(state.updateProject).not.toHaveBeenCalled(); expect(onPrompt).not.toHaveBeenCalled()
    expect(build.disabled).toBe(false)
    await act(async () => { build.click() })
    expect(saveFile).toHaveBeenCalledTimes(2)
    expect(state.updateProject).toHaveBeenCalledTimes(1); expect(onPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not submit an old project prompt or update a new project after the panel was closed', async () => {
    const pending = deferred(); saveFile.mockReturnValue(pending.promise)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    await act(async () => { host.querySelector<HTMLButtonElement>('.csu-primary')!.click() })
    await act(async () => { root.render(null) }); state.activeProject = '/projects/b'
    await act(async () => { pending.resolve() })
    expect(state.updateProject).not.toHaveBeenCalled(); expect(onPrompt).not.toHaveBeenCalled()
  })

  it('saving alone updates preferences after success without preparing an AI task', async () => {
    saveFile.mockResolvedValue(undefined)
    const onPrompt = vi.fn()
    await act(async () => { root.render(createElement(BriefPanel, { root: '/projects/a', onPrompt })) })
    // The first action is the explicit save button; no dependence on localized copy.
    await act(async () => { host.querySelector<HTMLButtonElement>('.csu-actions button')!.click() })
    expect(saveFile).toHaveBeenCalledTimes(1); expect(state.updateProject).toHaveBeenCalledTimes(1)
    expect(onPrompt).not.toHaveBeenCalled()
  })
})
