# Obsidian Bridge — Desktop 原型 / Desktop prototype

0.2 将三个原始 Obsidian 插件的编辑命令接到当前 **Amadeus 原生可视编辑器**。正文、选区、撤销和磁盘保存由原生编辑器持有；Bridge 管理面板只负责原包和设置。

Version 0.2 runs the three original Obsidian plugins against the active **native Amadeus visual editor**.
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
node prototypes/obsidian-bridge/install-plugins.mjs
npm run build:obsidianbridge
npm run build
# Follow the repository gui-verify devlock procedure when launching Electron.
npm run e2e:obsidiannative
# Runs acceptance and leaves the isolated native note open:
npm run preview:obsidiannative
```

`install-plugins.mjs [bridge-plugin-folder]` defaults to this prototype's `plugin/` folder. It downloads only
three pinned releases; reinstallation refuses modified existing assets. Runtime scans the real `plugins/`
subfolder on opening or pressing Rescan. There is no community-market browser or arbitrary ZIP installer yet.

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
| Number Headings | [1.16.0](https://github.com/onlyafly/number-headings-obsidian/releases/tag/1.16.0) | multiple text changes in one transaction, disable/re-enable, timer cleanup |

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

## 当前边界 / Limits

- 已接入原生可视正文，保留原生保存与撤销；不是整生态兼容声明。
- 元数据只覆盖当前正文的标题、基础列表和链接；frontmatter 写入命令、自动编号/延时回调、插件自定义弹窗暂不支持。
- 旧 v3 块编辑器、源码模式、任意 CodeMirror 扩展、完整 Vault/Workspace、Node/Electron 模块和后处理尚未接入。
- 无法可靠映射的富文本语法位置明确拒绝；不会猜测坐标后覆盖笔记。
- 原包保持同一目录结构；切换智库后下次执行命令或重新打开管理面板会重建对应设置实例。

Native visual body editing is supported for the exercised commands. Automatic numbering/timers,
frontmatter writes, custom plugin dialogs, old v3 blocks, source mode, arbitrary CodeMirror extensions,
full Vault/Workspace APIs, Node/Electron and Markdown postprocessors remain unsupported.
Unmappable syntax positions fail explicitly. Changing vault rebuilds the settings/runtime on the next
command or manager opening. The retained 0.1 lab (`lab-main.js`, `e2e:obsidianbridge`) is a separate
regression fixture, not the installed 0.2 entrypoint.

## 验证分层 / Verification

- `node prototypes/obsidian-bridge/check-runtime.mjs`: real original JS + DOM substitute; no GUI/disk claim.
- `node prototypes/obsidian-bridge/check-lifecycle.mjs`: delayed host writes across close/remount and a late note read racing with typing.
- `npx vitest run electron/pluginPackageFiles.test.ts frontend/src/amadeus/plugins/packageFiles.test.ts`: package path constraints and host lifecycle.
- `node prototypes/obsidian-bridge/check-native.mjs`: original bundles through command buffers, no editor DOM; stale commit rejection.
- `npm run e2e:obsidiannative`: native command palette, Amadeus edits, undo, saves, settings and quiet-window assertions.
- `npm run e2e:obsidianbridge` (0.1 lab): real Electron, native host IPC, on-disk original packages and exported Markdown,
  settings/disabled-state restart, screenshots. Run under the repository's GUI lock.

Host seams are optional read-only `ctx.packageFiles`, native `ctx.app.captureEditor()`, and disposable command registrations. It is absent on Web/mobile and
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
