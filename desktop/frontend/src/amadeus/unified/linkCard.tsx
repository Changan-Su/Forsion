// 链接悬停卡片 + 双框编辑面板(2026-08-14,AFFiNE `inlines/link` 的对位实现)。
//
// 节奏照抄上游:**500ms 才出、250ms 才收**,并且「从链接挪到卡片」的那道缝要兜住(safeBridge)——
// 卡片贴着链接下沿弹,指针进卡片即取消收起计时,所以缝里不会中途关掉。
//
// 落盘影响 = 零:卡片只读 `<a href>`,动作全部落成同一份 md 的行内 link mark 增删改。
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { OverlayPortal } from '../lib/overlayPortal'
import { OverlayAt } from '../lib/clampMenu'
import { normalizeHref } from '../blocks/markdown/linkHref'

const OPEN_DELAY = 500
const CLOSE_DELAY = 250

interface Hover {
  href: string
  text: string
  /** 链接在文档里的范围(找不到就只给「打开/复制」,不给改写动作)。 */
  from: number
  to: number
  x: number
  y: number
}

/** 从 DOM 的 <a> 反查它在文档里的范围:posAtDOM 拿到起点,再按 link mark 往两边扩。 */
function rangeOfLink(view: EditorView, el: HTMLElement): { from: number; to: number } | null {
  const linkType = view.state.schema.marks.link
  if (!linkType) return null
  let pos: number
  try {
    pos = view.posAtDOM(el, 0)
  } catch {
    return null
  }
  const $p = view.state.doc.resolve(Math.min(pos, view.state.doc.content.size))
  if (!$p.parent.isTextblock) return null
  const start = $p.start()
  let from = pos
  let to = pos
  $p.parent.forEach((child, offset) => {
    if (!child.isText || !linkType.isInSet(child.marks)) return
    const a = start + offset
    const b = a + child.nodeSize
    if (pos >= a && pos <= b) {
      from = a
      to = b
    }
  })
  return from === to ? null : { from, to }
}

export function LinkHoverCard({ getView }: { getView: () => EditorView | null }): ReactElement | null {
  const [hover, setHover] = useState<Hover | null>(null)
  const [edit, setEdit] = useState<{ from: number; to: number; text: string; href: string } | null>(null)
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearTimers = (): void => {
      if (openT.current) clearTimeout(openT.current)
      if (closeT.current) clearTimeout(closeT.current)
      openT.current = null
      closeT.current = null
    }
    /** 只服务**本实例**那个 pane:监听挂在 document 上,不比对的话 Dockview 开两个 v4 面板时
     *  在 A 面板悬停会让 A/B 两张卡同时弹(B 那张还因为 posAtDOM 跨实例失败退化成半张卡)。 */
    const mine = (a: HTMLElement): boolean => {
      const host = getView()?.dom.closest('.unified-body')
      return !!host && a.closest('.unified-body') === host
    }
    const onOver = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      const a = t?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || !mine(a)) return
      if (closeT.current) {
        clearTimeout(closeT.current)
        closeT.current = null
      }
      if (openT.current) clearTimeout(openT.current)
      openT.current = setTimeout(() => {
        const view = getView()
        const r = a.getBoundingClientRect()
        const rg = view ? rangeOfLink(view, a) : null
        setHover({
          href: a.getAttribute('href') ?? '',
          text: a.textContent ?? '',
          from: rg?.from ?? -1,
          to: rg?.to ?? -1,
          x: r.left,
          y: r.bottom + 6,
        })
      }, OPEN_DELAY)
    }
    const onOut = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.('a[href]')) return
      const to = e.relatedTarget as HTMLElement | null
      if (to?.closest?.('.amx-linkcard')) return // safeBridge:挪进卡片不算离开
      if (openT.current) clearTimeout(openT.current)
      if (closeT.current) clearTimeout(closeT.current)
      closeT.current = setTimeout(() => setHover(null), CLOSE_DELAY)
    }
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      clearTimers()
    }
  }, [getView])

  /** 改写选定链接:href=null 表示只摘掉链接(留文字);text 变了就整段替换文字。
   *  ⚠️ from/to 是悬停那一刻的快照:开着卡片期间可能有外部回灌/协同事务改过文档,动手前**重新校验**
   *  这段范围还带不带 link mark,不对就放弃 —— 宁可什么都不做,也不能改错一段文字。 */
  const rewrite = (from: number, to: number, text: string | null, href: string | null): void => {
    const view = getView()
    const linkType = view?.state.schema.marks.link
    if (!view || !linkType) return
    if (to > view.state.doc.content.size || from >= to) return
    if (!view.state.doc.rangeHasMark(from, to, linkType)) return
    // ⚠️ 空串不能走 schema.text('')(prosemirror-model 直接抛 RangeError:Empty text nodes are
    //    not allowed)——「删除」按钮就是 text='' 这条路,评审实测必炸。空串 = 连文字一起删。
    let tr = view.state.tr
    if (text === '') {
      tr = tr.delete(from, to)
    } else if (text !== null) {
      tr = tr.replaceWith(from, to, view.state.schema.text(text, href ? [linkType.create({ href })] : []))
      tr.setSelection(TextSelection.near(tr.doc.resolve(from + text.length)))
    } else if (href) {
      tr = tr.removeMark(from, to, linkType).addMark(from, to, linkType.create({ href }))
    } else {
      tr = tr.removeMark(from, to, linkType)
    }
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  if (edit) {
    return (
      <OverlayPortal>
        <div className="amx-linkedit-backdrop" onMouseDown={() => setEdit(null)} role="presentation" />
        <OverlayAt className="amx-linkedit" x={window.innerWidth / 2} y={Math.round(window.innerHeight * 0.3)} center>
          <label>
            文字
            <input
              autoFocus
              value={edit.text}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <label>
            链接
            <input value={edit.href} onChange={(e) => setEdit({ ...edit, href: e.target.value })} />
          </label>
          <div className="amx-linkedit-row">
            <button onClick={() => setEdit(null)}>取消</button>
            <button
              className="primary"
              disabled={!normalizeHref(edit.href) || !edit.text.trim()}
              onClick={() => {
                const href = normalizeHref(edit.href)
                if (!href) return
                rewrite(edit.from, edit.to, edit.text, href)
                setEdit(null)
                setHover(null)
              }}
            >
              保存
            </button>
          </div>
        </OverlayAt>
      </OverlayPortal>
    )
  }

  if (!hover) return null
  let host = hover.href
  try {
    host = new URL(hover.href).host || hover.href
  } catch {
    /* 相对路径/站内链接:原样显示 */
  }
  const editable = hover.from >= 0
  return (
    <OverlayPortal>
      <OverlayAt
        className="amx-linkcard"
        x={hover.x}
        y={hover.y}
        onMouseEnter={() => {
          if (closeT.current) clearTimeout(closeT.current)
          closeT.current = null
        }}
        onMouseLeave={() => {
          closeT.current = setTimeout(() => setHover(null), CLOSE_DELAY)
        }}
      >
        <button className="amx-linkcard-host" title={hover.href} onClick={() => window.open(hover.href, '_blank', 'noopener')}>
          {host}
        </button>
        <span className="amx-linkcard-sep" />
        <button onClick={() => void navigator.clipboard.writeText(hover.href)}>复制链接</button>
        {editable && (
          <button onClick={() => setEdit({ from: hover.from, to: hover.to, text: hover.text, href: hover.href })}>编辑</button>
        )}
        {editable && (
          <button onClick={() => { rewrite(hover.from, hover.to, null, null); setHover(null) }}>移除链接</button>
        )}
        {editable && (
          <button className="danger" onClick={() => { rewrite(hover.from, hover.to, '', null); setHover(null) }}>删除</button>
        )}
      </OverlayAt>
    </OverlayPortal>
  )
}
