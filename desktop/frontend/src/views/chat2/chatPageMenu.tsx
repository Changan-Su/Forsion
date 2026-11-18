/** 对话页自己的「⋯」(手机):这条对话的事 —— 置顶、重命名、归档、在这条对话里查找。
 *  条目和会话列表里长按一行出来的是同一批动作(同一份文案、同一个 store 方法),只是不用先退回列表。
 *  只是把行交给外壳(useNativeChromeExtras 的 more):画不画「⋯」、怎么呈现由外壳定,别的形态(桌面、平板横屏)不认这些行。 */
import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Pencil, Pin, PinOff, Search } from 'lucide-react'
import { dispatchNativeChromeAction, listFirstNow, useNativeChromeExtras, useWorkspace, type NativeChromePageAction } from '@lcl/engine'
import { useApp } from '../../stores/appStore'
import { registerMessages, useI18n } from '../../i18n'
import { displaySessionTitle } from '../../sessionTitle'
import { askString } from '../../amadeus/components/askString'
import { closeFindBar, findSupported, openFindBar, pickRoot, useFind } from '../../findInPage'
import { isOrbitPinned, onOrbitPinsChanged, readOrbitPins, toggleStoredOrbitPin } from './orbitPins'

registerMessages({
  'chat.pageMenu.find': { zh: '在这条对话里查找', en: 'Find in this chat' },
})

/** `sessionId` = 这一页的会话;null(新对话还没落库、右栏里的对话面板、子会话)= 这一页没有自己的菜单。 */
export function useChatPageMenu(sessionId: string | null): void {
  const { t } = useI18n()
  const title = useApp((s) => (sessionId ? (s.sessions.find((x) => x.id === sessionId) || s.archivedSessions.find((x) => x.id === sessionId))?.title : undefined))
  const known = useApp((s) => !!sessionId && (s.sessions.some((x) => x.id === sessionId) || s.archivedSessions.some((x) => x.id === sessionId)))
  // 活动列表里有它就按没归档算:归档列表是另一次请求拉的,两边一时都带着同一条(刚归档 / 刚取消、或后端两边都回)时,
  // 以用户此刻能在列表里看到的那一份为准,不把一条开着的对话写成「取消归档」。
  const archived = useApp((s) => !!sessionId && !s.sessions.some((x) => x.id === sessionId) && s.archivedSessions.some((x) => x.id === sessionId))
  const pinKey = `ses:${sessionId ?? ''}`
  const [pinned, setPinned] = useState(() => isOrbitPinned(readOrbitPins(), pinKey))
  useEffect(() => {
    const read = (): void => setPinned(isOrbitPinned(readOrbitPins(), pinKey))
    read()
    return onOrbitPinsChanged(read)
  }, [pinKey])

  // 和会话列表里那一行的动作同一套规矩:归档了的不给置顶、不给改名,只给「取消归档」。
  const rows: NativeChromePageAction[] | null = !sessionId || !known ? null : [
    ...(archived ? [] : [
      { id: pinned ? 'unpin' : 'pin', label: t(pinned ? 'sidebar.unpin' : 'sidebar.pin'), icon: pinned ? PinOff : Pin, run: () => { toggleStoredOrbitPin(pinKey) } },
      {
        id: 'rename', label: t('sidebar.rename'), icon: Pencil,
        run: () => {
          // 没起过题的会话,框里先填的是「新会话」这几个字(落库的是引擎的占位标题):原样点确定不算改名,别把占位写成用户起的题。
          const shown = displaySessionTitle(title, t)
          void askString(t('sidebar.rename'), shown).then((next) => {
            if (next && next !== shown) void useApp.getState().renameSession(sessionId, next)
          })
        },
      },
    ]),
    {
      id: archived ? 'unarchive' : 'archive', label: t(archived ? 'sidebar.unarchive' : 'sidebar.archive'), icon: archived ? ArchiveRestore : Archive,
      run: () => {
        void useApp.getState().archiveSession(sessionId, !archived).then(() => {
          // 归档完这一页就没什么可做的了:两级导航里退回列表(和点左上的返回是同一个动作)。取消归档留在原地。
          // 存上了(活动列表里没有它了)、人也还在详情层才退;没存上(断网)留在这条对话里,提示由 store 给。
          if (archived || !listFirstNow() || useWorkspace.getState().leftVisible) return
          if (!useApp.getState().sessions.some((x) => x.id === sessionId)) dispatchNativeChromeAction('left')
        })
      },
    },
    ...(findSupported ? [{
      id: 'find', label: t('chat.pageMenu.find'), icon: Search, section: 1,
      // 查找条已经开着、找的却是别的面(在列表层开的,列表还挂着):先收掉,再对着屏上这一面开。
      run: () => { const f = useFind.getState(); if (f.open && f.root !== pickRoot()) closeFindBar(); openFindBar() },
    }] : []),
  ]
  useNativeChromeExtras(rows ? { where: 'main', more: rows } : null)
}
