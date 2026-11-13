# 向 Agent 开放插件设置

UI 插件和引擎插件共用 `ctx.registerAgentSettings`。这是显式的只读字段契约，不会自动暴露 `registerSetting`、插件 JSON 文件或密钥存储。UI 旧宿主用可选调用探测；引擎插件也可用可选调用兼容旧引擎。

```js
ctx.registerAgentSettings?.({
  fields: [
    { key: 'language', type: 'string', description: 'Preferred translation language', scope: 'account' },
    { key: 'apiKey', type: 'secret', description: 'Whether an API key is configured', scope: 'device' }
  ],
  read: ({ keys, userId, workspaceId, signal }) => ({
    language: currentEffectiveLanguage(),
    apiKey: isApiKeyConfigured() // 只返回 boolean，绝不返回密钥
  })
});
```

`type` 可取 `string`、`number`、`boolean`、`secret`；`scope` 可取 `device`（缺省）、`account`、`workspace`。说明不超过 240 字符，最多 64 个不重复字段。普通值必须匹配类型，`null` 表示未设置；secret 必须返回布尔配置状态，否则标为无法读取。只投影声明的自有数据字段，未声明字段不出站，错误不回显插件异常正文。整个结果不超过 7400 字符，超限返回 `too_large`，Agent 可按 `keys` 分批读取。

`read` 每次调用现读生效值，不缓存。引擎传入当前 run 的 `userId`、项目或目录 `workspaceId` 和取消信号；多用户插件必须按这些上下文读取自己的设置。UI 插件从当前客户端的自身状态取值，不代表另一台设备或引擎。3 秒未完成、插件停用、卸载或换代都会使本次读取失效；同插件重注册替换旧契约，旧 disposer 不会撤掉新版。

Agent 使用 `read_plugin_settings({ source: 'ui' | 'engine', pluginId?, keys? })`。省略 pluginId 列出当前开放读取的插件；没有开放的字段明确返回 `not_exposed`，不能推断为默认值。UI 通过发起会话的现有命令通道读取，旧客户端不会获得这个能力；引擎侧也支持没有 GUI 的调用。结果作为不可信数据围栏返回，历史对话里用原生设置卡显示；可打开当前客户端/本端引擎的插件设置，远端引擎结果不会误开本机同名插件。

API 类型正典：`tangu-agent/src/contracts/agentSettings.ts`；两种插件都从宿主 ctx 注册，不从运行时 import 核心模块。
