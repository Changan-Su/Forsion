/**
 * 一次 run 的等待统计:Chat View 最后一条助手气泡下的「17m 33s · 10.5k tokens · 思考 12s」。
 * run 级而非消息级 —— steer 的 turn_boundary / 团队模式会把一个 run 拆成多条气泡,按气泡计会各自从零起算。
 * 仅内存:重载后只有重新挂上的在飞 run 有统计(起点取触发它的用户消息时间)。
 */
export interface RunStats {
  runId: string
  startedAt: number
  /** 引擎 usage.total:本 run 累计 prompt+completion(与输入框上下文弹层「会话累计」同口径)。 */
  tokens: number
  thinkMs: number
  /** 本窗口从 run 开头就在看。重挂(刷新 / 他端起的 run)时 SSE 从 seq 0 瞬间回放,思考时长量不出 → 不显示思考段。 */
  thinkTracked: boolean
  /** 当前这段思考的起点(本段首个 reasoning delta);出正文 / 工具 / 本次调用结束 / run 终结即结算进 thinkMs。 */
  thinkSince?: number
  finishedAt?: number
}

// 模型「开口」或本次调用结束 = 这段思考结束。status(llm_call 等)不算:那是下一次调用的前奏。
const THINK_ENDS = new Set(['token', 'tool_stream', 'tool_call', 'usage', 'turn_boundary', 'done', 'error'])

const closeThink = (rs: RunStats, now: number): RunStats =>
  rs.thinkSince == null ? rs : { ...rs, thinkMs: rs.thinkMs + Math.max(0, now - rs.thinkSince), thinkSince: undefined }

/** 按一条 run 事件推进统计。无变化原样返回(调用方据此跳过 set:reasoning/token delta 是高频事件)。 */
export function stepRunStats(rs: RunStats, ev: { type: string; payload?: any }, now: number): RunStats {
  if (ev.type === 'reasoning') return rs.thinkSince == null ? { ...rs, thinkSince: now } : rs
  let next = THINK_ENDS.has(ev.type) ? closeThink(rs, now) : rs
  // 带 phase 的是后台调用(压缩/子代理/脑暴)的用量,不带 run 累计 total。
  const total = ev.type === 'usage' && !ev.payload?.phase ? Number(ev.payload?.total) : 0
  if (total > 0 && total !== next.tokens) next = { ...next, tokens: total }
  return next
}

export const finishRunStats = (rs: RunStats, now: number): RunStats =>
  rs.finishedAt != null ? rs : { ...closeThink(rs, now), finishedAt: now }

// 远端(云端引擎)时间戳与本机时钟可能有几秒偏差,判「这条气泡属于这个 run」时放宽。
const CLOCK_SLACK_MS = 5000

/** 这条气泡是不是该 run 期间产生的 —— 统计行只挂在本 run 的气泡上:回退 / 重新生成删掉了本 run 的消息、
 *  轮询并进他端 run 的回复、团队成员占位全被隐藏时,「最后一条助手气泡」都不是它,不能张冠李戴。 */
export const inRunWindow = (rs: RunStats, timestamp: number): boolean =>
  timestamp >= rs.startedAt && (rs.finishedAt == null || timestamp <= rs.finishedAt + CLOCK_SLACK_MS)
