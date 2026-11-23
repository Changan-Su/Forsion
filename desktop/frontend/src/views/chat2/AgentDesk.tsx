/** Agent Desk:聊天右侧的 agent 演出面板。
 *  格子=shim leaf(不进 Dockview,不碰布局持久化):vault 内文件按类型改道原生 view(笔记/导图/
 *  白板/插件文件/.db),任意注册视图(item.view,含插件注册)按 LCL 注册表挂载,其余走 WsFileView
 *  通用预览。状态在 appStore.deskBySession(会话级快照落 localStorage)。宽度=size 档位或用户
 *  拖出的 fraction —— 一律比例制,对 body 端级 zoom 免疫(px 会被 zoom 缩放,% 不会)。 */
import React, { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, Copy, Eraser, Loader2, Maximize2, Minimize2, NotebookPen, Pin, Rows2, Sparkles, SquarePen, X } from 'lucide-react'
import { getView, subscribeViews, useWorkspace } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { useApp, type DeskItem } from '../../stores/appStore'
import { DESK_DRAFT_KEY, clampSplit, deskItemFor, deskMenuRows, extractLiveBody, extractStreamingString, visibleSlots } from '../../stores/deskPlan'
import { deskSideOf } from '../../stores/humanDeskPlan'
import { PATHS_MIME, REF_MIME, readChatRefs } from '../../components/chatDragRef'
import { WsFileView } from '../WsFileView'
import { usePageStore } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import { useDeskCompanion } from '@amadeus/plugins/deskCompanion'
import { DeskCompanionHost } from './DeskCompanionHost'
import { registerMessages, useI18n } from '../../i18n'
import { DeskItemIcon, deskDragTip, deskOpenItems, isOwnDeskDrag, startDeskItemDrag, canDragDeskItem, useDeskItemDrop } from './deskOpen'
import { fileViewRef, openDb, openFile, openNote, opensAsTab } from '../../amadeusNav'
import type { CtxItem } from '../../components/RightPanel'
import { DeskChromeContext, DeskMoreButton, DeskPickButton, type DeskChrome, type DeskPickRow } from './deskChrome'
import { DeskToolCardPane } from './DeskToolCardPane'
import { CardAction, SummaryCard } from './TaskSummary'
import { bumpOpen, openOf, setUserOpen, touchDesk, useSummaryOpen } from './summaryOpen'
import { DeskSqueezeContext } from './TaskSummary'
import '../../tangu/messages' // Tangu 自己的文案片段(核心插件化 2c)

registerMessages({
  'desk.writing': { zh: '正在编辑 {name}', en: 'Editing {name}' },
  'desk.drafting': { zh: '正在起草…', en: 'Drafting…' },
  'desk.expand': { zh: '展开', en: 'Expand' },
  'desk.collapse': { zh: '收起为卡片', en: 'Collapse to card' },
  'desk.empty': { zh: 'Agent 会在这里展示成果', en: 'Agent will present work here' },
  'desk.idle': { zh: '空着', en: 'Empty' },
  'desk.clear': { zh: '清空 Desk', en: 'Clear Desk' },
  'desk.more': { zh: '更多', en: 'More' },
  'desk.switch': { zh: '切换 Desk 上的内容', en: 'Switch Desk item' },
  // 两格手动控制(11-23 方案 A)
  'desk.solo': { zh: '只看这一格', en: 'Show only this' },
  'desk.both': { zh: '恢复两格', en: 'Show both' },
  'desk.moveUp': { zh: '移到上面', en: 'Move up' },
  'desk.moveDown': { zh: '移到下面', en: 'Move down' },
  'desk.remove': { zh: '从 Desk 拿掉', en: 'Remove from Desk' },
  // 旧叫法:Agent Desk 已换成 deskOpen.tsx 的四项(11-23);Human Desk 分支还在用,它换过去之后删
  'desk.openMain': { zh: '在主区打开', en: 'Open in main area' },
  'desk.pinned': { zh: '钉住', en: 'Pinned' },
  'desk.unpin': { zh: '取消钉住', en: 'Unpin' },
  'desk.fresh': { zh: 'Agent 刚放的', en: 'Just added by the agent' },
  'desk.recent': { zh: '最近放过的', en: 'Recently shown' },
  'desk.thisCell': { zh: '这一格', en: 'This cell' },
  'desk.otherCell': { zh: '在另一格', en: 'In the other cell' },
  'desk.justNow': { zh: '刚刚', en: 'Just now' },
  'desk.resize': { zh: '拖动调整上下高度，双击恢复各半', en: 'Drag to resize, double-click to reset' },
  // Human Desk(11-23 第三轮):Agent Desk 一格 ⋯ 里把这样东西挪到你那边
  'desk.takeOver': { zh: '我来改', en: 'I’ll edit this' },
})

/** 「清空 Desk」(idle 伴随面的回场键):条目清掉、侧板收回、说明一并作废 —— 卡片空态位交还伴随面。
 *  钉住、只看一格、▾ 上的点一起清(最近放过的留着)。 */
const clearDesk = (sessionId: string, keepOpen = false): void => {
  useApp.getState().deskAct(sessionId, { type: 'clear' })
  // keepOpen:有空闲面(Muse 私聊)时侧板不用收 —— 清掉条目,原地换回 Muse Space
  if (!keepOpen) useApp.getState().patchDesk(sessionId, { mode: undefined })
}

/** Muse 私聊的 Desk 空闲面(10-13 用户定):Desk 上没有任何条目时演 Muse Space,Agent 一往 Desk 上放东西就让位,
 *  「清空 Desk」把它请回来 —— 与 idle 伴随面同一套进出,只是内容是宿主的 `muse-library` 视图(Muse 自建插件的 home,
 *  没建就是 Library 浏览器)。条目只在渲染期合成:不进 deskBySession、不落盘、不占 Agent 的两格。
 *  视图没注册(Muse 内置关着 / 非本地)→ null,这条会话的 Desk 与别的会话无异。always 伴随面照旧整块替换,轮不到它。 */
const MUSE_HOME_VIEW = 'muse-library'
export function useDeskHome(sessionId: string | null | undefined): DeskItem | null {
  const { t } = useI18n()
  const muse = useApp((s) => !!sessionId && s.configBySession[sessionId]?.soloAgentSlug === 'muse')
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => (muse ? subscribeViews(bump) : undefined), [muse])
  const registered = muse && !!getView(MUSE_HOME_VIEW)
  const name = t('view.museHome')
  const home = useMemo<DeskItem | null>(
    () => (registered ? { key: 'home:muse', path: '', name, at: 0, view: { type: MUSE_HOME_VIEW } } : null),
    [registered, name],
  )
  // 缺省是右侧车道里的一张小卡(用户 10-14 定;起初做成第一次进来自动展开成侧板,被改回):展开 / 收起全由用户点。
  return home
}

/** 所有格子共用的 shim leaf(不进 Dockview,不碰布局持久化;setTitle/close 演出区无意义,noop)。 */
const shimLeaf = (id: string, type: string, params: Record<string, unknown>): ViewProps['leaf'] => ({
  id, type, loc: 'main', params, setTitle: () => {}, setParams: () => {}, close: () => {},
})

function DeskPane({ item }: { item: DeskItem }) {
  const leaf = useMemo<ViewProps['leaf']>(
    () => shimLeaf(`desk:${item.key}`, 'wsfile', { path: item.path, name: item.name }),
    [item.key, item.path, item.name],
  )
  return <WsFileView leaf={leaf} params={leaf.params} />
}

/** 任意注册视图的原生格:按 type 查 LCL 注册表挂 shim leaf —— desk_present {type:'view'}(含插件
 *  注册的视图)与 vault 文件类型改道(白板/插件文件/.db/笔记/导图)共用这一套。插件视图可能晚于
 *  boot 注册 → 订阅注册表,注册即从占位切到真视图。 */
export function DeskShimView({ type, params, k }: { type: string; params: Record<string, unknown>; k: string }) {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => subscribeViews(bump), [])
  // desk 本身住在聊天视图里 → 聊天进 desk = 无限递归,按未知视图占位
  const def = type === 'chat' ? undefined : getView(type)
  // params 由 k 派生(k 含路径/条目 key),k 稳定即语义稳定 —— 依赖只挂 k/type,防对象字面量每渲染重挂。
  const leaf = useMemo<ViewProps['leaf']>(() => shimLeaf(k, type, params), [k, type]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!def) {
    return (
      <div className="agent-desk-card-empty">
        <Sparkles size={18} />
        <span>{type}</span>
      </div>
    )
  }
  return <div className="desk-note-wrap">{def.factory({ leaf, params: leaf.params })}</div>
}

/** 文件在当前打开的 Amadeus vault 里 → vault 相对路径;否则 null(纯字符串,镜像 WsFileView 判定)。 */
export function vaultRelOf(path: string, root: string | null): string | null {
  if (!root || !path) return null
  const norm = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const q = norm(path)
  return q.startsWith(r + '/') ? q.slice(r.length + 1) : null
}

/** 认领全局单活页的类型(stage-1):普通笔记走全局 pageStore,双格最多一格认领。
 *  白板/插件文件类型/.db 走各自的独立视图,不占认领位 —— 其中插件文件类型(如思维导图)若也吃
 *  全局活动页,由插件自己的「另一处正在显示其它文件」守卫兜住,不必在这儿再算一遍。
 *  fileTypes 由调用方响应式订阅传入(插件异步装载期不误放行)。 */
export const claimKind = (rel: string, fileTypes: Parameters<typeof findFileType>[0]): 'note' | null =>
  isDrawingPath(rel) || findFileType(fileTypes, rel) ? null : /\.md$/i.test(rel) ? 'note' : null

/** 认领式加载守卫:loadPage 对不存在的路径会**建**一份空白页
 *  (compiler newPage),而 desk 持久化快照可能复活「文件已删」的条目 → 打开前必须确认文件真在
 *  库里,否则把删掉的文件凭空重建 = 毁档级事故。missing=确认不在库(调用方回落通用预览)。 */
function useClaimPage(rel: string): boolean {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    const st = () => usePageStore.getState()
    const norm = (p: string): string => p.replace(/\\/g, '/')
    const known = (): boolean => st().files.some((f) => norm(f) === rel) || st().pages.some((p) => norm(p) === rel)
    void (async () => {
      if (st().activePage === rel) return
      if (!known()) {
        await st().refreshStructure() // 结构可能还没加载完(冷启动恢复快照),先刷一次再判
        if (!alive) return
        if (!known()) { setMissing(true); return }
      }
      setMissing(false)
      void st().loadPage(rel)
    })()
    return () => { alive = false }
  }, [rel])
  return missing
}

/** vault 笔记 = 真 Amadeus 编辑器(原生 view)。
 *  stage-1 单活文档下的语义:挂载即认领全局「当前笔记」——与「激活一个笔记 tab」完全同一
 *  机制,回到 Amadeus 空间时原 tab 激活会自动认领回去(becameActive → loadPage),自愈不用管。
 *  卡片态与展开态同用(用户裁决:非展开态也要)。代价(用户知情接受):agent 自动上台 vault
 *  文件时会切全局当前页。直播格仍走流式轻预览。 */
function DeskClaimPane({ item, rel }: { item: DeskItem; rel: string }) {
  const missing = useClaimPage(rel)
  if (missing) return <DeskPane item={item} />
  return <DeskShimView type="amadeus-editor" params={{ notePath: rel }} k={`desk-note:${rel}`} />
}

/** 格子路由(卡片态与展开态共用):vault 内文件按类型进原生 view,vault 外与其余类型走通用预览
 *  (vault 外 md 原生化需要 pageStore 多根 = stage-2,vault 收容是云同步/协作的安全边界,不松)。
 *  allowNative:认领类(笔记/导图)双格里最多一格进原生,两格都认领会互抢当前页打乒乓。 */
export function DeskFilePane({ item, allowNative }: { item: DeskItem; allowNative: boolean }) {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const rel = vaultRelOf(item.path, vaultRoot)
  if (!rel) {
    // 库外本机 .pdf 听「默认打开方式」:声明了 external 的插件认领了就进它的视图(findFileType 自己看本机路径 + external)
    if (/\.pdf$/i.test(item.path) && findFileType(fileTypes, item.path)) return <DeskShimView type="amadeus-plugin-file" params={{ filePath: item.path }} k={`desk-ft:${item.path}`} />
    return <DeskPane item={item} />
  }
  const kind = claimKind(rel, fileTypes)
  if (kind) return allowNative ? <DeskClaimPane item={item} rel={rel} /> : <DeskPane item={item} />
  // 白板在 Desk 上是只读预览 + 「在白板中打开」(走查续七 7.7 A),要画就进主区那块。
  if (isDrawingPath(rel)) return <DeskShimView type="amadeus-drawing" params={{ drawingPath: rel, preview: true }} k={`desk-draw:${rel}`} />
  if (findFileType(fileTypes, rel)) return <DeskShimView type="amadeus-plugin-file" params={{ filePath: rel }} k={`desk-ft:${rel}`} />
  if (/\.db$/i.test(rel)) return <DeskShimView type="amadeus-db" params={{ dbPath: rel }} k={`desk-db:${rel}`} />
  return <DeskPane item={item} />
}

const isAbsPath = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)
/** 库内相对路径的分隔符,同编辑器自己的读法(useVaultRelParam → amadeus/lib/vaultFiles.slashRel):只有 Windows 库才把 `\\` 当分隔符,
 *  别的平台它是合法的文件名字符。照抄不 import:Tangu 模块的宿主依赖表只许缩(check:tanguboundary)。 */
const slashRel = (p: string, root: string | null): string => (root && /^[a-zA-Z]:[\\/]|^[\\/]{2}/.test(root) ? p.replace(/\\/g, '/') : p)

/** Agent 直接给出的笔记编辑器(desk_present {type:'view', view:'amadeus-editor', params:{notePath}})在格子里要不要改道。
 *  null = 原样挂(不是笔记编辑器 / 没给路径 / 指着的确实是笔记);否则 = 按那份文件挂,path 是它的绝对路径
 *  (相对路径而库还没就绪、拼不出来 → path: null,调用方挂占位,绝不先挂编辑器)。
 *  判定同拆分 / 新窗口那条(deskOpen.deskViewRef → amadeusNav.fileViewRef,「打开」的分派次序):.db、插件文件类型、
 *  白板、认不出的都不是笔记 —— 开进笔记编辑器,它一存就把 Markdown 写回那份文件 = 毁档(openNote / openDb 注释里的同类事故)。
 *  库内绝对路径按库内相对路径判(插件文件类型按库内路径认领)。仪器:agentDesk.viewReroute.test.ts、check:deskmanual 的 l 段。 */
export function deskEditorReroute(view: DeskItem['view'], vaultRoot: string | null): { path: string | null } | null {
  if (view?.type !== 'amadeus-editor') return null
  const note = (view.params ?? {}).notePath
  if (typeof note !== 'string' || !note) return null
  if (isAbsPath(note)) {
    const kind = fileViewRef(vaultRelOf(note, vaultRoot) ?? note)?.type
    return kind === 'amadeus-editor' || kind === 'dashboard' ? null : { path: note }
  }
  const rel = slashRel(note, vaultRoot)
  const kind = fileViewRef(rel)?.type
  // 仪表盘也原样挂:它本是一份合法笔记(布局在外来 frontmatter 键里,见 features/amadeus.tsx),格子的文件口径同样把 .dashboard.md
  // 交给笔记编辑器;改道去通用预览反倒落进 WsFileView 的 Markdown 编辑器(Codex 评审)
  if (kind === 'amadeus-editor' || kind === 'dashboard') return null
  // 爬出库外的相对路径(`../x.db`)不拼:库内的数据库 / 插件视图不替库外的文件读写 → 占位
  if (!vaultRoot || rel.split(/[\\/]/).includes('..')) return { path: null }
  return { path: `${vaultRoot.replace(/[\\/]+$/, '')}/${rel}` }
}

/** 格子里 Agent 给出的视图(item.view)。笔记编辑器先按文件重新分派一次(deskEditorReroute):不是笔记的照 DeskFilePane 的口径挂
 *  (白板只读预览、插件文件视图、数据库、其余通用预览),不认领全局当前页;其余视图原样按注册表挂。
 *  卡片态与展开态共用;Human Desk 挂视图条目也该走这里(Agent Desk ⋯「我来改」会把 Agent 给的视图原样挪过去)。 */
export function DeskViewPane({ item }: { item: DeskItem }) {
  // fileViewRef 读的是 store 快照:插件文件类型晚到、库晚就绪都要重判,订阅着就行
  usePluginStore((s) => s.fileTypes)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const view = item.view!
  const to = deskEditorReroute(view, vaultRoot)
  if (!to) return <DeskShimView type={view.type} params={view.params ?? {}} k={`desk-view:${item.key}`} />
  const name = String((view.params ?? {}).notePath).split(/[\\/]/).pop() || item.name
  if (!to.path) {
    return (
      <div className="agent-desk-card-empty">
        <Sparkles size={18} />
        <span>{name}</span>
      </div>
    )
  }
  return <DeskFilePane item={{ key: item.key, path: to.path, name, at: item.at }} allowNative={false} />
}

/** 双格里第一个认领类(vault 笔记)非直播格(用户裁决:卡片态也上原生,认领语义与展开态一致)。
 *  ⚠️必须先 ensureAmadeusReady:vault 只在 Amadeus/Calendar 视图挂载过才恢复(懒引导),
 *  否则本次启动没进过 Amadeus 时 vaultRoot 恒为 null → vault 文件也判不进原生(日历同款病)。 */
function useClaimKey(items: DeskItem[]): string | undefined {
  useEffect(() => { ensureAmadeusReady() }, [])
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const fileTypes = usePluginStore((s) => s.fileTypes)
  return items.find((it) => {
    if (it.live || it.view) return false
    const rel = vaultRelOf(it.path, vaultRoot)
    return !!rel && claimKind(rel, fileTypes) !== null
  })?.key
}

/** Human Desk 拿着一篇库里的笔记、而右边不是 Agent Desk 在演 → 原生编辑器归 Human Desk(同一时间只有一处能开,见 useClaimKey):
 *  Agent Desk 的格子(卡片预览 / 展开态)对笔记一律退回通用预览,免得 Agent 一放笔记就把你正在写的那篇从编辑器里换走。 */
export function useHumanHoldsClaim(sessionId: string): boolean {
  const item = useApp((s) => s.humanDeskBySession[sessionId]?.item)
  const side = useApp((s) => deskSideOf(s.deskBySession[sessionId]?.mode, s.humanDeskBySession[sessionId]?.open))
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const fileTypes = usePluginStore((s) => s.fileTypes)
  if (!item || item.view || side === 'agent') return false
  const rel = vaultRelOf(item.path, vaultRoot)
  return !!rel && claimKind(rel, fileTypes) !== null
}

/** 直播格(Cursor 式):编辑参数还在流式生成时,直接订阅 toolEvent.arguments 增量渲染正文前缀。
 *  write_file 看 content,edit_file/multi_edit 看 new_string;完成后由磁盘格(WsFileView)接棒。
 *  ponytail: 纯 <pre> 无高亮 —— 直播期要的是"看得见在写",完整高亮交给落盘后的真身。 */
function DeskLivePane({ sessionId, item }: { sessionId: string; item: DeskItem }) {
  const { t } = useI18n()
  const live = item.live!
  const args = useApp((s) => {
    const m = s.messagesBySession[sessionId]?.find((x) => x.id === live.msgId)
    return m?.toolEvents?.find((e) => e.id === live.toolId)?.arguments || ''
  })
  const body = useMemo(() => extractLiveBody(args, live.tool), [args, live.tool])
  const scrollRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight // 直播吸底
  }, [body])
  return (
    <div className="agent-desk-livepane">
      <div className="agent-desk-livehead">
        <Loader2 size={12} className="spin" />
        <span className="agent-desk-livehead-tx" title={item.path || undefined}>
          {item.path ? t('desk.writing', { name: item.name }) : t('desk.drafting')}
        </span>
      </div>
      <pre ref={scrollRef} className="agent-desk-livebody">{body}</pre>
    </div>
  )
}

/** 侧板拖宽(比例制,zoom 免疫);AgentDesk 与 TeamDesk 共用同一段手势与同一份 deskBySession.fraction。 */
export function useDeskGrip(sessionId: string, rootRef: React.RefObject<HTMLDivElement | null>): (e: React.PointerEvent<HTMLDivElement>) => void {
  return useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const host = rootRef.current?.parentElement // .t2-chat-view(row 容器)
    if (!host) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    rootRef.current?.classList.add('no-anim') // 拖宽期间关掉 flex-basis 过渡,否则不跟手
    const rect = host.getBoundingClientRect() // 拖动中总宽不变,只有分割线在动
    const move = (ev: PointerEvent): void => {
      const f = Math.min(0.72, Math.max(0.25, (rect.right - ev.clientX) / rect.width))
      useApp.getState().patchDesk(sessionId, { fraction: f, userResized: true })
    }
    // pointercancel / 失去捕获也要收场,否则残留的 move 监听会在下次拖动叠加
    const done = (): void => {
      rootRef.current?.classList.remove('no-anim')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', done)
      el.removeEventListener('pointercancel', done)
      el.removeEventListener('lostpointercapture', done)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', done)
    el.addEventListener('pointercancel', done)
    el.addEventListener('lostpointercapture', done)
  }, [sessionId, rootRef])
}

/** 「在主区打开」(方案 C 那一项):库内文件走 Amadeus 的打开方式(同「在 Amadeus 中打开」),库外文件开 wsfile 标签,
 *  注册视图按类型开一个主区标签。插件工具卡没有主区对应物,不给这一项。 */
export function openDeskItemInMain(it: DeskItem, vaultRoot: string | null): void {
  const rel = vaultRelOf(it.path, vaultRoot)
  if (rel) {
    if (opensAsTab(rel)) openFile(rel)
    else if (/\.md$/i.test(rel)) void openNote(rel)
    else openFile(rel)
    return
  }
  const ws = useWorkspace.getState()
  if (it.view) ws.openView(it.view.type, it.view.params ?? {}, 'main', { newTab: true })
  else if (it.path) ws.openView('wsfile', { path: it.path, name: it.name }, 'main', { newTab: true })
}

/** 两格都钉着时 Agent 正在写的那份:「Agent 刚放的」那行显示「正在编辑 X」(路径没流完 =「正在起草…」)。 */
function liveFreshLabel(sessionId: string, toolId: string, t: (k: string, v?: Record<string, string>) => string): string {
  for (const m of useApp.getState().messagesBySession[sessionId] || []) {
    const e = m.toolEvents?.find((x) => x.id === toolId)
    if (!e) continue
    const raw = extractStreamingString(e.arguments || '', 'path')
    return raw?.done ? t('desk.writing', { name: raw.value.split(/[\\/]/).pop() || raw.value }) : t('desk.drafting')
  }
  return t('desk.drafting')
}

/** 拖进一格(11-23 方案 A ⑧⑨):文件 / 工作区引用拖到哪一格就放进哪一格(这一格钉住)。
 *  聊天区的两个落区(Composer 的 OS 文件落区是 .t2-chat-view 上的原生监听,ChatView 的引用落区是 React)都在 Desk 外层,
 *  所以这里在格子上用**原生捕获**监听先接住(连格子里的编辑器也不先吃)。直播那格写完前不收:光标 not-allowed、不染色。
 *  dragover 读不到数据:会话 / 应用这类放不进 Desk 的引用到 drop 才知道,那时不拦,照旧冒泡给输入框变成引用。 */
function useDeskDrop(ref: React.RefObject<HTMLDivElement | null>, sessionId: string, slot: number, enabled: boolean, locked: boolean): void {
  useDeskPathDrop(ref, enabled, locked, (path) => useApp.getState().deskAct(sessionId, { type: 'pick', slot, item: deskItemFor(path, Date.now()) }), sessionId)
}

/** 拖一个文件 / 工作区引用到某块 Desk 上(格子、Human Desk 的卡与展开态共用):原生捕获监听先接住,解析出本机路径交给 onPath。
 *  ref 那块元素拖上去时挂 data-drop(染色由 CSS 画),聊天区挂 data-deskdrop 让出整片的淡染。
 *  sessionId:这条会话的 Desk 自己那一样被拖过来(名字胶囊,#842)不在这里收。 */
export function useDeskPathDrop(ref: React.RefObject<HTMLElement | null>, enabled: boolean, locked: boolean, onPath: (path: string) => void, sessionId?: string): void {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const take = useRef(onPath)
  take.current = onPath
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    const view = el.ownerDocument.defaultView
    const accepts = (e: DragEvent): boolean => {
      if (sessionId && isOwnDeskDrag(e, sessionId)) return false // Desk 自己那一样拖过来 = 对调,归 useDeskItemDrop(deskOpen.tsx)
      const ts = Array.from(e.dataTransfer?.types ?? [])
      return ts.includes('Files') || ts.includes(REF_MIME) || ts.includes(PATHS_MIME)
    }
    const mark = (on: boolean): void => {
      el.toggleAttribute('data-drop', on)
      el.closest('.t2-chat-view')?.toggleAttribute('data-deskdrop', on)
    }
    const over = (e: DragEvent): void => {
      if (!accepts(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = locked ? 'none' : 'copy'
      if (!locked) mark(true)
    }
    const leave = (e: DragEvent): void => { if (!el.contains(e.relatedTarget as Node)) mark(false) }
    const drop = (e: DragEvent): void => {
      if (!accepts(e)) return
      mark(false)
      if (locked) { e.preventDefault(); e.stopPropagation(); return }
      const dt = e.dataTransfer
      let path = ''
      for (const r of readChatRefs(dt)) {
        if (r.kind === 'file') { path = r.path; break }
        if (r.kind === 'note' && vaultRoot) { path = `${vaultRoot.replace(/[\\/]+$/, '')}/${r.path.replace(/^[\\/]+/, '')}`; break }
      }
      if (!path && dt?.files?.length && window.tangu?.getPathForFile) {
        try { path = window.tangu.getPathForFile(dt.files[0]) || '' } catch { path = '' }
      }
      if (!path) return // 放不进 Desk 的(会话 / 应用 / 窗口引用):交回聊天区
      e.preventDefault()
      e.stopPropagation()
      take.current(path)
    }
    const clear = (): void => mark(false)
    el.addEventListener('dragenter', over, true)
    el.addEventListener('dragover', over, true)
    el.addEventListener('dragleave', leave, true)
    el.addEventListener('drop', drop, true)
    view?.addEventListener('dragend', clear)
    view?.addEventListener('drop', clear, true)
    view?.addEventListener('blur', clear)
    return () => {
      el.removeEventListener('dragenter', over, true)
      el.removeEventListener('dragover', over, true)
      el.removeEventListener('dragleave', leave, true)
      el.removeEventListener('drop', drop, true)
      view?.removeEventListener('dragend', clear)
      view?.removeEventListener('drop', clear, true)
      view?.removeEventListener('blur', clear)
      mark(false)
    }
  }, [ref, enabled, locked, vaultRoot, sessionId])
}

/** 展开态的一格 = 悬浮胶囊 + 内容(方案 B,两颗胶囊同 Mini 顶栏 lcl/engine/miniCard.css .mini-card-cap)。
 *  左胶囊:条目名 + ▾(每一格都有:换成这条会话最近放过的 8 样)+ 钉住时一枚图钉(点了取消);
 *  右胶囊:视图控件槽 │ ⋯ │ 面板级按钮。下面的格(panel=null)不要右胶囊,槽和 ⋯ 跟在名字后面。伴随面(item 缺省)只有右胶囊。
 *  ⋯ 新加的几项在上(只看这一格 / 恢复两格、移到上面 / 下面、从 Desk 拿掉),打开的四项居中(deskOpen.tsx),原来的几项在下。 */
function DeskCaps({ sessionId, item, slot = 0, panel, lead, className, children }: {
  sessionId: string; item?: DeskItem; slot?: number; panel: React.ReactNode
  /** 最左那颗:Human Desk / Agent Desk 的切换件(只给第一格)。 */
  lead?: React.ReactNode
  className?: string; children: React.ReactNode
}) {
  const { t } = useI18n()
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null)
  const more = useRef<CtxItem[]>([])
  const chrome = useMemo<DeskChrome>(() => ({ slot: slotEl, more }), [slotEl])
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const desk = useApp((s) => s.deskBySession[sessionId])
  const paneRef = useRef<HTMLDivElement>(null)
  const note = desk?.note
  const all = desk?.items ?? []
  const own = !!item && all[slot]?.key === item.key // 空闲面(home)不是 Desk 自己的条目:没有这些控件
  const two = all.length >= 2
  const solo = two && (desk?.solo === 0 || desk?.solo === 1)
  useDeskDrop(paneRef, sessionId, slot, own, !!item?.live)
  useDeskItemDrop(paneRef, sessionId, slot, own, !!item?.live) // 名字胶囊拖到另一格 = 对调
  const path = item?.path || ''
  const rel = vaultRelOf(path, vaultRoot)
  // 「在 Amadeus 中打开」只给 Desk 自己会改道原生 view 的库内类型(与 DeskFilePane 同口径)
  const amadeus = rel && (/\.(md|db)$/i.test(rel) || isDrawingPath(rel) || !!findFileType(fileTypes, rel)) ? rel : null
  type Act = Parameters<ReturnType<typeof useApp.getState>['deskAct']>[1]
  const act = (a: Act): void => useApp.getState().deskAct(sessionId, a)
  // 菜单开着时摆法可能变了(Agent 落盘把这样挪到了另一格):动作执行那一刻按条目 key 重新找它在哪格,找不到就不动
  const actHere = (make: (slot: number) => Act): void => {
    const at = item ? (useApp.getState().deskBySession[sessionId]?.items ?? []).findIndex((x) => x.key === item.key) : -1
    if (at >= 0) act(make(at))
  }
  const takeOver = (it: DeskItem): void => {
    const at = (useApp.getState().deskBySession[sessionId]?.items ?? []).findIndex((x) => x.key === it.key)
    if (at < 0) return
    act({ type: 'remove', slot: at })
    useApp.getState().humanDeskAct(sessionId, { type: 'put', item: { ...it, at: Date.now() } })
  }
  const moreItems = (): CtxItem[] => {
    const mine: CtxItem[] = !own || !item ? [] : [
      ...(two ? [solo
        ? { label: t('desk.both'), icon: <Rows2 size={14} />, run: () => act({ type: 'solo' }) }
        : { label: t('desk.solo'), icon: <Maximize2 size={14} />, run: () => actHere((n) => ({ type: 'solo', slot: n })) }] : []),
      ...(two && !solo ? [slot === 0
        ? { label: t('desk.moveDown'), icon: <ArrowDown size={14} />, run: () => actHere((n) => ({ type: 'move', slot: n })) }
        : { label: t('desk.moveUp'), icon: <ArrowUp size={14} />, run: () => actHere((n) => ({ type: 'move', slot: n })) }] : []),
      // 「我来改」:挪到 Human Desk(是挪不是复制,这一格就没有它了);直播 / 插件工具卡不给
      ...(item.tool || item.live ? [] : [{ label: t('desk.takeOver'), icon: <SquarePen size={14} />, run: () => takeOver(item) }]),
      { label: t('desk.remove'), icon: <X size={14} />, run: () => actHere((n) => ({ type: 'remove', slot: n })) },
    ]
    // 打开的四项居中(11-23 Desk 标签栏互通 ②):这一格自己的在上,视图自己的在下;原「在主区打开」= 其中的「在新标签页打开」
    const opens: CtxItem[] = !own || !item ? [] : deskOpenItems({ item, rel, anchor: paneRef.current, openTab: () => openDeskItemInMain(item, vaultRoot), t })
    const orig: CtxItem[] = [
      ...more.current,
      // .db 走 openDb:openNote 会把它塞进笔记编辑器,保存时把 Markdown 写回数据库(Codex P1)
      ...(amadeus ? [{ label: t('preview.openInAmadeus'), icon: <NotebookPen size={14} />, run: () => { if (/\.db$/i.test(amadeus)) openDb(amadeus); else void openNote(amadeus) } }] : []),
      ...(path ? [{ label: t('panel.action.copyPath'), icon: <Copy size={14} />, run: () => void navigator.clipboard?.writeText(path) }] : []),
    ]
    const after = (xs: CtxItem[], sep: boolean): CtxItem[] => xs.map((x, i) => (i === 0 && sep ? { ...x, separatorBefore: true } : x))
    return [...mine, ...after(opens, mine.length > 0), ...after(orig, mine.length + opens.length > 0)]
  }
  const tools = item && (
    <>
      <span ref={setSlotEl} className="desk-cap-slot" />
      {/* 只看一格时:⋯ 左边一颗「恢复两格」,看得出另一格只是收起了(⋯ 里那项照旧留着) */}
      {panel && solo && <button className="icon-btn" title={t('desk.both')} aria-label={t('desk.both')} onClick={() => act({ type: 'solo' })}><Rows2 size={14} /></button>}
      {!item.live && (own || path || !item.view) && <DeskMoreButton items={moreItems} />}
    </>
  )
  let name: React.ReactNode = null
  if (item) {
    const label = item.live ? (path ? t('desk.writing', { name: item.name }) : t('desk.drafting')) : (item.name || path.split(/[/\\]/).pop() || '')
    // 悬停:路径 / 说明之后接一句「拖到标签栏…」(拖不起来的说原因)
    const tip = [path, !item.live && note, own && deskDragTip(item, t)].filter(Boolean).join('\n') || undefined
    const drag = own && canDragDeskItem(item)
      ? (e: React.DragEvent<HTMLElement>): void => startDeskItemDrag(e, { sessionId, item, rel, openVault: () => openDeskItemInMain(item, vaultRoot) })
      : undefined
    // 图标跟着这样东西的种类走(方案 ③,deskOpen.tsx);原来按视图放上来的一律给星
    const inner = <><DeskItemIcon item={item} rel={rel} size={13} className="desk-cap-ic" /><span className="desk-cap-label">{label}</span></>
    const menu = own && desk ? deskMenuRows(desk, slot) : null
    const dot = !!desk?.fresh && visibleSlots(desk)[0] === slot // 点只亮在最上面那格的 ▾ 上(方案图 ⑦)
    const pickable = !!menu && (menu.rows.length > 1 || !!menu.fresh || !!note)
    const rows = (): DeskPickRow[] => {
      const d = useApp.getState().deskBySession[sessionId]
      if (!d) return []
      const m = deskMenuRows(d, slot)
      const lockedNow = !!d.items[slot]?.live // 直播那格写完前不换内容
      const out: DeskPickRow[] = []
      if (d.note) out.push({ label: d.note, disabled: true, run: () => {} })
      if (m.fresh) {
        out.push({ head: t('desk.fresh'), separatorBefore: out.length > 0 })
        const f = m.fresh
        out.push('key' in f
          ? { label: f.name || f.path, dot: true, hint: t('desk.justNow'), disabled: lockedNow, run: () => actHere((n) => ({ type: 'pick', slot: n, item: f })) }
          : { label: liveFreshLabel(sessionId, f.liveToolId, t), dot: true, disabled: true, run: () => {} })
      }
      out.push({ head: t('desk.recent'), separatorBefore: out.length > 0 })
      for (const r of m.rows) {
        out.push({
          label: r.item.name || r.item.path,
          hint: r.where === 'this' ? t('desk.thisCell') : r.where === 'other' ? t('desk.otherCell') : undefined,
          disabled: r.where === 'this' || lockedNow,
          run: () => actHere((n) => ({ type: 'pick', slot: n, item: r.item })),
        })
      }
      return out
    }
    name = (
      <>
        {pickable ? (
          <DeskPickButton className="desk-cap-pick" title={tip ?? t('desk.switch')} rows={rows} onDragStart={drag} onOpen={() => { if (useApp.getState().deskBySession[sessionId]?.fresh) act({ type: 'seen' }) }}>
            {inner}<ChevronDown size={12} className="desk-cap-caret" />{dot && <span className="desk-cap-dot" aria-hidden="true" />}
          </DeskPickButton>
        ) : <span className="desk-cap-pick" title={tip} draggable={drag ? true : undefined} onDragStart={drag}>{inner}</span>}
        {own && item.pin && (
          <button type="button" className="icon-btn desk-cap-pin" aria-pressed="true" aria-label={t('desk.pinned')} title={t('desk.unpin')} onClick={() => actHere((n) => ({ type: 'unpin', slot: n }))}>
            <Pin size={13} />
          </button>
        )}
      </>
    )
  }
  return (
    <div ref={paneRef} className={`agent-desk-pane has-caps${className ? ' ' + className : ''}`} data-desk-slot={own ? slot : undefined} style={own && slot === 0 && two && !solo ? splitStyle(desk?.split) : undefined}>
      <div className="desk-caps">
        {lead ? (
          <div className="desk-caps-left">{lead}{name && <div className="desk-cap desk-cap-name">{name}{!panel && tools}</div>}</div>
        ) : name ? <div className="desk-cap desk-cap-name">{name}{!panel && tools}</div> : <span />}
        {panel && <div className="desk-cap">{tools}{item && <span className="desk-cap-div" />}{panel}</div>}
      </div>
      <DeskChromeContext.Provider value={chrome}>{children}</DeskChromeContext.Provider>
    </div>
  )
}

/** 两格时上格的高度 = 分界比例(border-box 百分比,下格吃剩下的):两格内边距不同也一样高(原来差 46px:
 *  md 格把胶囊让位挪进了自己的滚动区,另一格是外层 padding,flex-basis 0 时 padding 叠在外面)。 */
const splitStyle = (split: number | undefined): React.CSSProperties => ({ flex: `0 0 ${((split ?? 0.5) * 100).toFixed(2)}%` })

/** 上下两格之间的分界(⑴–⑶):平时不画,悬停变色、光标上下箭头(画法同左缘拖宽条 .agent-desk-grip);
 *  拖动 = 上格占比(20%–80%,按比例存,对界面缩放免疫);双击回到各半。按会话记(deskBySession.split)。 */
function DeskSplit({ sessionId, split }: { sessionId: string; split: number }) {
  const { t } = useI18n()
  const onDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const body = e.currentTarget.parentElement
    if (!body) return
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    el.classList.add('active')
    const rect = body.getBoundingClientRect() // 拖动中盒子不变,只有分界在动
    const move = (ev: PointerEvent): void => {
      useApp.getState().patchDesk(sessionId, { split: clampSplit((ev.clientY - rect.top) / rect.height) })
    }
    const done = (): void => {
      el.classList.remove('active')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', done)
      el.removeEventListener('pointercancel', done)
      el.removeEventListener('lostpointercapture', done)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', done)
    el.addEventListener('pointercancel', done)
    el.addEventListener('lostpointercapture', done)
  }
  return (
    <div
      className="agent-desk-split"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('desk.resize')}
      aria-valuenow={Math.round(split * 100)}
      title={t('desk.resize')}
      style={{ top: `${(split * 100).toFixed(2)}%` }}
      onPointerDown={onDown}
      onDoubleClick={() => useApp.getState().patchDesk(sessionId, { split: undefined })}
    />
  )
}

/** onQuote:Desk 里的插件结果卡片调 call.quote 时挂进哪个输入框(ChatView 传自己的;不传退回主对话)。
 *  右边这块壳 Agent Desk 和 Human Desk 共用(一次只展开一块,deskSideOf):humanPanel = 轮到 Human Desk 时整块换成它;
 *  switcher = 两块展开态最左上那颗「你 / Agent」切换件(Agent Desk 这边放在第一格的胶囊前)。 */
export function AgentDesk({ sessionId, onQuote, humanPanel, switcher }: { sessionId: string; onQuote?: (text: string) => void; humanPanel?: React.ReactNode; switcher?: React.ReactNode }) {
  const { t } = useI18n()
  const desk = useApp((s) => s.deskBySession[sessionId])
  const human = useApp((s) => s.humanDeskBySession[sessionId])
  const side = deskSideOf(desk?.mode, human?.open)
  const own = desk?.items.slice(0, 2) ?? []
  const shownSlots = visibleSlots({ items: own, solo: desk?.solo })
  const claimKey = useClaimKey(shownSlots.map((i) => own[i]))
  const humanClaims = useHumanHoldsClaim(sessionId)
  const rootRef = useRef<HTMLDivElement>(null)
  const onGrip = useDeskGrip(sessionId, rootRef)
  const comp = useDeskCompanion()
  const home = useDeskHome(sessionId)
  // always 伴随面 = 完全替换:侧板只演伴随面(没有任何条目也要能展开)
  const always = comp?.mode === 'always'
  // 用过 Human Desk 的会话里,经切换件切到空着的 Agent Desk → 演空态(留着切换件和收起);没用过 Human Desk 时照旧:空了就不挂
  const humanShown = side === 'human' && !!humanPanel
  const emptyAgent = side === 'agent' && !!human && !!switcher

  if (!desk?.items.length && !always && !home && !humanShown && !emptyAgent) return null
  const open = side !== null && (side === 'agent' || humanShown)
  // Human Desk 的宽度只认你拖出来的比例:Agent 的 size 档(wide)不撑你那块
  const frac = desk?.fraction ?? (desk?.size === 'wide' && side === 'agent' ? 0.62 : 0.46)
  // 空闲面:自己没有条目时演它(见 useDeskHome)。只看一格时只演那一格。
  const cells = own.length || !home ? shownSlots.map((i) => ({ it: own[i], slot: i })) : [{ it: home, slot: 0 }]
  const clearable = (comp?.mode === 'idle' || !!home) && !always && own.length > 0
  // 面板级按钮(清空 / 收起)住第一格的右胶囊末尾
  const panelBtns = (
    <>
      {clearable && (
        <button className="icon-btn" title={t('desk.clear')} onClick={() => clearDesk(sessionId, !!home)}>
          <Eraser size={14} />
        </button>
      )}
      <button className="icon-btn" title={t('desk.collapse')} onClick={() => { touchDesk(sessionId, 'desk'); useApp.getState().patchDesk(sessionId, { mode: undefined }) }}>
        <Minimize2 size={14} />
      </button>
    </>
  )

  return (
    // 壳常驻(有内容即挂):open 才有宽度与内容,flex-basis 过渡负责丝滑进出(见 chat2.css)
    // data-desk-session:desk_screenshot 靠它在多窗口/多聊天面板里认出该截哪一块(见 deskCapture.ts)
    <div ref={rootRef} data-desk-session={sessionId} className={`agent-desk${open ? ' open' : ''}`} style={{ '--desk-w': `${(frac * 100).toFixed(2)}%` } as React.CSSProperties}>
      {open && (
        <>
          <div className="agent-desk-grip" onPointerDown={onGrip} />
          <div className="agent-desk-inner">
            {side === 'human' ? humanPanel : (
            <div className="agent-desk-body">
              {always && comp ? (
                <DeskCaps sessionId={sessionId} panel={panelBtns} lead={switcher} className="agent-desk-companion">
                  <DeskCompanionHost key={comp.key} entry={comp} surface="desk-panel" sessionId={sessionId} />
                </DeskCaps>
              ) : cells.length ? cells.map(({ it, slot }, i) => (
                <DeskCaps key={it.key} sessionId={sessionId} item={it} slot={slot} panel={i === 0 ? panelBtns : null} lead={i === 0 ? switcher : undefined}>
                  {it.live ? <DeskLivePane sessionId={sessionId} item={it} />
                    : it.tool ? <DeskToolCardPane sessionId={sessionId} callId={it.tool.callId} onQuote={onQuote} />
                    : it.view ? <DeskViewPane item={it} />
                      : <DeskFilePane item={it} allowNative={it.key === claimKey && !humanClaims} />}
                </DeskCaps>
              )) : (
                <DeskCaps sessionId={sessionId} panel={panelBtns} lead={switcher}>
                  <div className="agent-desk-card-empty agent-desk-empty-open">
                    <Sparkles size={18} />
                    <span>{t('desk.empty')}</span>
                  </div>
                </DeskCaps>
              )}
              {!always && cells.length === 2 && <DeskSplit sessionId={sessionId} split={desk?.split ?? 0.5} />}
            </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** 卡片是否退场(.gone = 隐身但常驻,借 display allow-discrete 做进出动画):只有一条 ——
 *  侧板在演(open)且侧板真有东西可演;open 时内容已散(直播失败清场)就让卡片兜底,别双双消失。
 *  这里只判断卡片与侧板的切换;新会话开始前是否挂载由 ChatView 决定。 */
export const deskCardGone = (mode: string | undefined, panelHasContent: boolean): boolean =>
  mode === 'open' && panelHasContent

/** 卡片的四个决策(纯函数,单测钉住 always / idle 两种伴随面与无伴随面三套口径):
 *  - showCompanion:always 恒显示;idle 只在 Desk **零条目**时显示(草稿 / 空会话 / 清空后)。
 *  - panelHasContent:always 下侧板恒有东西可演(伴随面),但草稿没有侧板;否则看条目。
 *  - expandable:草稿永不展开(侧板要真会话)。
 *  - clearable:「清空 Desk」给 idle 伴随面与空闲面(home)用 —— 条目让它退了场,清掉才能请回来。 */
export function deskCardPlan(o: { mode: string | undefined; itemCount: number; companion: 'always' | 'idle' | null; draft: boolean; home?: boolean }): {
  gone: boolean; showCompanion: boolean; expandable: boolean; clearable: boolean
} {
  const always = o.companion === 'always'
  // 空闲面(home,Muse 私聊的 Muse Space):零条目时它就是这张 Desk 的内容 —— 可展开、压过 idle 伴随面;
  // 条目让它退了场,所以同样给「清空 Desk」。always 伴随面是整块替换,home 不参与。
  const home = !!o.home && !always
  const shown = o.itemCount > 0 || home
  const gone = deskCardGone(o.mode, always ? !o.draft : shown)
  return {
    gone,
    showCompanion: always || (o.companion === 'idle' && o.itemCount === 0 && !home),
    expandable: !gone && !o.draft && (always || shown),
    clearable: (o.companion === 'idle' || home) && o.itemCount > 0,
  }
}

/** 卡片态(默认态):摘要栏栈里的一张卡(2026-10-25 用户改为多卡片栈,方案 A:Desk 和别的卡一起排序、可折叠,
 *  展开时正文固定 380px —— 原来上下各占车道一半(严格 50/50),大窗口下被拉得很长,用户嫌不好看)。
 *  正文 pointer-events:none —— 卡片是"预览",点正文=放大成侧板;点卡头 = 折叠,卡头的放大钮是键盘入口。
 *  卡片不可关闭(用户裁决),但 **2026-10-25 用户改为空着时折叠**(09-26 撤回过的「零条目缩成小坞」那条不再适用):
 *  零条目且无伴随面 = 收起只剩卡头,点开看空态;有新条目上台(顶格 key 变了)自动展开,换会话不算。
 *  开合按会话放在内存里(summaryOpen.ts,10-29 第三轮):新条目上台算「来了新东西」;手动开 / 收只管到这一轮结束,
 *  不再按卡片种类全局记(用户否了:收过一次就再也看不到新内容)。
 *  ChatView 在首条消息出现后才挂载本组件;切换已开始的会话不挂 key,伴随面按自己的 key 挂载。 */
export function DeskCard({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const desk = useApp((s) => s.deskBySession[sessionId])
  const comp = useDeskCompanion()
  const home = useDeskHome(sessionId)
  const own = desk?.items?.slice(0, 2) ?? []
  const always = comp?.mode === 'always'
  // 卡片显示摆好之后的样子:只看一格时只那一格,两格按分界比例
  const vis = visibleSlots({ items: own, solo: desk?.solo }).map((i) => own[i])
  const items = own.length || !home || always ? vis : [home]
  const claimKey = useClaimKey(items)
  const humanClaims = useHumanHoldsClaim(sessionId)
  const squeezed = useContext(DeskSqueezeContext) === 'desk' // 两张 Desk 卡都开着放不下:最近碰过的那张开着(TaskSummary 判)
  const draft = sessionId === DESK_DRAFT_KEY
  const plan = deskCardPlan({ mode: desk?.mode, itemCount: own.length, companion: comp?.mode ?? null, draft, home: !!home })
  const gone = plan.gone
  const expand = plan.expandable ? () => { touchDesk(sessionId, 'desk'); useApp.getState().patchDesk(sessionId, { mode: 'open' }) } : undefined
  const companion = plan.showCompanion ? comp : null
  const hasContent = items.length > 0 || !!companion
  const pref = useSummaryOpen((s) => openOf(s.by[sessionId], 'desk', true))
  const [peek, setPeek] = useState(false) // 空着时手动点开看一眼;不记
  // 「来了新东西」= Agent 那边的格子换了(没钉的格);你钉住 / 换位不算
  const top = own.filter((x) => !x.pin).map((x) => x.key).join('|') || null
  const seen = useRef({ sessionId, top })
  const reveal = useRef(false) // 新条目到了、还没把卡露出来
  useEffect(() => {
    const s = seen.current
    if (s.sessionId !== sessionId) { seen.current = { sessionId, top }; reveal.current = false; return }
    if (top && top !== s.top) { bumpOpen(sessionId, 'desk'); reveal.current = true }
    s.top = top
  }, [sessionId, top])
  useEffect(() => { if (hasContent) setPeek(false) }, [hasContent])
  const want = hasContent ? pref : peek
  const open = want && !squeezed
  // 新条目自动展开后,卡在栈底时那 380px 落在栈的下沿外:等它真画出来(侧板开着时卡是 gone)、展开过渡走完,
  // 只滚栈本身把它露出来(scrollIntoView 会连带滚 overflow:hidden 的祖先)
  useEffect(() => {
    if (!reveal.current || gone || !open) return
    reveal.current = false
    const id = window.setTimeout(() => {
      const el = document.querySelector(`[data-desk-session="${CSS.escape(sessionId)}"]`)
      const st = el?.closest('.t2-tsum')
      if (!el || !st) return
      const below = el.getBoundingClientRect().bottom - st.getBoundingClientRect().bottom
      if (below > 0) st.scrollBy({ top: below + 20, behavior: 'smooth' })
    }, 320)
    return () => window.clearTimeout(id)
  }, [gone, open, sessionId, top])

  return (
    <SummaryCard
      id="desk"
      className={`agent-desk-card${gone ? ' gone' : ''}${hasContent ? '' : ' empty'}`}
      rootProps={{ 'data-desk-session': sessionId, 'data-want': want ? '1' : '0' }}
      open={open}
      onToggle={(o) => { touchDesk(sessionId, 'desk'); if (hasContent) setUserOpen(sessionId, 'desk', o); else setPeek(o) }}
      head={<>
        <Sparkles size={13} className="agent-desk-spark" />
        <span>{t('desk.title')}</span>
        {!companion && <span className="t2-card-hint agent-desk-card-title">{items[0]?.name || t('desk.idle')}</span>}
      </>}
      actions={<>
        {plan.clearable && <CardAction className="icon-btn" icon={<Eraser size={13} />} label={t('desk.clear')} run={() => clearDesk(sessionId)} />}
        {expand && <CardAction className="icon-btn" icon={<Maximize2 size={13} />} label={t('desk.expand')} run={expand} />}
      </>}
      bodyClassName={`agent-desk-card-frame${expand ? ' act' : ''}`}
      bodyProps={{ onClick: expand, title: expand ? t('desk.expand') : undefined }}
    >
      {open && !gone && (
        <div className={`agent-desk-card-body${companion ? ' companion' : ''}`}>
          {companion ? (
            <div className="agent-desk-pane agent-desk-companion">
              <DeskCompanionHost key={companion.key} entry={companion} surface="desk-card" sessionId={draft ? null : sessionId} />
            </div>
          ) : items.length ? (
            items.map((it, i) => (
              <div className="agent-desk-pane" key={it.key} style={items.length === 2 && i === 0 ? splitStyle(desk?.split) : undefined}>
                {it.live ? <DeskLivePane sessionId={sessionId} item={it} />
                  : it.tool ? <DeskToolCardPane sessionId={sessionId} callId={it.tool.callId} />
                  : it.view ? <DeskViewPane item={it} />
                    : <DeskFilePane item={it} allowNative={it.key === claimKey && !humanClaims} />}
              </div>
            ))
          ) : (
            <div className="agent-desk-card-empty">
              <Sparkles size={18} />
              <span>{t('desk.empty')}</span>
            </div>
          )}
        </div>
      )}
    </SummaryCard>
  )
}
