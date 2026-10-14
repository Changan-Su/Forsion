/** Host selection bar for a plugin's own view (ctx.ui.mountSelectionBar): the same strip chat shows over selected
 *  text — the host's shared actions (Ask Tangu, Translate, plugin actions behind ⋯) plus the view's own tools. */
import { ViewSelectionBar, type BarSelection } from '../../components/selectionBar/ViewSelectionBar'
import { HostLocaleProvider } from '../../i18n'
import { mountHostReact } from '@lcl/components'
import { resolveIcon } from '../components/icons'
import type { PluginSelectionBarHandle, PluginSelectionBarOptions } from './types'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, 2000) : undefined)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)

/** Nothing is added to the plugin's own DOM: the bar and its result card live under <body> (they are fixed-position
 *  overlays), and so does the host layer that owns their React tree. `root` is only watched for selections. */
export function mountPluginSelectionBar(root: HTMLElement, pluginId: string, initial: PluginSelectionBarOptions): PluginSelectionBarHandle {
  const layer = document.body.appendChild(document.createElement('div'))
  layer.hidden = true
  const opts = { ...initial }
  const rootRef = { current: root }
  let shown: BarSelection | null = null
  let epoch = 0 // bumping it remounts the bar: the only way to drop a selection the host is watching itself
  let disposed = false
  const pick = (s: BarSelection): { text: string; markdown?: string } => ({ text: s.text, ...(s.markdown ? { markdown: s.markdown } : {}) })
  const guard = (what: string, fn: () => void): void => {
    try { fn() } catch (e) { console.error(`[amadeus] plugin "${pluginId}" selection bar ${what} threw`, e) }
  }
  const tree = (): React.ReactElement => {
    const view = /^[A-Za-z0-9._-]{1,64}$/.test(String(opts.view ?? '')) ? String(opts.view) : 'view'
    const ask = opts.ask
    return (
      <HostLocaleProvider>
        <ViewSelectionBar
          key={epoch}
          view={`${pluginId}:${view}`}
          pluginId={pluginId}
          watch={opts.watch === false ? undefined : rootRef}
          selection={shown}
          onDismiss={() => { if (shown) { shown = null; render() } }}
          tools={(s) => (Array.isArray(opts.tools) ? opts.tools : []).filter((t) => t && typeof t.id === 'string' && typeof t.run === 'function').map((t) => {
            const icon = t.color ? null : resolveIcon(t.icon)
            return {
              id: t.id,
              title: String(t.title ?? t.id),
              color: str(t.color),
              icon: icon ? <span className="selbar-ico">{icon}</span> : undefined,
              on: t.on == null ? undefined : !!t.on,
              onRun: () => guard(`tool "${t.id}"`, () => t.run(pick(s))),
            }
          })}
          ask={ask === false ? false : typeof ask === 'function' ? (s) => guard('ask', () => ask(pick(s))) : undefined}
          source={(s) => {
            let from: ReturnType<NonNullable<PluginSelectionBarOptions['source']>> | undefined
            guard('source', () => { from = opts.source?.(pick(s)) })
            if (!from || typeof from !== 'object') return undefined
            const page = num(from.page)
            return { title: str(from.title), path: str(from.path), ...(Number.isNaN(page) ? {} : { page }) }
          }}
        />
      </HostLocaleProvider>
    )
  }
  const mounted = mountHostReact(layer, tree(), () => { disposed = true; layer.remove() })
  function render(): void { if (!disposed) mounted.render(tree()) }

  return {
    show(sel) {
      if (disposed) return
      const text = typeof sel?.text === 'string' ? sel.text.trim() : ''
      const r = sel?.rect
      const rect = { left: num(r?.left), right: num(r?.right), top: num(r?.top), bottom: num(r?.bottom) }
      if (!text || Object.values(rect).some(Number.isNaN)) { console.warn(`[amadeus] plugin "${pluginId}" selection bar show() needs text and a rect { left, right, top, bottom }`); return }
      shown = { text, markdown: typeof sel.markdown === 'string' && sel.markdown ? sel.markdown : undefined, rect } // content, not a label: never capped
      render()
    },
    hide() {
      if (disposed) return
      shown = null
      // 重挂只为丢掉宿主自己看着的那份选区;自己报选区的视图滚动 / 缩放时都要 hide(),重挂会把刚开的结果卡一起带走。
      if (opts.watch !== false) epoch++
      render()
    },
    update(patch) {
      if (disposed || !patch || typeof patch !== 'object') return
      Object.assign(opts, patch)
      render()
    },
    dispose: mounted.dispose,
  }
}
