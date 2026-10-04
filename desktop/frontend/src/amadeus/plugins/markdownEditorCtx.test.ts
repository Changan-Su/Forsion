// @vitest-environment happy-dom
/** Caller-owned Markdown survives synchronous reads; plugin retirement revokes pending and live mounts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginContext } from './types'
import type { PluginMarkdownEditorOptions } from '../../../../shared/markdownEditor'
const surface = vi.hoisted(() => ({ mount: vi.fn(), handles: [] as any[] }))
vi.mock('./markdownEditorSurface', () => ({
  mountPluginMarkdownEditor: surface.mount,
}))
vi.mock('../api', () => ({ amadeus: undefined }))
const { usePluginStore } = await import('./pluginStore')
function context(id: string, fail = false): PluginContext {
  let ref!: PluginContext
  usePluginStore.getState().init([
    {
      id,
      name: id,
      version: '1',
      setup(c) {
        ref = c
        if (fail) {
          c.ui!.mountMarkdownEditor!(document.createElement('div'), {
            value: '# Failed',
          })
          throw new Error('setup failed')
        }
      },
    },
  ])
  return ref
}
beforeEach(() => {
  usePluginStore.setState({
    initialized: false,
    plugins: [],
    activeIds: [],
    disabledIds: [],
    disposers: {},
  })
  surface.handles = []
  surface.mount
    .mockReset()
    .mockImplementation(
      (_el: HTMLElement, options: PluginMarkdownEditorOptions) => {
        const live = { ...options }
        const handle = {
          getValue: () => live.value,
          update: vi.fn((patch: any) => Object.assign(live, patch)),
          insertMarkdown: vi.fn((md: string) => {
            live.value += '\n\n' + md
            live.onChange?.(live.value)
          }),
          focus: vi.fn(),
          dispose: vi.fn(),
        }
        surface.handles.push(handle)
        return handle
      },
    )
})
afterEach(() => {
  for (const id of [...usePluginStore.getState().activeIds])
    usePluginStore.getState().disable(id)
})
describe('native Markdown plugin mount lifecycle', () => {
  it('a failed mount shows its error in a host-owned node: plugin nodes stay, dispose takes the error away', async () => {
    const c = context('failing')
    const el = document.createElement('div')
    const own = el.appendChild(document.createElement('p'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    surface.mount.mockImplementationOnce(() => { throw new Error('editor exploded') })
    const h = c.ui!.mountMarkdownEditor!(el, { value: '# Draft' })
    await vi.dynamicImportSettled()
    await Promise.resolve()
    logged.mockRestore()
    expect(el.textContent).toContain('editor exploded')
    expect(own.parentNode).toBe(el)
    h.dispose()
    expect([...el.children]).toEqual([own])
  })
  it('revokes a pending import before it creates an editor', async () => {
    const c = context('pending')
    const h = c.ui!.mountMarkdownEditor!(document.createElement('div'), {
      value: '# Draft',
    })
    usePluginStore.getState().disable('pending')
    await vi.dynamicImportSettled()
    expect(surface.mount).not.toHaveBeenCalled()
    expect(h.getValue()).toBe('# Draft')
  })
  it('retains the latest value after disposal and ignores stale update / insert / focus', async () => {
    const c = context('live')
    const changes = vi.fn()
    const h = c.ui!.mountMarkdownEditor!(document.createElement('div'), {
      value: '# Draft',
      onChange: changes,
    })
    await vi.dynamicImportSettled()
    h.insertMarkdown('New transaction')
    expect(h.getValue()).toContain('New transaction')
    expect(changes).toHaveBeenCalledOnce()
    const inner = surface.handles[0]
    usePluginStore.getState().disable('live')
    h.update({ value: 'Stale' })
    h.insertMarkdown('Stale')
    h.focus()
    h.dispose()
    expect(h.getValue()).toContain('New transaction')
    expect(inner.dispose).toHaveBeenCalledOnce()
    expect(inner.update).not.toHaveBeenCalled()
    expect(inner.focus).not.toHaveBeenCalled()
  })
  it('reconciles empty source and prevents inserts into a read-only pending mount', async () => {
    const c = context('readonly')
    const changes = vi.fn()
    const h = c.ui!.mountMarkdownEditor!(document.createElement('div'), {
      value: '# Draft',
      readOnly: true,
      onChange: changes,
    })
    h.insertMarkdown('Forbidden')
    h.update({ value: '' })
    expect(h.getValue()).toBe('')
    await vi.dynamicImportSettled()
    expect(surface.mount.mock.calls[0][1].value).toBe('')
    expect(changes).not.toHaveBeenCalled()
  })
  it('setup failure cancels a pending surface, and invalid inputs fail synchronously', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    context('failed', true)
    await vi.dynamicImportSettled()
    expect(surface.mount).not.toHaveBeenCalled()
    warn.mockRestore()
    const c = context('validate')
    expect(() =>
      c.ui!.mountMarkdownEditor!({} as HTMLElement, { value: '' }),
    ).toThrow(TypeError)
  })
})
