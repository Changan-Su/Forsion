/** Agent Desk:聊天右侧的 agent 演出面板。
 *  格子=shim leaf(不进 Dockview,不碰布局持久化):vault 内文件按类型改道原生 view(笔记/导图/
 *  白板/插件文件/.db),任意注册视图(item.view,含插件注册)按 LCL 注册表挂载,其余走 WsFileView
 *  通用预览。状态在 appStore.deskBySession(会话级快照落 localStorage)。宽度=size 档位或用户
 *  拖出的 fraction —— 一律比例制,对 body 端级 zoom 免疫(px 会被 zoom 缩放,% 不会)。 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ChevronDown, Copy, Eraser, Loader2, Maximize2, Minimize2, NotebookPen, Puzzle, Sparkles } from 'lucide-react'
import { getView, subscribeViews } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { useApp, type DeskItem } from '../../stores/appStore'
import { DESK_DRAFT_KEY, extractLiveBody } from '../../stores/deskPlan'
import { WsFileView } from '../WsFileView'
import { usePageStore } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import { useDeskCompanion } from '@amadeus/plugins/deskCompanion'
import { DeskCompanionHost } from './DeskCompanionHost'
import { registerMessages, useI18n } from '../../i18n'
import { iconForFile } from '../../services/fileKinds'
import { openDb, openNote } from '../../amadeusNav'
import type { CtxItem } from '../../components/RightPanel'
import { DeskChromeContext, DeskMenuButton, DeskMoreButton, type DeskChrome } from './deskChrome'
import { DeskToolCardPane } from './DeskToolCardPane'
import { CardAction, SummaryCard } from './TaskSummary'
import { bumpOpen, openOf, setUserOpen, useSummaryOpen } from './summaryOpen'
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
})

/** 「清空 Desk」(idle 伴随面的回场键):条目清掉、侧板收回、说明一并作废 —— 卡片空态位交还伴随面。 */
const clearDesk = (sessionId: string, keepOpen = false): void =>
  // keepOpen:有空闲面(Muse 私聊)时侧板不用收 —— 清掉条目,原地换回 Muse Space
  useApp.getState().patchDesk(sessionId, { items: [], note: undefined, ...(keepOpen ? {} : { mode: undefined }) })

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
function DeskShimView({ type, params, k }: { type: string; params: Record<string, unknown>; k: string }) {
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
function vaultRelOf(path: string, root: string | null): string | null {
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
const claimKind = (rel: string, fileTypes: Parameters<typeof findFileType>[0]): 'note' | null =>
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
function DeskFilePane({ item, allowNative }: { item: DeskItem; allowNative: boolean }) {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const rel = vaultRelOf(item.path, vaultRoot)
  if (!rel) return <DeskPane item={item} />
  const kind = claimKind(rel, fileTypes)
  if (kind) return allowNative ? <DeskClaimPane item={item} rel={rel} /> : <DeskPane item={item} />
  // 白板在 Desk 上是只读预览 + 「在白板中打开」(走查续七 7.7 A),要画就进主区那块。
  if (isDrawingPath(rel)) return <DeskShimView type="amadeus-drawing" params={{ drawingPath: rel, preview: true }} k={`desk-draw:${rel}`} />
  if (findFileType(fileTypes, rel)) return <DeskShimView type="amadeus-plugin-file" params={{ filePath: rel }} k={`desk-ft:${rel}`} />
  if (/\.db$/i.test(rel)) return <DeskShimView type="amadeus-db" params={{ dbPath: rel }} k={`desk-db:${rel}`} />
  return <DeskPane item={item} />
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

/** 展开态的一格 = 悬浮胶囊 + 内容(方案 B,两颗胶囊同 Mini 顶栏 lcl/engine/miniCard.css .mini-card-cap)。
 *  左胶囊:条目名(第一格且有得切 / 有 Agent 说明时带 ▾ 菜单);右胶囊:视图控件槽 │ ⋯ │ 面板级按钮。
 *  下面的格(panel=null)不要右胶囊,槽和 ⋯ 跟在名字后面。伴随面(item 缺省)只有右胶囊。 */
function DeskCaps({ sessionId, item, panel, switchable, className, children }: {
  sessionId: string; item?: DeskItem; panel: React.ReactNode; switchable?: boolean; className?: string; children: React.ReactNode
}) {
  const { t } = useI18n()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const more = useRef<CtxItem[]>([])
  const chrome = useMemo<DeskChrome>(() => ({ slot, more }), [slot])
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const fileTypes = usePluginStore((s) => s.fileTypes)
  const note = useApp((s) => s.deskBySession[sessionId]?.note)
  const all = useApp((s) => s.deskBySession[sessionId]?.items)
  const path = item?.path || ''
  const rel = vaultRelOf(path, vaultRoot)
  // 「在 Amadeus 中打开」只给 Desk 自己会改道原生 view 的库内类型(与 DeskFilePane 同口径)
  const amadeus = rel && (/\.(md|db)$/i.test(rel) || isDrawingPath(rel) || !!findFileType(fileTypes, rel)) ? rel : null
  const moreItems = (): CtxItem[] => [
    ...more.current,
    // .db 走 openDb:openNote 会把它塞进笔记编辑器,保存时把 Markdown 写回数据库(Codex P1)
    ...(amadeus ? [{ label: t('preview.openInAmadeus'), icon: <NotebookPen size={14} />, run: () => { if (/\.db$/i.test(amadeus)) openDb(amadeus); else void openNote(amadeus) } }] : []),
    ...(path ? [{ label: t('panel.action.copyPath'), icon: <Copy size={14} />, run: () => void navigator.clipboard?.writeText(path) }] : []),
  ]
  const tools = item && (
    <>
      <span ref={setSlot} className="desk-cap-slot" />
      {!item.live && (path || !item.view) && <DeskMoreButton items={moreItems} />}
    </>
  )
  let name: React.ReactNode = null
  if (item) {
    const Icon = item.live ? Loader2 : item.tool ? Puzzle : item.view ? Sparkles : iconForFile('', item.name || path)
    const label = item.live ? (path ? t('desk.writing', { name: item.name }) : t('desk.drafting')) : (item.name || path.split(/[/\\]/).pop() || '')
    const tip = [path, !item.live && note].filter(Boolean).join('\n') || undefined
    const inner = <><Icon size={13} className={`desk-cap-ic${item.live ? ' spin' : ''}`} /><span className="desk-cap-label">{label}</span></>
    const others = (all ?? []).filter((x) => x.key !== item.key)
    // 直播条目只认顶格(直播更新 / 落盘接棒 / 失败清场都按顶格做),有直播时不许换位
    const liveNow = (all ?? []).some((x) => x.live)
    name = switchable && (others.length || note) ? (
      <DeskMenuButton
        className="desk-cap-pick"
        title={tip ?? t('desk.switch')}
        items={() => [
          ...(note ? [{ label: note, disabled: true, run: () => {} }] : []),
          ...(all ?? []).map((x, i) => ({
            label: x.name || x.path, separatorBefore: !!note && i === 0, disabled: x.key === item.key || liveNow,
            run: () => useApp.getState().patchDesk(sessionId, { items: [x, ...(all ?? []).filter((y) => y.key !== x.key)] }),
          })),
        ]}
      >
        {inner}<ChevronDown size={12} className="desk-cap-caret" />
      </DeskMenuButton>
    ) : <span className="desk-cap-pick" title={tip}>{inner}</span>
  }
  return (
    <div className={`agent-desk-pane has-caps${className ? ' ' + className : ''}`}>
      <div className="desk-caps">
        {name ? <div className="desk-cap desk-cap-name">{name}{!panel && tools}</div> : <span />}
        {panel && <div className="desk-cap">{tools}{item && <span className="desk-cap-div" />}{panel}</div>}
      </div>
      <DeskChromeContext.Provider value={chrome}>{children}</DeskChromeContext.Provider>
    </div>
  )
}

/** onQuote:Desk 里的插件结果卡片调 call.quote 时挂进哪个输入框(ChatView 传自己的;不传退回主对话)。 */
export function AgentDesk({ sessionId, onQuote }: { sessionId: string; onQuote?: (text: string) => void }) {
  const { t } = useI18n()
  const desk = useApp((s) => s.deskBySession[sessionId])
  const claimKey = useClaimKey(desk?.items?.slice(0, 2) ?? [])
  const rootRef = useRef<HTMLDivElement>(null)
  const onGrip = useDeskGrip(sessionId, rootRef)
  const comp = useDeskCompanion()
  const home = useDeskHome(sessionId)
  // always 伴随面 = 完全替换:侧板只演伴随面(没有任何条目也要能展开)
  const always = comp?.mode === 'always'

  if (!desk?.items.length && !always && !home) return null
  const open = desk?.mode === 'open'
  const frac = desk?.fraction ?? (desk?.size === 'wide' ? 0.62 : 0.46)
  const own = desk?.items.slice(0, 2) ?? []
  // 空闲面:自己没有条目时演它(见 useDeskHome)
  const items = own.length || !home ? own : [home]
  const clearable = (comp?.mode === 'idle' || !!home) && !always && own.length > 0
  // 面板级按钮(清空 / 收起)住第一格的右胶囊末尾
  const panelBtns = (
    <>
      {clearable && (
        <button className="icon-btn" title={t('desk.clear')} onClick={() => clearDesk(sessionId, !!home)}>
          <Eraser size={14} />
        </button>
      )}
      <button className="icon-btn" title={t('desk.collapse')} onClick={() => useApp.getState().patchDesk(sessionId, { mode: undefined })}>
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
            <div className="agent-desk-body">
              {always && comp ? (
                <DeskCaps sessionId={sessionId} panel={panelBtns} className="agent-desk-companion">
                  <DeskCompanionHost key={comp.key} entry={comp} surface="desk-panel" sessionId={sessionId} />
                </DeskCaps>
              ) : items.map((it, i) => (
                <DeskCaps key={it.key} sessionId={sessionId} item={it} panel={i === 0 ? panelBtns : null} switchable={i === 0}>
                  {it.live ? <DeskLivePane sessionId={sessionId} item={it} />
                    : it.tool ? <DeskToolCardPane sessionId={sessionId} callId={it.tool.callId} onQuote={onQuote} />
                    : it.view ? <DeskShimView type={it.view.type} params={it.view.params ?? {}} k={`desk-view:${it.key}`} />
                      : <DeskFilePane item={it} allowNative={it.key === claimKey} />}
                </DeskCaps>
              ))}
            </div>
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
  const items = own.length || !home || always ? own : [home]
  const claimKey = useClaimKey(items)
  const draft = sessionId === DESK_DRAFT_KEY
  const plan = deskCardPlan({ mode: desk?.mode, itemCount: own.length, companion: comp?.mode ?? null, draft, home: !!home })
  const gone = plan.gone
  const expand = plan.expandable ? () => useApp.getState().patchDesk(sessionId, { mode: 'open' }) : undefined
  const companion = plan.showCompanion ? comp : null
  const hasContent = items.length > 0 || !!companion
  const pref = useSummaryOpen((s) => openOf(s.by[sessionId], 'desk', true))
  const [peek, setPeek] = useState(false) // 空着时手动点开看一眼;不记
  const top = own[0]?.key ?? null
  const seen = useRef({ sessionId, top })
  const reveal = useRef(false) // 新条目到了、还没把卡露出来
  useEffect(() => {
    const s = seen.current
    if (s.sessionId !== sessionId) { seen.current = { sessionId, top }; reveal.current = false; return }
    if (top && top !== s.top) { bumpOpen(sessionId, 'desk'); reveal.current = true }
    s.top = top
  }, [sessionId, top])
  useEffect(() => { if (hasContent) setPeek(false) }, [hasContent])
  const open = hasContent ? pref : peek
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
      rootProps={{ 'data-desk-session': sessionId }}
      open={open}
      onToggle={(o) => (hasContent ? setUserOpen(sessionId, 'desk', o) : setPeek(o))}
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
            items.map((it) => (
              <div className="agent-desk-pane" key={it.key}>
                {it.live ? <DeskLivePane sessionId={sessionId} item={it} />
                  : it.tool ? <DeskToolCardPane sessionId={sessionId} callId={it.tool.callId} />
                  : it.view ? <DeskShimView type={it.view.type} params={it.view.params ?? {}} k={`desk-view:${it.key}`} />
                    : <DeskFilePane item={it} allowNative={it.key === claimKey} />}
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
