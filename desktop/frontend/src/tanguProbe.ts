/**
 * `ctx.tangu` 探针的实现(2026-08-29+)。契约与「为什么要探针」见
 * `amadeus/plugins/tanguSeam.ts` —— 那边是叶子,这边才碰 store。
 *
 * 由 `installEngine()` 调用,**必须早于 `installAmadeusPlugins()`**:`ctx.tangu` 的有无是在
 * 建 plugin context 那一刻定的。三端共用 installEngine,移动端自动跟上(check:parity)。
 */
import { useSpaceStore } from '@lcl/engine'
import { setTanguProbe, type TanguModelInfo, type TanguSessionInfo } from '@amadeus/plugins/tanguSeam'
import { activeChatModelId, stickyDefaults, useApp } from './stores/appStore'

function readActiveModel(): TanguModelInfo | null {
  const s = useApp.getState()
  // activeSession 的取法与 ChatView 的选择器一致(归档会话也算活动会话)。
  const activeSession =
    s.sessions.find((x) => x.id === s.activeId) ?? s.archivedSessions.find((x) => x.id === s.activeId) ?? null
  const id = activeChatModelId({ ...s, activeSession })
  if (!id) return null
  // 目录还没拉回来(冷启动/离线)时回落成 id,别给空串 —— 插件多半直接拿去当标题画。
  return { id, name: s.modelsResp?.models.find((m) => m.id === id)?.name || id }
}

/** 给插件设置页用的模型目录。和聊天模型选择器同口径:缺 modelType 的旧目录项也算 llm。 */
function readModels(): TanguModelInfo[] {
  return (useApp.getState().modelsResp?.models ?? [])
    .filter((m) => !m.modelType || m.modelType === 'llm')
    .map((m) => ({ id: m.id, name: m.name || m.id }))
}

const readActiveSpace = (): string | null => useSpaceStore.getState().activeSpaceId || null

/** 用量/档位快照。三条口径与 ChatView 传给输入框的那套**同源**,别就地另写:
 *  ① ctxInfo 必须过「模型没变」这道闸 —— 切模型后 SSE 重放会复活旧 run 的事件,不过闸会同时
 *     报错窗口**和**报错思考档(两个值都出自这一条事件);
 *  ② 窗口未知给 0(引擎的 128k 兜底是它自己的事,这里不替它猜);
 *  ③ 空态(还没建会话)也要给得出来:用量 0 + 新对话的起步档。 */
function readSession(): TanguSessionInfo {
  const s = useApp.getState()
  const modelId = readActiveModel()?.id ?? ''
  const raw = s.activeId ? s.ctxInfoBySession[s.activeId] : null
  const ci = raw && (!raw.modelId || !modelId || raw.modelId === modelId) ? raw : null
  const usage = (s.activeId && s.usageBySession[s.activeId]) || null
  const cfgLevel = s.activeId
    ? s.configBySession[s.activeId]?.thinkingLevel
    : s.newChatCfg.thinkingLevel || stickyDefaults(s.desktopConfig, true).thinkingLevel
  // 思考档还要过**第二道闸**(与 Composer2 药丸同口径):`setSessionThinking` 不作废 ctxInfo,
  // 所以「改完档、还没发下一条消息」的窗口里,ci.thinkingEffective 仍是**上一次 run** 的档 ——
  // 拿它显示等于当着用户的面否认他刚改的设置(药丸显示 max、面板显示 medium)。
  // ⚠️只作废 effort,别把整条 ci 作废:换思考档不影响上下文窗口。
  const runEffort = ci && ci.thinkingRequested === (cfgLevel || 'medium') ? ci.thinkingEffective : undefined
  return {
    contextWindow: ci?.ctxWindow || s.modelsResp?.models.find((m) => m.id === modelId)?.contextWindow || 0,
    contextTokens: usage?.ctx || 0,
    sessionTokens: (usage?.base || 0) + (usage?.live || 0),
    // thinkingLevel 的类型里含空串(「不指定」),别原样吐给插件 —— 它会当成一个档位名去查表。
    effort: runEffort || cfgLevel || null,
  }
}

export function installTanguProbe(): void {
  setTanguProbe({
    activeModel: readActiveModel,
    models: readModels,
    activeSpace: readActiveSpace,
    session: readSession,
    // ⚠️只在 (模型 id, Space id) 这对值**真变了**时才回调。useApp 在流式回答期间每收一个
    // SSE 增量就 set 一次 state,裸转发 = 把每个订阅插件按帧敲一遍(浮层类插件会当场掉帧)。
    subscribe: (cb) => {
      const key = (): string => `${readActiveModel()?.id ?? ''}|${readActiveSpace() ?? ''}`
      let last = key()
      const fire = (): void => {
        const k = key()
        if (k === last) return
        last = k
        cb()
      }
      const offApp = useApp.subscribe(fire)
      const offSpace = useSpaceStore.subscribe(fire)
      return () => {
        offApp()
        offSpace()
      }
    },
  })
}
