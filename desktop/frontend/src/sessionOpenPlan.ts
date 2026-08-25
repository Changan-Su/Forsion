// 「点会话 → 落哪个主 leaf」的纯决策(与引擎/store 解耦,方便单测)。
// chat leaf 支持两态:followActive(跟随全局 activeId,即「主聊天」)/ 固定会话(followActive:false + sessionId)。
//  - activate:已有钉住该会话的标签 → 激活它(与 openNote 的「已开着就切过去」逐字同语义)。
//  - newtab:⌘/Ctrl 点击或右键「在新标签页打开」→ 新开一个钉住该会话的标签。
//  - follow:焦点已在「跟随主聊天」→ 切 activeId 即可,leaf 自随。
//  - pin:焦点在空白新标签 / 笔记 / 固定到别的会话的聊天 → 就地把它固定成该会话的聊天(修「新标签点会话却替换旧视图」)。
//  - fresh:主区无 leaf → 兜底新建主聊天。
//
// ⚠️ activate 只认**钉住的**标签(followActive===false):主聊天恒随 activeId,一旦把它也算「认领了该会话」,
//    每次点会话都会跳回主聊天,钉住的标签再也聚不上焦。

export interface FocusedLeaf { type?: string; followActive?: boolean }
/** 主区现存的聊天 leaf(只需判定所需的三个字段)。 */
export interface ChatLeaf { id: string; sessionId?: string; followActive?: boolean }

export type SessionOpenPlan =
  | { act: 'activate'; leafId: string }
  | { act: 'newtab' | 'follow' | 'pin' | 'fresh' }

/** 「新对话」落在哪:站在**空白标签**(＋ 开出来的启动器 / Space 空白首页)里 → 就开在这个标签(here);
 *  站在笔记/已有聊天上 → 复用主聊天(reuse),与「新建笔记」复用已有编辑器同一口径。
 *  ⚠️ 焦点本身就是主聊天时必须 reuse:否则等于把它「导航成它自己」,白重挂一次。 */
export function planNewChat(focused: (FocusedLeaf & { id?: string }) | null, primaryLeafId?: string | null): 'here' | 'reuse' {
  if (!focused) return 'reuse'
  if (focused.type !== 'launcher' && focused.type !== 'home') return 'reuse'
  if (primaryLeafId && focused.id === primaryLeafId) return 'reuse'
  return 'here'
}

/** 前进/后退复原一条会话到**某个具体 leaf**:该怎么落?
 *  - follow:它是跟随档主聊天 → 切 activeId,它自随(侧栏那份陪伴聊天也跟着,这是「跟随」本义)。
 *  - pin:它是钉住会话的标签 → 只改它自己的 sessionId。**绝不能走 activeId** —— 钉住的 leaf 根本不看
 *        activeId,那样按后退等于「本标签纹丝不动,却把别的标签换了内容」(用户实报的两个症状同一根因)。
 *  - navigate:这个 leaf 已被就地切成别的视图(笔记等)→ 先切回聊天,并且**钉住**该会话:此刻主聊天
 *        很可能是另一个 leaf,再开一个跟随档会变成两个 leaf 抢同一个 activeId。
 *  ⚠️ 必须在 restore **当时**读 leaf 的状态,不能沿用 record 当时的:主聊天会被 freezeMainPrimary 冻成钉住档,
 *     用录制时的判断会把它反向解冻回跟随档,08-16 那条冻结不变式当场破掉。 */
export function planChatRestore(leaf: { type?: string; followActive?: boolean } | null): 'follow' | 'pin' | 'navigate' | null {
  if (!leaf) return null
  if (leaf.type !== 'chat') return 'navigate'
  return leaf.followActive === false ? 'pin' : 'follow'
}

export function planSessionOpen(
  focused: FocusedLeaf | null,
  ctx?: { sessionId?: string; leaves?: ChatLeaf[]; newTab?: boolean },
): SessionOpenPlan {
  if (ctx?.newTab) return { act: 'newtab' }
  const claimed = ctx?.sessionId
    ? ctx.leaves?.find((l) => l.followActive === false && l.sessionId === ctx.sessionId)
    : undefined
  if (claimed) return { act: 'activate', leafId: claimed.id }
  if (!focused) return { act: 'fresh' }
  if (focused.type === 'chat' && focused.followActive !== false) return { act: 'follow' }
  return { act: 'pin' }
}

/** 切 Space 时的「当前会话」交接:老 Space 那条存进账本,取新 Space 上次那条(从没进过 / 已删 → null = 空白新对话)。
 *  为什么要分账:所有跟随档 chat leaf 共用同一个全局 activeId,不分账的话 Tangu 主 tab 里开的会话会原样
 *  出现在 Amadeus/Coding 侧栏那份陪伴聊天里,且双向互拖(2026-08-23 用户实报)。Space **内部**的跟随不变
 *  (点会话列表 → 同 Space 的陪伴聊天照旧跟着切,Coding Space 的左栏 Prompt 靠这个)。 */
export function planSpaceSwitch(
  ledger: Map<string, string | null>,
  from: string,
  to: string,
  current: string | null,
  alive: (id: string) => boolean,
): string | null {
  ledger.set(from, current)
  const next = ledger.get(to) ?? null
  return next && alive(next) ? next : null
}
