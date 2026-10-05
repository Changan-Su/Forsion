import { useEffect, useRef, useState } from 'react'
import { mountHostReact } from '@lcl/components'
import { PlainMarkdownEditor } from '../blocks/markdown/MarkdownBlock'
import { renderPublicMarkdown } from '@amadeus-shared/publishing/publicMarkdown'
import { mountPublishedMedia } from '@amadeus-shared/publishing/mediaPlayer'
import { HostLocaleProvider, registerMessages, useI18n } from '../../i18n'
import './publishingEditor.css'
import type {
  PluginMarkdownEditorHandle,
  PluginMarkdownEditorOptions,
} from '../../../../shared/markdownEditor'

registerMessages({
  'publishing.visual': { zh: 'Amadeus 编辑', en: 'Amadeus editor' },
  'publishing.source': { zh: 'Markdown 源码', en: 'Markdown source' },
  'publishing.preview': { zh: '预览', en: 'Preview' },
})
function EditorSurface({
  options,
  revision,
  alive,
}: {
  options: PluginMarkdownEditorOptions
  revision: number
  alive(): boolean
}) {
  const { t, locale } = useI18n()
  const [value, setValue] = useState(options.value)
  const [mode, setMode] = useState<'visual' | 'source' | 'preview'>('visual')
  const preview = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setValue(options.value)
  }, [options.value, revision])
  const change = (next: string): void => {
    if (!alive()) return
    options.value = next
    setValue(next)
    options.onChange?.(next)
  }
  useEffect(
    () =>
      preview.current
        ? mountPublishedMedia(preview.current, locale)
        : undefined,
    [mode, value, locale, options.previewBaseUrl],
  )
  const rendered =
    mode === 'preview'
      ? renderPublicMarkdown(value, { locale, baseUrl: options.previewBaseUrl })
      : null
  return (
    <div className="am-app amx-publishing-editor" aria-label={options.label}>
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0' }}
      >
        {(['visual', 'source', 'preview'] as const).map((m) => (
          <button
            key={m}
            className="btn"
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
          >
            {t(`publishing.${m}`)}
          </button>
        ))}
      </div>
      {mode === 'visual' && (
        <PlainMarkdownEditor
          initial={value}
          onChange={change}
          readOnly={options.readOnly}
          immediate
        />
      )}
      {mode === 'source' && (
        <textarea
          aria-label={options.label || t('publishing.source')}
          value={value}
          readOnly={options.readOnly}
          onChange={(e) => change(e.target.value)}
          style={{
            width: '100%',
            minHeight: 420,
            resize: 'vertical',
            padding: 12,
            font: 'inherit',
            fontFamily: 'var(--font-mono)',
            color: 'var(--text)',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
          }}
        />
      )}
      {rendered && (
        <div
          ref={preview}
          className="amadeus-published"
          dangerouslySetInnerHTML={{
            __html:
              (rendered.title
                ? `<h1>${rendered.title.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)}</h1>`
                : '') + rendered.html,
          }}
        />
      )}
    </div>
  )
}
export function mountPluginMarkdownEditor(
  el: HTMLElement,
  initial: PluginMarkdownEditorOptions,
): PluginMarkdownEditorHandle {
  const options = { ...initial }
  let alive = true,
    revision = 0
  const tree = () => (
    <HostLocaleProvider>
      <EditorSurface
        options={options}
        revision={revision++}
        alive={() => alive}
      />
    </HostLocaleProvider>
  )
  // alive 跟着这次挂载走:被后来的挂载收掉之后,旧句柄不再改正文、不再回调 onChange(getValue 留着那一刻的值)
  const mounted = mountHostReact(el, tree(), () => {
    alive = false
  })
  const render = (): void => mounted.render(tree())
  return {
    getValue() {
      return options.value
    },
    update(patch) {
      if (alive) {
        Object.assign(options, patch)
        render()
      }
    },
    insertMarkdown(markdown) {
      if (alive && !options.readOnly) {
        options.value += '\n\n' + markdown
        options.onChange?.(options.value)
        render()
      }
    },
    focus() {
      if (alive)
        el.querySelector<HTMLElement>(
          '[contenteditable="true"],textarea',
        )?.focus()
    },
    dispose: mounted.dispose,
  }
}
