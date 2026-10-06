# tangu-sample-agent

Tangu（Forsion Desktop）**智能体（Agent）**开发模板 —— 最小可用 agent = 两个文件：`config.toml` + `SOUL.md`。

## 快速开始

把文件夹拷到 `~/.forsion/agents/sample-agent/`（**文件夹名就是 slug**，kebab-case ≤64 字符），重启后端或重开应用——「示例助手」出现在 agent 名册里。也可以完全不手写：应用内 设置 → 智能体 新建，或让 agent 用 `manage_agent` 工具自建。

## 文件契约

| 文件 | 作用 | 必须? |
|---|---|---|
| `config.toml` | 元数据 + `developer_instructions`（系统提示主体） | ✅ |
| `SOUL.md` | 人格，注入为 `## Persona` 块（按它行事、不逐字背诵） | 建议 |
| `Library/` | 随身参考资料，`library_order` 建议阅读顺序 | 可选 |

config.toml 可识别字段（全部可缺省）：`name`（名册显示，缺省=slug）、`version`（**必须带引号**——商店更新检查用正则读带引号值）、`description`、`model`（覆盖会话模型）、`model_reasoning_effort`（off/low/medium/high）、`approval_mode`（readonly/auto-edit/full-auto）、`max_iterations`（≤200）、`tools`（工具白名单，空=继承）、`library_order`、`apps`（限定出现在哪些 app，空=不限）、`avatar`（Library 内的文件名，png/jpeg/gif/webp ≤1MB）、`share_default_memory`、`developer_instructions`（多行用 `'''…'''`）。

## 这些东西**不要**放进模板

- `MEMORY.md` / `LOG/` —— 运行时长期记忆与日志，属于用户；预置空 MEMORY.md 还会干扰迁移检测
- `plugins/*.json`、`.sync.json`、`.cloudsync.json`、各种 `.` 开头标记文件 —— 设备/用户态
- config.toml 里的 `created_at`（运行时自动填）、`cloud_sync`（用户偏好）；`created_by` 保持 `"user"`
- 悬空的 `avatar` 引用 —— 写了 `avatar` 就必须在 `Library/` 里真的放这个文件

## 发布到 Forsion 商店

打包 zip（`config.toml` 在 zip 根或单层文件夹内均可，安装器按它重定根），个人中心 → 投稿 选「智能体」；或推成 GitHub 公开仓。用户装完落 `~/.forsion/agents/<slug>/`。

---

## English (short)

A Tangu agent is a folder at `~/.forsion/agents/<slug>/`: `config.toml` (metadata + `developer_instructions` as the system prompt) plus `SOUL.md` (persona, injected as `## Persona`). Keep `version` quoted so market update checks work. Never ship `MEMORY.md`, `LOG/`, sync/marker dotfiles, or `created_at`/`cloud_sync` — those are user/device state.

MIT © Changan Su
