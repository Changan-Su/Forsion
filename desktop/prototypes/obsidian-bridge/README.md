# Obsidian Bridge — Desktop 原型 / Desktop prototype

0.5 将六个原始 Obsidian 插件的编辑命令接到当前 **Amadeus 原生可视编辑器**。正文、选区、撤销和磁盘保存由原生编辑器持有；Bridge 管理面板只负责原包和设置。

Version 0.5 runs six original Obsidian plugins against the active **native Amadeus visual editor**.
Amadeus owns the document, selection, undo and save pipeline. Bridge manages packages and settings.

选中笔记正文，点击左下角 **命令面板 (⌘K)** 按钮，搜索 `Obsidian`，选择插件命令。
正文内的 `Cmd+K` 保留为原生“插入链接”。搜索 `Obsidian Bridge` 打开设置管理面板。

Select text in a note, click the lower-left **Command palette (⌘K)** button, search `Obsidian`, then select
an editing command. Inside the editor, `Cmd+K` remains the native Insert link shortcut. Search
`Obsidian Bridge` to open package management and settings.

## 安装布局 / Installation layout

```text
<isolated Forsion home>/plugins/forsion-plugin-obsidian-bridge/
  manifest.json
  main.js
  runtime.js
  spaces/obsidian-bridge/space.json
  plugins/
    obsidian-sort-and-permute-lines/{manifest.json,main.js,source.json}
    obsidian-plugin-toc/{manifest.json,main.js,source.json}
    number-headings-obsidian/{manifest.json,main.js,styles.css,source.json}
    obsidian-linter/{manifest.json,main.js,styles.css,source.json}
    table-editor-obsidian/{manifest.json,main.js,styles.css,source.json}
    note-refactor-obsidian/{manifest.json,main.js,styles.css,source.json}
    sources.json
```

Obsidian 插件原包就在 Bridge 插件自己的插件文件夹内；不读写用户的 `.obsidian/plugins`。
`source.json` 记录 GitHub 发布地址、版本、逐文件 SHA-256。原包不重新打包、不修改。
Bridge 的设置仍通过 Forsion 的 `loadData/saveData` 保存到插件数据目录，按智库和子插件 ID 分开。
同一 Desktop profile 一次只允许一个 Bridge 运行实例，避免不同窗口覆盖设置。

Original packages live inside Bridge's own folder. The user's `.obsidian/plugins` is untouched.
Settings use Forsion's plugin data store, separated by vault and child plugin ID. A profile-wide Web Lock
allows one Bridge runtime at a time. The iframe isolates CSS and DOM helpers; it is **not a security sandbox**.

## 运行 / Run

From the Genesis worktree's `desktop/` directory:

```sh
npm ci --prefix prototypes/obsidian-bridge
node prototypes/obsidian-bridge/install-plugins.mjs
npm run build:obsidianbridge
npm run build
# Follow the repository gui-verify devlock procedure when launching Electron.
npm run e2e:obsidiannative
# Runs acceptance and leaves the isolated native note open:
npm run preview:obsidiannative
```

`install-plugins.mjs [bridge-plugin-folder]` defaults to this prototype's `plugin/` folder. It downloads only
six pinned releases; reinstallation refuses modified existing assets. Runtime scans the real `plugins/`
subfolder on opening or pressing Rescan. Open **Community plugins / 社区插件商店** to search the official
[Obsidian community catalog](https://github.com/obsidianmd/obsidian-releases). The Desktop host downloads
stable GitHub release assets into Bridge's `plugins/<id>/`, validates identity/version, records SHA-256,
and atomically installs the complete package. It preserves existing packages and leaves new packages
disabled until explicitly enabled. This is a catalog browser, not an embedded Obsidian application.
Updates, uninstall, arbitrary ZIP imports and automatic compatibility certification are not implemented.

The Electron harness creates an isolated home, installs Bridge from disk, creates a fixture vault, drives
real UI clicks, verifies restart persistence and writes screenshots/results to `artifacts/`.
It explicitly sets `TANGU_HARNESS_QUIET=1`; macOS windows stay at native level **-1** without taking focus.
The harness verifies the real CoreGraphics window layer and window focus while driving and capturing it
through Playwright. Interactive previews use this same quiet launch policy.
Only the unrelated AI backend is a stub. It does not test model execution or the production installer.
`--demo` keeps the isolated instance open after acceptance. `BRIDGE_HOME`, `BRIDGE_ARTIFACTS`, and `STAGE_ELECTRON`
can override the isolated home, evidence folder, and the separate Electron identity used for the demo.
`--preview` starts the same isolated fixture and waits for the user to close it; use a separate
`BRIDGE_ARTIFACTS` directory to keep its session details separate from the acceptance run.

## 固定样本 / Pinned samples

| Plugin | Release | Intended acceptance |
| --- | --- | --- |
| Sort and Permute Lines | [0.9.0](https://github.com/Vinzent03/obsidian-sort-and-permute-lines/releases/tag/0.9.0) | alphabetical sorting, duplicate removal, editor undo |
| Table of Contents | [0.2.0](https://github.com/hipstersmoothie/obsidian-plugin-toc/releases/tag/0.2.0) | headings metadata, generated links, original settings UI and persistence |
| Number Headings | [1.16.0](https://github.com/onlyafly/number-headings-obsidian/releases/tag/1.16.0) | native multi-change edit, actual 10-second automatic numbering, native properties, timer cleanup |
| Linter | [1.34.1](https://github.com/platers/obsidian-linter/releases/tag/1.34.1) | original lint-file command removes repeated blank lines, native undo |
| Advanced Tables | [0.23.2](https://github.com/tgrosinger/advanced-tables-obsidian/releases/tag/0.23.2) | insert a native table column, preserve each cell |
| Note Refactor | [1.8.2](https://github.com/lynchjames/note-refactor-obsidian/releases/tag/1.8.2) | extract selected text to a new vault note, replace with a link |

“加载成功”不等于所有命令已兼容；只把验收脚本里实际完成的动作列为已验证。
Successfully loading a package does not certify every command. Only actions exercised by the acceptance
harness are validated; `artifacts/results.json` is the execution record.

## 原生接口 / Native contract

`ctx.app.captureEditor()` 返回绑定当前可编辑 v4 实例的一次性 Markdown 正文快照与 UTF-16 选区。
插件命令在内存中计算修改，再由 `apply()` 提交为一个原生最小差异事务。没有第二个编辑器控件，也不调用文件覆盖写入。
原生自动保存保留笔记 frontmatter；未变化的块保持原对象。正文、选区、活动标签、智库或插件生命周期变化后拒绝提交。

The generic optional host API `ctx.app.captureEditor()` captures a single-use Markdown body snapshot
and UTF-16 selection from the active editable v4 instance. Commands calculate edits in memory and
commit one minimal native transaction through `apply()`. No second editor widget or direct file write
is involved. Native saves retain frontmatter; unchanged blocks retain their identity. Stale documents,
selections, leaf/vault changes, hidden/source/read-only editors and revoked plugins refuse edits.

## 后台与 API / Background and APIs

- 原始定时器、`onLayoutReady`、`editor-change/file-open`、Vault 与 metadata events 进入串行调用队列；隐藏管理面板后继续工作，禁用时清理。延时回调不能跟随用户切换到另一篇笔记。
- `TFile/TFolder`、Markdown 文件与目录索引、`read/cachedRead/create/modify/process/append`、基础 adapter 读写、链接解析与打开。新建仅允许不存在的目标；关闭笔记写入使用 CAS；打开的正文走原生编辑事务。
- `processFrontMatter` 通过原生属性管线修改打开笔记。`vault.read` 含属性区，活动编辑器的元数据位置使用正文坐标，属性值单独保留。
- Component/Plugin 生命周期、设置控件、基础 Modal/SuggestModal、Moment、YAML、DOM helpers、命令注册与清理。原包 CSS/DOM 只放在独立 realm。

Timers and event callbacks serialize their native edits, drain tracked host operations and stop on disable.
Vault writes use create-only or compare-and-swap semantics; native edits retain stale document/selection
checks. A failed extraction keeps the source selection. Extraction is not a cross-file atomic transaction:
if a new note was created successfully but the source changed before commit, the new note remains and
source replacement is refused. All source content is retained.

## 快捷键 / Hotkeys (0.4)

原包声明的默认快捷键进入原生命令系统。在 **设置 → 快捷键** 搜索插件命令即可改键或解绑；设置窗口的修改立即同步到主窗口。禁用子插件会移除其命令，重新启用保留用户键位。

Original default hotkeys join the native command system. Search a plugin command in **Settings → Shortcuts**
to rebind or unbind it; settings-window changes apply immediately in the main window. Disabling removes
commands; re-enabling retains user bindings. Multiple defaults are displayed and replaced together by a
user override. Exact Ctrl and Meta remain distinct. Native handled keys take priority.

当前 Bridge 快捷键只在原生笔记正文响应，不在搜索框、设置输入框或管理弹窗中执行；默认禁止按住重复执行，除非原包声明 repeatable。IME 组合输入不触发。

Bridge shortcuts currently require a native editable note body, and do not run in search/settings inputs
or the manager. Held keys repeat only when the original command declares `repeatable`; IME composition
is ignored. This does not implement Obsidian Scope stacks or CodeMirror keymaps.

See the versioned [compatibility matrix](COMPATIBILITY.md) and [machine-readable source](compatibility.json)
for capabilities, evidence and unfinished Goal work. No claim of majority ecosystem compatibility is made.

## 当前边界 / Limits

- 六个原包的指定操作已验收；不代表这些插件全部功能或大部分 Obsidian 生态已兼容。
- 尚未接入 CodeMirror 键位/扩展、原生输入建议、完整自定义视图 API、Markdown 后处理、Node/Electron 模块、移动端、旧 v3/源码编辑器。
- Advanced Tables 的原生表格命令可用，专用侧栏与 Tab 键位未接入；Linter 的显式命令可用，原生 Cmd+S 自动 lint 未接入。
- Vault 索引目前只含 Markdown，最多 5000 篇；不提供真实文件时间戳、完整 backlinks 或附件/二进制/文件夹写 API。原生属性写仅支持已经打开的笔记。
- `requestUrl` 目前走浏览器 fetch，仍受 CORS 限制；HTML-to-Markdown 未接入。安装器不受该限制，走 Desktop 主进程。
- 无法证明安全映射的富文本位置拒绝执行。原生表格映射需解析往返验证；表格结构修改保留原生撤销。
- 切换智库由父服务重建对应 runtime 与设置；同一 profile 的 Web Lock 随已接受写入完成后释放。

The manager marks partial support rather than treating installation as compatibility. Package code is
trusted local plugin code; the iframe is a styling/runtime boundary, not a security sandbox. The retained
0.1 lab (`lab-main.js`, `e2e:obsidianbridge`) is an independent regression fixture.

## 验证分层 / Verification

- `node prototypes/obsidian-bridge/check-runtime.mjs`: real original JS + DOM substitute; no GUI/disk claim.
- `node prototypes/obsidian-bridge/check-lifecycle.mjs`: delayed host writes across close/remount and a late note read racing with typing.
- `npx vitest run electron/pluginPackageFiles.test.ts frontend/src/amadeus/plugins/packageFiles.test.ts`: package path constraints and host lifecycle.
- `node prototypes/obsidian-bridge/check-native.mjs`: original bundles through command buffers, no editor DOM; stale commit rejection.
- `npm run check:obsidianexpanded`: six original bundles plus native metadata, failure preservation, API lifecycle and store failure checks.
- `npm run e2e:obsidiannative`: real store search/install, six original packages, native commands/undo/save, background numbering, property writes and quiet-window assertions.
- `npx vitest run electron/obsidianCommunity.test.ts electron/amadeus/ipc.unitEvents.test.ts`: installer rollback, no overwrite, checked vault identity and native event plumbing.
- `npm run e2e:obsidianbridge` (0.1 lab): real Electron, native host IPC, on-disk original packages and exported Markdown,
  settings/disabled-state restart, screenshots. Run under the repository's GUI lock.

Host seams are optional `ctx.packageFiles` reads and community installer, `ctx.app.captureEditor()`, checked closed-file writes, native property patches, vault events and disposable command registrations. It is absent on Web/mobile and
Studio development sources. The runtime and package manager are distributed in the Bridge plugin.

## 0.1 历史回归 / Version 0.1 regression history

The focused Codex review found three reproducible lifecycle issues: premature lease release during
settings writes, dropped queued settings on close, and a delayed note read replacing newer draft edits.
The parent realm now serializes accepted settings snapshots and retains its Web Lock until they settle.
The runtime rejects late reads if the draft revision changed. `check-lifecycle.mjs` reproduces these
scenarios against the retained 0.1 lab entrypoint and original TOC package.
Real Electron navigation also exposed iframe reloads when Dockview moves a tab's DOM. The parent keeps
the draft, cursor and vault identity, then rehydrates the compatibility realm on `load`; returning from
the native note is an explicit acceptance check. Closing the view still discards unexported drafts.

`node prototypes/obsidian-bridge/report.mjs` renders `artifacts/index.html` from the latest Electron
results, receipts and screenshots. Missing/failed checks remain visible. Bundled runtime dependency
licenses are generated into `plugin/THIRD-PARTY-NOTICES.txt`; original plugin release assets stay in the
ignored nested installation directory and are fetched by the pinned installer.

## 0.2 评审修复 / Native review fixes

The focused review reproduced two regressions: a non-note split retaining the previous page scope, and
canonical serialization rewriting unrelated reference links. Capture/apply now check the actual active
main leaf as well as visibility and scope; snapshots use the native preservation serializer. No-op
commands do not reparse. Native unit tests cover both cases. In-flight child commands also reject after
disable/re-enable, and replaceSelection carries its resulting cursor to the native transaction.

`node prototypes/obsidian-bridge/report-native.mjs` renders the native acceptance report from
`artifacts/native/results.json` and actual screenshots. The original lab report remains separate.

## 0.3 验收 / Expanded acceptance

`node prototypes/obsidian-bridge/report-expanded.mjs` renders `artifacts/expanded/index.html` from actual
Electron screenshots and results. `validation.json` records relevant unit checks, review outcome and CI.
No release package, main merge or production deployment is implied by this worktree acceptance.

The focused 0.3 Codex review identified four issues, all repaired with regressions: preserve the original
read baseline for CAS, propagate child-plugin epoch through asynchronous reads/writes, resume awaited
timers inside their own operation, and isolate malformed YAML per file. Disabling also cancels a pending
command so a cleared timer cannot leave the command queue stuck.

## 0.4 验收 / Hotkey acceptance

`node prototypes/obsidian-bridge/report-compatibility.mjs` generates the bilingual HTML acceptance
report from the current real Electron results, screenshots and compatibility matrix. Native shortcut
coverage includes original Note Refactor default extraction, changing Sort's binding in the separate
settings window, dispatch in the main editor, search-field exclusion, unbind, disable and re-enable.
Shared command tests cover multiple defaults, exact modifiers, composition, recording and cleanup.

Focused review regressions are retained: queued commands keep their dispatch-time native snapshot and
reject note/selection/instance changes before execution; disabling removes commands before asynchronous
settings persistence; rescanning withdraws all hotkeys before package enumeration and checks readiness
before consuming a key. `check-native.mjs` exercises delayed queue/save/scan cases; native Electron
acceptance verifies an original queued Sort command cannot move to another note.


## 0.5 原生视图 / Native views

原版 Advanced Tables 的 `table-control-bar` 命令在 Forsion 原生右侧栏打开工具栏；插列按钮使用同一 Amadeus 编辑事务，可单步撤销。原包 DOM 与 CSS 保留，CSS 隔离在原生 View 的 ShadowRoot 中。折叠、恢复、显式关闭及插件禁用均有回归验证。

The original Advanced Tables `table-control-bar` command opens its toolbar in the native Forsion right sidebar. Its insert-column button uses a single Amadeus transaction and undo. Original DOM and CSS are hosted inside the native View's ShadowRoot. Collapse/restore, explicit detach and disable have regression coverage.

View registrations use stable IDs and exist before opening a command. This currently supports one leaf per registered type. Native close is a suspension, while explicit detach/disable calls `onClose` and unloads the component. Cross-restart plugin state, arbitrary DOM listeners, active custom-view routing and advanced embedded views remain Goal work; see the compatibility matrix.

视图使用稳定 ID，在命令执行前即注册；当前每种类型一个实例。原生关闭暂按暂停处理，显式 detach／禁用才调用 `onClose` 并卸载组件。跨重启插件状态、任意 DOM 监听、活动自定义视图路由和复杂嵌入仍在 Goal 范围内，详见兼容矩阵。


The focused read-only Codex review reproduced four defects, repaired with regression fixtures: explicit no-editor gestures must not acquire a later note; `openFile` must follow the current edit commit; detach during asynchronous state restoration must prevent `onOpen`; and unloaded Components must release their plugin-owned cleanup references. Returned leaf methods are also revoked on plugin disable. Tests: `check-view-transactions.mjs` and `check-native-views.mjs`.

聚焦只读 Codex 评审复现了四个缺陷，均已修复并加入回归：无编辑器的手势不得取得后来打开的笔记；`openFile` 必须在当前编辑提交后执行；异步状态恢复期间关闭视图不得再调用 `onOpen`；组件卸载后必须释放插件清理队列中的引用。返回的 leaf 方法也在禁用时失效。对应测试为 `check-view-transactions.mjs` 和 `check-native-views.mjs`。
