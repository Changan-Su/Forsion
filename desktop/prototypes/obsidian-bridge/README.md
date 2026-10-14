# Obsidian Bridge — Desktop 原型 / Desktop prototype

一个 Forsion 原生插件，在 LCL 标签页里加载未经修改的 Obsidian 发布包。
目前仅在独立 CodeMirror 兼容编辑区中运行；没有接管普通 Amadeus 笔记页。

A native Forsion plugin that runs unchanged Obsidian release packages inside an LCL tab.
Version 0.1 operates in its own CodeMirror compatibility editor, not the regular Amadeus editor.

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
同一 Desktop profile 一次只允许一个 Bridge 运行视图，避免不同窗口覆盖设置。

Original packages live inside Bridge's own folder. The user's `.obsidian/plugins` is untouched.
Settings use Forsion's plugin data store, separated by vault and child plugin ID. A profile-wide Web Lock
allows one Bridge view at a time. The iframe isolates CSS and DOM helpers; it is **not a security sandbox**.

## 运行 / Run

From the Genesis worktree's `desktop/` directory:

```sh
node prototypes/obsidian-bridge/install-plugins.mjs
npm run build:obsidianbridge
npm run build
# Follow the repository gui-verify devlock procedure when launching Electron.
npm run e2e:obsidianbridge
npm run demo:obsidianbridge
# Or open a fresh interactive fixture without replaying acceptance:
npm run preview:obsidianbridge
```

`install-plugins.mjs [bridge-plugin-folder]` defaults to this prototype's `plugin/` folder. It downloads only
three pinned releases; reinstallation refuses modified existing assets. Runtime scans the real `plugins/`
subfolder on opening or pressing Rescan. There is no community-market browser or arbitrary ZIP installer yet.

The Electron harness creates an isolated home, installs Bridge from disk, creates a fixture vault, drives
real UI clicks, verifies restart persistence and writes screenshots/results to `artifacts/`.
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

## 当前边界 / Limits

- 原生 LCL 标签页 + 独立兼容编辑区；不桥接普通 Amadeus 编辑页的选区。
- 可读取智库笔记为草稿，导出时只创建新副本；不覆盖原笔记，不提供自动保存。
- 元数据仅覆盖当前草稿的标题、基础列表、Markdown 链接及 YAML；不是完整 Vault 索引。
- 支持样本使用的 Plugin、Setting、Modal、Editor 和 MarkdownView API 子集。
- `sourceMode.cmEditor` 是 Editor 方法适配，不是完整 CodeMirror 5。CM6 插件扩展注册尚不支持。
- 未实现 Node/Electron 模块、完整 WorkspaceLeaf/ItemView、文件系统变更事件、插件间 API、Markdown 后处理。
- 未知 `require()` 和 API 导出明确报错，不用空对象假装成功。没有全生态兼容率结论。
- 切换智库后操作拒绝执行，需要重新打开 Bridge；草稿尚未导出时应先导出。

Native LCL tab with a dedicated editor; copy-only exports; current-document metadata only. No native
Amadeus editor integration, full Vault/Workspace model, CodeMirror extension registration, Node/Electron
modules, inter-plugin APIs or Markdown postprocessors. Unknown modules/API exports fail explicitly.
A vault switch requires reopening Bridge. Export drafts before closing; drafts are not auto-saved.

## 验证分层 / Verification

- `node prototypes/obsidian-bridge/check-runtime.mjs`: real original JS + DOM substitute; no GUI/disk claim.
- `node prototypes/obsidian-bridge/check-lifecycle.mjs`: delayed host writes across close/remount and a late note read racing with typing.
- `npx vitest run electron/pluginPackageFiles.test.ts frontend/src/amadeus/plugins/packageFiles.test.ts`: package path constraints and host lifecycle.
- `npm run e2e:obsidianbridge`: real Electron, native host IPC, on-disk original packages and exported Markdown,
  settings/disabled-state restart, screenshots. Run under the repository's GUI lock.

The host change is a generic optional read-only `ctx.packageFiles` seam. It is absent on Web/mobile and
Studio development sources. The runtime and package manager are distributed in the Bridge plugin.

## 评审与复现 / Review and evidence

The focused Codex review found three reproducible lifecycle issues: premature lease release during
settings writes, dropped queued settings on close, and a delayed note read replacing newer draft edits.
The parent realm now serializes accepted settings snapshots and retains its Web Lock until they settle.
The runtime rejects late reads if the draft revision changed. `check-lifecycle.mjs` reproduces these
scenarios against the actual Bridge entrypoint and original TOC package.

`node prototypes/obsidian-bridge/report.mjs` renders `artifacts/index.html` from the latest Electron
results, receipts and screenshots. Missing/failed checks remain visible. Bundled runtime dependency
licenses are generated into `plugin/THIRD-PARTY-NOTICES.txt`; original plugin release assets stay in the
ignored nested installation directory and are fetched by the pinned installer.
