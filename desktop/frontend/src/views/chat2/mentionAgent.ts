/**
 * 「@ 它」(Chat 头像资料卡):从输入框外面往这张输入卡插一个 @Agent,语义同输入框自己的 @ 选人(pickMention):
 * 群聊里 = 这句定向给它,普通会话里 = 派给它,私聊(@ 的是项目)里不接。输入卡挂 MENTION_TARGET_ATTR,
 * 调用方找到自己那个对话里的卡,发一个 cancelable 的事件;卡接了就 preventDefault。
 */
export const MENTION_AGENT_EVENT = 'forsion:mention-agent'
export const MENTION_TARGET_ATTR = 'data-mention-target'

/** 发给 root 里的那张输入卡。返回卡接没接。 */
export function mentionAgentIn(root: ParentNode | null | undefined, slug: string): boolean {
  const card = root?.querySelector<HTMLElement>(`[${MENTION_TARGET_ATTR}]`)
  if (!card) return false
  return !card.dispatchEvent(new CustomEvent<{ slug: string }>(MENTION_AGENT_EVENT, { detail: { slug }, cancelable: true }))
}
