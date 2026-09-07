// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectLaunchpad } from './ProjectLaunchpad'

let host: HTMLDivElement
let reactRoot: Root
const onOpen = vi.fn()
const onCreate = vi.fn()
const listDir = vi.fn(async () => [] as Array<{ name: string; path: string; isDir: boolean; size: number }>)
const mkdirHost = vi.fn(async (_root: string, name: string) => ({ path: `/projects/${name}` }))
const pickDirectory = vi.fn(async (): Promise<string | null> => 'C:\\Users\\Jane\\Existing project')

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onOpen.mockReset(); onCreate.mockReset()
  listDir.mockReset().mockResolvedValue([])
  mkdirHost.mockClear(); pickDirectory.mockClear()
  window.tangu = { listDir, mkdirHost, pickDirectory } as unknown as NonNullable<typeof window.tangu>
  host = document.createElement('div'); document.body.append(host)
  reactRoot = createRoot(host)
})
afterEach(async () => {
  await act(async () => { reactRoot.unmount() })
  host.remove(); delete window.tangu; vi.unstubAllGlobals()
})
async function mount() {
  await act(async () => { reactRoot.render(createElement(ProjectLaunchpad, { root: '/projects', onOpen, onCreate })) })
}
async function useFirstTemplate() {
  await act(async () => { (host.querySelector('.csl-template') as HTMLButtonElement).click() })
}
async function submit() {
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('project launchpad', () => {
  it('creates a real folder and returns an editable brief without opening or running it', async () => {
    await mount(); await useFirstTemplate(); await submit()
    expect(mkdirHost).toHaveBeenCalledWith('/projects', 'writing-assistant')
    expect(onCreate).toHaveBeenCalledWith('/projects/writing-assistant', 'writing-assistant', expect.objectContaining({
      idea: expect.stringContaining('AI'), capabilities: ['chat'], templateId: 'assistant', locale: 'zh',
    }))
    expect(onOpen).not.toHaveBeenCalled()
  })
  it('rechecks names on submit and refuses a newly created duplicate file', async () => {
    await mount(); await useFirstTemplate()
    listDir.mockResolvedValue([{ name: 'Writing-Assistant', path: '/projects/Writing-Assistant', isDir: false, size: 3 }])
    await submit()
    expect(mkdirHost).not.toHaveBeenCalled()
    expect(onCreate).not.toHaveBeenCalled()
    expect(host.textContent).toContain('同名项目或文件已存在')
  })
  it('does not create twice while the submission check is in flight', async () => {
    await mount(); await useFirstTemplate()
    let complete!: (value: []) => void
    listDir.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    await submit(); await submit()
    expect(listDir).toHaveBeenCalledTimes(2) // Initial load and a single submission check.
    await act(async () => { complete([]) })
    expect(mkdirHost).toHaveBeenCalledTimes(1)
  })
  it('imports a local folder without creating or rewriting it', async () => {
    await mount()
    await act(async () => { (host.querySelector('.csl-import') as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith('C:\\Users\\Jane\\Existing project', 'Existing project')
    expect(mkdirHost).not.toHaveBeenCalled()
    expect(onCreate).not.toHaveBeenCalled()
  })
  it('shows directory failures instead of presenting an empty success state', async () => {
    listDir.mockRejectedValue(new Error('permission denied'))
    await mount()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法读取项目目录')
    expect(host.querySelector('.csl-empty')).toBeNull()
  })
  it('keeps the brief on a create failure', async () => {
    mkdirHost.mockRejectedValueOnce(new Error('permission denied'))
    await mount(); await useFirstTemplate(); await submit()
    expect((host.querySelector('.csl-idea') as HTMLTextAreaElement).value).toContain('AI')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('项目未创建成功')
    expect(onCreate).not.toHaveBeenCalled()
  })
  it('merges imported recent projects with managed folders without duplicates', async () => {
    listDir.mockResolvedValue([{ name: 'Managed', path: '/projects/Managed', isDir: true, size: 0 }])
    await act(async () => { reactRoot.render(createElement(ProjectLaunchpad, {
      root: '/projects', onOpen, onCreate,
      recentProjects: [{ name: 'Imported', path: '/elsewhere/Imported' }, { name: 'Managed', path: '/projects/Managed/' }],
    })) })
    expect(host.querySelectorAll('.csl-project')).toHaveLength(2)
    await act(async () => { (host.querySelector('.csl-project') as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith('/elsewhere/Imported', 'Imported')
  })
})
