# 本地插件任务 SDK / Local plugin task SDK

这些接口用于桌面本地执行；需要包含本次 SDK 的宿主构建，已发布 2.12.2 不包含它们。插件必须按能力检测，不能只比较版本号。类型正典是 `tangu-agent/plugin-api/tangu-agent.d.ts`。

These additive APIs require a host build containing this change. Released 2.12.2 lacks them; feature-detect the interfaces rather than relying on the version number. The canonical declarations are in `tangu-agent/plugin-api/tangu-agent.d.ts`.

| API | 契约 / Contract |
| --- | --- |
| `ctx.tangu.request(engineId,path,options)` | 渲染端通过宿主调用同捆绑包内的引擎插件 JSON 路由。宿主认证、限制路由、停用时取消请求；不返回凭据。 Authenticated, bundle-scoped local requests; no credential exposure. |
| `ctx.tangu.openSession(id)` | 加载隐藏任务会话的真实模型/配置，再打开原生聊天；不自动开跑。 Opens native chat with persisted metadata without starting a run. |
| `ctx.registerScopedRoutes(register)` | 路由挂到 `/extensions/<bundle>/<engineId>`，校验本地来源、登录用户，停用时撤销。 Use `req.user.userId`, never a body-supplied owner. |
| `ctx.paths.dataDir` | 宿主分配的稳定插件数据目录。 Stable host-owned data directory, separate from installed code. |
| `sdk.runs.start(options)` | 创建插件拥有的隐藏 `kind=task` 会话。先保存意图，再使用固定 `requestId` 提交；结果未知时用同一 ID 重试。 Native approvals and questions remain active. |
| `runs.status/sessionRuns/events/subscribe/stop` | 都校验插件和用户所有权；`sessionRuns` 包含原生续聊，订阅在停用时清理。 Ownership-checked status, bounded events, native continuations and Stop. |
| `runs.usage(sessionId,userId)` | token 合计与未报告运行数；外部缺少遥测时不能当作零。 Token totals with explicit unreported external runs. |
| `runs.followupParent(options)` | 仅从子任务关联的、工具受限的总管会话续跑；固定请求 ID 防重复，仍走原生审批。 Restricted parent follow-up with idempotency. |
| `sdk.engines.list()` | 列出本机外部引擎与可用性，不证明 CLI 已登录。 Availability does not establish authentication. |

`runs.start` 支持 `readOnly`、`toolNames` 和外部 `resumeSessionId`。工具列表只能包含所属插件的工具和显式 `ask_user`。原生只读任务使用精确的读取工具白名单，原生续聊不能自行解除。外部只读模式只接受明确适配的 Claude Code/Codex ACP 身份和能力；未知适配器拒绝。Claude 禁用内置工具与用户工具配置，受限 MCP 仍经宿主逐项审批；Codex 使用原生 read-only 沙箱。恢复外部会话必须匹配引擎和工作目录，并要求适配器支持 session/load。

`runs.start` accepts `readOnly`, `toolNames` and external `resumeSessionId`. Explicit tools must be owned by the plugin or be `ask_user`. Native read-only restrictions remain sticky across continuations. Only verified Claude/Codex ACP identities support external read-only execution; unknown adapters fail closed. Resumption requires the same engine/directory and advertised session/load support. Scoped MCP calls still pass through native approval, including approved argument edits.

## 工作区与自动化 / Workspaces and automation

`sdk.workspaces.prepare({id,userId,cwd,baseRef?,trust?})` 创建插件拥有的 Git worktree；`inspect(id,userId)` 返回 diff 和 revision；`merge(id,userId,revision)` 仅合并用户检查过的内容，要求干净且未变化的目标；`archive(id,userId)` 移动工作区并保留忽略/未跟踪文件。合并和归档在源目录与目标目录取得原生任务维护锁，无法取得就拒绝。本机多个引擎进程之间不构成分布式锁。

Workspaces are owned Git worktrees. Merge requires a current revision from `inspect` and a clean unchanged destination. Conflicts remain in the task worktree. Archive preserves ignored and untracked files and supports recovery after an interrupted move. Source/destination maintenance locks share the local native task FIFO; they are not distributed across engine processes.

`sdk.automation.save(key,input)` 只允许本地 UI 授权，使用原生触发器存储和调度历史，只能调用本插件声明 `automationSafe` 的工具；ID 固定为 `plugin:<owner>:<key>`。`remove(key)` 允许撤销本插件的触发器，包括已批准的 Stop 工具。`notify(userId,title,body)` 写入 Inbox，不转发到外部消息通道。插件负责校验触发来源、授权 nonce、错过时段与重叠运行。

Schedule creation requires local user authorization and an owned `automationSafe` tool. Revocation may also come from an approved Stop tool. Inbox notifications do not forward externally. Plugins must validate trigger origin and authorization and define overlap/missed-slot behavior.

## Desktop MCP

Desktop MCP 的 `plugin_tools` / `plugin_call` 只枚举和执行最终解析结果中由启用插件提供、显式声明 `capabilities.externalMcp` 的工具；还要求宿主外部 MCP 开关打开。只读工具直接执行；写工具创建原生待批 run，支持停止、修改批准参数与调用前再次校验是否撤销。不允许同名核心工具因禁用插件的声明而被间接暴露。

Both the host external-MCP switch and the final resolved plugin tool's `externalMcp` opt-in are required. Writes create native approval runs, honor argument edits and cancellation, and recheck availability before execution. Disabled plugin declarations cannot expose a same-named core tool.
