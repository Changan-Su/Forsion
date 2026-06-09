/** standalone /agent 契约的最小前端类型(与 server eventBus / runs 路由一致)。 */
export interface TanguDesktopConfig {
  backendUrl: string
  token: string
  modelId: string
}

export interface StartRunResult {
  runId: string
  assistantMessageId: string
  userMessageId: string
}

/** SSE 事件:{ seq, type, payload }。type ∈ token/reasoning/tool_call/tool_result/status/done/error。 */
export interface AgentRunEvent {
  seq: number
  type: string
  payload?: any
}

/** preload 注入的 window.tangu。 */
declare global {
  interface Window {
    tangu?: {
      getConfig(): Promise<TanguDesktopConfig>
      setConfig(patch: Partial<TanguDesktopConfig>): Promise<TanguDesktopConfig>
    }
  }
}
