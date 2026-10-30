# 插件自带的 MCP server 与 hooks

Moved out of SKILL.md (tool results are capped; see the skill's "Reference files").

### 插件自带的 MCP server 与 hooks(2026-10-17 起;只收 stdio MCP、只开观察档 hooks)

两样都写在**包里引擎插件的 `tangu-plugin.json`**(不是包根的 `manifest.json`),开关就跟着引擎插件走:捆绑包在桌面上拨开关时级联到引擎插件,所以「停用插件 → 它的 MCP 进程和 hooks 一起停」是现成的。两样都要在插件**进入运行态之后**才登记,启动时随即休眠的插件不会拉起子进程。入口里照常 `ctx.registerPlugin({ id, name, … })` 登记一次 —— **没登记的引擎插件没有开关**(引擎当它常开),桌面停用捆绑包时级联关不到它,MCP 进程就一直开着;只想带 MCP / hooks 的插件不注册工具也行,但这一步不能省。

```json
{
  "id": "my-plugin", "name": "My plugin", "version": "1.0.0", "apiVersion": 1, "entry": "dist/index.js",
  "mcpServers": {
    "mytools": { "command": "node", "args": ["${pluginDir}/mcp/server.js"], "env": { "DATA": "${pluginDir}/data" } }
  },
  "hooks": {
    "PostToolUse": [{ "matcher": "write_file", "hooks": [{ "type": "command", "command": "node ${pluginDir}/hooks/audit.js" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node ${pluginDir}/hooks/archive.js" }] }]
  }
}
```

- **MCP 只收 stdio**(随包发的静态 server):要有 `command`,`url` / `headers` 不收 —— 远端 server 的地址与令牌是运行期数据,写不进 manifest。能力在某台服务端的,照旧让**服务端自己出 MCP 端点**、插件只做「接入卡」(先例 = server-admin 的「接入 Agent(MCP)」+ server `microserver/admin-mcp/`)。
- `${pluginDir}` 在 command / args / env 里展开成插件目录的绝对路径;stdio 子进程的工作目录就是插件目录。子进程拿不到引擎凭据(同用户自己配的 MCP)。
- 工具名照常是 `mcp__<server 名>__<工具>`,server 名用你声明的那个(≤32 字符,字母数字 `_` `-`),取得短而独特;**和用户自己配的 server 撞名时你这份不起**,在设置 → MCP 里显示成错误。设置 → MCP 只读列出插件自带的 server(写着来自哪个插件),用户要关就停用插件。只在本机引擎上生效,云端 worker 没有 MCP。
- **hooks 只开观察档**:`SessionStart` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`。hook 照常跑、照常从 stdin 收事件 JSON,但**输出一律不进判定**:`decision: block`、退出码 2、`continue: false`、`additionalContext` 都没有效果 —— 拦不住工具、停不了循环、也往对话里加不了东西。`PreToolUse` / `PermissionRequest` / `UserPromptSubmit` / `PreCompact` 不收(那是审批面的一部分)。适合审计、会话归档、写完文件跑一下自己的索引。设置 → Hooks 只读列出它们(「来自插件 X · 只观察」),排在用户自己的 hook 之后。
- hook 和 MCP server 都是插件自己的代码,信任级别与引擎插件相同,装上即生效、不走「需审阅」;**别在 hook 里做慢事**(它在 run 的关键路径上,会拖慢每一次工具调用),也别把用户数据往外发。
