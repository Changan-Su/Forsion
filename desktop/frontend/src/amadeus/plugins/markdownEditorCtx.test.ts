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
// The revoked-context case calls ctx.table / ctx.dashboard / ctx.ui.mountChatBox: stub their surfaces so the test never
// loads the real table, dashboard and chat graphs (over a second of imports, a timeout on a loaded machine).
vi.mock('./tableSurface', () => ({ mountPluginTable: surface.mount }))
vi.mock('./dashboardSurface', () => ({ mountPluginDashboard: surface.mount }))
vi.mock('./chatBoxSurface', () => ({ mountPluginChatBox: surface.mount }))
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
    await vi.waitFor(() => expect(el.textContent).toContain('editor exploded'))
    logged.mockRestore()
    expect(own.parentNode).toBe(el)
    h.dispose()
    expect([...el.children]).toEqual([own])
  })
  it('a revoked context cannot take an element away from a live request', async () => {
    const { claimHostMount } = await import('@lcl/components')
    const c = context('reloaded')
    usePluginStore.getState().disable('reloaded') // the old context is dead; a late task of its still calls in
    const el = document.createElement('div')
    const stillMine = claimHostMount(el) // the new context's request, import still loading
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {})
    c.ui!.mountMarkdownEditor!(el, { value: '# late' })
    c.ui!.mountChatBox!(el, { onSubmit: async () => true })
    c.table!.mount(el, { id: 't', columns: [{ key: 'a', label: 'A', kind: 'text' }], rows: [] })
    c.dashboard!.mount!(el, { recipe: { cards: [] } })
    await vi.dynamicImportSettled()
    quiet.mockRestore()
    expect(stillMine()).toBe(true)
    expect(surface.mount).not.toHaveBeenCalled()
    expect(el.childElementCount).toBe(0)
  })
  it('a request loses its element to a later mount while its import is still loading: it never mounts', async () => {
    const { mountHostReact } = await import('@lcl/components')
    const c = context('outrun')
    const el = document.createElement('div')
    const h = c.ui!.mountMarkdownEditor!(el, { value: '# Draft' })
    mountHostReact(el, 'later mount') // the plugin hands the same element to something else, without disposing
    await vi.dynamicImportSettled()
    await Promise.resolve()
    expect(surface.mount).not.toHaveBeenCalled()
    expect(h.getValue()).toBe('# Draft')
    await vi.waitFor(() => expect(el.textContent).toBe('later mount'))
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
