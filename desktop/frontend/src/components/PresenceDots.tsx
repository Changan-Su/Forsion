/**
 * presence 头像点(web 专属,window.amadeusCollab 解闸):当前云库在线成员,除自己。
 * 同页的人高亮;挂载期驱动 30s 心跳(页面切换即刻上报)。不落库,TTL 由服务端/汇流器管。
 */
import React, { useEffect, useState } from 'react'
import { usePageStore } from '@amadeus/store/pageStore'
import { registerMessages, useI18n } from '../i18n'

registerMessages({
  'presencedots.viewing': { zh: '{name} 正在看 {page}', en: '{name} is viewing {page}' },
  'presencedots.online': { zh: '{name} 在线', en: '{name} is online' },
})

interface P { userId: string; username: string; page: string | null; at: number }

export function PresenceDots(): React.ReactElement | null {
  const { t } = useI18n()
  const collab = window.amadeusCollab
  const activePage = usePageStore((s) => s.activePage ?? s.activeNotePath) // v4 不设 activePage
  const vaultSide = usePageStore((s) => s.vaultSide)
  const [list, setList] = useState<P[]>([])
  // 桌面(有 amadeusSync)只在 Cloud 侧渲染/心跳:Local 侧的页面路径对云端无意义。
  const active = !window.amadeusSync || vaultSide === 'cloud'

  useEffect(() => {
    if (!collab || !active) return
    const off = collab.onPresence(setList)
    return () => { off(); collab.stopHeartbeat() }
  }, [collab, active])

  useEffect(() => {
    if (active) collab?.heartbeat(activePage)
  }, [collab, activePage, active])

  if (!collab || !active) return null
  const me = collab.myUserId()
  const others = list.filter((p) => p.userId !== me)
  if (!others.length) return null

  return (
    <span className="amxc-presence" title={others.map((p) => `${p.username}${p.page ? ` · ${p.page.replace(/\.md$/i, '')}` : ''}`).join('\n')}>
      {others.slice(0, 5).map((p) => (
        <span
          key={p.userId}
          className={`amxc-dot${p.page && p.page === activePage ? ' same' : ''}`}
          title={p.page
            ? t('presencedots.viewing', { name: p.username, page: p.page.replace(/\.md$/i, '') })
            : t('presencedots.online', { name: p.username })}
        >
          {(p.username || '?').slice(0, 1).toUpperCase()}
        </span>
      ))}
      {others.length > 5 && <span className="amxc-dot more">+{others.length - 5}</span>}
    </span>
  )
}
