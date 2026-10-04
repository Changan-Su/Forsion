# LCL：Space、View 与可复用 UI 组件

Genesis 当前使用这份 LCL。`apps/Archived/Forsion-LCL` 是早期组合引擎，不能作为当前 API。

| 层 | 职责 | 公共入口 |
| --- | --- | --- |
| Space | 组织 View 的位置、默认布局与导航 | `@lcl/engine` 的 SpaceDefinition |
| View | 可在主区、侧栏、浮窗等宿主独立打开的功能面 | `@lcl/engine` 的 ViewDefinition / ViewProps |
| UI component | View 内可独立组合的输入、控制和内容表面 | `@lcl/components`；需要业务服务的组件由应用层提供公共入口 |

第三层统一称 **UI component / UI 组件**。早期 LCL 使用过 Block；Amadeus Block 现在专指文档内容与存储，Dashboard Card 是 View 的卡片宿主，都不替代这层组件契约。组件不创建 Leaf、不改变 Space，不隐式操作活动会话。

## 复用纪律

1. 写 View 前先查公共组件。已有能力缺少插槽时扩展公共组件，不复制 View 内的 JSX / CSS。
2. 无业务依赖的组件放 `lcl/components`，只从 `@lcl/components` 导出；模型目录等业务适配放应用层。LCL 不反向导入 desktop。
3. 状态与副作用归宿主：输入值、选择、禁用、提交回调明确传入。不要用活动 View / session 单例作为隐式目标。
4. 对插件开放采用现有 `ctx.ui` 的 DOM 挂载协议，返回 `update` / `focus` / `dispose`；插件不打包第二份 React，不 import 宿主内部路径。禁用、重载、setup 失败由宿主统一清理。挂载一律走 `mountHostReact`:树挂在宿主自己加进 `el` 的一层里(`display:contents`),`dispose` 同步摘掉这一层,`el` 立刻归还插件;同一个 `el` 不 dispose 再挂是原地更新。
5. 公共接口变更必须同步类型、作者手册、真实消费者与生命周期测试。CSS 同源，并覆盖明暗、窄容器、输入法和菜单。

## Chat Box

- `@lcl/components`：`ChatBox`、`ChatBoxSurface`、`ChatBoxInput`、`ChatBoxToolbar`、`ChatBoxSubmit`。受控输入、伸缩、键盘提交与插槽；没有会话副作用。
- `desktop/frontend/src/components/chatbox`：接入共享 `ModelPill` 与宿主实时模型目录的 ChatBox、`useChatBoxSelection`。草稿选择局部保存，用户排序 / 隐藏偏好和模型思考档复用现有选择器。
- `Composer2`：聊天会话编排器，组合上述基础组件并接入附件、引用、命令、语音、运行状态。首页复用该编排器；Coding 项目创建使用提示表单组件，在创建成功后显式移交模型与思考档。
- 插件：`ctx.ui.mountChatBox`；详见 [公共契约](../docs/customization/ui-components.md)。

## English contract

Space owns layout; View owns a navigable feature; UI components compose the inside of a View. Amadeus document Blocks and Dashboard Cards have different responsibilities. Use `@lcl/components` for host-independent primitives and application adapters for services. Inputs and callbacks are explicit; a component must not implicitly target the active session. DOM plugins consume `ctx.ui` mounts, with lifecycle cleanup owned by the host. Keep types, documentation, consumers, and lifecycle coverage together when changing public APIs.
