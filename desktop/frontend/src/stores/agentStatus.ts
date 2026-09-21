/**
 * 某会话里「agent 此刻在干什么」的纯推导(2026-09-19+):`ctx.tangu.agentStatus` / Desk 伴随面的数据源。
 * 契约类型住 `amadeus/plugins/tanguSeam.ts`(叶子);订阅与变更过滤在 `tanguProbe.ts`。
 * 2026-09-20 起每条状态还带上「这会话归哪个 Agent」(agentSlug / agentName,见 agentOf)——
 * 相位与归属是两件事,故分成 phaseOf + agentOf 两半,后者只在最外层盖一次,相位逻辑一个字没动。
 *
 * 只读 store 已有的字段,不新增任何写入(热路径上一个 set 都不加):
 *  - 在跑 = runningBySession[sid];停止中 = stoppingBySession[sid] === runId → 按 idle(用户已经叫停)。
 *  - 等人(审批 / 提问)优先级最高:引擎先发 tool_call 再过审批闸,所以那一刻工具也是「未完成」——
 *    「等用户永远压过在跑」,与 taskFacts 同一口径。只在**在跑且在本 run 窗口内**找 pending,
 *    否则上一个 run 残留在团队占位气泡上的 pending 会把状态永远钉在 waiting。
 *  - done / error 的余韵只认 runStats.finishedAt(仅内存):重载后历史里 is_error 的旧气泡**不会**复活成 error。
 *
 * 已知歧义:最后一个正文增量之后、下一事件到达之前,状态停在 speaking。口型包络(textChars 增量)会自然归零。
 * 同一口径:run 还在跑、最后一条非 system 是**已落定**(done / error)且以正文收尾的助手气泡 → 仍报 speaking。
 *   为的是 done / error 收尾那两次 set 之间不冒假 thinking;代价是团队模式里成员气泡之间的空档也报 speaking。
 * 已知局限(团队):成员的工具只有 team_activity(tool_call)写 work.tool,引擎 groupChat 的 forward() 不转发
 *   tool_result → 工具跑完后该成员一直停在 tool:<上一个工具>,直到下一次工具调用或它的 team_member end。
 *   根治 = 引擎把 tool_result 也转成 team_activity(done:true),reducer 清 work.tool。
 * 本文件只许 import 类型 + runStats 的 inRunWindow + tanguSeam 的叶子工具 —— tanguProbe 引它,别在这里拉 store。
 */
import type { AppState } from './appStore'
import type { UiMessage } from '../types'
import { inRunWindow } from './runStats'
import { idleAgentStatus, type TanguAgentStatus } from '../amadeus/plugins/tanguSeam'

/** 成功结束后保持 done 的时长,之后回落 idle。 */
export const DONE_HOLD_MS = 4000
/** 失败后保持 error 的时长(比 done 长一点:失败更值得被看见)。 */
export const ERROR_HOLD_MS = 6000

export type AgentStatusSlice = Pick<
  AppState,
  'activeId' | 'messagesBySession' | 'runningBySession' | 'stoppingBySession' | 'runStatsBySession' | 'llmRetryBySession' | 'groupVoting'
  // 归属推导(2026-09-20):会话配的 agent / 用户默认 / 名册(查展示名)/ 新对话草稿配的那个。
  | 'configBySession' | 'defaultAgentSlug' | 'agentDefs' | 'newChatCfg'
>

/** 变更过滤的键:这几样变了才算「状态变了」。since / 字符数 / messageId 不进键(它们随 token 在动)。
 *  agentSlug 进键 —— 用户中途换 Agent 时订阅方(按 Agent 挑形象的插件)必须醒过来;
 *  agentName **不**进键:改个展示名不是状态变化,不值得把每个插件敲一遍(拉取式照样拿得到最新名)。 */
export const statusKey = (s: TanguAgentStatus): string =>
  `${s.phase}|${s.tool ?? ''}|${s.toolStage ?? ''}|${s.waitingFor ?? ''}|${s.sessionId ?? ''}|${s.agentSlug ?? ''}`

function lastStreamingAssistant(msgs: UiMessage[]): UiMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.status === 'streaming') return m
  }
  return undefined
}

/**
 * 「这个会话归哪个 Agent」(2026-09-20 加):给「每个 Agent 一个形象」的插件挑形象用。
 * 口径与 appStore 的 `agentStamp`(助手气泡的身份盖章)对齐 —— 同一个会话在气泡上是 A、在伴随形象上是 B
 * 才是真正会被用户当 bug 报的那种错:
 *  - **外部引擎会话(engineId)根本没有 Tangu agent** → 整条不报(别拿 agentSlug 冒充,插件据此退回通用形象);
 *  - 会话没显式选 → 用户默认 agent(会话真跑起来时 appStore 也是这么把 slug 钉进 config 的);
 *  - 草稿(sid = null)看新对话配置,与用户在「选择 Agent」条上看到的一致。
 * 与 agentStamp 有意分岔的一处:**团队会话照报会话配置的 agent,不跟当前发言的成员** —— 状态流里跟不出稳定的
 * 说话人(成员占位气泡不带 slug),跟着跳只会让插件的形象忽闪。
 * 展示名查不到(名册还没拉回来 / agent 已删)就**省略**,不回落 slug:拿 slug 当名字画出来比没有更糟。
 */
function agentOf(s: AgentStatusSlice, sid: string | null): { agentSlug?: string; agentName?: string } {
  const cfg = sid ? s.configBySession[sid] : s.newChatCfg
  if (cfg?.engineId) return {}
  const slug = cfg?.agentSlug || s.defaultAgentSlug
  if (!slug) return {}
  const name = s.agentDefs.find((a) => a.slug === slug)?.name
  return name ? { agentSlug: slug, agentName: name } : { agentSlug: slug }
}

/**
 * @param sessionId 省略(undefined)= 全局活动会话;null = 新对话草稿(恒 idle)。
 * @param now 由调用方给(纯函数:done/error 的余韵按它判,拉取式调用天然拿到正确答案)。
 */
export function agentStatusOf(s: AgentStatusSlice, sessionId: string | null | undefined, now: number): TanguAgentStatus {
  const sid = sessionId === undefined ? s.activeId : sessionId
  // 相位推导一个字没动:归属只是**给每条返回值再盖一层**。草稿那条早退也要盖(新对话的 Desk 卡片
  // 恒 idle,但它照样得知道「待会儿是谁来说话」——否则切了 Agent 卡片上还是上一个形象)。
  return { ...phaseOf(s, sid, now), ...agentOf(s, sid) }
}

function phaseOf(s: AgentStatusSlice, sid: string | null, now: number): TanguAgentStatus {
  if (!sid) return idleAgentStatus(null)
  const runId = s.runningBySession[sid] ?? null
  const rs = s.runStatsBySession[sid]
  const msgs = s.messagesBySession[sid] ?? []

  if (runId) {
    const L = lastStreamingAssistant(msgs)
    // 刚落定的气泡:done / error 的 reducer 先 patchMessage(气泡 done/error)、后 endRun(清 running)——两次 set
    // 之间 running 还在、却已没有流式气泡。不认它就掉进 ⑤ 兜底,每个 run 收尾都冒一个假 thinking。
    let settled: UiMessage | undefined
    if (!L) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'system') continue
        if (m.role === 'assistant' && (m.status === 'done' || m.status === 'error')) settled = m
        break
      }
    }
    const base = {
      sessionId: sid,
      runId,
      messageId: L?.id,
      textChars: L?.content.length ?? 0,
      reasoningChars: L?.reasoning?.length ?? 0,
    }
    if (s.stoppingBySession[sid] === runId) return { ...base, phase: 'idle', since: now }

    // ① waiting:只在本 run 的窗口里往回找(消息按时间有序,出窗即停)。
    if (rs?.runId === runId) {
      for (let i = msgs.length - 1; i >= 0 && inRunWindow(rs, msgs[i].timestamp); i--) {
        const m = msgs[i]
        const a = m.approvals?.find((x) => x.status === 'pending')
        if (a) return { ...base, phase: 'waiting', waitingFor: 'approval', tool: a.name, since: now }
        const q = m.inquiries?.find((x) => x.status === 'pending')
        if (q) return { ...base, phase: 'waiting', waitingFor: 'inquiry', tool: q.kind === 'plan' ? 'exit_plan_mode' : 'ask_user', since: now }
        // 团队成员在等(审批 / 询问落在成员占位气泡上;work.waiting 是兜底信号,分不清是哪一种)
        if (m.status === 'streaming' && m.work?.waiting) return { ...base, phase: 'waiting', since: now }
      }
    }

    // ② tool:当前气泡最后一个未完成的工具;没有 startedAt = 模型还在写参数。
    const evs = L?.toolEvents
    if (evs) {
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i]
        if (!ev.done) {
          return { ...base, phase: 'tool', tool: ev.name, toolStage: ev.startedAt == null ? 'args' : 'exec', since: ev.startedAt ?? now }
        }
      }
    }
    // 团队成员的工具不进 toolEvents,只有 team_activity 写的 work.tool。work.activity 是展示文案(start 时是任务句子),
    // 不许从它猜工具名 —— 只有任务的占位气泡落到 ③/⑤ = thinking。
    if (L?.work?.tool) return { ...base, phase: 'tool', tool: L.work.tool, toolStage: 'exec', since: now }

    // ③ thinking(确切信号):推理流中 / 等本次模型调用的首帧 / LLM 重试 / 群聊投票。
    if (rs?.runId === runId && rs.thinkSince != null) return { ...base, phase: 'thinking', since: rs.thinkSince }
    if (L?.live) return { ...base, phase: 'thinking', since: L.live.since }
    if (s.llmRetryBySession[sid] || s.groupVoting[sid]) return { ...base, phase: 'thinking', since: now }

    // ④ speaking:顺序段末尾是正文;没有 segments 的老形状退回看 content。
    const segs = L?.segments
    if (L && (segs?.length ? segs[segs.length - 1].t === 'text' : L.content.length > 0)) {
      return { ...base, phase: 'speaking', since: now }
    }
    // 刚落定的气泡按同一判据续着 speaking(键不变 → 不回调),等 endRun 那次 set 直接进 done / error。
    // 以工具收尾的照旧落 ⑤(之前也是 thinking,同样不回调)。
    const ss = settled?.segments
    if (settled && (ss?.length ? ss[ss.length - 1].t === 'text' : settled.content.length > 0)) {
      return {
        ...base, messageId: settled.id, textChars: settled.content.length, reasoningChars: settled.reasoning?.length ?? 0,
        phase: 'speaking', since: now,
      }
    }

    // ⑤ 兜底 thinking:工具结果回来等下一轮 llm_call、run 刚起还没任何输出。
    return { ...base, phase: 'thinking', since: rs?.runId === runId ? rs.startedAt : now }
  }

  // 没在跑:done / error 余韵。最后一条非 system 消息必须是助手、且属于刚结束的那个 run。
  let last: UiMessage | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'system') continue
    last = msgs[i]
    break
  }
  const fin = rs?.finishedAt
  const idle = (): TanguAgentStatus => ({
    ...idleAgentStatus(sid),
    since: fin != null ? fin + (last?.status === 'error' ? ERROR_HOLD_MS : last?.status === 'done' ? DONE_HOLD_MS : 0) : 0,
  })
  if (!rs || fin == null || last?.role !== 'assistant' || !inRunWindow(rs, last.timestamp)) return idle()
  if (last.status === 'error' && now - fin < ERROR_HOLD_MS) {
    return { ...idleAgentStatus(sid), phase: 'error', runId: rs.runId, since: fin, until: fin + ERROR_HOLD_MS }
  }
  if (last.status === 'done' && now - fin < DONE_HOLD_MS) {
    return { ...idleAgentStatus(sid), phase: 'done', runId: rs.runId, since: fin, until: fin + DONE_HOLD_MS }
  }
  return idle()
}
