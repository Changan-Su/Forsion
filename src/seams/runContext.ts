/**
 * 每个 run 的执行上下文(当前用户)—— 多租户部署的接缝。
 *
 * 背景:run loop 与 HTTP 连接解耦、后台异步跑,只从 DB 拿到 run.user_id;而 LLM 接缝
 * (resolveModelAndKey/buildProviderPayload/streamProviderCompletion)签名里没有 userId。
 * 分离式云 worker 一个进程服务多用户,brain-api 调用必须按**当前 run 的用户**鉴权/计费。
 *
 * 用 AsyncLocalStorage 在 runLoop 顶部把 userId 注入本 run 的整个异步子树;brain 适配器
 * (如 worker 的 httpBrain token 函数)用 currentRunUserId() 取它来铸 per-user token。
 *
 * 对 microserver/standalone **无害**:它们的 brain 不读此上下文(固定身份),enterRunContext 只是
 * 设了个没人看的值。core loop 逻辑不变——这是上下文传播的基础设施,不是循环逻辑。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<{ userId: string }>();

/** 在当前 run 的异步子树建立用户上下文(runLoop 顶部调用一次)。 */
export function enterRunContext(userId: string): void {
  als.enterWith({ userId });
}

/** 当前 run 的 userId(不在 run 上下文内时 undefined)。 */
export function currentRunUserId(): string | undefined {
  return als.getStore()?.userId;
}
