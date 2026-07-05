/**
 * 每个 run 的执行上下文(当前用户 + runId)—— 多租户 / thin-worker 的接缝。
 *
 * 背景:run loop 与 HTTP 连接解耦、后台异步跑,只从 DB/状态拿到 run.user_id;而 LLM 接缝
 * (resolveModelAndKey/buildProviderPayload/streamProviderCompletion)签名里没有 userId。
 * 分离式云 worker 一个进程服务多用户,brain-api 调用必须按**当前 run 的用户**鉴权/计费;
 * thin worker 还要按 **当前 runId** 取该 run 的 per-dispatch token(见 HttpStateStore / httpBrain)。
 *
 * 用 AsyncLocalStorage 在 runLoop 顶部把 {userId, runId} 注入本 run 的整个异步子树。
 * 对 microserver/standalone **无害**:它们的 brain/state 不读此上下文(固定身份、本地库)。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RunCtx {
  userId: string;
  runId?: string;
  /** 本 run 激活的 Normal Agent slug —— 记忆/日志据此落到 ~/.tangu/agents/<slug>/(缺省 = 默认 agent)。
   *  注意这是「记忆作用域」slug:shareDefaultMemory 的 agent 会是 DEFAULT,不能直接拿来当展示身份。 */
  agentSlug?: string;
  /** 本 run 实际激活的 agent slug(展示身份用,不受 shareDefaultMemory 折叠成 DEFAULT 影响)。 */
  displayAgentSlug?: string;
}

const als = new AsyncLocalStorage<RunCtx>();

/**
 * 在当前 run 的异步子树建立上下文(runLoop 顶部调用一次;slug 解析出来后可再调一次覆盖)。
 * 用 enterWith 而非 run:改写当前同步帧之后整个异步子树的 store,故 system prompt 的 getMemory
 * 与每个 executeTool 都能读到 agentSlug。
 */
export function enterRunContext(userId: string, runId?: string, agentSlug?: string, displayAgentSlug?: string): void {
  als.enterWith({ userId, runId, agentSlug, displayAgentSlug: displayAgentSlug ?? agentSlug });
}

/** 当前 run 的 userId(不在 run 上下文内时 undefined)。 */
export function currentRunUserId(): string | undefined {
  return als.getStore()?.userId;
}

/** 当前 run 的 runId(thin worker 据此取该 run 的 per-dispatch token)。 */
export function currentRunId(): string | undefined {
  return als.getStore()?.runId;
}

/** 当前 run 激活的 agent slug(本地记忆层据此选 agent 文件夹;不在 run 上下文内时 undefined)。 */
export function currentAgentSlug(): string | undefined {
  return als.getStore()?.agentSlug;
}

/** 当前 run 的展示身份 slug(写进消息 agent_slug,供客户端还原头像/昵称;缺省回退记忆作用域 slug)。 */
export function currentDisplayAgentSlug(): string | undefined {
  const s = als.getStore();
  return s?.displayAgentSlug ?? s?.agentSlug;
}

/**
 * 在子作用域内临时把 agentSlug 改成另一个(子代理:让被委派的具名 agent 的 remember/log_event
 * 落到它自己的文件夹),fn 结束后**自动恢复**父作用域。用 als.run(非 enterWith)故不污染父 run。
 */
export function runWithAgentSlug<T>(agentSlug: string, fn: () => Promise<T>): Promise<T> {
  const cur = als.getStore();
  return als.run({ userId: cur?.userId || '', runId: cur?.runId, agentSlug }, fn);
}
