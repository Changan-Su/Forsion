/** Space 的 ribbon 顶部图标:复用 .rb-btn,当前空间加 .on 高亮(订阅 activeSpaceId 自动刷新)。
 *  原住 spaces.tsx —— 2026-08-27 独立成文件:spaces.tsx 顶层就读 `window`(SPACES 的能力门控),
 *  node 单测里导入即炸,而内置插件(builtins/calendar)与用户 Space(userSpaces)都要复用这个按钮。 */
import { switchSpace, useSpaceStore, label, getDetachApi, landOnMainPage } from '@lcl/engine'
import type { SpaceDefinition } from '@lcl/engine'
import type { CSSProperties } from 'react'
import { useInbox } from '../stores/inboxStore'
import { soloBadge, useSoloStatus } from '../stores/attentionStore'
import { useSpaceProgress } from '../stores/spaceProgress'
import { useI18n } from '../i18n'
import '../shellMessages'

export function SpaceButton({ space, expanded }: { space: SpaceDefinition; expanded: boolean }) {
  const { t } = useI18n()
  const active = useSpaceStore((s) => s.activeSpaceId === space.id)
  // hook 无条件调用(React 规则),选择器按 space.id 归零:收件箱 = 未读信数;Tangu = 有新消息或在等你的私聊个数
  // (10-18 Muse 私聊方案 B),有一条在等你就换警示色。
  const inboxUnread = useInbox((s) => (space.id === 'inbox' ? s.unreadCount : 0))
  const solo = soloBadge(useSoloStatus(space.id === 'tangu'))
  const unread = space.id === 'tangu' ? solo.n : inboxUnread
  // 插件挂的进度环(ctx.app.setSpaceProgress,如蓬洲云在传文件);有未读角标时让角标
  const progress = useSpaceProgress((s) => s.progress[space.id])
  const pct = progress == null ? null : Math.round(progress * 100)
  // 插件挂的提示红点(ctx.app.setSpaceDot,如服务器管理有没看过的反馈):让给未读角标,压过进度环
  const dot = useSpaceProgress((s) => s.dot[space.id] === true)
  const Icon = space.icon
  const name = label(space.name)
  // 可访问名:原来唯一的文本子节点是角标,读屏念出来就是「1」。名字 + 未读条数进 aria-label,角标对读屏隐藏。
  // 收起态的悬停名走 Ribbon 自绘浮签(data-rb-tip),不再挂原生 title(否则两层提示叠在一起)。
  const a11y = unread > 0 ? t(solo.wait ? 'ribbon.spaceWaiting' : 'ribbon.spaceUnread', { name, n: unread })
    : dot ? t('ribbon.spaceDot', { name }) : pct != null ? t('ribbon.spaceProgress', { name, pct }) : name
  return (
    <button
      className={`rb-btn rb-space${active ? ' on' : ''}`}
      aria-label={a11y}
      aria-current={active ? 'page' : undefined}
      data-rb-tip={expanded ? undefined : a11y}
      // Ribbon 的左面板悬停预览按它认「指针停在哪个 Space 上」(lcl/engine/Ribbon.tsx 的 onPeekOver)。
      data-space-id={space.id}
      // ⌘ / Ctrl + 点击 = 在它自己的窗口里打开(宿主能开窗才有;mac 上 Ctrl+点击是右键,走不到这里)。
      onClick={(e) => {
        const open = getDetachApi()?.openSpace
        if ((e.metaKey || e.ctrlKey) && open) open(space.id)
        // 带过渡(人手点的;见 lcl/engine/spaceTransition.ts)。点的就是当前这个:回到它的默认主页(有声明的话,见 SpaceDefinition.mainPage)
        else switchSpace(space.id, active ? landOnMainPage : undefined)
      }}
    >
      {Icon && <Icon size={18} />}
      {expanded && <span className="rb-label">{name}</span>}
      {unread > 0 && <span className={`rb-badge${solo.wait ? ' dm-wait' : ''}`} aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      {unread === 0 && dot && <span className="rb-badge rb-dot" aria-hidden="true" />}
      {unread === 0 && !dot && pct != null && <span className="rb-badge rb-ring" style={{ '--p': pct } as CSSProperties} aria-hidden="true" />}
    </button>
  )
}
