# Obsidian Bridge compatibility / 兼容矩阵

矩阵记录公共能力及其边界，不按成功加载数量推算兼容率。完整支持仅用于已穷尽验证的明确范围；当前没有整类标为完整支持。

This matrix tracks shared capabilities and boundaries, not compatibility percentages inferred from successful loads. Full support requires exhaustive evidence for a defined scope; no whole category is currently marked full.

Status: **partial / 部分支持** means only the named behavior; **unsupported / 未支持** includes declarations without an operational native integration.

## 安装与商店 / Installation and catalog — partial

官方目录搜索、稳定原包安装、SHA-256、默认禁用、错误重试。

Official catalog search, stable original packages, SHA-256, disabled-on-install and retry.

**待补 / Remaining:** 更新、卸载和任意 ZIP 导入待实现。 Updates, uninstall and arbitrary ZIP imports remain unimplemented.

Evidence: `electron/obsidianCommunity.test.ts; scripts/obsidian-native.e2e.cjs`

## 原生编辑器命令 / Native editor commands — partial

正文快照、选区、单事务撤销、保存与过期提交拒绝；六个原包指定操作。

Body snapshots, selections, single-transaction undo, save and stale-commit rejection; selected operations from six packages.

**待补 / Remaining:** 不等于完整 Editor API；旧 v3、源码模式及无法证明的富文本位置不支持。 Not the complete Editor API; v3, source mode and unprovable rich-text positions are unsupported.

Evidence: `frontend/src/amadeus/unified/pluginEditor.test.ts; scripts/obsidian-native.e2e.cjs`

## 后台与生命周期 / Background and lifecycle — partial

定时器、布局就绪、编辑/文件事件串行执行；禁用清理并取消等待。

Timers, layout-ready and edit/file events serialize; disabling cleans up and cancels waiting calls.

**待补 / Remaining:** 尚未覆盖所有 Obsidian 事件、多窗口活动上下文和后台插件类型。 Not all Obsidian events, multi-window contexts or background plugin classes are covered.

Evidence: `prototypes/obsidian-bridge/check-native.mjs; scripts/obsidian-native.e2e.cjs`

## 智库与元数据 / Vault and metadata — partial

Markdown 索引、read/create/modify/process、CAS、正文坐标元数据和原生属性写入。

Markdown index, read/create/modify/process, CAS, body-position metadata and native property writes.

**待补 / Remaining:** 最多 5000 篇；无真实时间戳、完整反链、附件/二进制写；属性写仅限打开的笔记。 5000-note limit; no real timestamps, complete backlinks or attachment/binary writes; property writes require an open note.

Evidence: `prototypes/obsidian-bridge/check-native-app.mjs; scripts/obsidian-native.e2e.cjs`

## 设置与弹窗 / Settings and modals — partial

原包设置控件、基础 Modal/SuggestModal、按智库保存。

Original settings controls, basic Modal/SuggestModal and per-vault persistence.

**待补 / Remaining:** 控件与弹窗 API 尚未全覆盖；原包 UI 在 Bridge 管理窗口中。 Incomplete control/modal API; original UI lives in the Bridge manager.

Evidence: `prototypes/obsidian-bridge/check-lifecycle.mjs; scripts/obsidian-native.e2e.cjs`

## 快捷键 / Hotkeys — partial

原包多组默认键位、原生改键/解绑、跨设置窗口同步、禁用清理；Note Refactor 默认键与 Sort 自定义键。

Multiple original defaults, native rebinding/unbinding, settings-window sync and cleanup; Note Refactor default and custom Sort binding.

**待补 / Remaining:** 当前只在原生正文响应；尚无 Scope 栈、CM 键位或完整命令可用性展示；原生已处理键优先。 Currently scoped to native note bodies; no Scope stack, CM keymaps or full command-availability presentation; handled native keys take priority.

Evidence: `frontend/src/commandRegistry.plugins.test.ts; frontend/src/shortcutCatalog.test.ts; scripts/obsidian-native.e2e.cjs`

## 自定义视图 / Custom views — partial

原版 Advanced Tables ItemView 工具栏挂入原生右侧栏；按钮事务、原生撤销、显式关闭重开、折叠恢复和禁用清理。

Original Advanced Tables ItemView in the native right sidebar; button transactions, native undo, explicit close/reopen, collapse/restore and disable cleanup.

**待补 / Remaining:** 每种视图仅一个实例；原生关闭按钮暂按挂载暂停处理，onClose 在显式 detach 或禁用时运行。跨重启状态、活动视图路由、任意 DOM 监听及复杂嵌入视图仍待补。 One instance per type. Native close currently suspends mounting; onClose runs on explicit detach or disable. Cross-restart state, active-view routing, arbitrary DOM listeners and complex embedded views remain incomplete.

Evidence: `prototypes/obsidian-bridge/check-native-views.mjs; prototypes/obsidian-bridge/check-expanded.mjs; scripts/obsidian-native.e2e.cjs`

## Markdown 渲染扩展 / Markdown rendering extensions — unsupported

尚无原生接入的验收证据。

No evidence of native integration yet.

**待补 / Remaining:** 代码块处理器、后处理器和渲染子组件生命周期待接入。 Code-block processors, postprocessors and render-child lifecycle remain to be integrated.

Evidence: `prototypes/obsidian-bridge/src/obsidian.js`

## 编辑器扩展与建议 / Editor extensions and suggestions — unsupported

仅提供命令缓冲区的部分 CodeMirror 兼容对象。

Only partial CodeMirror objects for command buffers.

**待补 / Remaining:** 不执行任意 CM 扩展；Advanced Tables Tab、Linter 保存拦截与输入建议待接入。 No arbitrary CM extensions; Advanced Tables Tab, Linter save interception and editor suggestions remain unimplemented.

Evidence: `prototypes/obsidian-bridge/src/native-editor.js`

## 平台与网络 / Platform and network — partial

Desktop、本地可信插件、浏览器 fetch、Moment 与 YAML。

Desktop, trusted local plugins, browser fetch, Moment and YAML.

**待补 / Remaining:** 无 Node/Electron 模块或移动端；requestUrl 受 CORS 限制；iframe 不是安全沙箱。 No Node/Electron modules or mobile support; requestUrl is CORS-bound; iframe is not a security sandbox.

Evidence: `prototypes/obsidian-bridge/src/runtime.js; prototypes/obsidian-bridge/src/obsidian.js`

## Completion gate / 完成门槛

Views, rendering and editor extensions remain Goal work. Each capability needs a real unmodified package operation, native lifecycle/data-preservation checks and recorded GUI evidence before its status changes. A passing unit test or successful onload alone is insufficient.

视图、渲染和编辑器扩展仍在 Goal 范围内；状态升级必须附真实原包操作、原生数据与生命周期验证及 GUI 证据。单测或 onload 成功不能代替完整操作验收。
