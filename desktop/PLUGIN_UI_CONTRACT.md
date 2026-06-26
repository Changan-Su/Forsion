# Tangu 插件 UI 设计语言契约（声明式主题面板）

插件**不写 UI 代码、不带 CSS**。插件只在 manifest 的 `settings.fields` 里**声明**一个面板，
Tangu 渲染端用**统一设计语言（LCL token）**把它渲染出来。因此插件 UI **天然继承当前主题 /
明暗 / 扁平**，零样式泄漏，跨 Lovable / Echo / QBird / 自定义 全部一致。

> 机制：插件经 `/agent/plugins` 返回 `settings: { fields: PluginField[] }`（纯 JSON）；
> 渲染端 `PluginSettingsForm` 按下表渲染，全部用 `var(--*)` token。
> 类型见 `desktop/frontend/src/services/backendService.ts` 的 `PluginField`。

## 通用约定

- 每个字段有 `key`（唯一）、`label`（中文）、可选 `labelEn`（英文，跟随应用语言）。
- **设置型**字段（toggle/text/textarea/number/select/image-list）有值，存到 `/agent/plugins/:id/settings`。
- **展示/结构型**字段（section/note/link）无值，只排版/提示。
- 颜色/圆角/间距**一律不要写死**——交给 Tangu。需要强调就用语义（如 note 的 `tone`）。

## 字段（widget）一览

| type | 作用 | 关键属性 |
|---|---|---|
| `section` | 分区标题 + 分隔线（给面板分组） | `label`, `help?` |
| `note` | 只读提示框（吃主题色） | `label`, `tone?: 'info'｜'warn'｜'success'` |
| `link` | 外链按钮（新窗口打开） | `label`, `url` |
| `toggle` | 开关 | `label`, `default?: boolean`, `help?` |
| `text` / `textarea` | 单行 / 多行文本 | `label`, `default?`, `placeholder?` |
| `number` | 数字 | `label`, `default?`, `min?`, `max?` |
| `select` | 下拉 | `label`, `options: {value,label,labelEn?}[]`, `default?` |
| `image-list` | 图片列表（上传/删除 + 每项子字段） | `label`, `itemFields: PluginField[]` |

- `tone`：`info`（强调色淡底）/ `warn`（危险色淡底）/ `success`（成功色淡底）。
- 设置型字段：toggle/select 即时保存；text/number/textarea 失焦保存。

## 示例（manifest 里的 `settings.fields`）

```json
[
  { "key": "intro", "type": "note", "tone": "info",
    "label": "本插件把表情包注入到对话里。", "labelEn": "Injects stickers into chats." },
  { "key": "sec_basic", "type": "section", "label": "基础", "labelEn": "Basics" },
  { "key": "enabled", "type": "toggle", "label": "启用注入", "default": true },
  { "key": "style", "type": "select", "label": "风格",
    "options": [{ "value": "cute", "label": "可爱" }, { "value": "meme", "label": "梗图" }] },
  { "key": "sec_assets", "type": "section", "label": "素材" },
  { "key": "imgs", "type": "image-list", "label": "表情图",
    "itemFields": [{ "key": "tag", "type": "text", "label": "标签" }] },
  { "key": "docs", "type": "link", "label": "查看文档 ↗", "url": "https://forsion.net/docs/stickers" }
]
```

渲染后即一个分区、带提示、跟随主题的设置面板，出现在 **设置 → 插件 → <你的插件>**。

## 路线（后续增量）

- 插件**动作按钮**（POST 到插件路由，触发后端动作 + 回显状态）——需后端动作端点。
- 插件**面板挂到设置之外**（侧栏项 / 右栏视图），仍走同一套声明式 token 渲染。
- 更多展示件（进度条 / 键值状态表 / 列表卡）。

> 单一原则不变:**插件描述，Tangu 渲染**——所以插件永远跟着统一设计语言走。
