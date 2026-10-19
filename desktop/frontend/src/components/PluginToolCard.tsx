/**
 * 插件工具结果卡片(ctx.registerToolResultRenderer;认领与 state 在 amadeus/plugins/toolResultCards.ts)。
 * 原生 DOM 挂在宿主里,不进 iframe:主题、字号、ctx.ui 零件插件直接用。
 *
 * 落点(10-19 方案 D):对话里的卡片(inline,缺省)或 Agent Desk 里的一格(desk)。唯一真源是 Desk 条目本身 ——
 * 这次调用在本会话的 Desk 条目里 = 对话里画占位卡,不在 = 画卡片。挪位置 = 加 / 删 Desk 条目,React 卸掉旧位置的
 * 挂载(先跑插件的清理)、在新位置重新 mount,视图状态经 call.state 交还。没有 Desk 的地方(手机、Desk 关着、
 * 画布 / 子会话占着侧边)一律卡片。
 */
import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { MessageSquare, PanelRight, Puzzle } from 'lucide-react'
import type { ToolEvent } from '../types'
import { useApp, type DeskItem } from '../stores/appStore'
import { replaceTop } from '../stores/deskPlan'
import { registerMessages, useI18n } from '../i18n'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { pluginDisplayName } from '../amadeus/plugins/display'
import type { ToolResultSurface } from '../amadeus/plugins/types'
import { cardStateHandle, parseToolArgs, refreshEngineTools, toolCardOf, toolCardTitle, type ToolCardClaim } from '../amadeus/plugins/toolResultCards'
import { quoteInMainChat } from '../views/chat2/btwStore'
import { deskAcceptsFiles } from '../amadeus/plugins/deskCompanion'
import { UI_MODE } from '@lcl/engine'
import './PluginToolCard.css'

registerMessages({
  'toolCard.openInDesk': { zh: '在 Desk 打开', en: 'Open in Desk' },
  'toolCard.backToChat': { zh: '收回到对话', en: 'Back to chat' },
  'toolCard.putBack': { zh: '放回对话', en: 'Move back to chat' },
  'toolCard.showingInDesk': { zh: '正在 Desk 中显示', en: 'Showing in Desk' },
  'toolCard.notLoaded': { zh: '这次调用的记录还没加载', en: 'This call isn’t loaded yet' },
  'toolCard.noRenderer': { zh: '插件没在运行，先显示原始结果', en: 'The plugin isn’t running. Showing the raw result.' },
})

/** 这块对话的 Desk 此刻看得见、收得下卡片 → 它所属的会话 id;否则(手机、Desk 关着、画布、窗口窄于 760px 被 CSS 藏掉、
 *  子会话面板顶掉了展开的 Desk)→ null,一律画卡片。ChatView 提供。 */
export const ToolCardDeskContext = createContext<string | null>(null)

const QUOTE_CAP = 20_000 // 同 quoteInMainChat

export const deskItemsOf = (sessionId: string): DeskItem[] => useApp.getState().deskBySession[sessionId]?.items ?? []

/** 放进 Desk 顶格并展开成半宽侧板(用户拖过宽度就不动宽度);同一次调用已在 Desk 里时只挪到顶格。 */
export function showToolCardInDesk(sessionId: string, callId: string, name: string): void {
  const app = useApp.getState()
  const cur = app.deskBySession[sessionId]
  const item: DeskItem = { key: `tool:${callId}`, path: '', name, at: Date.now(), tool: { callId } }
  const items = replaceTop(deskItemsOf(sessionId).filter((x) => x.tool?.callId !== callId), item)
  app.patchDesk(sessionId, { items, mode: 'open', ...(cur?.userResized ? {} : { size: 'half' as const }) })
}

/** 从 Desk 拿掉;Desk 空了就收起侧板。 */
export function returnToolCardToChat(sessionId: string, callId: string): void {
  const items = deskItemsOf(sessionId).filter((x) => x.tool?.callId !== callId)
  useApp.getState().patchDesk(sessionId, { items, ...(items.length ? {} : { mode: undefined }) })
}

// 落点 desk 的卡片只在结果**直播到达**那一刻自动进 Desk 一次(重载的历史不进);用户收回之后不再弹回去,SSE 重放也靠它去重。
const autoPlaced = new Set<string>()
/** appStore 收到成功的 tool_result 后调。名单还没拉到(引擎半身比桌面半身晚激活)而本插件确有 desk 渲染器时,重拉一次再判。 */
export async function placeLiveToolCard(sessionId: string, callId: string): Promise<void> {
  if (autoPlaced.has(callId) || UI_MODE === 'mobile' || !deskAcceptsFiles(!!useApp.getState().desktopConfig?.agentDeskEnabled)) return
  const ev = findToolEvent(sessionId, callId)
  if (!ev) return
  let claim = toolCardOf(ev)
  if (!claim && usePluginStore.getState().toolResultRenderers.some((r) => r.item.tool === ev.name && r.item.surface === 'desk')) {
    await refreshEngineTools()
    if (autoPlaced.has(callId)) return
    claim = toolCardOf(ev)
  }
  if (!claim || claim.item.surface !== 'desk') return
  autoPlaced.add(callId)
  showToolCardInDesk(sessionId, callId, toolCardTitle(claim.item))
}

/** 仅供单测复位。 */
export const __resetToolCardPlacement = (): void => autoPlaced.clear()

export function findToolEvent(sessionId: string, callId: string): ToolEvent | undefined {
  for (const m of useApp.getState().messagesBySession[sessionId] || []) {
    const ev = m.toolEvents?.find((e) => e.id === callId)
    if (ev) return ev
  }
  return undefined
}

function usePluginName(pluginId: string): string {
  const { locale } = useI18n()
  const p = usePluginStore((s) => s.plugins.find((x) => x.id === pluginId))
  return p ? pluginDisplayName(p, locale) : pluginId
}

/** 把渲染器挂进宿主元素(对话与 Desk 共用)。依赖只挂渲染器本身与这次调用的数据(claim 对象每次渲染都是新的,挂它会循环重挂)。
 *  mount 抛错 → 交给调用方的 fallback(通用记录)。 */
export function CardMount({ event, claim, surface, onQuote, fallback }: {
  event: ToolEvent; claim: ToolCardClaim; surface: ToolResultSurface; onQuote?: (text: string) => void; fallback: React.ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  // 记的是「哪一个渲染器挂失败了」:插件重载换了新渲染器,自动回到挂载(只记布尔值的话 fallback 那支没有宿主元素,永远挂不回来)
  const [failedItem, setFailedItem] = useState<unknown>(null)
  const quoteRef = useRef(onQuote)
  quoteRef.current = onQuote
  const { item } = claim
  const failed = failedItem === item
  useEffect(() => {
    const el = host.current
    if (!el) return
    el.textContent = ''
    let cleanup: (() => void) | void
    try {
      cleanup = item.mount(el, {
        id: event.id, tool: event.name, args: parseToolArgs(event.arguments), result: event.result ?? '', surface,
        state: cardStateHandle(event.id),
        quote: (text: string) => {
          const body = String(text ?? '').trim().slice(0, QUOTE_CAP)
          if (!body) return
          if (quoteRef.current) quoteRef.current(body)
          else quoteInMainChat(body)
        },
      })
    } catch (e) {
      console.error(`[plugin:${claim.pluginId}] 工具结果卡片挂载失败(${event.name})`, e)
      setFailedItem(item)
    }
    return () => {
      try { cleanup?.() } catch (e) { console.warn(`[plugin:${claim.pluginId}] 工具结果卡片清理失败`, e) }
      el.textContent = ''
    }
  }, [item, failed, event.id, event.name, event.arguments, event.result, surface]) // eslint-disable-line react-hooks/exhaustive-deps
  return failed ? <>{fallback}</> : <div ref={host} className={`plugin-tool-card-body ${surface}`} data-plugin-tool-card-body={surface} />
}

/** 对话里的那一张:卡片,或者「正在 Desk 中显示」的占位卡。fallback = 通用工具记录(mount 抛错时画它)。 */
export function PluginToolCard({ event, claim, onQuote, fallback }: {
  event: ToolEvent; claim: ToolCardClaim; onQuote?: (text: string) => void; fallback: React.ReactNode
}) {
  const { t } = useI18n()
  const deskSid = useContext(ToolCardDeskContext)
  const inDesk = useApp((s) => !!deskSid && !!s.deskBySession[deskSid]?.items.some((it) => it.tool?.callId === event.id))
  const pluginName = usePluginName(claim.pluginId)
  const title = toolCardTitle(claim.item)
  if (deskSid && inDesk) {
    return (
      <div className="sketch-card plugin-tool-card is-stub" data-plugin-tool-stub={event.name}>
        <Puzzle size={14} className="plugin-tool-stub-ic" />
        <span className="plugin-tool-stub-copy">
          <span className="plugin-tool-stub-name">{title}</span>
          <span className="plugin-tool-stub-meta">{pluginName} · {t('toolCard.showingInDesk')}</span>
        </span>
        <button type="button" className="plugin-tool-stub-back" data-act="tool-card-back" onClick={() => returnToolCardToChat(deskSid, event.id)}>
          <MessageSquare size={13} />{t('toolCard.backToChat')}
        </button>
      </div>
    )
  }
  return (
    <div className="sketch-card plugin-tool-card" data-plugin-tool-card={event.name}>
      <div className="sketch-card-head">
        <span className="sketch-card-title">{title}<span className="plugin-tool-card-by"> · {pluginName}</span></span>
        {deskSid && (
          <button type="button" className="t2-iconbtn" data-act="tool-card-desk" title={t('toolCard.openInDesk')} aria-label={t('toolCard.openInDesk')}
            onClick={() => showToolCardInDesk(deskSid, event.id, title)}>
            <PanelRight size={14} />
          </button>
        )}
      </div>
      <CardMount event={event} claim={claim} surface="inline" onQuote={onQuote} fallback={fallback} />
    </div>
  )
}
