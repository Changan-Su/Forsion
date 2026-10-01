---
title: 可复用界面组件 / Reusable UI components
description: 在 View 与插件中复用 Chat Box，明确草稿、模型选择与提交的归属。
---

# 可复用界面组件 / Reusable UI components

Space 组织布局，View 是可独立打开的功能面，UI component 是 View 内可组合的部件。此处不使用 Amadeus 的文档 Block 或仪表盘 Card 作为组件名称。工程分层及维护规则见 [LCL](../../lcl/README.md)。

Chat Box 的卡面、输入、操作栏和提交按钮由 `@lcl/components` 维护。聊天与首页通过 `Composer2` 接会话行为；Coding 的新建项目通过 `components/chatbox` 接模型目录，并在创建完成后传递选定模型与思考档。项目详情与 Forsion 能力选择是宿主插槽。

## 插件使用

`ctx.ui?.mountChatBox` 可挂到插件自己的 View 中，不需要 React。当前支持文本输入、模型选择、思考档、键盘提交；附件、命令、审批和运行控制属于会话编排器，未接线的行为不显示。

```js
ctx.registerView({
  id: 'prompt', title: 'Prompt',
  mount(el) {
    const zh = ctx.getLocale?.() === 'zh'
    const box = ctx.ui?.mountChatBox?.(el, {
      label: zh ? '描述需求' : 'Describe your request',
      placeholder: zh ? '输入要处理的内容…' : 'Describe what to work on…',
      submitLabel: zh ? '保存草稿' : 'Save draft',
      async onSubmit({ text, modelId, thinkingLevel }) {
        // The plugin owns what happens next. This example only saves a draft.
        await ctx.saveData?.({ text, modelId, thinkingLevel })
        return true
      },
    })
    if (!box) el.textContent = zh ? '请更新 Forsion 以使用共享输入框。' : 'Update Forsion to use the shared input.'
    return () => box?.dispose()
  },
})
```

类型真源：`desktop/shared/chatBox.ts`。

| API | 约定 |
| --- | --- |
| `value`, `modelId`, `thinkingLevel` | 初始草稿；通过 handle.update 可局部修改。未指定模型时使用宿主默认；`agentSlug` 可提供该 Agent 的初始默认。 |
| `label`, `placeholder`, `submitLabel`, `disabled` | 展示与可操作状态，插件负责双语；update 不重挂、不丢输入。 |
| `submitOn` | 默认 `modifier-enter`（⌘/Ctrl+Enter）；可设 `enter`。Shift+Enter 换行，输入法确认不会提交。 |
| `onChange(draft)` | 文本或模型选择变化时返回 `{ text, modelId, thinkingLevel }`。只通知本组件的宿主。 |
| `onSubmit(draft)` | 返回 true 清空已提交文本；false 或异常保留草稿。等待期间防重复提交；异常显示可重试提示。 |
| `update(patch)`, `focus()`, `dispose()` | 更新、聚焦、幂等卸载。卸载后的异步回调不再修改 UI；宿主在插件禁用、重载、setup 失败时统一回收。 |

模型目录与聊天共用，主模型只展示 LLM，遵守用户的排序和隐藏设置，不额外按品牌限制。选择停留在此组件，不修改全局默认或当前会话。提交回调拿到的是当次选择；插件必须将它们传给自己的业务流程，不能展示了选择却丢弃它。挂载和编辑不发起模型请求、不自动创建会话。旧宿主必须 feature-detect，不复制内部 CSS 伪装支持。

## Android 宿主展示

Android 的共享 `ModelPill` 可通过 `modelPickerHost` 接口使用 Kotlin / Jetpack Compose 半屏选择器。
插件继续调用 `ctx.ui.mountChatBox`，不用创建原生 View，也不用访问 Capacitor。
宿主将模型目录、已选值、双语标签和主题传给原生层，用户点击完成后才原子更新该输入框的模型和思考档。
取消与卸载不写回；宿主不可用时保留 Web 菜单。插件独立绘制的选择器不会自动获得该能力。

此接口只改变交互的展示层，不改变插件安装、DOM View 或编辑器扩展机制。
移动端外部插件加载的支持情况需独立确认，详见 [Android 试点与验收](../../mobile/README.md)。

## English API notes

Use `ctx.ui?.mountChatBox?.(element, options)` inside a plugin View. The host supplies the same input surface and model picker used by built-in Views; the plugin supplies localized labels and owns submission. `onSubmit` receives `{ text, modelId, thinkingLevel }`: return true to clear the submitted text, or false to keep it. Rejected submissions keep the draft and show a retryable error. Model and effort choices remain local, without changing the active conversation or global defaults.

`handle.update(patch)` preserves mounted state; `focus()` focuses the input; `dispose()` is idempotent. The host also cleans up on plugin disable, reload, or setup failure. Submission is locked while pending, and disposed instances ignore late results. Default keyboard submission is ⌘/Ctrl+Enter; Shift+Enter adds a line and IME confirmation never submits. Text, model selection, and effort are supported; conversation-only attachments, slash commands, approvals, and run controls require their session host. Feature-detect on older hosts. The canonical options and handle types live in `desktop/shared/chatBox.ts`.
