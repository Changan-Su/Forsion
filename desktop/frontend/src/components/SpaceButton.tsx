/** Space 的 ribbon 顶部图标:复用 .rb-btn,当前空间加 .on 高亮(订阅 activeSpaceId 自动刷新)。
 *  原住 spaces.tsx —— 2026-08-27 独立成文件:spaces.tsx 顶层就读 `window`(SPACES 的能力门控),
 *  node 单测里导入即炸,而内置插件(builtins/calendar)与用户 Space(userSpaces)都要复用这个按钮。 */
import { setActiveSpace, useSpaceStore, label } from '@lcl/engine'
import type { SpaceDefinition } from '@lcl/engine'
import { useInbox } from '../stores/inboxStore'

export function SpaceButton({ space, expanded }: { space: SpaceDefinition; expanded: boolean }) {
  const active = useSpaceStore((s) => s.activeSpaceId === space.id)
  // hook 无条件调用(React 规则),选择器按 space.id 归零:只有收件箱图标显示未读角标。
  const unread = useInbox((s) => (space.id === 'inbox' ? s.unreadCount : 0))
  const Icon = space.icon
  const name = label(space.name)
  return (
    <button
      className={`rb-btn rb-space${active ? ' on' : ''}`}
      title={expanded ? undefined : name}
      onClick={() => setActiveSpace(space.id)}
    >
      {Icon && <Icon size={18} />}
      {expanded && <span className="rb-label">{name}</span>}
      {unread > 0 && <span className="rb-badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
  )
}
