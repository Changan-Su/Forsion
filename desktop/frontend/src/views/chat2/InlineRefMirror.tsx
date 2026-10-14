/**
 * 输入框里行内引用的那层画面(草稿里怎么写见 ./inlineRefs):叠在文本框上、不接指针,只在每一段的位置画芯片底色和图标。
 * 文字本身仍由文本框显示,这一层的字是透明的,只用来占出一模一样的排版 —— 所以字体、内边距、宽度每次都从文本框现抄,
 * 滚动跟着文本框走。位置用 offset 累加(布局像素),不用 getBoundingClientRect:界面缩放下后者会差一个倍数。
 *
 * ⚠️ 必须紧跟在文本框**后面**渲染,文本框从 DOM 上取(前一个兄弟),不走 ref:ChatBoxInput 的 ref 是每次渲染新建的回调,
 *    React 每次提交都先把它置空再接回去,排在文本框前面的组件在自己的 layout effect 里读到的恒是 null(实测整层没对上)。
 */
import { useLayoutEffect, useRef } from 'react'
import { FileText, Folder, MessageSquare } from 'lucide-react'
import { AppRefIcon } from '../../components/appRefs'
import type { RefChip } from './Composer2'
import { RUN_LEAD, RUN_TAIL, type InlineRun } from './inlineRefs'

const COPY = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'direction', 'fontFeatureSettings', 'fontVariantNumeric', 'wordBreak'] as const

export function InlineRefMirror({ text, runs, chipOf }: {
  text: string
  runs: InlineRun[]
  chipOf: (name: string) => RefChip | undefined
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const on = runs.length > 0
  useLayoutEffect(() => {
    const box = boxRef.current
    const inner = innerRef.current
    const ta = box?.previousElementSibling
    if (!on || !box || !inner || !(ta instanceof HTMLTextAreaElement)) return
    const sync = (): void => {
      const cs = getComputedStyle(ta)
      for (const p of COPY) box.style[p] = cs[p]
      let x = ta.clientLeft
      let y = ta.clientTop
      for (let n: HTMLElement | null = ta; n && n !== box.offsetParent; n = n.offsetParent as HTMLElement | null) { x += n.offsetLeft; y += n.offsetTop }
      box.style.left = `${x}px`
      box.style.top = `${y}px`
      box.style.width = `${ta.clientWidth}px`
      box.style.height = `${ta.clientHeight}px`
      inner.style.transform = `translateY(${-ta.scrollTop}px)`
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(ta)
    ta.addEventListener('scroll', sync, { passive: true })
    return () => { ro.disconnect(); ta.removeEventListener('scroll', sync) }
  }, [on, text])
  if (!on) return null

  const parts: React.ReactNode[] = []
  let last = 0
  runs.forEach((r, i) => {
    if (r.start > last) parts.push(text.slice(last, r.start))
    const chip = chipOf(r.name)
    parts.push(
      <span className="t2c-inref" key={i}>
        <span className="t2c-inref-slot">
          {RUN_LEAD}
          {chip?.appRef ? <AppRefIcon id={chip.appRef.id} className="t2c-inref-ico" />
            : chip?.kind === 'session' ? <MessageSquare className="t2c-inref-ico" />
            : chip?.kind === 'folder' ? <Folder className="t2c-inref-ico" />
            : <FileText className="t2c-inref-ico" />}
        </span>
        {r.name}{RUN_TAIL}
      </span>,
    )
    last = r.end
  })
  // 文本框以换行结尾时最后那个空行也占高度,镜像层补一个零宽字符才对得上
  parts.push(text.slice(last) + (text.endsWith('\n') ? '​' : ''))
  return <div ref={boxRef} className="t2c-mirror" aria-hidden><div ref={innerRef}>{parts}</div></div>
}
