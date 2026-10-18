/**
 * 近况卡上那一行(从 HomepageView 搬出,2026-10-18 主页插件化 S4):内置主页的卡片和插件经 `ctx.spaces.mountStatus`
 * 拿到的是同一份 —— 只说手头就有的事实(最近的会话 / 最近打开的笔记 / 下一条日程 / 未读 / 已装插件 / 成就),拿不到就不写。
 */
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { mountHostReact } from '@lcl/components'
import { useApp } from '../stores/appStore'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { usePluginStore } from '../amadeus/plugins/pluginStore'
import { allSeries, useAchievements } from '../achievements/store'
import { displaySessionTitle } from '../sessionTitle'
import { HostLocaleProvider, registerMessages, useI18n } from '../i18n'
import { formatMonthDay, formatTime } from '../format/time'
import { useAgendaItems } from './DashboardCompactViews'
import { useInbox } from '../stores/inboxStore'

registerMessages({
  'home.card.continue': { zh: '继续：{title}', en: 'Continue: {title}' },
  'home.card.claimable': { zh: '{n} 项可领取', en: '{n} to claim' },
  'home.card.earned': { zh: '已得 {n} 项', en: '{n} earned' },
  'home.card.installed': { zh: '已装 {n} 个插件', en: '{n} plugins installed' },
  'home.card.unread': { zh: '{n} 条未读', en: '{n} unread' },
})

/** 桌面近况卡(摆法 C)的那一行。日历、收件箱各自一个组件:日程要读好几份日历库,不摆这张卡就不该算。 */
export function DeskCardStatus({ spaceId }: { spaceId: string }) {
  if (spaceId === 'calendar') return <CalendarCardStatus />
  if (spaceId === 'inbox') return <InboxCardStatus />
  return <CommonCardStatus spaceId={spaceId} />
}
function CommonCardStatus({ spaceId }: { spaceId: string }) {
  return <>{useCardStatus()(spaceId)}</>
}
function CalendarCardStatus() {
  // 自己每分钟重画一次:插件挂的那份(ctx.spaces.mountStatus)没有主页时钟带着它重画,结束了的那条会一直挂着(Codex 评审)
  const [, tick] = useState(0)
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(id) }, [])
  const { t } = useI18n()
  // 按此刻过滤(不靠 memo):主页时钟每分钟重画一次,结束了的那条就换成下一条
  const now = Date.now()
  const next = useAgendaItems().find((item) => item.end >= now)
  if (!next) return null
  const today = next.start.toDateString() === new Date().toDateString()
  const when = next.allDay ? (today ? '' : formatMonthDay(next.start)) : today ? formatTime(next.start) : `${formatMonthDay(next.start)} ${formatTime(next.start)}`
  return <>{[when, next.title || t('dashcompact.untitled')].filter(Boolean).join(' ')}</>
}
function InboxCardStatus() {
  const { t } = useI18n()
  const unread = useInbox((s) => s.unreadCount)
  useEffect(() => { void useInbox.getState().refreshUnread() }, [])
  return <>{unread ? t('home.card.unread', { n: String(unread) }) : ''}</>
}

/** 卡片上那一行近况:只说手头就有的事实(最近的会话 / 最近打开的笔记 / 成就 / 已装插件),拿不到就不写。 */
export function useCardStatus(): (id: string) => string {
  const { t } = useI18n()
  const session = useApp((s) => s.sessions[0])
  const note = useAmadeusPrefs((s) => s.recents[0])
  // 随 App 自带的不算「装了的」
  const plugins = usePluginStore((s) => s.plugins.filter((x) => !x.builtin && !x.preinstalled).length)
  const ach = useAchievements(useShallow((s) => ({ counters: s.counters, claimed: s.claimed, pluginSeries: s.pluginSeries })))
  return (id) => {
    if (id === 'tangu') return session ? t('home.card.continue', { title: displaySessionTitle(session.title, t) }) : ''
    if (id === 'amadeus') return note ? (note.split('/').pop() ?? note).replace(/\.md$/i, '') : ''
    if (id === 'rb-market') return plugins ? t('home.card.installed', { n: String(plugins) }) : ''
    if (id === 'rb-achievements') {
      const all = allSeries(ach).flatMap((x) => x.achievements)
      const open = all.filter((a) => !ach.claimed[a.id] && (ach.counters[a.event] || 0) >= a.goal).length
      const got = all.filter((a) => ach.claimed[a.id]).length
      return open ? t('home.card.claimable', { n: String(open) }) : got ? t('home.card.earned', { n: String(got) }) : ''
    }
    return ''
  }
}

/** `ctx.spaces.mountStatus` 的界面那半:把某个 Space(或商店 / 成就那两格)的近况那一行画进插件给的 `el`,跟着数据自己更新。 */
export function mountCardStatus(el: HTMLElement, id: string): () => void {
  return mountHostReact(el, <HostLocaleProvider><DeskCardStatus spaceId={id} /></HostLocaleProvider>).dispose
}
