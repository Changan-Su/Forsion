/**
 * 手机的对话页少写几样(只在原生外壳的窄列里生效,样式在 chat2.css 文末「手机:对话页少写几样」):
 *   · 只有一个 Agent 的对话,回答上面不写 Agent 的名字;团队 / 多 Agent 的照旧;
 *   · 时间只在离上一条超过 5 分钟(以及第一条)时写,点一下气泡也出来;
 *   · 回答下面那排按钮只在最后一条回答下常驻,别的回答点一下才出来(messageTap.ts)。
 *
 * 这里只算「哪一条带哪几个记号」:EditorialMessage 把它写成消息根上的 `data-quiet`(记号用空格隔开),剩下的全是样式。
 * 三样都要看相邻的消息,而一条消息的组件只拿得到自己 —— 所以按整段消息算一次(同一个数组只算一遍),每条消息来查自己那一格。
 */
import type { AgentConfig, UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { isBubble } from './canvasTree'

/** 离上一条超过这么久,这一条写时间。 */
export const TIME_GAP_MS = 5 * 60_000

const GAP = 1 // 写时间
const LAST = 2 // 最后一条回答:按钮常驻
const SOLO = 4 // 对话里只有一个 Agent:这条回答不写名字
const ANSWER = 8 // 这只气泡是回答(只在这里用:名字只有回答有)
/** 记号的八种组合。写成固定的几个串:查一次不新造字符串,选择器前后两次拿到的是同一个值。 */
const TOKENS = ['', 'gap', 'last', 'gap last', 'solo', 'gap solo', 'last solo', 'gap last solo'] as const

export interface QuietMarks {
  /** 气泡 id → GAP | LAST | ANSWER;不在里面 = 这一行不是气泡(不画的、系统行、机器行)。 */
  bits: ReadonlyMap<string, number>
  /** 回答里出现过几个不同的发言人。没标发言人的回答不算(老消息没存这一项,它们是这场会话自己的 Agent 说的)。 */
  speakers: number
}

/** 一段消息里每只气泡的记号。「上一条」= 上一只带时间的气泡:系统行、机器行、列表里不画的行都不算,没存时间的老消息也不算。 */
export function quietMarksOf(rows: readonly UiMessage[]): QuietMarks {
  const bits = new Map<string, number>()
  const speakers = new Set<string>()
  let prevAt = 0
  let last: string | null = null
  for (const m of rows) {
    if (!isBubble(m)) continue
    let b = 0
    if (m.timestamp > 0) {
      if (!prevAt || m.timestamp - prevAt > TIME_GAP_MS) b |= GAP
      prevAt = m.timestamp
    }
    if (m.role === 'assistant') {
      b |= ANSWER
      last = m.id
      const who = m.agentId || m.agentName
      if (who) speakers.add(who)
    }
    bits.set(m.id, b)
  }
  if (last) bits.set(last, (bits.get(last) ?? 0) | LAST)
  return { bits, speakers: speakers.size }
}

/** 团队 / 群聊 / 团队成员的会话:回答各有各的发言人,名字要留着。 */
export const isTeamConfig = (cfg: AgentConfig | null | undefined): boolean =>
  !!cfg && (!!cfg.groupChat || !!cfg.teamSlug || !!cfg.teamMember || (cfg.groupAgents?.length ?? 0) >= 2)

const cache = new WeakMap<readonly UiMessage[], QuietMarks>()

/** 这条消息的 `data-quiet`。undefined = 不在这段消息里、或者不是气泡 —— 这条消息照原样画,什么都不少写。
 *  「只有一个 Agent」两头都看:会话配置不是团队,回答里也只出现过一个发言人(中途换过 Agent、关掉过团队模式的对话,配置是单人的,
 *  回答却是几个人的)。 */
export function quietTokens(rows: readonly UiMessage[] | undefined, cfg: AgentConfig | null | undefined, id: string): string | undefined {
  if (!rows) return undefined
  let marks = cache.get(rows)
  if (!marks) { marks = quietMarksOf(rows); cache.set(rows, marks) }
  const b = marks.bits.get(id)
  if (b === undefined) return undefined
  const solo = (b & ANSWER) !== 0 && marks.speakers <= 1 && !isTeamConfig(cfg)
  return TOKENS[(b & (GAP | LAST)) | (solo ? SOLO : 0)]
}
