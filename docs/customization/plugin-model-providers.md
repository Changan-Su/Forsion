---
title: 插件模型来源
description: 将单次推理接入 Tangu 原生模型边界，历史、工具执行和审批继续由宿主负责。
---
# 插件模型来源

本地引擎插件可以通过 `ctx.registerModelProvider(provider)` 注册模型来源。模型进入原生目录，普通 Tangu 会话与插件任务都能选用。这是单次推理接口：会话历史、Agent 循环、工具执行、审批和用量记录由 Tangu 负责。来源不能另起 Agent 循环，也不能自行执行返回的工具调用。

先检测 `typeof ctx.registerModelProvider === 'function'`。注册要求本地引擎；它不是云端模型提供方的注册入口。类型正典为 `tangu-agent/plugin-api/tangu-agent.d.ts`。

宿主必须先装配原生运行时，再激活插件。在 `tangu-agent` 运行 `npm run test:plugin-model-boot`，会构建并在隔离 home 内验证真实 standalone 冷启动、模型目录及停用/重启用生命周期。

```ts
ctx.registerModelProvider({
  id: 'source',
  listModels: async ({ signal }) => readEnabledModels(signal),
  resolveModel: async (modelId, { signal }) => readEnabledModel(modelId, signal),
  stream: async input => inferOnce(input),
})
```

来源 `id` 是 1–64 字符的 kebab-case 局部标识。所属引擎插件身份由宿主提供，包含商店安装身份。完整模型 ID 为 `plugin:<engineId>/<providerId>/<encodeURIComponent(model.id)>`。来源局部模型 ID 可含 `/`，必须为 1–240 字符且不能含控制字符。来源不能覆盖内置模型或其他插件的命名空间；同一次激活重复注册会抛错。

| 成员 | 契约 |
| --- | --- |
| `listModels({signal})` | 现读来源已启用模型，最多返回 512 条 `PluginModel`。列表失败或格式不合法时从目录省略该来源，不把空结果写回来源。 |
| `resolveModel(modelId,{signal})` | 现读来源局部 ID，返回匹配的元数据；不可用时返回 `null`。缺失或已撤销的插件模型明确失败，不回落为云模型。 |
| `stream(input)` | 接收宿主整理好的消息与工具定义，完成一次推理，返回 `PluginModelResult`。凭据留在来源闭包或服务中，不暴露给渲染层或原生模型目录。 |

`PluginModel` 包含 `id`、`name`，可选正整数 `contextWindow`、可选 `supportsVision`（缺省 `false`）和可选非空 `thinkingLevels`（`off/minimal/low/medium/high/xhigh/max`）。宿主沿用上下文窗口政策，并按声明的思考档夹紧请求。未知能力不填，不臆测。

`PluginModelRequest` 提供来源局部 `modelId`、`messages`，可选的 `tools`、`toolChoice`、`temperature`、`maxTokens`、`thinkingLevel`、`cacheKey`，以及 `AbortSignal`。消息使用原生 OpenAI 风格的角色与工具调用字段；图片已在消息内容中。流式回调为 `onResponseStart()`、`onToken(delta)`、`onReasoning(delta)` 和 `onToolCallDelta({id,name,argsLen,args,argsDelta})`。`args` 是累计 JSON 参数文本，`argsDelta` 是新片段，`argsLen` 是累计字符数。

原生 run 内还会提供冻结的只读 `input.context = {sessionId,userId,cwd}`，仅供本地适配器隔离状态；`cwd` 可为 `null`。身份来自宿主已经读取的 run 行，不增加数据库查询，也不从 `cacheKey`、请求字段或项目目录推断。外部有状态上下文必须同时绑定用户和会话：同一目录内的两个会话也要分开。这个对象在推理 payload 之外传入，**禁止转发给上游模型**。没有绑定原生会话的调用不提供该对象，不能猜会话或 home 目录。远程起跑、被远程 steer 染色的 run 和远程 HTTP 推理调用都不能使用本地来源；推理中染色会终止请求。排队的原生 run 使用自己的来源，不能继承上一个 HTTP 请求的来源。

结果必须为 `{content, reasoning, toolCalls, usage, finishReason?}`。工具调用格式为 `{id,type:'function',function:{name,arguments}}`，参数为 JSON 文本。`usage` 必须提供非负整数 `prompt_tokens` 与 `completion_tokens`，可选计数为 `cached_tokens`、`cache_write_tokens`、`reasoning_tokens`。映射真实遥测：缺用量是错误，不能伪造零。两份文本和工具调用数组即使为空也必须返回；除了流式回调，还要返回最终聚合结果。FIM、生图和厂商私有输出块不在本接口范围内。

模型列表/解析调用的 signal 带五秒截止时间；推理 signal 合并调用方取消与插件激活撤销，必须传递给每次上游请求。停用、卸载、激活失败或替换插件都会移除注册并终止活动操作。旧实例的迟到回调、结果和 payload 无效；旧注销函数不能移除新实例。即使来源忽略取消，宿主也能停止等待，但来源仍必须停止自己的网络和计算任务。

插件推理注册在原生出站脱敏层**内侧**：来源收到的消息内容已经过脱敏，返回文本/工具参数中的占位符由宿主恢复。不要在 Agent 工具里另发一次模型请求绕过此边界。无项目面板应遵循[任务 SDK 上下文契约](plugin-tasks.md)，让用户选择项目。
