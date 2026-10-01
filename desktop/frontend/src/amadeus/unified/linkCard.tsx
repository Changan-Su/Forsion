// 链接悬停卡片 + 双框编辑面板(2026-08-14,AFFiNE `inlines/link` 的对位实现)。
//
// 节奏照抄上游:**500ms 才出、250ms 才收**,并且「从链接挪到卡片」的那道缝要兜住(safeBridge)——
// 卡片贴着链接下沿弹,指针进卡片即取消收起计时,所以缝里不会中途关掉。
//
// 落盘影响 = 零:卡片只读 `<a href>`,动作全部落成同一份 md 的行内 link mark 增删改。
// 脚注上标(R-18)同一套计时与外壳:悬停 `sup[data-type=footnote_reference]` 出一张只读卡,显示定义正文(点上标本身跳定义,见 footnote.ts)。
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Mark, MarkType, Node as ProseNode } from '@milkdown/kit/prose/model'
import { OverlayPortal } from '../lib/overlayPortal'
import { OverlayAt } from '../lib/clampMenu'
import { hrefKind, normalizeHref } from '../blocks/markdown/linkHref'
import { footnoteDefText } from '../blocks/markdown/footnote'
import { registerMessages, useI18n } from '../../i18n'

// 取消 / 保存 / 编辑 / 删除复用 common.*;这里只登记卡片自己的(评审 C-14:原来全是 JSX 裸中文)。
registerMessages({
  'linkcard.text': { zh: '文字', en: 'Text' },
  'linkcard.link': { zh: '链接', en: 'Link' },
  'linkcard.copy': { zh: '复制链接', en: 'Copy link' },
  'linkcard.unlink': { zh: '移除链接', en: 'Remove link' },
  'linkcard.fnEmpty': { zh: '脚注还是空的', en: 'This footnote is empty' },
  'linkcard.fnMissing': { zh: '找不到这条脚注的定义', en: 'Footnote definition not found' },
})

const OPEN_DELAY = 500
const CLOSE_DELAY = 250
/** 悬停卡认的两种目标:链接,与脚注上标(R-18)。 */
const HOVER_SEL = 'a[href], sup[data-type="footnote_reference"]'

interface FootHover {
  /** 上标上显示的编号(没编号时是 label)。 */
  num: string
  /** 定义正文;null = 文中没有这条定义。 */
  text: string | null
  x: number
  y: number
}

interface Hover {
  href: string
  text: string
  /** 链接在文档里的范围(找不到就只给「打开/复制」,不给改写动作)。 */
  from: number
  to: number
  x: number
  y: number
}

/** 文档位 pos 处那条链接的**整条**范围(I-07):先找 pos 所在、带 link mark 的行内节点,再沿**同一个** link mark
 *  (`isInSet` 按 eq 比:href、title 都相同)往两边扩到相邻行内节点 —— `[**粗**普通](url)` 在文档里是两段文字、
 *  DOM 里是两个 `<a>`,但它是一条链接;只取悬停那一段,「编辑 / 移除 / 删除」就只作用于半条(还把链接劈成两条)。
 *  导出给同文件以外的链接编辑入口复用(⌘K 编辑已有链接等),口径只此一份。 */
export function linkRangeAt(doc: ProseNode, pos: number, linkType: MarkType): { from: number; to: number; mark: Mark } | null {
  const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  if (!$p.parent.isTextblock) return null
  const start = $p.start()
  const kids: Array<{ node: ProseNode; from: number; to: number }> = []
  $p.parent.forEach((node, offset) => kids.push({ node, from: start + offset, to: start + offset + node.nodeSize }))
  const linked = (k: { node: ProseNode }): boolean => !!linkType.isInSet(k.node.marks)
  // 优先 pos 落在节点内部(半开区间);落在两段交界时退回右端点相接的那段。
  let i = kids.findIndex((k) => linked(k) && pos >= k.from && pos < k.to)
  if (i < 0) i = kids.findIndex((k) => linked(k) && pos >= k.from && pos <= k.to)
  if (i < 0) return null
  const mark = linkType.isInSet(kids[i].node.marks) as Mark
  let a = i
  let b = i
  while (a > 0 && mark.isInSet(kids[a - 1].node.marks)) a--
  while (b < kids.length - 1 && mark.isInSet(kids[b + 1].node.marks)) b++
  return { from: kids[a].from, to: kids[b].to, mark }
}

/** 从 DOM 的 <a> 反查它所属整条链接在文档里的范围:posAtDOM 拿到悬停那一段的起点,再交给 linkRangeAt 扩。 */
function rangeOfLink(view: EditorView, el: HTMLElement): { from: number; to: number } | null {
  const linkType = view.state.schema.marks.link
  if (!linkType) return null
  let pos: number
  try {
    pos = view.posAtDOM(el, 0)
  } catch {
    return null
  }
  const r = linkRangeAt(view.state.doc, pos, linkType)
  return r && r.from < r.to ? { from: r.from, to: r.to } : null
}

export function LinkHoverCard({ getView, onOpenNote }: {
  getView: () => EditorView | null
  /** 库内笔记链接 `[t](笔记.md)` 的打开(与编辑器点击同路,L-07);不给就退回 window.open。 */
  onOpenNote?: (href: string) => void
}): ReactElement | null {
  const { t } = useI18n()
  const [hover, setHover] = useState<Hover | null>(null)
  const [foot, setFoot] = useState<FootHover | null>(null)
  const [edit, setEdit] = useState<{ from: number; to: number; text: string; href: string; wasHref: string } | null>(null)
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
      const hit = t?.closest?.(HOVER_SEL) as HTMLElement | null
      if (!hit || !mine(hit)) return
      if (closeT.current) {
        clearTimeout(closeT.current)
        closeT.current = null
      }
      if (openT.current) clearTimeout(openT.current)
      if (hit.tagName === 'SUP') {
        openT.current = setTimeout(() => {
          const view = getView()
          const r = hit.getBoundingClientRect()
          setHover(null)
          setFoot({
            num: hit.textContent ?? '',
            text: view ? footnoteDefText(view.state.doc, hit.getAttribute('data-label') ?? '') : null,
            x: r.left,
            y: r.bottom + 6,
          })
        }, OPEN_DELAY)
        return
      }
      const a = hit as HTMLAnchorElement
      openT.current = setTimeout(() => {
        const view = getView()
        setFoot(null)
        const r = a.getBoundingClientRect()
        const rg = view ? rangeOfLink(view, a) : null
        setHover({
          href: a.getAttribute('href') ?? '',
          // 整条链接的文字(不是悬停那个 <a> 的):编辑框里看到、改到的都是整条
          text: rg && view ? view.state.doc.textBetween(rg.from, rg.to) : a.textContent ?? '',
          from: rg?.from ?? -1,
          to: rg?.to ?? -1,
          x: r.left,
          y: r.bottom + 6,
        })
      }, OPEN_DELAY)
    }
    const onOut = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t?.closest?.(HOVER_SEL)) return
      const to = e.relatedTarget as HTMLElement | null
      if (to?.closest?.('.amx-linkcard')) return // safeBridge:挪进卡片不算离开
      if (openT.current) clearTimeout(openT.current)
      if (closeT.current) clearTimeout(closeT.current)
      closeT.current = setTimeout(() => { setHover(null); setFoot(null) }, CLOSE_DELAY)
    }
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    return () => {
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      clearTimers()
    }
  }, [getView])

  // 卡片是 fixed + 悬停那一刻的视口坐标:页面一滚,链接走了卡片还钉在原处 —— 滚动即收(编辑面板居中,不受影响)。
  useEffect(() => {
    if ((!hover && !foot) || edit) return
    const close = (): void => { setHover(null); setFoot(null) }
    document.addEventListener('scroll', close, true)
    return () => document.removeEventListener('scroll', close, true)
  }, [hover, foot, edit])

  /** 改写选定的整条链接:href=null 表示只摘掉链接(留文字与其余格式);text=''  连文字一起删;
   *  text 与原文相同 = 只改地址 → removeMark/addMark,**不重建文字**(code / 斜体 / 粗体原样留着,I-07);
   *  text 变了才整段重建,保留整条链接处处都有的格式(交集:整条加粗的改完仍加粗,半条加粗的无从归属就不带)。
   *  ⚠️ from/to/wasHref 是悬停那一刻的快照:开着卡片期间可能有外部回灌/协同事务改过文档,动手前**重新校验**
   *  这段仍恰好是那一条链接,不对就放弃 —— 宁可什么都不做,也不能改错一段文字。 */
  const rewrite = (from: number, to: number, wasHref: string, text: string | null, href: string | null): void => {
    const view = getView()
    const linkType = view?.state.schema.marks.link
    if (!view || !linkType) return
    const { doc } = view.state
    if (to > doc.content.size || from >= to) return
    const cur = linkRangeAt(doc, from, linkType)
    if (!cur || cur.from !== from || cur.to !== to || cur.mark.attrs.href !== wasHref) return
    const oldText = doc.textBetween(from, to)
    // 换地址时引用形(`[t][ref]`)的 ref 不再准确:清掉,落盘退成行内链接(与 refDefinitions 的写回口径一致)。
    const nextLink = (h: string): Mark => linkType.create({ ...cur.mark.attrs, href: h, ...('ref' in cur.mark.attrs ? { ref: null } : {}) })
    // ⚠️ 空串不能走 schema.text('')(prosemirror-model 直接抛 RangeError:Empty text nodes are
    //    not allowed)——「删除」按钮就是 text='' 这条路,评审实测必炸。空串 = 连文字一起删。
    let tr = view.state.tr
    if (text === '') {
      tr = tr.delete(from, to)
    } else if (text !== null && text !== oldText) {
      let common: readonly Mark[] | null = null
      doc.nodesBetween(from, to, (n) => {
        if (!n.isInline) return true
        common = common === null ? n.marks : common.filter((m) => m.isInSet(n.marks))
        return false
      })
      const keep = ((common ?? []) as readonly Mark[]).filter((m) => m.type !== linkType)
      tr = tr.replaceWith(from, to, view.state.schema.text(text, href ? nextLink(href).addToSet(keep) : keep))
      tr.setSelection(TextSelection.near(tr.doc.resolve(from + text.length)))
    } else if (href) {
      if (href === cur.mark.attrs.href) { view.focus(); return } // 什么都没改:不派事务、不写盘
      tr = tr.removeMark(from, to, cur.mark).addMark(from, to, nextLink(href))
    } else {
      tr = tr.removeMark(from, to, cur.mark)
    }
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  if (edit) {
    const canSave = !!normalizeHref(edit.href) && !!edit.text.trim()
    const close = (): void => {
      setEdit(null)
      setHover(null)
      getView()?.focus()
    }
    return (
      <OverlayPortal>
        <div className="amx-linkedit-backdrop" onMouseDown={() => setEdit(null)} role="presentation" />
        <OverlayAt className="amx-linkedit" x={window.innerWidth / 2} y={Math.round(window.innerHeight * 0.3)} center>
          {/* form:两个输入框里按 Enter 即保存;Esc 取消(键盘用户此前只能靠鼠标点按钮)。 */}
          <form
            className="amx-linkedit-form"
            onSubmit={(e) => {
              e.preventDefault()
              const href = normalizeHref(edit.href)
              if (!href || !edit.text.trim()) return
              rewrite(edit.from, edit.to, edit.wasHref, edit.text, href)
              setEdit(null)
              setHover(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.stopPropagation()
              close()
            }}
          >
          <label>
            {t('linkcard.text')}
            <input
              autoFocus
              value={edit.text}
              onChange={(e) => setEdit({ ...edit, text: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <label>
            {t('linkcard.link')}
            <input value={edit.href} onChange={(e) => setEdit({ ...edit, href: e.target.value })} />
          </label>
          <div className="amx-linkedit-row">
            <button type="button" onClick={close}>{t('common.cancel')}</button>
            <button type="submit" className="primary" disabled={!canSave}>
              {t('common.save')}
            </button>
          </div>
          </form>
        </OverlayAt>
      </OverlayPortal>
    )
  }

  if (foot) {
    return (
      <OverlayPortal>
        <OverlayAt
          className="amx-linkcard amx-fncard"
          x={foot.x}
          y={foot.y}
          onMouseEnter={() => {
            if (closeT.current) clearTimeout(closeT.current)
            closeT.current = null
          }}
          onMouseLeave={() => {
            closeT.current = setTimeout(() => setFoot(null), CLOSE_DELAY)
          }}
        >
          <span className="amx-fncard-num">{foot.num}</span>
          <span className={`amx-fncard-text${foot.text ? '' : ' muted'}`}>{foot.text == null ? t('linkcard.fnMissing') : foot.text || t('linkcard.fnEmpty')}</span>
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
  const editable = hover.from >= 0 && (getView()?.editable ?? true) // 只读视图(分享页):只给打开/复制
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
        <button
          className="amx-linkcard-host"
          title={hover.href}
          onClick={() => {
            if (onOpenNote && hrefKind(hover.href) === 'note') {
              setHover(null)
              onOpenNote(hover.href)
            } else window.open(hover.href, '_blank', 'noopener')
          }}
        >
          {host}
        </button>
        <span className="amx-linkcard-sep" />
        <button onClick={() => void navigator.clipboard.writeText(hover.href)}>{t('linkcard.copy')}</button>
        {editable && (
          <button onClick={() => setEdit({ from: hover.from, to: hover.to, text: hover.text, href: hover.href, wasHref: hover.href })}>{t('common.edit')}</button>
        )}
        {editable && (
          <button onClick={() => { rewrite(hover.from, hover.to, hover.href, null, null); setHover(null) }}>{t('linkcard.unlink')}</button>
        )}
        {editable && (
          <button className="danger" onClick={() => { rewrite(hover.from, hover.to, hover.href, '', null); setHover(null) }}>{t('common.delete')}</button>
        )}
      </OverlayAt>
    </OverlayPortal>
  )
}
