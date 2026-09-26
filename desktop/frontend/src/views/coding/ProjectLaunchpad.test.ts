// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../stores/appStore'
import { ProjectLaunchpad } from './ProjectLaunchpad'
import { useLaunchNavigation } from './launchpadNavigation'

let host: HTMLDivElement
let reactRoot: Root
const onOpen = vi.fn()
const onCreate = vi.fn()
const listDir = vi.fn(async () => [] as Array<{ name: string; path: string; isDir: boolean; size: number }>)
const mkdirHost = vi.fn(async (_root: string, name: string) => ({ path: `/projects/${name}` }))
const pickDirectory = vi.fn(async (): Promise<string | null> => 'C:\\Users\\Jane\\Existing project')

beforeEach(() => {
  useApp.setState({ agentDefs: [], modelsResp: { directProviders: [], models: [{ id: 'm1', name: 'Model one', provider: 'test', source: 'direct' }, { id: 'm2', name: 'Model two', provider: 'test', source: 'direct' }], defaultModelId: 'm1' }, newChatModel: 'm1' })
  useLaunchNavigation.setState({ page: 'projects', filter: 'all' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
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
async function openCreate() {
  if (host.querySelector('.csl-create-page')) return
  await act(async () => { (host.querySelector('.csl-catalog-actions .csl-new') as HTMLButtonElement).click() })
}
async function useFirstTemplate() {
  await openCreate()
  await act(async () => { (host.querySelector('.csl-template') as HTMLButtonElement).click() })
}
async function useTemplate(id: string) {
  await openCreate()
  await act(async () => { (host.querySelector(`.csl-template[data-template-id="${id}"]`) as HTMLButtonElement).click() })
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
    }), expect.objectContaining({ modelId: 'm1', thinkingLevel: 'medium' }))
    expect(onOpen).not.toHaveBeenCalled()
  })
  it('chooses a local model without submitting the form or changing another chat', async () => {
    await mount(); await useFirstTemplate()
    await act(async () => { (host.querySelector('.model-pill-btn') as HTMLButtonElement).click() })
    expect(onCreate).not.toHaveBeenCalled()
    await act(async () => { (document.querySelector('[data-pane-trigger="model"]') as HTMLButtonElement).click() })
    const model = [...document.querySelectorAll<HTMLButtonElement>('.composer-menu--portal button')].find(b => b.textContent?.includes('Model two'))!
    await act(async () => { model.click() })
    expect(useApp.getState().newChatModel).toBe('m1')
    expect(onCreate).not.toHaveBeenCalled()
    await act(async () => { useLaunchNavigation.getState().showProjects() })
    await openCreate(); await submit()
    expect(onCreate.mock.calls[0][3]).toEqual({ modelId: 'm2', thinkingLevel: 'medium' })
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
  it('offers a Forsion plugin starting point that creates a plugin brief without Connect capabilities', async () => {
    await mount(); await openCreate()
    expect(host.querySelectorAll('.csl-template[data-template-id="plugin"]')).toHaveLength(1)
    await useTemplate('plugin')
    // 能力块整块收起,并说清为什么 —— 留着让人勾却不生效,比不给更糟。
    expect(host.querySelector('.csl-capabilities')).toBeNull()
    expect(host.querySelector('[data-plugin-note]')?.textContent).toContain('Forsion Connect')
    expect((host.querySelector('.csl-idea') as HTMLTextAreaElement).value).toContain('manifest.json')
    await submit()
    expect(mkdirHost).toHaveBeenCalledWith('/projects', 'my-forsion-plugin')
    expect(onCreate).toHaveBeenCalledWith('/projects/my-forsion-plugin', 'my-forsion-plugin', expect.objectContaining({
      kind: 'plugin', templateId: 'plugin', capabilities: [],
    }), expect.any(Object))
  })

  it('returns to a web brief when a web template is chosen after the plugin one', async () => {
    await mount()
    await useTemplate('plugin')
    await useTemplate('assistant')
    expect(host.querySelector('.csl-capabilities')).not.toBeNull()
    await submit()
    expect(onCreate).toHaveBeenCalledWith('/projects/writing-assistant', 'writing-assistant', expect.objectContaining({ templateId: 'assistant', capabilities: ['chat'] }), expect.any(Object))
    expect(onCreate.mock.calls[0][2]).not.toHaveProperty('kind')
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

  it('starts on the project index and filters recent and external projects', async () => {
    listDir.mockResolvedValue([{ name: 'Managed', path: '/projects/Managed', isDir: true, size: 0 }])
    await act(async () => { reactRoot.render(createElement(ProjectLaunchpad, {
      root: '/projects', onOpen, onCreate,
      recentProjects: [{ name: 'Imported', path: '/elsewhere/Imported', openedAt: 1000, description: 'A local experiment' }],
    })) })
    expect(host.querySelector('.csl-catalog')).not.toBeNull()
    expect(host.querySelector('.csl-brief')).toBeNull()
    expect(host.querySelectorAll('.csl-project')).toHaveLength(2)
    await act(async () => { useLaunchNavigation.getState().showProjects('recent') })
    expect(host.querySelectorAll('.csl-project')).toHaveLength(1)
    expect(host.querySelector('.csl-project')?.textContent).toContain('Imported')
    await act(async () => { useLaunchNavigation.getState().showProjects('imported') })
    expect(host.querySelectorAll('.csl-project')).toHaveLength(1)
    expect(host.querySelector('.csl-project')?.textContent).toContain('外部文件夹')
  })

  it('keeps a draft when returning to the index and opening creation again', async () => {
    await mount(); await useTemplate('assistant')
    await act(async () => { (host.querySelector('.csl-back') as HTMLButtonElement).click() })
    expect(host.querySelector('.csl-catalog')).not.toBeNull()
    await openCreate()
    expect((host.querySelector('.csl-idea') as HTMLTextAreaElement).value).toContain('AI')
    expect((host.querySelector('.csl-name-field input') as HTMLInputElement).value).toBe('writing-assistant')
  })
  it('opens a Gallery template into the editable creation brief', async () => {
    await mount()
    await act(async () => { useLaunchNavigation.getState().showGallery() })
    expect(host.querySelectorAll('.csl-gallery-card')).toHaveLength(7)
    await act(async () => { (host.querySelector('.csl-gallery-card') as HTMLButtonElement).click() })
    expect(host.querySelector('.csl-create-page')).not.toBeNull()
    expect((host.querySelector('.csl-idea') as HTMLTextAreaElement).value).toContain('AI')
  })
})
