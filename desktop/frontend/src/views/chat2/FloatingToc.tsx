/** Chat DOM adapter for the shared LCL FloatingToc. */
import type { RefObject } from 'react'
import {
  FloatingToc as LclFloatingToc,
  type FloatingTocItemReader,
} from '@lcl/engine'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'ftoc.label': { zh: '目录', en: 'Table of contents' },
})

const readChatItem: FloatingTocItemReader = (element) => {
  if (element.dataset.tocMsgRole === 'user') {
    const text = (element.dataset.tocTitle || element.textContent || '').trim()
    return text ? { text, level: 0, primary: true } : null
  }
  const text = (element.textContent || '').trim()
  if (!text || !element.dataset.tocLevel) return null
  return { text, level: Number(element.dataset.tocLevel) || 1 }
}

/** Chat keeps only its source-DOM mapping here; scanning, navigation, focus, and visuals live in LCL. */
export function FloatingToc({ scrollContainerRef, scanTrigger }: {
  scrollContainerRef: RefObject<HTMLElement | null>
  scanTrigger?: number
}) {
  const { t } = useI18n()
  return (
    <LclFloatingToc
      scrollContainer={scrollContainerRef}
      selector="[data-toc-msg-role='user'], [data-toc-level]"
      itemFromElement={readChatItem}
      label={t('ftoc.label')}
      scanTrigger={scanTrigger}
    />
  )
}
