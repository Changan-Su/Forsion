# Mini Panel 适配

Moved out of SKILL.md (tool results are capped; see the skill's "Reference files").

### Mini Panel 适配

Space 需要显式声明 `mini` 才会出现在 Mini Panel。它是一块扩展面板：默认 320×420，用户可拖卡片的边和角在 260×160 到 640×900 之间改大小（自动弹出的临时 Mini 固定 320×420），单层宿主栏提供 Space 切换、在主面板显示、关闭；只设计本能力的快捷交互，不复制应用导航、设置、标签管理或移动端抽屉。

Computer Use 占用外部应用前台时，宿主可临时打开 Tangu Mini 观察当前运行会话，无需用户先打开 Mini。自动窗口的焦点、跟随、会话同步与收起由宿主管理，不覆盖手动 Mini 的状态；插件无需监听前台信号或新增适配字段。

```json
"mini": {
  "name": { "zh": "快捷记录", "en": "Quick capture" },
  "view": { "type": "plugin:my-bundle:quick", "params": { "itemId": "today" } },
  "mainView": { "type": "plugin:my-bundle:detail" }
}
```

- `view` 与 `mainView` 都是 `{type, params?}`；必须使用**不同的已注册视图类型**。缺少适配或视图未注册时不显示在 Mini 中，完整 Space 仍可用。不要把可选 Mini 类型放进 `requires.views`，否则旧宿主会拒绝整个配方。
- 在 `mount(el, view)` 中用 `view.surface === 'mini'` 识别容器；老宿主这些字段可缺省。Mini 不提供 `extendView`。
- `view.getParams()` 读当前实体/筛选参数，`view.setParams(patch)` 合并更新，`view.onParamsChanged(fn)` 订阅后返回取消函数。参数更新不重挂 DOM；自己更新需要变化的内容，避免丢失正在输入的草稿。
- `view.showInMainPanel?.()` 打开 `mini.mainView`，同一份当前参数覆盖 `mainView.params`。两边使用相同实体键（如 `itemId`/`notePath`），不要另建一份业务数据。宿主顶部已有按钮，不必重复绘制。
- `mount` 返回清理函数，停止订阅/计时器并保存必要内容。旧实例的 context 在关闭、切换 Space 或禁用后失效，异步回调不得继续调用。
- 插件级清理:`main.js` 就是 `setup(ctx)` 的函数体,末尾 `return () => { … }`(async 时 resolve 出函数)就是整个插件的清理,停用 / 重载 / setup 失败时宿主调用。`ctx.register*`、`ctx.ui.*`、`ctx.addStyle`、`ctx.subscribeLocale` 这些宿主自己收;只有你自己挂到 `window` / `document` 上的监听、定时器、元素才需要写在这里。
- 布局跟随容器，不要写死 320×420：窄到 260、矮到 160 时内容自己滚动或省略，不撑出横向滚动条。
- 按中英、亮暗、320×420 与最小 260×160、实体定位与插件启停验证。参考捆绑包模板的 `mini-counter` / `counter` 视图及 `spaces/sample-bundle-mini/space.json`；Genesis 回归命令为 `desktop` 下 `npm run check:minicard`。

插件只有一块快捷视图、不值得为它建完整 Space 时，直接调用开放接口：

```js
ctx.openMiniPanel?.('mini-counter', {
  title: 'Counter', params: { itemId: 'today' },
  mainViewId: 'counter', mainViewParams: { section: 'inbox' },
})
```

`viewId` / `mainViewId` 都写**本插件相对 id**，宿主自动加 `plugin:<pluginId>:`，省略 `mainViewId` 就把同一视图交回主面板。仍须先 `registerView`；Web/mobile 或旧宿主可能没有原生 Mini，务必可选链并保留 `ctx.openView()` 回退。
