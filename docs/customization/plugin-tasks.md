---
title: 本地插件任务 SDK
description: 插件在桌面本地创建隐藏任务会话、Git 工作区与定时自动化的接口契约。
---
# 本地插件任务 SDK

这些接口用于桌面本地执行；需要包含本次 SDK 的宿主构建，已发布 2.12.2 不包含它们。插件必须按能力检测，不能只比较版本号。类型正典是 `tangu-agent/plugin-api/tangu-agent.d.ts`。

| API | 契约 |
| --- | --- |
| `ctx.tangu.request(engineId,path,options)` | 渲染端通过宿主调用同捆绑包内的引擎插件 JSON 路由。宿主认证、限制路由、停用时取消请求；不返回凭据。路由前缀由宿主按包的安装目录名拼;桌面 2.13.3 及更早按 manifest `id` 拼,安装目录名和 `id` 不一样的包在那些版本上每次调用都是 404。 |
| `ctx.tangu.openSession(id)` | 加载隐藏任务会话的真实模型/配置，再打开原生聊天；不自动开跑。 |
| `ctx.registerScopedRoutes(register)` | 路由挂到 `/extensions/<包的安装目录名>/<engineId>`(目录名以磁盘上的为准,不听包自己声明的 id)，校验本地来源、登录用户，停用时撤销。所有者用 `req.user.userId`，不要信请求体里传来的 owner。 |
| `ctx.paths.dataDir` | 宿主分配的稳定插件数据目录，与安装的代码分开。 |
| `sdk.runs.context(sessionId,userId)` | 读取该用户已有会话保存的 `sessionId/cwd/modelId/thinkingLevel/approvalMode`，缺项为 `null`。只读元数据，不读取聊天正文；会话不存在、属于其他用户或参数为空时抛错。停用、非本地引擎和远程发起的运行均拒绝。 |
| `sdk.runs.start(options)` | 创建插件拥有的隐藏 `kind=task` 会话。先保存意图，再使用固定 `requestId` 提交；结果未知时用同一 ID 重试。原生审批和提问照常生效。 |
| `runs.status/sessionRuns/events/subscribe/stop` | 都校验插件和用户所有权；`sessionRuns` 包含原生续聊，订阅在停用时清理；事件有条数上限。 |
| `runs.usage(sessionId,userId)` | token 合计与未报告运行数；外部缺少遥测时不能当作零。 |
| `runs.followupParent(options)` | 仅从子任务关联的、工具受限的总管会话续跑；固定请求 ID 防重复，仍走原生审批。 |
| `sdk.engines.list()` | 列出本机外部引擎与可用性，不证明 CLI 已登录。 |

`runs.start` 支持 `readOnly`、`toolNames` 和外部 `resumeSessionId`。工具列表只能包含所属插件的工具和显式 `ask_user`。原生只读任务使用精确的读取工具白名单，原生续聊不能自行解除。外部只读模式只接受明确适配的 Claude Code/Codex ACP 身份和能力；未知适配器拒绝。Claude 禁用内置工具与用户工具配置，受限 MCP 仍经宿主逐项审批（包括批准时修改过的参数）；Codex 使用原生 read-only 沙箱。恢复外部会话必须匹配引擎和工作目录，并要求适配器支持 session/load。

## 沿用当前会话的项目与模型

渲染端从 `ctx.tangu?.agentStatus?.()?.sessionId` 取得活动会话 ID，经 `ctx.tangu.request` 交给本包引擎路由。路由必须把宿主认证的 `req.user.userId` 传给 `ctx.sdk.runs.context`，不能接受请求体里的用户 ID：

```js
// Inside a handler registered with ctx.registerScopedRoutes:
const context = await ctx.sdk.runs.context(req.body.sessionId, req.user.userId)
res.json(context)
```

旧宿主先检测 `typeof ctx.sdk.runs?.context === 'function'`。新对话草稿没有会话 ID，或返回的 `cwd` 为 `null`，应让用户选择项目，不可猜测 home 或默认工作目录。结果是保存的会话快照，不含未保存的输入栏草稿；没有值时不自动补模型、思考档或审批档，未知非空审批档按宿主规则收紧到 `readonly`。读取普通会话元数据不授予插件执行或读取该会话正文的权限；新任务仍经 `runs.start` 创建独立会话，不可把来源 ID 当成插件任务的 `sessionId`。`approvalMode` 仅供展示，不会给新任务授权；执行沿用 `runs.start` 自身的项目审批设置与原生审批。

如果要让外部来源提供推理并保留原生循环，请注册[插件模型来源](plugin-model-providers.md)，再在 `runs.start` 选择它的完整模型 ID。

## 工作区与自动化

`sdk.workspaces.prepare` 创建插件拥有的 Git worktree；`inspect(id,userId)` 返回 diff 和 revision；`merge(id,userId,revision)` 仅合并用户检查过的内容，要求干净且未变化的目标，冲突留在任务 worktree 里；`archive(id,userId)` 移动工作区并保留忽略/未跟踪文件，移动中断后可以恢复。合并和归档在源目录与目标目录取得原生任务维护锁，无法取得就拒绝。本机多个引擎进程之间不构成分布式锁。

```js
sdk.workspaces.prepare({id,userId,cwd,baseRef?,trust?})
```

`sdk.automation.save(key,input)` 只允许本地 UI 授权，使用原生触发器存储和调度历史，只能调用本插件声明 `automationSafe` 的工具；ID 固定为 `plugin:<owner>:<key>`。`remove(key)` 允许撤销本插件的触发器，包括已批准的 Stop 工具。`notify(userId,title,body)` 写入 Inbox，不转发到外部消息通道。插件负责校验触发来源、授权 nonce、错过时段与重叠运行。

## Desktop MCP

Desktop MCP 的 `plugin_tools` / `plugin_call` 只枚举和执行最终解析结果中由启用插件提供、显式声明 `capabilities.externalMcp` 的工具；还要求宿主外部 MCP 开关打开。只读工具直接执行；写工具创建原生待批 run，支持停止、修改批准参数与调用前再次校验是否撤销。不允许同名核心工具因禁用插件的声明而被间接暴露。
