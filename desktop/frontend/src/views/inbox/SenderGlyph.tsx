/** 发信人的长相,只此一份:阅读面板头部与仪表盘收件箱卡共用(列表行首走 ListItem.icon / iconUrl,画的是同样几枚字形,
 *  见 inboxListSource 的 SOURCE_ICON)。Agent = 它自己的头像,没有就是名字首字母;其余按来源一枚线性图标。
 *  圆的 —— 应用里 Agent 头像处处是圆的(.msg-avatar / .agent-pill-avatar),这里从前是方块。 */
import { Cloud, Info, Workflow } from 'lucide-react'
import { useHomeAgentAvatars } from '../../stores/homeCatalog'
import { isAutomationSender, senderOf, type InboxMessage } from '../../stores/inboxStore'
import './inbox.css'

export function SenderGlyph({ msg, size }: { msg: InboxMessage; size: number }) {
  const avatars = useHomeAgentAvatars() // 收件箱是本端的(P1-K6:焦点在我的电脑时也按本端的 Agent)
  const url = msg.sender_kind === 'agent' && msg.sender_id ? avatars[msg.sender_id] : undefined
  if (url) return <img className="ibx-ava" style={{ width: size, height: size }} src={url} alt="" />
  const icon = Math.round(size * 0.5)
  return (
    <span className="ibx-ava-fallback" style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}>
      {msg.sender_kind === 'server' ? <Cloud size={icon} /> : msg.sender_kind === 'system' ? <Info size={icon} /> : isAutomationSender(msg) ? <Workflow size={icon} /> : (senderOf(msg) || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}
