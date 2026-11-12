import { useLayoutEffect, useRef, useState } from 'react'
import { createNoteRenderSurface, currentNoteRenderer, noteRendererReloadState, subscribeNoteRenderers, type NoteReadingSnapshot, type NoteRendererHost, type NoteRendererContribution } from '../plugins/noteRenderers'
import { captureReadingPosition, officialNoteRenderer, restoreReadingPosition, type ReadingPosition } from './readingSnapshot'
import { registerMessages, useI18n } from '../../i18n'
import { BookOpen, Pencil } from 'lucide-react'

registerMessages({
  'reading.enter': { zh: '阅读', en: 'Read' },
  'reading.edit': { zh: '编辑', en: 'Edit' },
  'reading.mode': { zh: '阅读模式', en: 'Reading mode' },
  'reading.preparing': { zh: '正在保存编辑', en: 'Saving changes' },
  'reading.failed': { zh: '暂时无法进入阅读模式，编辑内容已保留。', en: 'Could not enter reading mode. Your edits are preserved.' },
  'reading.updateFailed': { zh: '阅读渲染更新失败，继续显示上一版本。', en: 'The reading renderer update failed. The previous version is still displayed.' },
  'reading.toggle': { zh: '切换阅读 / 编辑', en: 'Toggle reading / editing' },
})

export interface ReadingModeControl { on: boolean; busy: boolean; toggle(): void }
export function ReadingModeButton({ control }: { control: ReadingModeControl }) {
  const { t } = useI18n()
  return <button
    type="button"
    className={`amx-mode-btn amx-reading-mode-btn${control.on ? ' amx-pin-on' : ''}`}
    data-reading-toggle
    title={t(control.busy ? 'reading.preparing' : 'reading.toggle')}
    aria-pressed={control.on}
    disabled={control.busy}
    onClick={control.toggle}
  >{control.on ? <Pencil size={14} /> : <BookOpen size={14} />}<span>{t(control.on ? 'reading.edit' : 'reading.enter')}</span></button>
}
export function ReadingSurface({ snapshot, scroll, position, openLink, rootRef }: {
  snapshot: NoteReadingSnapshot
  scroll: () => HTMLElement
  position: ReadingPosition | null
  openLink: NoteRendererHost['openLink']
  rootRef: { current: HTMLDivElement | null }
}) {
  const { t } = useI18n()
  const options = useRef({ snapshot, scroll, position, openLink })
  options.current = { snapshot, scroll, position, openLink }
  const [failed, setFailed] = useState(false)
  const refresh = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    let alive = true
    let mounted = false
    let lastPlugin = ''
    let lastGood: NoteRendererContribution = officialNoteRenderer
    let lastRevision = -1
    let request = 0
    const surface = createNoteRenderSurface(el, (...args) => options.current.openLink(...args))
    const draw = async (): Promise<void> => {
      const mine = ++request
      const current = options.current
      const selected = currentNoteRenderer()
      const reload = lastPlugin ? noteRendererReloadState(lastPlugin) : undefined
      if (!selected && mounted && reload && lastRevision === current.snapshot.revision) { setFailed(reload === 'failed'); return }
      const position = mounted ? captureReadingPosition(el, current.scroll()) : current.position
      const renderer = selected ?? (reload ? lastGood : officialNoteRenderer)
      const restore = () => () => {
        if (position) restoreReadingPosition(el, current.scroll(), position)
      }
      const ok = await surface.render(renderer, current.snapshot, restore)
      if (!alive || mine !== request) return
      // The bundled renderer is the initial fallback; a failed later update keeps the old DOM.
      if (!ok && (!mounted || lastRevision !== current.snapshot.revision)) {
        const kept = mounted && await surface.render(lastGood, current.snapshot, restore)
        if (!alive || mine !== request) return
        if (!kept) await surface.render(officialNoteRenderer, current.snapshot, restore)
        if (!alive || mine !== request) return
      }
      if (ok) { lastGood = renderer; lastPlugin = selected?.pluginId ?? (reload ? lastPlugin : '') }
      lastRevision = current.snapshot.revision
      mounted = true
      setFailed(!ok)
    }
    refresh.current = () => { void draw() }
    const off = subscribeNoteRenderers(refresh.current)
    return () => { alive = false; refresh.current = null; off(); surface.dispose() }
  }, [rootRef])
  useLayoutEffect(() => { refresh.current?.() }, [snapshot, rootRef])
  return <>
    {failed && <div className="mk-notice amx-reading-notice" role="status">{t('reading.updateFailed')}</div>}
    <div ref={rootRef} className="page-view unified-body amx-reading-surface" data-reading-surface data-bare />
  </>
}
