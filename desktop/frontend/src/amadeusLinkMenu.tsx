/**
 * 笔记里渲染出来的双链的右键菜单(2026-10-13 用户定:双链是一个文件,右键出这份文件的操作,不是文字编辑菜单)。
 *
 * 双链部件(amadeus/blocks/markdown/wikilink.ts)在 contextmenu 时向上派 `amadeus:wikilink-menu`;这里在 window 上接:
 * 认得出目标就 preventDefault(部件据此不出系统菜单)并弹菜单,外链不接(照旧系统菜单)。来源页读链接所在那个编辑器
 * 钉在根上的 `data-amx-src`(与点击、悬停预览同一个源:嵌在别的笔记里的内容按它自己的所有者解析),没钉的宿主退回当前活动页。
 * 另管一件:按下双链时把它所在的那一栏设成活动栏(见 activatePaneOf),点击的「开在旁边」和菜单里的两项才有准头。
 *
 * 只放对「一条链接指向的文件」说得通、且现成流程接得住的几项。重命名 / 移动 / 删除不在这里:它们目前只在文件树那一行上有,
 * 各类型有各自的流程(笔记改名连带反链、多维表走 renameDb、PDF 等附件没有改名),别在这儿另写一套。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Columns2, Copy, ExternalLink, FilePlus, FolderOpen, Pencil, Plus } from 'lucide-react'
import { OverlayAt, useWorkspace } from '@lcl/engine'
import { amadeus } from '@amadeus/api'
import { usePageStore } from '@amadeus/store/pageStore'
import { canOpenAttachment, canRevealInFileManager } from '@amadeus/lib/hostCaps'
import { resolveWikiTarget, type WikiTarget } from '@amadeus/lib/wikiTarget'
import { isPdfLinkInner, parseBlockSubpath, parseMediaLinkInner } from '@amadeus-shared/pdfLink'
import { openNote, opensAsTab, revealBlockWhenReady, revealHeadingWhenReady } from './amadeusNav'
import { extHit } from './viewFileMatch'
import { registerMessages, useI18n } from './i18n'

registerMessages({
  'linkmenu.aria': { zh: '链接菜单', en: 'Link menu' },
  'linkmenu.newTab': { zh: '在新标签页打开', en: 'Open in new tab' },
  'linkmenu.split': { zh: '在分屏中打开', en: 'Open in split' },
  'linkmenu.system': { zh: '用系统程序打开', en: 'Open with the system app' },
  'linkmenu.reveal': { zh: '在文件管理器中显示', en: 'Show in file manager' },
  'linkmenu.copyPath': { zh: '复制路径', en: 'Copy path' },
  'linkmenu.edit': { zh: '编辑链接', en: 'Edit link' },
  'linkmenu.create': { zh: '创建笔记', en: 'Create note' },
})

/** 把 el 所在的那一栏设成活动栏。双链部件吃掉了 mousedown(不落光标),焦点进不了这一栏,Dockview 就不知道用户在这儿:
 *  随后的「开在旁边」会拿上一次的活动栏当参照 —— 旁边已经开着一份 PDF 时,再点一条双链反而开进笔记自己这一栏。 */
function activatePaneOf(el: Element): void {
  const api = useWorkspace.getState().api
  const group = api?.groups.find((g) => g.element.contains(el))
  const front = group?.activePanel
  // 只管主区:侧栏(对话里的引用条等)里的双链不该把侧栏变成「当前栏」。
  if (front && (front.params as { __loc?: string } | undefined)?.__loc === 'main' && group.id !== api?.activeGroup?.id) front.api.setActive()
}

interface MenuDetail { inner?: string; x?: number; y?: number; edit?: () => void }
interface LinkMenu { x: number; y: number; inner: string; src?: string; target: Exclude<WikiTarget, { kind: 'external' }>; edit?: () => void; host: HTMLElement }

export function WikiLinkMenuHost(): ReactElement | null {
  const { t } = useI18n()
  const [menu, setMenu] = useState<LinkMenu | null>(null)

  useEffect(() => {
    const onMenu = (e: Event): void => {
      const d = (e as CustomEvent<MenuDetail>).detail
      const inner = (d?.inner ?? '').trim()
      if (!inner || typeof d?.x !== 'number' || typeof d?.y !== 'number') return
      const st = usePageStore.getState()
      const el = e.target as HTMLElement | null
      const src = el?.closest?.<HTMLElement>('[data-amx-src]')?.dataset.amxSrc || st.activePage || undefined
      const target = resolveWikiTarget(inner, st.pages, st.files, src)
      if (target.kind === 'external') return
      // 找不到的 PDF / 媒体链接没有「创建笔记」可言(openWikiLink 对它们直接返回);连「编辑链接」也没有(只读)就不接。
      if (target.kind === 'missing' && !d.edit && (isPdfLinkInner(inner) || !!parseMediaLinkInner(inner))) return
      e.preventDefault()
      // 挂到链接所在的 .am-app 下:菜单的主题作用域与编辑器自己的块菜单一致(同 OverlayPortal 的做法)。
      setMenu({ x: d.x, y: d.y, inner, src, target, edit: d.edit, host: el?.closest?.<HTMLElement>('.am-app') ?? document.body })
    }
    // 捕获阶段:赶在部件自己的 mousedown(当场就开)之前,左键 / 中键 / 右键都算。
    const onDown = (e: MouseEvent): void => {
      const link = (e.target as Element | null)?.closest?.('.ProseMirror .wikilink[data-wiki]')
      if (link) activatePaneOf(link)
    }
    window.addEventListener('amadeus:wikilink-menu', onMenu)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('amadeus:wikilink-menu', onMenu)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = (e: Event): void => {
      if ((e.target as HTMLElement | null)?.closest?.('.amx-link-menu')) return
      setMenu(null)
    }
    // 按任何键都收:菜单只认鼠标,而快捷键(后退 / 换标签…)会把链接所在的页面换走,留着的菜单指的就是一份过期的目标。
    const drop = (): void => setMenu(null)
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('wheel', close, true)
    window.addEventListener('keydown', drop, true)
    window.addEventListener('blur', drop)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('wheel', close, true)
      window.removeEventListener('keydown', drop, true)
      window.removeEventListener('blur', drop)
    }
  }, [menu])

  if (!menu) return null
  const { target, inner, src } = menu
  const run = (fn: () => void) => (): void => { setMenu(null); fn() }
  const open = (opts?: { newTab?: boolean; split?: boolean }): void => usePageStore.getState().openWikiLink(inner, src, opts)
  // 笔记的「在分屏中打开」:openWikiLink 的 split 只认文件(点击的默认,笔记要留在原地),这里是显式要分屏 → 直接走 openNote。
  const noteBeside = async (path: string, subpath?: string): Promise<void> => {
    await openNote(path, { split: true })
    const block = subpath ? parseBlockSubpath(subpath) : null
    if (block) await revealBlockWhenReady(path, block)
    else if (subpath && !subpath.startsWith('^')) await revealHeadingWhenReady(path, subpath)
  }
  // 「新标签页 / 分屏」只给应用里开得成标签的目标:交系统程序的文件给了也是空话。单列壳(手机)没有分屏;图片不分屏(用户定)。
  const asTab = target.kind === 'note' || (target.kind === 'file' && opensAsTab(target.path))
  const canSplit = asTab && !!useWorkspace.getState().api && !(target.kind === 'file' && extHit(target.path, 'amadeus-image'))
  const creatable = target.kind === 'missing' && !isPdfLinkInner(inner) && !parseMediaLinkInner(inner)

  return createPortal(
    <OverlayAt className="ctx-menu amx-link-menu" role="menu" aria-label={t('linkmenu.aria')} x={menu.x} y={menu.y} onClick={(e) => e.stopPropagation()}>
      {target.kind === 'missing' ? creatable && (
        <button data-act="create" onClick={run(() => open())}><FilePlus size={13} /> {t('linkmenu.create')}</button>
      ) : (
        <>
          {asTab && <button data-act="newtab" onClick={run(() => open({ newTab: true }))}><Plus size={13} /> {t('linkmenu.newTab')}</button>}
          {canSplit && (
            <button data-act="split" onClick={run(() => { if (target.kind === 'note') void noteBeside(target.path, target.subpath); else open({ split: true }) })}>
              <Columns2 size={13} /> {t('linkmenu.split')}
            </button>
          )}
          {target.kind === 'file' && canOpenAttachment() && (
            <button data-act="system" onClick={run(() => void amadeus.openVaultFile(target.path).catch(() => {}))}><ExternalLink size={13} /> {t('linkmenu.system')}</button>
          )}
          {canRevealInFileManager() && (
            <button data-act="reveal" onClick={run(() => void amadeus.revealInFileManager(target.path))}><FolderOpen size={13} /> {t('linkmenu.reveal')}</button>
          )}
          <button data-act="copypath" onClick={run(() => void navigator.clipboard?.writeText(target.path).catch(() => {}))}><Copy size={13} /> {t('linkmenu.copyPath')}</button>
        </>
      )}
      {menu.edit && <button data-act="edit" onClick={run(menu.edit)}><Pencil size={13} /> {t('linkmenu.edit')}</button>}
    </OverlayAt>,
    menu.host,
  )
}
