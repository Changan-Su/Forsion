import type { ReactElement, RefObject } from 'react'
import { FloatingToc } from '@lcl/engine'
import { READING_GAP, stickyTopInset } from './revealScroll'

/** 笔记正文的浮动目录(LCL FloatingToc 的笔记适配)。落点与右栏大纲跳转(revealBlockAtTop)同一口径:
 *  标题顶停在「sticky 顶栏下 12px」。此前只用了 LCL 缺省 topOffset=24,顶栏 37px 高 → 跳过去标题被盖住 14px
 *  (评审 C-04);高亮当前小节的判定线同样要让开顶栏,否则跳完高亮的是上一节。台架 `&upane&utoc` 挂的是这同一个组件。 */
export function NoteFloatingToc({ host, label, scanTrigger }: {
  host: RefObject<HTMLElement | null>
  label: string
  scanTrigger: unknown
}): ReactElement {
  return (
    <FloatingToc
      scrollContainer={host}
      contentRoot={host}
      selector=".page-view h1, .page-view h2, .page-view h3"
      label={label}
      scanTrigger={scanTrigger}
      placement="sticky"
      topOffset={READING_GAP}
      topInset={stickyTopInset}
    />
  )
}
