import { useLayoutEffect, useRef, useState } from 'react'
import type { RegisteredCodeBlockRenderer } from '../../plugins/codeBlockRenderers'
import { registerMessages, translate } from '../../../i18n'

registerMessages({
  'plugin.codeBlockFailed': {zh: '插件渲染失败，原始代码保留如下。', en: 'Plugin rendering failed. The original code is preserved below.'},
})
export function PluginCodeBlock({renderer, source, language, pagePath, readOnly}: {
  renderer: RegisteredCodeBlockRenderer; source: string; language: string; pagePath: string; readOnly: boolean
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current!
    const controller = new AbortController()
    let cleanup: (() => void) | void
    const fail = (e: unknown): void => {
      if (controller.signal.aborted) return
      console.error('[plugin-code-block] render failed', e)
      setError(true)
    }
    setError(false)
    try {
      Promise.resolve(renderer.item.mount(el, {source, language, pagePath, readOnly, signal: controller.signal})).then(fn => {
        if (controller.signal.aborted) fn?.(); else cleanup = fn
      }, fail)
    } catch (e) { fail(e) }
    return () => { controller.abort(); cleanup?.(); el.replaceChildren() }
  }, [renderer, source, language, pagePath, readOnly])
  return <div className="plugin-code-block" data-renderer={renderer.item.id}>
    <div ref={ref} hidden={error} />
    {error && <><p role="status">{translate('plugin.codeBlockFailed')}</p><pre><code>{source}</code></pre></>}
  </div>
}
