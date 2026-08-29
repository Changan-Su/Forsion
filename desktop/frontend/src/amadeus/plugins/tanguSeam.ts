/**
 * 插件 ctx 的 Tangu 只读探针(叶子模块,2026-08-29+)。
 *
 * 为什么是探针而不是直接 import appStore:`pluginStore → appStore → SettingsModal → pluginStore`
 * 是一个真实的 import 环(appStore 顶部就 import 了 amadeus 的 pageStore)。做法同
 * `editorExtensions.ts` —— 叶子模块只存实现,由 `bootstrapEngine` 在装配时注入。
 *
 * 没注入(纯 Amadeus 壳 / unit 设备页 / 云端)→ `readTangu()` 恒 null,`ctx.tangu` 整个不注入,
 * 插件据此判断「这不是 Tangu 宿主」。这是**能力探测**,不是权限闸(模型名不敏感,不走 manifest
 * `capabilities` 白名单那道双闸)。
 */

export interface TanguModelInfo {
  /** 模型 id(引擎侧标识,如 `claude-opus-5`)。 */
  id: string
  /** 展示名(模型目录里查到的;查不到时回落成 id —— 目录还没拉回来时也不至于给空串)。 */
  name: string
}

/** 主区聊天此刻的**用量与档位**快照(2026-08-29+)。全部是「读一次拿走」的口径。 */
export interface TanguSessionInfo {
  /** 模型的上下文窗口(tokens);引擎报的真实预算优先于目录值。**未知给 0**,别当 128k 兜底用。 */
  contextWindow: number
  /** 当前上下文占用(最近一次 run 的 prompt tokens);没跑过给 0。 */
  contextTokens: number
  /** 本会话累计 tokens(历史 + 本次流式)。空态会话 = 0。 */
  sessionTokens: number
  /** 生效的思考档(`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`);不知道给 null。
   *  引擎报过 `thinkingEffective`(被能力表 clamp 后的真实档)就用它,否则用会话配置里的请求档。 */
  effort: string | null
}

export interface TanguProbe {
  /** 主区聊天此刻**实际会用**的模型;一个都没有 → null。 */
  activeModel(): TanguModelInfo | null
  /** 当前模型目录里的全部对话模型(只含 llm,不混入生图 / 语音模型)。 */
  models(): TanguModelInfo[]
  /** 当前 Space id(`tangu` / `__home__` / 用户 Space …);无 Space 时 null。 */
  activeSpace(): string | null
  /** 用量/档位快照。**纯拉取,永远不进 `subscribe` 的变更键** —— 这些值在流式回答里每个
   *  SSE 增量都在动,放进订阅等于把浮层插件按帧敲一遍(那正是变更过滤器存在的理由)。
   *  插件要"实时"就自己定时拉。
   *  可选:台架的假探针可以整条不给,插件那边表现得与旧宿主一致(`session` 返回 null)。 */
  session?(): TanguSessionInfo
  /** 仅在 (模型 id, Space id) 这对值**真的变了**时回调。返回退订。 */
  subscribe(cb: () => void): () => void
}

let probe: TanguProbe | null = null

/** 由 `installEngine()` 注入(desktop / web / mobile 三端共用那一处装配 → 天然对齐)。
 *  必须早于 `installAmadeusPlugins()`:`ctx.tangu` 的有无是在建 context 那一刻定的。 */
export function setTanguProbe(p: TanguProbe | null): void {
  probe = p
}

export function readTangu(): TanguProbe | null {
  return probe
}
