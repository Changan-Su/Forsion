/** Muse 的开场建议:新对话页 Chat Box 正下方最多三行(10-25 用户选方案 A,docs/ToBeImproved/Muse预制提示词方案_2026-10-25)。
 *  一行 = 来源图标 + Muse 写的一句话,句子里所指的东西(日程 / 笔记 / 会话 / 网页)画成链接。
 *  点行 = 整句填进输入框(不发;笔记 / 会话同时挂成引用芯片);点链接 = 只打开那个东西;× = 不感兴趣(告诉 Muse)。
 *  有草稿就收起:居中时只淡出、留着高度 —— 收掉高度会让居中的那一块在第一个字时整体跳一下。 */
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, BellOff, CalendarDays, FileText, Globe, ListTodo, MessagesSquare, Settings, Sparkles, X } from 'lucide-react'
import { OverlayAt, setActiveSpace, useNativeSheetMenu, type SheetMenuItem } from '@lcl/engine'
import { useI18n } from '../../i18n'
import { useApp } from '../../stores/appStore'
import { usePageStore } from '../../amadeus/store/pageStore'
import { openNote } from '../../amadeusNav'
import { openSession } from '../../sessionNav'
import { hostTargetFor, openWsFile } from '../wsFileNav'
import { CtxMenuButtons } from '../../components/CtxMenuButtons'
import type { MuseStarter } from '../../types'
import { refChipOf, type RefChip } from './Composer2'
import { setDraftField, useComposerDrafts } from './composerDrafts'
import { dismissStarter, noteStarterFilled, refreshMuseStarters, splitStarter, useMuseStarters } from './museStarterStore'
import '../../tangu/messages'

/** 草稿 key → 点行时挂上的那枚引用芯片的 token(模块级:草稿本身也是模块级的,切会话回来还对得上)。 */
const starterChips = new Map<string, string>()

const ICON: Record<MuseStarter['source']['kind'], typeof FileText> = {
  calendar: CalendarDays, note: FileText, todo: ListTodo, session: MessagesSquare, web: Globe, muse: Sparkles,
}

/** 笔记来源的路径引擎已解析成磁盘上真有的绝对路径(services/museStarters.ts resolveNoteRef)。落在本地笔记库里 → 库内相对路径;
 *  库外(授权文件夹里的 .md)→ null,按库外文件开、按文件挂引用。 */
const vaultRel = (path: string, root: string | null | undefined): string | null => {
  const p = path.replace(/\\/g, '/')
  const r = (root || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!/^(\/|[A-Za-z]:\/)/.test(p)) return p // 老数据里的库内相对路径
  return r && p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null
}

function openSource(s: MuseStarter, vaultRoot: string | null | undefined): void {
  const ref = s.source.ref
  switch (s.source.kind) {
    // 新标签打开:就地换掉的会是眼前这个新对话
    case 'note': if (ref) { const rel = vaultRel(ref, vaultRoot); if (rel) void openNote(rel, { newTab: true }); else openWsFile(hostTargetFor(ref, ref.split(/[/\\]/).pop() || ref), { newTab: true }) } return
    case 'session': if (ref) openSession(ref, { newTab: true }); return
    case 'web': if (ref && /^https?:\/\//i.test(ref)) { if (window.tangu?.openExternal) void window.tangu.openExternal(ref); else window.open(ref, '_blank', 'noopener') } return
    case 'calendar': case 'todo': setActiveSpace('calendar'); return
    default:
  }
}
const linkable = (s: MuseStarter): boolean =>
  s.source.kind === 'calendar' || s.source.kind === 'todo' || (s.source.kind === 'web' ? /^https?:\/\//i.test(s.source.ref || '') : (s.source.kind === 'note' || s.source.kind === 'session') && !!s.source.ref)

export function MuseStarters({ draftKey, centered }: { draftKey: string; centered: boolean }): React.ReactElement | null {
  const { t } = useI18n()
  const list = useMuseStarters((st) => st.list)
  const vaultRoot = usePageStore((st) => st.vaultRoot)
  // 点行时挂上的那枚引用芯片是这条建议的一部分:不算「用户在写」,文字删空时一起摘掉(三行才回得来)
  const ownChip = starterChips.get(draftKey)
  const text = useComposerDrafts((all) => all[draftKey]?.text ?? '')
  const drafting = useComposerDrafts((all) => {
    const d = all[draftKey]
    return !!d && (!!d.text.trim() || d.attachments.length > 0 || d.wsFiles.length > 0 || d.pastes.length > 0 || d.elements.length > 0 || d.refChips.some((c) => c.token !== ownChip))
  })
  useEffect(() => {
    if (text.trim() || !ownChip) return
    starterChips.delete(draftKey)
    setDraftField(draftKey, 'refChips', (prev) => prev.filter((c) => c.token !== ownChip))
  }, [text, ownChip, draftKey])
  const boxRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => { void refreshMuseStarters() }, [])
  useEffect(() => {
    const onFocus = (): void => { void refreshMuseStarters() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const fill = (s: MuseStarter): void => {
    setDraftField(draftKey, 'text', s.text)
    const root = vaultRoot || ''
    const rel = s.source.kind === 'note' && s.source.ref ? vaultRel(s.source.ref, root) : null
    const chip: RefChip | null = s.source.kind === 'note' && s.source.ref
      ? (rel && root ? refChipOf({ kind: 'note', path: rel }, root) : refChipOf({ kind: 'file', path: s.source.ref }, root))
      : s.source.kind === 'session' && s.source.ref ? refChipOf({ kind: 'session', id: s.source.ref, title: s.source.label }, root) : null
    // 换一条建议:先摘掉上一条挂的芯片
    const prevChip = starterChips.get(draftKey)
    starterChips.delete(draftKey)
    setDraftField(draftKey, 'refChips', (prev) => {
      const rest = prev.filter((c) => c.token !== prevChip)
      if (!chip || rest.some((c) => c.token === chip.token)) return rest
      starterChips.set(draftKey, chip.token)
      return [...rest, chip]
    })
    noteStarterFilled(draftKey, s.id)
    requestAnimationFrame(() => {
      const ta = boxRef.current?.closest('.composer-anchor')?.querySelector<HTMLTextAreaElement>('.t2c-ta')
      if (!ta) return
      ta.focus({ preventScroll: true })
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  const closeMenu = (): void => setMenu(null)
  const menuItems = (id: string): SheetMenuItem[] => [
    { id: 'dismiss', label: t('chat.starters.dismiss'), icon: <X size={13} />, run: () => { closeMenu(); dismissStarter(id) } },
    { id: 'mute', label: t('chat.starters.mute'), icon: <BellOff size={13} />, run: () => { closeMenu(); dismissStarter(id, true) } },
    { id: 'settings', label: t('chat.starters.settings'), icon: <Settings size={13} />, run: () => { closeMenu(); useApp.getState().openSettings('agents/ag-special') } },
  ]
  const webMenu = useNativeSheetMenu(menu, () => menu && { sections: [{ items: menuItems(menu.id) }] }, closeMenu)
  useEffect(() => {
    if (!menu || !webMenu) return
    const down = (e: PointerEvent): void => { if (!(e.target as Element | null)?.closest?.('.t2-starters-menu')) closeMenu() }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeMenu() }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', closeMenu)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); window.removeEventListener('blur', closeMenu) }
  }, [menu, webMenu])

  if (!list.length) return null
  return (
    <div ref={boxRef} className="t2-starters" data-hidden={drafting || undefined} data-centered={centered || undefined} aria-hidden={drafting || undefined}>
      {list.map((s) => {
        const Icon = ICON[s.source.kind] || Sparkles
        const { pre, link, post } = splitStarter(s)
        const canOpen = linkable(s)
        return (
          <div
            key={s.id}
            className="t2-starter"
            role="button"
            tabIndex={drafting ? -1 : 0}
            data-kind={s.source.kind}
            aria-label={t('chat.starters.aria', { text: s.text })}
            onClick={() => fill(s)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fill(s) }
              else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); dismissStarter(s.id) }
            }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ id: s.id, x: e.clientX, y: e.clientY }) }}
          >
            <Icon className="t2-starter-ic" size={16} aria-hidden />
            <span className="t2-starter-text">
              {pre}
              {link && (canOpen
                ? <a className="t2-starter-link" role="link" tabIndex={-1} onClick={(e) => { e.stopPropagation(); openSource(s, vaultRoot) }}>{link}<ArrowUpRight size={11} aria-hidden /></a>
                : <span className="t2-starter-link" data-static>{link}</span>)}
              {post}
            </span>
            <button type="button" className="t2-starter-x" tabIndex={-1} title={t('chat.starters.dismiss')} aria-label={t('chat.starters.dismiss')} onClick={(e) => { e.stopPropagation(); dismissStarter(s.id) }}>
              <X size={14} />
            </button>
          </div>
        )
      })}
      {/* 挂到 body:居中时输入区带着 translate,会成为 fixed 浮层的包含块,菜单按视口坐标就偏到别处去了 */}
      {menu && webMenu && createPortal(
        <OverlayAt className="ctx-menu t2-starters-menu" x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
          <CtxMenuButtons items={menuItems(menu.id)} />
        </OverlayAt>,
        document.body,
      )}
    </div>
  )
}
