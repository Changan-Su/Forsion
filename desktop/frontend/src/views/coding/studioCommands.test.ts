// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommandStore } from '@lcl/engine/commandRegistry'
import { setLocaleGlobal } from '../../i18n'
import './studioMessages'

// Keep the real command registry without mounting the unrelated workbench chrome.
vi.mock('@lcl/engine', async () => import('@lcl/engine/commandRegistry'))
import { registerStudioCommands, STUDIO_TOOL_COMMAND } from './studioCommands'

const getCommand = (id = STUDIO_TOOL_COMMAND) => useCommandStore.getState().commands.find(command => command.id === id)!
const invoke = (args: Record<string, unknown>) => getCommand().invoke!.run!(args)
let disposers: Array<() => void>
beforeEach(() => { useCommandStore.setState({ commands: [] }); disposers = []; setLocaleGlobal('zh') })
afterEach(() => { disposers.forEach(dispose => dispose()); useCommandStore.setState({ commands: [] }); setLocaleGlobal('zh'); vi.unstubAllGlobals() })

describe('Coding Studio presentation commands', () => {
  it('exposes one explicit agent command and five human tool commands without mutation capabilities', () => {
    const open = vi.fn(() => true)
    const writes = vi.fn()
    Object.defineProperty(window, 'tangu', { configurable: true, value: { writeFile: writes, codeStudioSnapshot: writes, codeStudioRestore: writes, connectPublish: writes } })
    disposers.push(registerStudioCommands('/projects/a', open, () => true))
    const commands = useCommandStore.getState().commands
    expect(commands).toHaveLength(6)
    expect(commands.filter(command => command.invoke).map(command => command.id)).toEqual([STUDIO_TOOL_COMMAND])
    for (const tool of ['brief', 'history', 'checks', 'issues', 'setup']) {
      getCommand(`coding-studio.${tool}`).run()
      expect(open).toHaveBeenLastCalledWith(tool)
    }
    for (const side of ['left', 'right', 'bottom']) {
      invoke({ projectRoot: '/projects/a', tool: 'issues', side })
      expect(open).toHaveBeenLastCalledWith('issues', side)
    }
    invoke({ projectRoot: '/projects/a/', tool: 'history' })
    expect(open).toHaveBeenLastCalledWith('history', undefined)
    expect(writes).not.toHaveBeenCalled()
    delete window.tangu
  })

  it('uses idempotent explicit requests and provides current project state and localized human titles', () => {
    const open = vi.fn(() => true)
    let current = true
    disposers.push(registerStudioCommands('/projects/a', open, () => current))
    const request = { projectRoot: '/projects/a', tool: 'brief', side: 'left' }
    invoke(request); invoke(request)
    expect(open.mock.calls).toEqual([['brief', 'left'], ['brief', 'left']])
    expect(JSON.parse(getCommand().invoke!.state!())).toEqual({ projectRoot: '/projects/a', available: true })
    const title = getCommand('coding-studio.brief').title as () => string
    expect(title()).toContain('项目简报')
    setLocaleGlobal('en')
    expect(title()).toBe('Coding Studio · Project brief')
    expect(getCommand().invoke!.description).not.toMatch(/[\u4e00-\u9fff]/)
    current = false
    expect(JSON.parse(getCommand().invoke!.state!()).available).toBe(false)
    expect(() => invoke(request)).toThrow('not active')
  })

  it.each(['/projects/b', '/projects/ab', '/projects/a/../b', 'projects/a', '', null, 42])('rejects a different or invalid root %j before opening anything', (projectRoot) => {
    const open = vi.fn(() => true)
    disposers.push(registerStudioCommands('/projects/a', open, () => true))
    expect(() => invoke({ projectRoot, tool: 'brief' })).toThrow('not active')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['save', 'restore', 'publish', '__proto__', 'constructor', ['brief'], null, 1])('rejects invalid tool enum %j', (tool) => {
    const open = vi.fn(() => true)
    disposers.push(registerStudioCommands('/projects/a', open, () => true))
    expect(() => invoke({ projectRoot: '/projects/a', tool })).toThrow('Unknown Coding Studio tool')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['main', 'top', '', ['left'], { toString: () => 'right' }, null, 1])('rejects invalid side enum %j even when invoked directly by a rule', (side) => {
    const open = vi.fn(() => true)
    disposers.push(registerStudioCommands('/projects/a', open, () => true))
    expect(() => invoke({ projectRoot: '/projects/a', tool: 'brief', side })).toThrow('Invalid Coding Studio panel position')
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects extra arguments, unavailable projects and a hidden tool owner', () => {
    const open = vi.fn(() => false)
    let current = true
    disposers.push(registerStudioCommands('/projects/a', open, () => current))
    expect(() => invoke({ projectRoot: '/projects/a', tool: 'brief', restore: true })).toThrow('Unknown Coding Studio command argument')
    expect(open).not.toHaveBeenCalled()
    expect(() => invoke({ projectRoot: '/projects/a', tool: 'brief' })).toThrow('not visible')
    current = false; open.mockClear()
    getCommand('coding-studio.brief').run()
    getCommand().run()
    expect(() => invoke({ projectRoot: '/projects/a', tool: 'brief' })).toThrow('not active')
    expect(open).not.toHaveBeenCalled()
  })

  it('normalizes a Windows root consistently with the project store', () => {
    const open = vi.fn(() => true)
    disposers.push(registerStudioCommands('C:\\projects\\a', open, () => true))
    invoke({ projectRoot: 'C:/projects/a/', tool: 'setup', side: 'right' })
    expect(open).toHaveBeenCalledExactlyOnceWith('setup', 'right')
  })

  it('revokes captured callbacks on cleanup and leaves unrelated commands intact', () => {
    const open = vi.fn(() => true)
    useCommandStore.getState().addCommand({ id: 'unrelated', title: 'Unrelated', run: vi.fn() })
    const cleanup = registerStudioCommands('/projects/a', open, () => true)
    disposers.push(cleanup)
    const oldAgent = getCommand(), oldHuman = getCommand('coding-studio.brief')
    cleanup(); cleanup()
    expect(useCommandStore.getState().commands.map(command => command.id)).toEqual(['unrelated'])
    oldHuman.run(); oldAgent.run()
    expect(() => oldAgent.invoke!.run!({ projectRoot: '/projects/a', tool: 'brief' })).toThrow('not active')
    expect(JSON.parse(oldAgent.invoke!.state!()).available).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('a delayed cleanup cannot remove commands installed by the next project', () => {
    const oldOpen = vi.fn(() => true), nextOpen = vi.fn(() => true)
    const cleanupOld = registerStudioCommands('/projects/a', oldOpen, () => true)
    const cleanupNext = registerStudioCommands('/projects/b', nextOpen, () => true)
    disposers.push(cleanupOld, cleanupNext)
    cleanupOld()
    expect(useCommandStore.getState().commands).toHaveLength(6)
    invoke({ projectRoot: '/projects/b', tool: 'history', side: 'bottom' })
    expect(nextOpen).toHaveBeenCalledExactlyOnceWith('history', 'bottom')
    expect(oldOpen).not.toHaveBeenCalled()
    cleanupNext()
    expect(useCommandStore.getState().commands).toEqual([])
  })
})
