/** Desk 一格里那样东西「是什么、怎么拿出去」的共用件(11-23 Desk 视图与标签栏互通方案,用户定全部按建议):
 *  名字胶囊的图标、⋯ 里的四项打开、名字胶囊拖出去。Agent Desk 与 Human Desk 共用,别各写一份。
 *  这里不 import AgentDesk(它反过来用这里):库内相对路径由调用方算好传进来(rel)。 */
import React, { useEffect } from 'react'
import { Columns2, FileText, Loader2, Plus, Puzzle, Rows2, SquareArrowOutUpRight } from 'lucide-react'
import { copyOfView, endOpenDrag, getDetachApi, getView, hideDropCue, openViewSplit, startOpenDrag, useWorkspace, viewCopyable } from '@lcl/engine'
import type { ViewRef } from '@lcl/engine'
import { useApp, type DeskItem } from '../../stores/appStore'
import { setChatRefDrag } from '../../components/chatDragRef'
import type { CtxItem } from '../../components/RightPanel'
import { registerMessages } from '../../i18n'
import { fileViewRef } from '../../amadeusNav'
import { usePageStore } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { resolveIcon } from '@amadeus/components/icons'
import { iconForPath } from '../../services/fileKinds'

// ⋯ 里的四项打开:叫法照搬左栏「在新标签页打开」(sidebar.openInNewTab)与标签右键(lcl.tab.*),逐字一致;
// 另起 desk.* 键是因为那几条分别挂在左栏模块 / 引擎词典里,Desk 这里不能指望它们已经注册。
registerMessages({
  'desk.openNewTab': { zh: '在新标签页打开', en: 'Open in new tab' },
  'desk.splitRight': { zh: '向右拆分', en: 'Split right' },
  'desk.splitDown': { zh: '向下拆分', en: 'Split down' },
  'desk.openWindow': { zh: '在新窗口中打开', en: 'Open in new window' },
  // 名字胶囊悬停:能拖时接在路径后面;拖不起来的说原因(方案 §7)
  'desk.dragHint': { zh: '拖到标签栏可在新标签页打开', en: 'Drag to the tab bar to open in a new tab' },
  'desk.dragLive': { zh: '写完才能拖出去', en: 'Can be dragged out once writing finishes' },
  'desk.dragTool': { zh: '插件结果卡只能留在 Desk 和对话里', en: 'Plugin result cards stay in the Desk and chat' },
})

/** 视图参数里认作「这是哪份文件」的键(amadeus-* 视图是库内相对路径,wsfile / 媒体是 path)。 */
const FILE_KEYS = ['notePath', 'drawingPath', 'dbPath', 'pdfPath', 'imagePath', 'dashPath', 'filePath', 'path'] as const
const isAbsPath = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)
/** 网页引用把 URL 记在条目路径与视图参数里(ChatWikiLink:deskShowFile(url, browser 视图))—— 那不是文件。 */
const isUrl = (p: string): boolean => /^[a-z][a-z0-9+.-]+:\/\//i.test(p) && !/^file:/i.test(p)

/** 条目对应的那份文件:条目路径,或视图参数里的文件键;没有文件的(网页、插件视图……)回空串。 */
export function deskItemFile(it: DeskItem): string {
  if (it.path && !isUrl(it.path)) return it.path
  const p = (it.view?.params ?? {}) as Record<string, unknown>
  for (const k of FILE_KEYS) {
    const v = p[k]
    if (typeof v === 'string' && v && !isUrl(v)) return v
  }
  return ''
}

/** 名字胶囊的图标(方案 ③ 的表):直播 → 转圈;插件结果卡 → 拼图;有文件的 → 页面 emoji > 插件文件类型的图标 >
 *  按种类(白板 / 数据库 / 仪表盘 / PDF 书本 / 扩展名);没有文件的 → 它注册时给的标签图标;都认不出 → 一张纸。不再给星
 *  (星是卡片头「Agent Desk」的牌子)。rel = 条目路径在当前库里的相对路径(调用方算,库外为 null)。 */
export function DeskItemIcon({ item, rel, size, className }: { item: DeskItem; rel: string | null; size: number; className?: string }): React.ReactElement {
  const file = deskItemFile(item)
  // amadeus-* 视图参数里的文件本来就是库内相对路径;条目自己的路径由调用方相对化
  const key = rel ?? (item.view && file && !isAbsPath(file) ? file : null)
  const emoji = usePageStore((s) => (key ? s.icons[key] ?? null : null))
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const cls = className ?? ''
  if (item.live) return <Loader2 size={size} className={`${cls} spin`} />
  if (item.tool) return <Puzzle size={size} className={cls} />
  const Kind = file ? iconForPath(file) : (item.view && getView(item.view.type)?.icon) || FileText
  if (emoji) return <span className={`${cls} desk-cap-emoji`} aria-hidden="true">{emoji}</span>
  const ft = key ? findFileType(fileTypes, key) : undefined
  // resolveIcon 对不认识的键名回兜底 —— 兜底必须给,否则插件写了个新键这一格就空了(同文件树)
  if (ft?.icon) return <span className={`${cls} desk-cap-emoji`} aria-hidden="true">{resolveIcon(ft.icon, <Kind size={size} />)}</span>
  return <Kind size={size} className={cls} />
}

/** 这样东西在主区里对应的视图({type, params}),拆分 / 新窗口用。直播格、插件结果卡没有主区对应物 → null。
 *  库内文件按「打开」的分派次序算(amadeusNav.fileViewRef,插件文件类型、.db 不会进笔记编辑器);库外的、库里开不成
 *  主区标签的(.html、没人认领的类型)= 通用预览 wsfile,也就是 Desk 这一格本来显示的那种。 */
export function deskViewRef(it: DeskItem, rel: string | null): ViewRef | null {
  if (it.live || it.tool) return null
  if (it.view) {
    // Agent 直接给出的笔记编辑器也按文件重新分派一次:desk_present 可以写 amadeus-editor + 一份 .db / 插件文件类型,
    // 原样拆出去、开进新窗口 = 用笔记编辑器存回那份文件 = 毁档(Codex 评审)
    if (it.view.type === 'amadeus-editor') {
      const note = (it.view.params ?? {}).notePath
      const routed = typeof note === 'string' && note ? fileViewRef(note) : null
      return routed && copyOfView(routed)
    }
    return copyOfView({ type: it.view.type, params: { ...(it.view.params ?? {}) } }) // 跟随型视图钉住此刻看着的(同标签右键)
  }
  if (!it.path || isUrl(it.path)) return null
  return copyOfView((rel && fileViewRef(rel)) || { type: 'wsfile', params: { path: it.path, name: it.name } })
}

/** Desk 所在的那个对话标签(拆分的参照组)。ChatView 把正文滚动区 .t2-stream 登记成 chat surface,
 *  它和 Desk 是兄弟,同在 .t2-chat-view 里 —— 所以按共同的 .t2-chat-view 认,不能拿 surface.contains(Desk)。 */
export function deskHostLeaf(el: Element | null): string | null {
  const view = el?.closest('.t2-chat-view')
  if (!view) return null
  for (const [id, surface] of Object.entries(useWorkspace.getState().chatSurfaces ?? {})) {
    if (surface?.isConnected && view.contains(surface)) return id
  }
  return null
}

/** ⋯ 里的四项打开(方案 ②):在新标签页打开 → 向右拆分 → 向下拆分 → 在新窗口中打开(同标签右键「拆分在前、窗口在后」)。
 *  做不到的项不显示、不做灰项(标签右键也是按当下能不能做逐项出现),条件与标签右键同一套(viewCopyable)。
 *  Desk 那一格留着(11-23 用户定 A):四项都是再开一份。openTab = 原「在主区打开」的走法(库内走 Amadeus 的打开,已开着就切过去)。
 *  anchor = 这一格的元素,拆分按它所在的对话组算。 */
export function deskOpenItems(o: { item: DeskItem; rel: string | null; anchor: Element | null; openTab: () => void; t: (k: string) => string }): CtxItem[] {
  const { item, t } = o
  if (item.live || item.tool) return []
  const ref = deskViewRef(item, o.rel)
  const can = ref ? viewCopyable(ref.type) : { split: false, window: false }
  const host = ref && can.split ? deskHostLeaf(o.anchor) : null
  const split = (dir: 'right' | 'down') => (): void => {
    const h = deskHostLeaf(o.anchor) ?? host // 菜单开着时对话可能被拖到了别的组:执行那一刻再认一次
    if (ref && h) openViewSplit(ref, h, dir)
  }
  // 显式的笔记编辑器视图:新标签页也走重新分派过的那份(原「在主区打开」会原样开,.db 进笔记编辑器 = 毁档)
  const openTab = item.view?.type === 'amadeus-editor'
    ? (): void => { if (ref) useWorkspace.getState().openView(ref.type, ref.params ?? {}, 'main', { newTab: true }) }
    : o.openTab
  return [
    ...(item.view?.type === 'amadeus-editor' && !ref ? [] : [{ label: t('desk.openNewTab'), icon: <Plus size={14} />, run: openTab }]),
    ...(ref && host ? [
      { label: t('desk.splitRight'), icon: <Columns2 size={14} />, run: split('right') },
      { label: t('desk.splitDown'), icon: <Rows2 size={14} />, run: split('down') },
    ] : []),
    ...(ref && can.window ? [{ label: t('desk.openWindow'), icon: <SquareArrowOutUpRight size={14} />, run: () => getDetachApi()?.detach([ref]) }] : []),
  ]
}

// ── 名字胶囊拖出去(方案 ①) ───────────────────────────────────────────────────────────

/** 拖的是 Desk 里的一样(名字胶囊):格子据此分辨「Desk 自己的一样」与「拖进来一份文件」。 */
export const DESK_ITEM_MIME = 'application/x-forsion-desk-item'
let dragging: { sessionId: string; key: string } | null = null
/** 这扇窗里正拖着的 Desk 条目(dragover 读不到载荷,只能看 types —— 拖的是哪一样记在这里)。 */
export const deskDragging = (): { sessionId: string; key: string } | null => dragging

/** 这次拖拽是不是这条会话的 Desk 自己那一样(文件落点据此让路:不然拖到另一格会被当成「放进一份文件」= pick,不是对调)。 */
export const isOwnDeskDrag = (e: DragEvent, sessionId: string): boolean =>
  !!dragging && dragging.sessionId === sessionId && !!e.dataTransfer?.types.includes(DESK_ITEM_MIME)

/** 名字胶囊拖得起来吗:直播格(写完前)、插件结果卡(没有主区对应物)拖不起来。 */
export const canDragDeskItem = (it: DeskItem): boolean => !it.live && !it.tool

/** 名字胶囊悬停的那句(能拖 = 怎么拖;拖不起来 = 为什么)。 */
export function deskDragTip(it: DeskItem, t: (k: string) => string): string {
  return it.live ? t('desk.dragLive') : it.tool ? t('desk.dragTool') : t('desk.dragHint')
}

/** 拖进标签栏 / 主区正文的「落点即开」:同一份已经开着就切到它(LCL 再把它挪到落点),不新开第二个 —— 同从文件面板拖文件。
 *  库内文件交给调用方的打开(openVault = Amadeus 的打开,本来就是「已开着就切过去」);其余按视图开在当前标签旁边
 *  (不带 newTab:那一档只复用参数一致的那份,见 openBeside.ts)。 */
function dropOpen(it: DeskItem, rel: string | null, openVault: () => void): void {
  if (rel && !it.view) { openVault(); return }
  const ref = deskViewRef(it, rel)
  if (ref) useWorkspace.getState().openView(ref.type, ref.params ?? {}, 'main')
}

/** 名字胶囊的 onDragStart。拖影就是胶囊本身(浏览器缺省拖影),源胶囊变淡(.desk-cap-dragging,同拖标签)。落点:
 *  标签栏 / 主区正文 = 在落点打开(LCL 落点即开,落点线 / 半屏高亮都是现成的);输入框 = 一枚引用(带文件的才有);
 *  另一格 = 两格对调(useDeskItemDrop);拖出窗外 = 新窗口(LCL)。Desk 这一格一律留着(11-23 用户定 A)。
 *  没有文件的(网页、插件视图)不带引用:拖到对话正文上什么都不做 —— 对话区先认领下来,不让 LCL 画出「把对话那组拆开」。 */
/**  taken:拖出去真开出来了(落进标签栏 / 主区正文,或拖出窗外对面开成了)之后回一声 —— Human Desk 拖出去是「拿走」,
 *  在这里从它那边拿掉;拖进输入框(一枚引用)、落空、被别处接走都不算。Agent Desk 不传(那格留着)。 */
export function startDeskItemDrag(e: React.DragEvent<HTMLElement>, o: { sessionId: string; item: DeskItem; rel: string | null; openVault: () => void; taken?: () => void }): void {
  const dt = e.dataTransfer
  if (!dt || !canDragDeskItem(o.item)) { e.preventDefault(); return }
  e.stopPropagation() // 胶囊在聊天视图里:别让外层的拖源(若有)再起一次
  dragging = { sessionId: o.sessionId, key: o.item.key }
  try { dt.setData(DESK_ITEM_MIME, JSON.stringify(dragging)) } catch { /* 写不进自定义类型就只是普通拖拽 */ }
  dt.effectAllowed = 'copyMove' // 输入框按 copy 接、格子按 move 接:源只给一种,协商会把另一处判成不许放
  const file = deskItemFile(o.item)
  const rel = o.rel ?? (o.item.view && file && !isAbsPath(file) ? file : null)
  if (file) setChatRefDrag(dt, [rel ? { kind: 'note', path: rel } : { kind: 'file', path: file }])
  const ref = deskViewRef(o.item, o.rel)
  startOpenDrag(dt, {
    open: () => { dropOpen(o.item, o.rel, o.openVault); o.taken?.() },
    view: ref ?? undefined,
    ...(o.taken ? { detached: o.taken } : {}),
  })
  const cap = e.currentTarget.closest('.desk-cap-name')
  cap?.classList.add('desk-cap-dragging')
  // 没有文件的:窗里每一块对话区都先认领(不止源那一块 —— 并排的另一个对话同样不该被画成「拆开那组」,Codex 评审)
  const chats = file ? [] : [...document.querySelectorAll('.t2-chat-view')]
  const claim = (ev: Event): void => {
    const de = ev as DragEvent
    if (!dragging || !de.dataTransfer?.types.includes(DESK_ITEM_MIME)) return
    de.preventDefault() // 认领:LCL 的落点即开让给里层落区(见 WorkspaceHost watchClaims)
    if (de.dataTransfer) de.dataTransfer.dropEffect = 'none'
  }
  chats.forEach((c) => c.addEventListener('dragover', claim))
  // 收尾认 dragend;窗里松手再兜一次(落点开了新标签、对话那组被盖住时源胶囊可能卸掉,dragend 就到不了 window)。
  // 松手那一下先让格子 / 输入框把 drop 处理完(它们要读 dragging),下一拍再清。
  // 格子 / 输入框接住时停了冒泡,LCL 的 onListDrop 收不到 → 这里替它收尾(dragend 那一路 LCL 自己收,不在这里抢先)
  const late = (): void => { setTimeout(() => { end(); endOpenDrag() }, 0) }
  const end = (): void => {
    dragging = null
    cap?.classList.remove('desk-cap-dragging')
    chats.forEach((c) => c.removeEventListener('dragover', claim))
    window.removeEventListener('dragend', end, true)
    window.removeEventListener('drop', late, true)
  }
  window.addEventListener('dragend', end, true)
  window.addEventListener('drop', late, true)
}

/** 格子接住「这块 Desk 自己的一样」:到另一格 = 两格对调、拖过去的那样钉住(同 ⋯ 移到上面 / 下面,deskAct move);
 *  回到自己那格、直播那格 = 不接(光标 not-allowed、不染色)。文件落点(useDeskDrop)对这种拖拽不认,两边各管各的。 */
export function useDeskItemDrop(ref: React.RefObject<HTMLElement | null>, sessionId: string, slot: number, enabled: boolean, locked: boolean): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const mine = (e: DragEvent): { sessionId: string; key: string } | null =>
      dragging && dragging.sessionId === sessionId && e.dataTransfer?.types.includes(DESK_ITEM_MIME) ? dragging : null
    const from = (key: string): number => (useApp.getState().deskBySession[sessionId]?.items ?? []).findIndex((x) => x.key === key)
    const mark = (on: boolean): void => {
      el.toggleAttribute('data-drop', on)
      el.closest('.t2-chat-view')?.toggleAttribute('data-deskdrop', on)
    }
    const over = (e: DragEvent): void => {
      const d = mine(e)
      if (!d) return
      e.preventDefault()
      e.stopPropagation()
      const at = from(d.key)
      const ok = at >= 0 && at !== slot && !locked
      if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'move' : 'none'
      mark(ok)
      hideDropCue() // 从标签栏移过来:那根落点线别留着(这里停了冒泡,LCL 自己看不到这一下)
    }
    const drop = (e: DragEvent): void => {
      const d = mine(e)
      if (!d) return
      e.preventDefault()
      e.stopPropagation()
      mark(false)
      const at = from(d.key)
      if (at >= 0 && at !== slot && !locked) useApp.getState().deskAct(sessionId, { type: 'move', slot: at })
    }
    el.addEventListener('dragenter', over, true)
    el.addEventListener('dragover', over, true)
    el.addEventListener('drop', drop, true)
    return () => {
      el.removeEventListener('dragenter', over, true)
      el.removeEventListener('dragover', over, true)
      el.removeEventListener('drop', drop, true)
      mark(false)
    }
  }, [ref, sessionId, slot, enabled, locked])
}
