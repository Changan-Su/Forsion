/** Agent Desk:聊天右侧的 agent 演出面板。
 *  格子=shim leaf(不进 Dockview,不碰布局持久化):vault 内文件按类型改道原生 view(笔记/导图/
 *  白板/插件文件/.db),任意注册视图(item.view,含插件注册)按 LCL 注册表挂载,其余走 WsFileView
 *  通用预览。状态在 appStore.deskBySession(会话级快照落 localStorage)。宽度=size 档位或用户
 *  拖出的 fraction —— 一律比例制,对 body 端级 zoom 免疫(px 会被 zoom 缩放,% 不会)。 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Loader2, Maximize2, Minimize2, Sparkles } from 'lucide-react'
import { getView, subscribeViews } from '@lcl/engine'
import type { ViewProps } from '@lcl/engine'
import { useApp, type DeskItem } from '../../stores/appStore'
import { extractLiveBody } from '../../stores/deskPlan'
import { WsFileView } from '../WsFileView'
import { usePageStore } from '@amadeus/store/pageStore'
import { findFileType, usePluginStore } from '@amadeus/plugins/pluginStore'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import { registerMessages, useI18n } from '../../i18n'

registerMessages({
  'desk.writing': { zh: '正在编辑 {name}', en: 'Editing {name}' },
  'desk.drafting': { zh: '正在起草…', en: 'Drafting…' },
  'desk.expand': { zh: '展开', en: 'Expand' },
  'desk.collapse': { zh: '收起为卡片', en: 'Collapse to card' },
  'desk.empty': { zh: 'Agent 会在这里展示成果', en: 'Agent will present work here' },
})

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
  if (isDrawingPath(rel)) return <DeskShimView type="amadeus-drawing" params={{ drawingPath: rel }} k={`desk-draw:${rel}`} />
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

export function AgentDesk({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const desk = useApp((s) => s.deskBySession[sessionId])
  const claimKey = useClaimKey(desk?.items?.slice(0, 2) ?? [])
  const rootRef = useRef<HTMLDivElement>(null)

  const onGrip = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
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
  }, [sessionId])

  if (!desk || !desk.items.length) return null
  const open = desk.mode === 'open'
  const frac = desk.fraction ?? (desk.size === 'wide' ? 0.62 : 0.46)
  const items = desk.items.slice(0, 2)

  return (
    // 壳常驻(有内容即挂):open 才有宽度与内容,flex-basis 过渡负责丝滑进出(见 chat2.css)
    // data-desk-session:desk_screenshot 靠它在多窗口/多聊天面板里认出该截哪一块(见 deskCapture.ts)
    <div ref={rootRef} data-desk-session={sessionId} className={`agent-desk${open ? ' open' : ''}`} style={{ '--desk-w': `${(frac * 100).toFixed(2)}%` } as React.CSSProperties}>
      {open && (
        <>
          <div className="agent-desk-grip" onPointerDown={onGrip} />
          <div className="agent-desk-inner">
            <div className="agent-desk-head">
              <Sparkles size={13} className="agent-desk-spark" />
              <span className="agent-desk-title">{t('desk.title')}</span>
              {desk.note ? <span className="agent-desk-note" title={desk.note}>{desk.note}</span> : <span className="agent-desk-note" />}
              <button
                className="icon-btn"
                title={t('desk.collapse')}
                onClick={() => useApp.getState().patchDesk(sessionId, { mode: undefined })}
              >
                <Minimize2 size={14} />
              </button>
            </div>
            <div className="agent-desk-body">
              {items.map((it) => (
                <div className="agent-desk-pane" key={it.key}>
                  {it.live ? <DeskLivePane sessionId={sessionId} item={it} />
                    : it.view ? <DeskShimView type={it.view.type} params={it.view.params ?? {}} k={`desk-view:${it.key}`} />
                      : <DeskFilePane item={it} allowNative={it.key === claimKey} />}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 卡片是否退场(.gone = 隐身但常驻,借 display allow-discrete 做进出动画):
 *  ① 侧板在演 —— 但 open 时内容已散(直播失败清场)就让卡片兜底,别双双消失;
 *  ② 还没开聊的空会话 —— 车道一占位,`.newchat-pickers`(Agent 选择器)拿不到让位
 *     (让位只挂 .t2-stream/.composer-anchor)就会歪出中线、还被空卡压住。
 *  「卡片不可关」的用户裁决只管**聊起来之后**:那时空态卡照常在场当预览位。 */
export const deskCardGone = (mode: string | undefined, itemCount: number, hasMessages: boolean): boolean =>
  (mode === 'open' && itemCount > 0) || (!hasMessages && itemCount === 0)

/** 卡片态(默认态):Pin Summary 下方的常驻预览小卡,上下各占右侧车道一半(严格 50/50)。
 *  正文 pointer-events:none —— 卡片是"预览",点整卡=放大成侧板;交互(编辑/按钮)只在 open 态。
 *  卡片不可关闭(用户裁决):空态也常驻当预览位,收/放只在卡片↔侧板之间切。 */
export function DeskCard({ sessionId }: { sessionId: string }) {
  const { t } = useI18n()
  const desk = useApp((s) => s.deskBySession[sessionId])
  const hasMessages = useApp((s) => !!s.messagesBySession[sessionId]?.length)
  const items = desk?.items?.slice(0, 2) ?? []
  const claimKey = useClaimKey(items)
  const gone = deskCardGone(desk?.mode, items.length, hasMessages)
  const expand = !gone && items.length ? () => useApp.getState().patchDesk(sessionId, { mode: 'open' }) : undefined

  return (
    <div data-desk-session={sessionId} className={`agent-desk-card${expand ? ' act' : ''}${gone ? ' gone' : ''}`} onClick={expand} title={expand ? t('desk.expand') : undefined}>
      <div className="agent-desk-card-head">
        <Sparkles size={12} className="agent-desk-spark" />
        <span className="agent-desk-card-title">{items[0]?.name || t('desk.title')}</span>
        {/* 键盘可达的放大入口(整卡 onClick 只服务鼠标) */}
        {expand && (
          <button className="icon-btn" title={t('desk.expand')} onClick={(e) => { e.stopPropagation(); expand() }}>
            <Maximize2 size={13} />
          </button>
        )}
      </div>
      <div className="agent-desk-card-body">
        {gone ? null : items.length ? (
          items.map((it) => (
            <div className="agent-desk-pane" key={it.key}>
              {it.live ? <DeskLivePane sessionId={sessionId} item={it} />
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
    </div>
  )
}
