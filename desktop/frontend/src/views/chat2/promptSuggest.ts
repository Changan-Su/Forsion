/**
 * 输入建议:一轮结束后,在空输入框里用灰字给出「你下一句最可能发的话」,Tab 采用。缺省开(2026-10-14 用户定;设置 → 高级 → 界面与会话)。
 * 渲染层这半 = 开关 + 按会话存那一句 + 收到 done 后向引擎拉一次
 * (`POST /agent/sessions/:id/suggest`,tangu-agent services/promptSuggestion.ts:复用主循环的前缀缓存,一轮最多一次)。
 *
 * 那一句和平常的占位文字一样常驻:从拿到起一直留到这个会话的下一轮开始,输入框空着就显示。
 * 打字、Tab 采用、切到别的会话 / 视图都不丢它 —— 把字删空、切回来,它还在(2026-10-13 用户定)。
 *
 * 「没有建议」是常态:开关关着 / 不是桌面宿主(网页版、手机、设备页:没有本机引擎的快照,也没摆开关)/ 触屏(没有 Tab)/
 * 老引擎没有这条路由 / 模型说猜不准 / 请求失败,
 * 一律就是没有,不提示、不重试。
 */
import { create } from 'zustand'
import { engineFetch, targetForSession } from '../../services/engine/targets'
import { currentClientId } from '../../services/agentRunService'

export const PROMPT_SUGGEST_KEY = 'forsion_tangu_prompt_suggest'

/** 只有桌面宿主算数:开关只摆在那儿,快照也只存在本机引擎里。网页版 / 手机 / 设备页缺省开也不去拉(拉了只是白打一次)。
 *  设备页(本机投射)的 shim 也给 backendStatus,得单独排除;没有 window 的(Node 里跑的 store 测试)一律不算。 */
const supported = (): boolean =>
  typeof window !== 'undefined' && !!window.tangu?.backendStatus && !window.tangu?.unitPage && !window.tangu?.mobile
  && !window.matchMedia?.('(hover: none)').matches

/** 开关的唯一读法:没存过 = 开;关掉存成 '0'(10-14 之前开着存的 '1' 照样算开)。
 *  每次现读 localStorage —— 设置页可能开在另一扇窗里。 */
export function isPromptSuggestOn(): boolean {
  if (!supported()) return false
  try { return localStorage.getItem(PROMPT_SUGGEST_KEY) !== '0' } catch { return true }
}

/** 唯一写口。开是缺省,存成「没存」。 */
export function setPromptSuggest(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PROMPT_SUGGEST_KEY)
    else localStorage.setItem(PROMPT_SUGGEST_KEY, '0')
  } catch { /* 隐私模式 / 配额:偏好丢了也不该影响对话 */ }
  if (!on) clearAll()
}

function clearAll(): void {
  for (const ac of inflight.values()) ac.abort()
  inflight.clear()
  usePromptSuggest.setState({ bySession: {} })
}

// 设置开在另一扇窗(另一个渲染进程)里:那边关掉开关,这边已经显示着的灰字也跟着撤掉。
if (typeof window !== 'undefined') {
  window.addEventListener?.('storage', (e) => { if (e.key === PROMPT_SUGGEST_KEY && e.newValue === '0') clearAll() })
}

export const usePromptSuggest = create<{ bySession: Record<string, string> }>(() => ({ bySession: {} }))

const inflight = new Map<string, AbortController>()

/** 这个会话的建议作废:新一轮开始 / 这一轮出错 / 一轮结束(新的那句马上来)。在飞的请求一并掐掉。 */
export function clearSuggestion(sessionId: string): void {
  inflight.get(sessionId)?.abort()
  inflight.delete(sessionId)
  if (sessionId in usePromptSuggest.getState().bySession) {
    usePromptSuggest.setState((s) => {
      const { [sessionId]: _gone, ...rest } = s.bySession
      return { bySession: rest }
    })
  }
}

/** run 收尾(done)后调:开关开着才真的发请求。 */
export async function requestSuggestion(sessionId: string, runId: string): Promise<void> {
  clearSuggestion(sessionId)
  if (!isPromptSuggestOn()) return
  const ac = new AbortController()
  inflight.set(sessionId, ac)
  try {
    const r = await engineFetch(targetForSession(sessionId), `/agent/sessions/${encodeURIComponent(sessionId)}/suggest`, {
      method: 'POST',
      signal: ac.signal,
      body: JSON.stringify({ run_id: runId, client: currentClientId() }),
    }, { timeoutMs: 25_000 })
    if (!r.ok) return // 老引擎 / 假引擎没有这条路由(404)= 没有建议
    const j = await r.json().catch(() => null) as { suggestion?: unknown } | null
    const text = typeof j?.suggestion === 'string' ? j.suggestion.trim() : ''
    // 期间被作废过(新一轮起跑、开关被关掉)→ 这句不要了。输入框里有没有字不管:有字时藏着,删空就显示。
    if (!text || inflight.get(sessionId) !== ac || !isPromptSuggestOn()) return
    usePromptSuggest.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: text } }))
  } catch { /* 没有建议 */ } finally {
    if (inflight.get(sessionId) === ac) inflight.delete(sessionId)
  }
}
