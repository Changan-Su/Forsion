/**
 * Chat 画布(方案「Chat 画布分支」第二步):把一棵会话树(树根 + 挂在它下面的分支)排成「一轮问答一张卡」的卡片树。
 * 纯函数,不碰 store / DOM(canvasTree.test.ts)。
 *
 * 分支把分叉点之前的对话**复制**成新 id(引擎 sessionBranch.ts,时间戳照抄)。认回来源那一轮:
 *  - 来源会话里含 fork_message_id 的那一轮 = 分叉卡;分支的复制段不会越过它;
 *  - 分支里哪几轮是复制的,按「问题 + 回答」的文字对齐来源的几轮(连续命中才算)。**不比时间戳**:这一端直播出来的消息
 *    记的是客户端时刻(appStore.send 的 sentAt),库里的副本是服务端时刻,对不上;
 *  - 两边的历史都只拉最近 200 条(引擎 /messages 缺省 LIMIT),窗口可能错开:从分支里第一处对上的那一轮开始认。
 * 对不上的轮次一律算分支自己的,挂在分叉卡下面(分叉卡也认不出就各自成一棵)。
 */
import type { SessionRecord, UiMessage } from '../../types'

/** 列表里不画的(同 ChatView 的 isHiddenInList)和这一端自己插的系统行(投票 / 压缩 / 成本提示):不进卡。 */
const unseen = (m: UiMessage): boolean =>
  m.role === 'system' || !!m.teamSummary || (!!m.work && !m.content && !m.error && !m.approvals?.length && !m.inquiries?.length)
/** 引擎落库的机器行(打断 / 审批结局 / 子会话回报)也是 role=user,但不是用户问的话:跟着上一轮,不另起一张卡。 */
const MACHINE = /^<(turn_interrupted|approval_update|child_sessions_update)>/
const isQuestion = (m: UiMessage): boolean => m.role === 'user' && !MACHINE.test(m.content)

export interface Turn { user?: UiMessage; answers: UiMessage[]; first: string; last: string; ids: Set<string> }

/** 一轮 = 一句问题 + 后面到下一句问题之前的所有行(回答、机器行)。开头没有问题的几行自成一轮。 */
export function splitTurns(rows: readonly UiMessage[]): Turn[] {
  const out: Turn[] = []
  for (const m of rows) {
    if (unseen(m)) continue
    let cur = out[out.length - 1]
    if (!cur || isQuestion(m)) {
      cur = { user: isQuestion(m) ? m : undefined, answers: [], first: m.id, last: m.id, ids: new Set() }
      out.push(cur)
    }
    if (m !== cur.user) cur.answers.push(m)
    cur.last = m.id
    cur.ids.add(m.id)
  }
  return out
}

export interface TurnCard {
  /** `${sid}:${这一轮第一行的 id}`,React key 与选中都认它。 */
  key: string
  /** 这一轮最早出现在哪个会话:卡里画的、卡上的动作都用这一份消息。 */
  sid: string
  user?: UiMessage
  answers: UiMessage[]
  parent: string | null
  children: string[]
  /** 经过这一轮的每个会话 → 它那份副本的第一行 / 最后一行 id(分支里是复制出来的新 id)。 */
  at: Record<string, { first: string; last: string }>
}

export interface TurnTree {
  cards: Map<string, TurnCard>
  roots: string[]
  /** 每个会话从第一轮到最后一轮经过的卡(只含已拉到历史的会话)。 */
  paths: Record<string, string[]>
}

const byCreated = (a: SessionRecord, b: SessionRecord): number => String(a.created_at || '').localeCompare(String(b.created_at || ''))
/** 前 400 字够认出「是不是同一份」,也不怕这一端对超长正文的截断(capContent)。 */
const norm = (m: UiMessage): string => m.content.trim().slice(0, 400)
/** 分支里的这一轮是来源那一轮的副本:问题一样,回答是来源回答的前几条(分叉点落在一轮中间时副本只抄到那条)。
 *  只比问题不够:主线后来把这一轮重新生成了,分支里存的还是旧回答,不能画成同一张卡(Codex 评审)。 */
function sameTurn(b: Turn, src: Turn): boolean {
  if (!b.user || !src.user || norm(b.user) !== norm(src.user) || b.answers.length > src.answers.length) return false
  return b.answers.every((m, i) => norm(m) === norm(src.answers[i]))
}

/** @param branches 树根下面 fork_message_id 有值的会话(分支的分支也挂树根,见引擎 routes/sessions.ts)
 *  @param rowsOf 会话已拉到的消息;undefined = 还没拉,先不画它(拉到后重算) */
export function buildTurnTree(rootId: string, branches: readonly SessionRecord[], rowsOf: (sid: string) => readonly UiMessage[] | undefined): TurnTree {
  const cards = new Map<string, TurnCard>()
  const roots: string[] = []
  const paths: Record<string, string[]> = {}
  const turnsOf: Record<string, Turn[]> = {} // 与 paths 逐项对齐:这个会话里那一轮自己的那份
  const grow = (sid: string, turns: Turn[], path: string[], seen: Turn[]): void => {
    for (const t of turns) {
      const key = `${sid}:${t.first}`
      const parent = path[path.length - 1] ?? null
      cards.set(key, { key, sid, user: t.user, answers: t.answers, parent, children: [], at: { [sid]: { first: t.first, last: t.last } } })
      if (parent) cards.get(parent)!.children.push(key)
      else roots.push(key)
      path.push(key)
      seen.push(t)
    }
    paths[sid] = path
    turnsOf[sid] = seen
  }

  const rootRows = rowsOf(rootId)
  if (rootRows) grow(rootId, splitTurns(rootRows), [], [])
  // 按建的先后排:分支的分支一定比它的来源晚建,来源先排好才认得出分叉那一轮
  for (const b of [...branches].sort(byCreated)) {
    const rows = rowsOf(b.id)
    const src = b.fork_session_id && paths[b.fork_session_id] ? b.fork_session_id : rootId
    if (!rows || !paths[src]) continue
    const srcPath = paths[src]
    const srcTurns = turnsOf[src]
    const forkIdx = b.fork_message_id ? srcTurns.findIndex((t) => t.ids.has(b.fork_message_id!)) : -1
    const limit = forkIdx >= 0 ? forkIdx : srcTurns.length - 1
    const turns = splitTurns(rows)
    // 复制段 = 分支里第一处和来源对上的那一轮起,依次和来源的连续几轮一样(两边都只拉最近 200 条,窗口可以错开);
    // 对上之前的几轮是来源窗口之外更早的副本,不画(来源那边也看不到它们)。一轮都对不上 = 全是分支自己的。
    let s = -1
    let j = -1
    for (let i = 0; i < turns.length && s < 0; i++) {
      j = srcTurns.findIndex((t, k) => k <= limit && sameTurn(turns[i], t))
      if (j >= 0) s = i
    }
    let n = s < 0 ? 0 : s + 1
    if (s >= 0) while (n < turns.length && j + 1 <= limit && sameTurn(turns[n], srcTurns[j + 1])) { j++; n++ }
    // 自己的几轮挂在分叉卡下;分叉消息不在来源已拉到的那段里,就挂在对上的最后一轮下(都没有 = 各自成一棵)
    const end = forkIdx >= 0 ? forkIdx : j
    const seen = srcTurns.slice(0, end + 1)
    for (let i = Math.max(s, 0); i < n; i++) {
      const k = j - (n - 1 - i)
      seen[k] = turns[i]
      cards.get(srcPath[k])!.at[b.id] = { first: turns[i].first, last: turns[i].last }
    }
    grow(b.id, turns.slice(n), srcPath.slice(0, end + 1), seen)
  }
  return { cards, roots, paths }
}
