---
name: 配置与管理 Agent
description: 当用户想新建 / 配置 / 修改 / 删除 Tangu 本地 Agent(Normal Agent),或想把一种好用的角色 / 工作方式沉淀成可复用的 agent 时使用。讲解 manage_agent 工具与 agent 的文件夹结构(config.toml / SOUL.md / MEMORY.md / LOG / Library)。
version: 1.0.0
category: agent 管理
---

# 配置与管理 Agent

把一种值得复用的角色 / 工作方式沉淀成一个 **Normal Agent**(本地个性化 agent)。每个 agent 是 `~/.tangu/agents/<slug>/` 下的一个文件夹,被用户在新会话里选用后,其人格 / 模型 / 工具 / 设置会套用到该会话。

## 一个 Agent 由什么组成

`~/.tangu/agents/<slug>/`(slug = 小写字母数字与连字符):

- **config.toml** — 参数 + `developer_instructions`(该 agent「做什么 / 怎么做 / 必读什么」的开发指令)。键:`name`、`description`、`model`(覆盖会话模型,可空)、`tools`(启用的工具 id 白名单,可空=继承)、`model_reasoning_effort`(off/low/medium/high)、`approval_mode`(readonly/auto-edit/full-auto)、`max_iterations`(1~200)、`library_order`(Library 优先阅读顺序)、`avatar`(Library 内头像文件名)。
- **SOUL.md** — 人格设定:语气、态度、价值观(区别于「做什么」的开发指令,这里塑造「怎么说话、是个怎样的存在」)。
- **MEMORY.md** — 该 agent 自己的长期记忆(用 `remember` 工具写,跨会话保留)。
- **LOG/<日期>.md** — 该 agent 的按日日志(用 `log_event` 写、`read_log` 读)。
- **Library/** — 资料库:用文件读写工具往里存 / 取长期参考资料(人物设定、工具手册、知识文档)。`config.toml` 的 `library_order` 可指定优先阅读顺序。

## 用 manage_agent 工具

`action` ∈ `list` / `create` / `update` / `delete`。

**列出**:
```json
{ "action": "list" }
```

**创建**(`name` 与 `system_prompt` 必填;`slug` 省略则由 name 派生;其余可省):
```json
{
  "action": "create",
  "name": "代码审查员",
  "description": "专注质量、安全与可维护性的代码审查",
  "system_prompt": "你是一位资深代码审查员。聚焦正确性与边界条件、安全漏洞、并发与性能、可读性与命名、错误处理与测试覆盖;按「严重/建议/提示」分级给出可操作修改并解释原因。",
  "soul": "严谨、细心、对事不对人。不空泛表扬,只在确有问题时指出。",
  "thinking_level": "medium",
  "approval_mode": "auto-edit",
  "max_iterations": 60
}
```
> `system_prompt` 写进 config.toml 的 `developer_instructions`;`soul` 写进 SOUL.md。

**更新**(`slug` 必填;只传要改的字段):
```json
{ "action": "update", "slug": "code-reviewer", "soul": "（新的人格…）" }
```

**删除**(不能删默认 agent):
```json
{ "action": "delete", "slug": "code-reviewer" }
```

## 最佳实践

1. **system_prompt 三层**:角色定位(你是谁)→ 核心职责(做什么 / 怎么做)→ 必读约束(关键规则 / 禁区,例如「动手前先读 Library/persona.md」)。
2. **soul 塑造语气**:写得越具体生动越好;它决定 agent 的「人味」,与职责正交。
3. **tools 白名单**:只给必需工具,留空=继承会话设置。
4. **thinking_level**:off 快答 / low 日常(默认) / medium 复杂(代码审查) / high 研究型难题。
5. **approval_mode**:readonly 只读 / auto-edit 自动小改 / full-auto 全自动(谨慎)。
6. **沉淀资料进 Library**:角色设定、长文档、工具手册等放进该 agent 的 `Library/`,并在 `developer_instructions` 里要求按需阅读;agent 自己也能用文件工具往 Library 写 / 读。
7. **记忆与日志**:让 agent 用 `remember` 记长期事实 / 偏好、`log_event` 记当天产出——都落在该 agent 自己的 MEMORY.md / LOG/。

## 何时创建新 agent

当一种角色 / 流程会被反复用到(如某项目的专属助手、某类审查 / 写作 / 研究角色),就 `create` 一个;一次性任务不必。创建后告诉用户可在新会话的 Agent 选择器里选用它。
