/**
 * 库内文件这类对象(LCL 对象层第一期,正典:仓根 docs/ToBeImproved/LCL对象动作统一方案_2026-11-07)。
 *
 * id = 库内相对路径(笔记、仪表盘、白板、多维表、库里的 PDF / 图片 / 插件文件 / 其它附件)。一处定义能对它做什么:
 * 打开 / 在新标签页打开 / 用内置阅读器打开 / 用系统程序打开 / 收藏 / 云同步 / 在文件管理器中显示 / 复制路径 / 删除。
 * 笔记树右键(单选、多选、手机「最近」长按)、笔记「⋯」(桌面菜单、手机底部 sheet)出的都是这一份;
 * 各处只另给「本处」那几项(新建子笔记、重命名、排版、切源码…)。双链菜单等 #521 合进来后再接。
 *
 * 跟着笔记视图装(amadeusViews 顶层调 installNoteObject):笔记的界面都在那个模块里,不把整个库栈拉进启动路径。
 * 电脑上的绝对路径(对话文件面板、工作区文件视图)是另一类,第二期接。
 */
import { ArrowUpRight, BookOpen, Cloud, Copy, ExternalLink, FolderOpen, Plus, Star, Trash2 } from 'lucide-react'
import {
  getObjectAction, objectCaps, buildObjectMenu, registerObjectAction, registerObjectType,
  OBJECT_REASON, type ActionResult, type ObjectContext, type ObjectRef, type Place,
} from '@lcl/engine'
import type { ReactNode } from 'react'
import { usePageStore, pageStoreFor } from '@amadeus/store/pageStore'
import { amadeus } from '@amadeus/api'
import { usePluginStore, findFileType } from '@amadeus/plugins/pluginStore'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isDashboardPath } from '@amadeus-shared/dashboard'
import { openNote, openDb, openPdf, openImage, openDrawing, openDashboard, openFile } from '../amadeusNav'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { isSyncedEntry } from '../stores/entrySyncStore'
import { openCloudSyncDialog } from '../components/CloudSyncDialog'
import { isSafeVaultPath } from '../deepLinkPlan'
import { canTrash, deleteFileMsg, deleteNoteFlow, deleteNoteMsg } from '../noteDelete'
import { registerMessages, translate } from '../i18n'

registerMessages({
  'objects.file.label': { zh: '文件', en: 'File' },
  // 下面这些沿用笔记树原来的键(树上 swipe、文件夹菜单也还在用),跟着对象动作搬到这里登记
  'amxv.menu.openInNewTab': { zh: '在新标签页打开', en: 'Open in new tab' },
  'amxv.menu.openNInNewTabs': { zh: '在新标签页打开 {n} 项', en: 'Open {n} items in new tabs' },
  'amxv.menu.deleteN': { zh: '删除 {n} 项', en: 'Delete {n} items' },
  'amxv.menu.star': { zh: '收藏', en: 'Star' },
  'amxv.menu.unstar': { zh: '取消收藏', en: 'Unstar' },
  'amxv.menu.cloudSyncOff': { zh: '关闭云同步', en: 'Turn off cloud sync' },
  'amxv.menu.cloudSyncOn': { zh: '开启云同步', en: 'Turn on cloud sync' },
  'amxv.menu.delete': { zh: '删除', en: 'Delete' },
  'amxv.menu.open': { zh: '打开', en: 'Open' },
  'amxv.menu.openWithSystem': { zh: '用系统程序打开', en: 'Open with the system app' },
  'amxv.menu.openBuiltinReader': { zh: '用内置阅读器打开', en: 'Open with the built-in reader' },
  'amxv.menu.openDrawing': { zh: '打开白板', en: 'Open whiteboard' },
  'amxv.menu.deleteNote': { zh: '删除笔记', en: 'Delete note' },
  'objects.file.reveal': { zh: '在文件管理器中显示', en: 'Show in file manager' },
  'objects.file.copyPath': { zh: '复制路径', en: 'Copy path' },
  'objects.file.deleteOk': { zh: '删除', en: 'Delete' },
  'objects.file.gone': { zh: '这个文件已经不在了', en: 'This file no longer exists' },
  'objects.file.changed': { zh: '这个文件刚刚变过，请重新打开菜单再试', en: 'This file just changed. Open the menu again and retry.' },
  'objects.file.otherVault': { zh: '已经换了智库，请重新打开菜单再试', en: 'The vault changed. Open the menu again and retry.' },
})

export const NOTE = 'note'
/** scope = 库根:同一个相对路径在另一个库里是另一个文件。弹菜单后切了库,执行时就对不上,不动它。 */
const vaultNow = (): string | undefined => usePageStore.getState().vaultRoot ?? undefined
export const noteRef = (path: string): ObjectRef => {
  const scope = vaultNow()
  return scope ? { type: NOTE, id: path, scope } : { type: NOTE, id: path }
}

const isNotePath = (p: string): boolean => /\.md$/i.test(p)
const isDbPath = (p: string): boolean => /\.db$/i.test(p)
const isPdfPath = (p: string): boolean => /\.pdf$/i.test(p)
const isImagePath = (p: string): boolean => /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(p)
const pluginType = (p: string) => findFileType(usePluginStore.getState().fileTypes, p)

/** 树上那一行算哪种(同 amadeusViews 树行的 ctxKind 与资源菜单的分支顺序):page = 笔记 / 仪表盘(点开就是它,菜单里不给「打开」)。 */
export type FileKind = 'page' | 'db' | 'pdf' | 'image' | 'drawing' | 'plugin' | 'other'
export function fileKind(p: string): FileKind {
  const draw = isDrawingPath(p)
  const dash = !draw && isDashboardPath(p)
  const ft = !draw && !dash ? pluginType(p) : undefined
  if (dash || (!draw && !ft && isNotePath(p))) return 'page'
  if (isDbPath(p)) return 'db'
  if (isPdfPath(p)) return 'pdf'
  if (isImagePath(p)) return 'image'
  if (draw) return 'drawing'
  if (ft) return 'plugin'
  return 'other'
}
/** 删除走「笔记流程」(确认 + 问独占附件)的那些:同多选删除的判据。 */
const deletesAsNote = (p: string): boolean => isNotePath(p) && !isDrawingPath(p)

/** 点一下 = 树上点那一行(同 amadeusViews 的 openEntry):按种类开进各自的视图,认不出的交系统程序。 */
export function openVaultEntry(path: string, nt?: { newTab?: boolean }): void {
  const isDraw = isDrawingPath(path)
  const isDash = !isDraw && isDashboardPath(path)
  const ft = !isDraw && !isDash ? pluginType(path) : undefined
  if (ft) openFile(path, nt)
  else if (isDash) openDashboard(path, nt)
  else if (isDraw) openDrawing(path, nt)
  else if (isNotePath(path)) void openNote(path, nt)
  else if (isDbPath(path)) openDb(path, nt)
  else if (isPdfPath(path)) openPdf(path, undefined, nt)
  else if (isImagePath(path)) openImage(path, nt)
  else void amadeus.openVaultFile(path).catch(() => {})
}

// ── 「还是那一个」:同一个库里同一路径被删掉 / 改名走后又出现(另一个文件占了这个名字)就换一代。菜单弹出时记下代数,
//    执行前对不上 = 不是弹菜单时那个文件了,不动它。代数按「库 + 路径」记。同一次刷新里先改名再新建同名的(路径从没消失过)
//    认不出 —— 已知限度。
const gen = new Map<string, number>()
let seen = new Set<string>()
const keyOf = (vault: string | undefined, p: string): string => `${vault ?? ''}\u0000${p}`
const genOf = (ref: ObjectRef): number => gen.get(keyOf(ref.scope, ref.id)) ?? 0
function trackGenerations(): void {
  const keysOf = (s: { vaultRoot: string | null; pages: string[]; files: string[] }): Set<string> =>
    new Set([...s.pages, ...s.files].map((p) => keyOf(s.vaultRoot ?? undefined, p)))
  seen = keysOf(usePageStore.getState())
  usePageStore.subscribe((s, prev) => {
    if (s.pages === prev.pages && s.files === prev.files && s.vaultRoot === prev.vaultRoot) return
    const next = keysOf(s)
    for (const k of next) if (!seen.has(k)) gen.set(k, (gen.get(k) ?? 0) + 1)
    seen = next
  })
}
const exists = (p: string): boolean => {
  const s = usePageStore.getState()
  return s.pages.includes(p) || s.files.includes(p)
}

/** 删除 / 读状态用哪份 store:「⋯」带着本面板的 scope(place.container),树上用门面(活动面板)。 */
const storeOf = (cx: ObjectContext) => (cx.place.container ? () => pageStoreFor(cx.place.container!).getState() : () => usePageStore.getState())
const vaultSideLocal = (): boolean => usePageStore.getState().vaultSide === 'local'
const canEntrySync = (): boolean => typeof window !== 'undefined' && !!window.amadeusSync?.entrySyncEnable && vaultSideLocal()
const synced = (p: string): boolean => isSyncedEntry(usePageStore.getState().vaultRoot, p)
const inNoteMore = (cx: ObjectContext): boolean => cx.place.kind === 'note-more'

let installed = false
export function installNoteObject(): void {
  if (installed) return
  installed = true
  trackGenerations()

  registerObjectType({
    type: NOTE,
    label: () => translate('objects.file.label'),
    isValidId: isSafeVaultPath,
    info: (ref) => (exists(ref.id) ? { title: ref.id.split('/').pop()!.replace(/\.md$/i, '') } : undefined),
    subscribe: (cb) => usePageStore.subscribe((s, p) => { if (s.pages !== p.pages || s.files !== p.files) cb() }),
    openModes: ['here', 'newTab'],
    open: (ref, how) => openVaultEntry(ref.id, how === 'newTab' ? { newTab: true } : undefined),
    snapshot: (ref) => genOf(ref),
    verify: (ref, snap) => {
      if (ref.scope !== vaultNow()) return translate('objects.file.otherVault')
      if (!exists(ref.id)) return translate('objects.file.gone')
      return snap !== undefined && snap !== genOf(ref) ? translate('objects.file.changed') : null
    },
    uri: (ref) => `forsion://note/${ref.id.split('/').map(encodeURIComponent).join('/')}`,
  })

  // ── 打开 ──
  registerObjectAction({
    id: 'note.open',
    types: [NOTE],
    group: 'open',
    order: 0,
    icon: ArrowUpRight,
    // 白板沿用「打开白板」;笔记 / 仪表盘点那一行就开,树上不列(「⋯」里那篇已经开着)
    title: ([r]) => translate(fileKind(r.id) === 'drawing' ? 'amxv.menu.openDrawing' : 'amxv.menu.open'),
    when: ([r], cx) => !inNoteMore(cx) && fileKind(r.id) !== 'page',
    run: ([r]) => {
      const k = fileKind(r.id)
      if (k === 'db') openDb(r.id)
      else if (k === 'image') openImage(r.id)
      else if (k === 'drawing') openDrawing(r.id)
      else if (k === 'pdf' || k === 'plugin') openFile(r.id) // PDF 经 openFile:插件接管了就进插件视图,否则内置阅读器
      else void amadeus.openVaultFile(r.id).catch(() => {})
    },
  })

  registerObjectAction({
    id: 'note.openInNewTab',
    types: [NOTE],
    group: 'open',
    order: 1,
    icon: Plus,
    multi: true,
    title: (refs) => (refs.length > 1 ? translate('amxv.menu.openNInNewTabs', { n: refs.length }) : translate('amxv.menu.openInNewTab')),
    when: (refs, cx) => !inNoteMore(cx) && (refs.length > 1 || fileKind(refs[0].id) === 'page'),
    run: (refs) => { for (const r of refs) openVaultEntry(r.id, { newTab: true }) },
  })

  // 插件接管了 PDF 时,内置阅读器留一条永远够得着的入口
  registerObjectAction({
    id: 'note.openBuiltinReader',
    types: [NOTE],
    group: 'open',
    order: 2,
    icon: BookOpen,
    title: () => translate('amxv.menu.openBuiltinReader'),
    when: ([r], cx) => !inNoteMore(cx) && isPdfPath(r.id) && !!pluginType(r.id),
    run: ([r]) => openPdf(r.id),
  })

  registerObjectAction({
    id: 'note.openWithSystem',
    types: [NOTE],
    group: 'open',
    order: 3,
    icon: ExternalLink,
    title: () => translate('amxv.menu.openWithSystem'),
    // 认不出的文件「打开」本来就是交系统程序,不再重复列一条
    when: ([r], cx) => !inNoteMore(cx) && !['page', 'other'].includes(fileKind(r.id)),
    run: ([r]) => { void amadeus.openVaultFile(r.id).catch(() => {}) },
  })

  // ── 整理 ──
  registerObjectAction({
    id: 'note.star',
    types: [NOTE],
    group: 'organize',
    order: 0,
    icon: Star,
    title: ([r]) => translate(useAmadeusPrefs.getState().starred.includes(r.id) ? 'amxv.menu.unstar' : 'amxv.menu.star'),
    on: ([r]) => useAmadeusPrefs.getState().starred.includes(r.id),
    when: ([r]) => fileKind(r.id) === 'page',
    run: ([r]) => useAmadeusPrefs.getState().toggleStar(r.id),
  })

  registerObjectAction({
    id: 'note.cloudSync',
    types: [NOTE],
    group: 'organize',
    order: 1,
    icon: Cloud,
    title: ([r]) => translate(synced(r.id) ? 'amxv.menu.cloudSyncOff' : 'amxv.menu.cloudSyncOn'),
    on: ([r]) => synced(r.id),
    when: ([r]) => fileKind(r.id) === 'page' && canEntrySync(),
    run: ([r]) => {
      if (synced(r.id)) void window.amadeusSync?.entrySyncDisable?.(r.id)
      else openCloudSyncDialog(r.id, 'page')
    },
  })

  // ── 分享 / 定位 ──
  registerObjectAction({
    id: 'note.reveal',
    types: [NOTE],
    group: 'share',
    order: 0,
    icon: FolderOpen,
    title: () => translate('objects.file.reveal'),
    when: (_refs, cx) => cx.caps.revealFile,
    run: ([r]) => { void amadeus.revealInFileManager(r.id) },
  })

  registerObjectAction({
    id: 'note.copyPath',
    types: [NOTE],
    group: 'share',
    order: 1,
    icon: Copy,
    title: () => translate('objects.file.copyPath'),
    run: async ([r]) => { await navigator.clipboard.writeText(r.id) },
  })

  // ── 删除:确认归执行层(一次);笔记照旧走 deleteNoteFlow(问独占附件),其余文件直接删(有回收站就进回收站) ──
  registerObjectAction({
    id: 'note.delete',
    types: [NOTE],
    group: 'danger',
    icon: Trash2,
    multi: true,
    title: (refs, cx) => refs.length > 1
      ? translate('amxv.menu.deleteN', { n: refs.length })
      : translate(inNoteMore(cx) ? 'amxv.menu.deleteNote' : 'amxv.menu.delete'),
    // 有回收站(可恢复)单个删除不问;一次删好几个照旧先问一句 —— 按当初选了几个算(cx.batch),重验滤掉一个剩下的也照样问
    confirm: (refs, cx) => {
      if (refs.length > 1 || (cx.batch ?? refs.length) > 1) return { title: translate('amxv.confirm.deleteSelected', { n: refs.length }), confirm: translate('objects.file.deleteOk'), danger: true }
      if (canTrash()) return undefined
      const p = refs[0].id
      return { title: deletesAsNote(p) ? deleteNoteMsg(p) : deleteFileMsg(p), confirm: translate('objects.file.deleteOk'), danger: true }
    },
    run: async (refs, cx): Promise<ActionResult[]> => {
      const store = storeOf(cx)
      const out: ActionResult[] = []
      for (const r of refs) {
        try {
          if (deletesAsNote(r.id)) {
            const done = await deleteNoteFlow(r.id, store, { confirmed: true })
            out.push(done ? { ref: r, ok: true } : { ref: r, ok: false, reason: OBJECT_REASON.cancelled })
          } else {
            await store().deletePage(r.id)
            out.push({ ref: r, ok: true })
          }
        } catch (e) {
          out.push({ ref: r, ok: false, reason: e instanceof Error && e.message ? e.message : OBJECT_REASON.error })
        }
      }
      return out
    },
  })
}

/** 手机底部 sheet 的行(`AmxAction` 形状):同一份对象动作,图标 16,开关项带 `on` 高亮。 */
export function noteSheetRows(path: string, place: Place): Array<{ id: string; icon: ReactNode; label: string; on?: boolean; danger?: boolean; run: () => void }> {
  const refs = [noteRef(path)]
  const cx: ObjectContext = { place, caps: objectCaps() }
  return buildObjectMenu({ refs, place, iconSize: 16 }).sections.flatMap((s) => s.items).filter((it) => !!it.run).map((it) => {
    let on: boolean | undefined
    try { on = getObjectAction(it.id)?.on?.(refs, cx) } catch { on = undefined }
    return { id: it.id, icon: it.icon, label: it.label, ...(on ? { on } : {}), ...(it.danger ? { danger: true } : {}), run: it.run! }
  })
}
