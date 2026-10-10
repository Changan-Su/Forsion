/**
 * 输入建议:一轮结束后,在空输入框里用灰字给出「你下一句最可能发的话」,Tab 采用。默认关(设置 → 外观)。
 * 渲染层这半 = 开关 + 按会话存那一句 + 收到 done 后向引擎拉一次
 * (`POST /agent/sessions/:id/suggest`,tangu-agent services/promptSuggestion.ts:复用主循环的前缀缓存,一轮最多一次)。
 *
 * 「没有建议」是常态:开关关着 / 触屏(没有 Tab)/ 老引擎或云端没有这条路由 / 模型说猜不准 / 请求失败,
 * 一律就是没有,不提示、不重试。
 */
import { create } from 'zustand'
import { engineFetch, targetForSession } from '../../services/engine/targets'
import { currentClientId } from '../../services/agentRunService'
import { useComposerDrafts } from './composerDrafts'

export const PROMPT_SUGGEST_KEY = 'forsion_tangu_prompt_suggest'

/** 开关的唯一读法:没存过 = 关。每次现读 localStorage —— 设置页可能开在另一扇窗里。 */
export function isPromptSuggestOn(): boolean {
  try { return localStorage.getItem(PROMPT_SUGGEST_KEY) === '1' } catch { return false }
}

/** 唯一写口。关是缺省,存成「没存」。 */
export function setPromptSuggest(on: boolean): void {
  try {
    if (on) localStorage.setItem(PROMPT_SUGGEST_KEY, '1')
    else localStorage.removeItem(PROMPT_SUGGEST_KEY)
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
  window.addEventListener?.('storage', (e) => { if (e.key === PROMPT_SUGGEST_KEY && e.newValue !== '1') clearAll() })
}

/** 没有 Tab 键的设备上不拉(拉了也没法采用,白花一次请求)。 */
const touchOnly = (): boolean => !!window.tangu?.mobile || !!window.matchMedia?.('(hover: none)').matches

export const usePromptSuggest = create<{ bySession: Record<string, string> }>(() => ({ bySession: {} }))

const inflight = new Map<string, AbortController>()

/** 这个会话的建议作废:新一轮开始 / 用户动手打字 / 已采用 / 一轮结束(新的那句马上来)。在飞的请求一并掐掉。 */
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
  if (!isPromptSuggestOn() || touchOnly()) return
  if (useComposerDrafts.getState()[sessionId]?.text) return // 已经在打字了:灰字只在空输入框里出现,拉了也看不到
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
    // 期间被作废过(新一轮起跑、用户已经在打字、开关被关掉)→ 这句不要了
    if (!text || inflight.get(sessionId) !== ac || !isPromptSuggestOn() || useComposerDrafts.getState()[sessionId]?.text) return
    usePromptSuggest.setState((s) => ({ bySession: { ...s.bySession, [sessionId]: text } }))
  } catch { /* 没有建议 */ } finally {
    if (inflight.get(sessionId) === ac) inflight.delete(sessionId)
  }
}
